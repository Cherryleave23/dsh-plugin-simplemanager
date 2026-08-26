/**
 * Node 模块缓存驱逐（官方 HMR partialReload 同款术，供 tempLoad 装配前清同名旧模块缓存）。
 *
 * 背景：tempRemove/uninstall 拆的是 cordis 装配树与磁盘包，但 Node 的 ESM loadCache
 * （按 realpath URL 键控的进程级模块表）条目仍在。同名重装回同一路径 → loader.create 的
 * import() 命中旧 ModuleJob → 装配旧代码、顶层副作用不重跑（实测复现：拆净+改码+重装仍取 v1，
 * probe 残留/channel 复活同根因）。
 *
 * 修法：装配前按包真实目录前缀驱逐两张表——ESM loadCache + CJS require.cache——
 * 让下次 import 未命中、走完整读盘求值。钥匙与 HMR 同一把（Node 内部 module loader：
 * `internal/modules/esm/loader` 的 getOrInitializeCascadedLoader()），姿势与 HMR 同款
 * （Map.prototype.delete.call：Node 24 LoadCache.delete 只置空类型槽不删条目，必须借原生
 * Map delete 才真移除；Node 22/23 为普通 Map，同一写法通吃）。
 *
 * loadCache 的取得有两道门，任一层断了都会让驱逐失效：
 *   A. `ctx.loader.internal`（官方 Loader 类的 `public internal = ModuleLoader.fromInternal()`）。
 *      而 fromInternal() 依赖 node-addon-require-builtin 或 --expose-internals；桌面壳两者都缺时
 *      `.internal` 即为 undefined。
 *   B. 本进程内自取：复制 fromInternal() 的姿势，直接从宿主进程（tempLoad 就运行在此进程）拿
 *      `internal/modules/esm/loader`。跑在宿主进程内就能摸到宿主真正的 loadCache。
 * 驱逐自身走 A 拿不到时才退 B；两者都不可用时降级为现状、不阻断装载，且把「断在哪一环」写进
 * 结果供观测（本次是 `.internal` 为 undefined，还是 `.loadCache` 为 undefined，还是 require 失败）。
 *
 * 边界：只驱逐目标包自身真实目录（pnpm 布局下 .pnpm/<name>@<ver>/node_modules/<name>，
 * file: link 布局下即源码目录本身），共享依赖（cordis 等）不在其内，保持单实例不重复求值；
 * 驱逐后不回滚——磁盘已是新码，回填旧条目反而复活旧代码（HMR 面向文件监视的瞬态写入故需
 * 回滚，本处磁盘态已终态）。
 */
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** 驱逐结果：ok=false 表示宿主拿不到 loadCache（调用方降级为现状，不阻断装载）；source/diagnosis
 * 记录 loadCache 的来源与「断在哪一环」，供 agent 观测并据以修复。 */
export interface EvictResult {
  ok: boolean
  evictedEsm: number
  evictedCjs: number
  /** loadCache 来源：'ctx.loader.internal' | 'in-process' | 'none'。 */
  source: 'ctx.loader.internal' | 'in-process' | 'none'
  reason?: string
  /** 归因明细（source='none' 时给出具体断点）。 */
  diagnosis?: string
}

/**
 * 驱逐 packageRealDir 目录下所有已缓存模块条目（ESM loadCache + CJS require.cache）。
 * loader 只读其 internal；拿不到 internal 时降级为本进程内自取（tempLoad 就运行在宿主进程内）。
 * 返回驱逐计数 + loadCache 来源；任何异常都不应外抛——驱逐是尽力而为的增强，
 * 绝不能让它把一次本可成功的装载打断。
 */
export function evictPackageModuleCaches(
  loader: { internal?: { loadCache?: unknown } } | undefined,
  packageRealDir: string,
): EvictResult {
  // 归因：区分「ctx.loader.internal 不存在」与「存在但 loadCache 不存在」，别混为一谈。
  const hasInternalSlot = loader !== null && typeof loader === 'object'
  const internal = hasInternalSlot ? loader?.internal : undefined
  const internalLoadCacheType = typeof internal?.loadCache
  const ctxLoadCache = parseLoadCache(internal?.loadCache)

  let source: EvictResult['source'] = 'ctx.loader.internal'
  let loadCache = ctxLoadCache

  if (!loadCache) {
    // A 门断了：退回 B——本进程内按官方 fromInternal() 姿势自取宿主 loader。既然 tempLoad
    // 就在宿主进程内跑，这里拿到的就是宿主真正的 loadCache。
    source = 'in-process'
    const acquired = acquireInProcessLoadCache()
    loadCache = acquired.ok ? parseLoadCache(acquired.loadCache) : undefined
    if (loadCache) return runEviction(loadCache, packageRealDir, source, internalLoadCacheType, undefined)
    // 两道门都断：把每道门的断点写进归因，让下一轮判定直接看到真正的阻断项。
    const diagnosis = [
      `ctx.loader.internal=${internal === undefined ? 'undefined' : 'object'}`,
      `internal.loadCache=${internalLoadCacheType}`,
      `inProcess=${acquired.ok ? 'ok' : 'fail'} [${acquired.steps.join('; ')}]`,
    ].join(' | ')
    return {
      ok: false,
      evictedEsm: 0,
      evictedCjs: 0,
      source: 'none',
      reason: '拿不到宿主 Node 内部 loadCache（ctx.loader.internal 与进程内自取均不可用）',
      diagnosis,
    }
  }

  return runEviction(loadCache, packageRealDir, source, internalLoadCacheType, undefined)
}

/** 实际驱逐：按目录前缀清 ESM loadCache + CJS require.cache。 */
function runEviction(
  cacheMap: Map<unknown, unknown>,
  packageRealDir: string,
  source: EvictResult['source'],
  _internalLoadCacheType: string,
  _inProcessDetail: string | undefined,
): EvictResult {
  try {
    // ESM：键为 file URL（可能带 ?query，按去 query 后的 pathname 判前缀），只清目标包目录内条目。
    // 目录 URL 后必须补 '/'，否则 file:///D:/a/b2 会被 D:/a/b 前缀误伤。
    const dirUrl = pathToFileURL(packageRealDir).href + '/'
    const esmKeys: string[] = []
    for (const key of safeKeys(cacheMap)) {
      if (typeof key === 'string' && key.split('?')[0].startsWith(dirUrl)) esmKeys.push(key)
    }
    for (const key of esmKeys) Map.prototype.delete.call(cacheMap, key)

    // CJS：被 import() 加载的 CJS 模块同时挂 require.cache（不清会继续供旧模块）；包内自建
    // createRequire 的 require 也只进这张表。键为原生分隔符真实路径，按目录前缀清。
    const cjsPrefix = packageRealDir + sep
    const cjsKeys: string[] = []
    for (const path of Object.keys(require.cache)) {
      if (path.startsWith(cjsPrefix)) cjsKeys.push(path)
    }
    for (const path of cjsKeys) delete require.cache[path]

    return { ok: true, evictedEsm: esmKeys.length, evictedCjs: cjsKeys.length, source }
  } catch (error) {
    return {
      ok: false,
      evictedEsm: 0,
      evictedCjs: 0,
      source,
      reason: '驱逐执行异常：' + (error instanceof Error ? error.message : String(error)),
    }
  }
}

/** 鸭子类型探测 Map 内部槽并返回可迭代键集；无槽返回 undefined。
 * 注意：Node 内部 loadCache 的构造器是 LoadCache 而非 Map，instanceof Map 在 Node 22 实测为
 * false（官方 HMR 也不做 instanceof，直接借 Map.prototype 方法调用）。无 Map 内部槽的对象会让
 * Map.prototype.keys.call 抛 TypeError，正好当失败处理。 */
function parseLoadCache(candidate: unknown): Map<unknown, unknown> | undefined {
  if (candidate === null || typeof candidate !== 'object') return undefined
  try {
    const raw = Map.prototype.keys.call(candidate as Map<unknown, unknown>)
    if (raw && typeof (raw as Iterable<unknown>)[Symbol.iterator] === 'function') {
      return candidate as Map<unknown, unknown>
    }
  } catch { /* 无 Map 内部槽，按不可用处理 */ }
  return undefined
}

/** 拿到已验证的 loadCache 后的键迭代（安全兜底：有些 LoadCache 的 keys 迭代会在中途暴露非字符串键）。 */
function safeKeys(map: Map<unknown, unknown>): unknown[] {
  try {
    return Array.from(map.keys())
  } catch {
    try {
      return Array.from(Map.prototype.keys.call(map) as Iterable<unknown>)
    } catch {
      return []
    }
  }
}

/** 进程内自取宿主 Node 内部 loader 的 loadCache（复制官方 ModuleLoader.fromInternal() 姿势）。
 * 恒返回结构化探针：ok 时带 loadCache，失败时 steps 记录每一步的真实结果——锚点是否解析到
 * addon、requireBuiltin 类型、getOrInitializeCascadedLoader 是否存在、loadCache 类型，供 trace 归因。 */
interface AcquireOutcome {
  ok: boolean
  loadCache?: unknown
  via?: string
  steps: string[]
}

function acquireInProcessLoadCache(): AcquireOutcome {
  const steps: string[] = []
  const [major] = process.versions.node.split('.').map(Number)
  steps.push(
    `node=${process.versions.node} major=${major} electron=${process.versions.electron ?? '-'} execArgv=${JSON.stringify(process.execArgv)} resourcesPath=${(process as { resourcesPath?: string }).resourcesPath ?? '-'}`,
  )
  steps.push(`runtimeNodeModules=${runtimeNodeModules() ?? '-'}`)
  if (major < 22) {
    steps.push(`skip:major<22`)
    return { ok: false, steps }
  }

  // 1) --expose-internals 直接 require internal 模块。
  const expose = process.execArgv.includes('--expose-internals')
  steps.push(`expose-internals=${expose}`)
  if (expose) {
    try {
      const m = require('internal/modules/esm/loader')
      const raw = m?.getOrInitializeCascadedLoader?.()
      steps.push(`expose:loader=${typeof m} getOrInit=${typeof m?.getOrInitializeCascadedLoader} loaderType=${typeof raw} loadCache=${typeof raw?.loadCache}`)
      if (raw && raw.loadCache !== undefined) return { ok: true, loadCache: raw.loadCache, via: 'expose-internals', steps }
    } catch (e) { steps.push(`expose:ERR=${e instanceof Error ? e.message : String(e)}`) }
  }

  // 2) node-addon-require-builtin：从多个锚点解析，requireBuiltin 取内部 loader 的 loadCache。
  for (const anchor of loadAddonAnchors()) {
    try {
      const addon = createRequire(anchor)('node-addon-require-builtin')
      steps.push(`addon@${anchor}:resolved keys=${Object.keys(addon ?? {}).join(',')} rbType=${typeof addon?.requireBuiltin}`)
      let m: any
      try { m = addon.requireBuiltin('internal/modules/esm/loader') } catch (err) { steps.push(`addon@${anchor}:requireBuiltinERR=${err instanceof Error ? err.message : String(err)}`); continue }
      const raw = m?.getOrInitializeCascadedLoader?.()
      steps.push(`addon@${anchor}:loader=${typeof m} getOrInit=${typeof m?.getOrInitializeCascadedLoader} loaderType=${typeof raw} loadCache=${typeof raw?.loadCache} loaderKeys=${raw ? Object.keys(raw).slice(0, 15).join(',') : '-'}`)
      if (raw && raw.loadCache !== undefined) return { ok: true, loadCache: raw.loadCache, via: 'addon@' + anchor, steps }
    } catch (e) { steps.push(`addon@${anchor}:ERR=${e instanceof Error ? e.message : String(e)}`) }
  }

  steps.push('all-strategies-failed')
  return { ok: false, steps }
}

/** node-addon-require-builtin 的候选解析锚点（本包 → 官方内核 @deepseek-ai/dsh → 宿主运行时 node_modules）。 */
function loadAddonAnchors(): string[] {
  const out = [import.meta.url]
  // @deepseek-ai/dsh 若能由本包解析到，则以它所在目录为锚（其级联依赖含 node-addon-require-builtin）。
  try {
    out.push(require.resolve('@deepseek-ai/dsh/package.json'))
  } catch { /* 本包内解析不到内核，跳过 */ }
  // 宿主运行时 node_modules 根：Desktop 为 resources/app.asar.unpacked/node_modules，
  // 从中向上锚定 node-addon-require-builtin 所在目录。
  const rr = runtimeNodeModules()
  if (rr) out.push(join(rr, 'x.js'))
  return out
}

/** 宿主运行时官方内核 node_modules 根（avoids 依赖 host.ts 的运行时探测，保持自包含）。 */
function runtimeNodeModules(): string | null {
  const candidates: string[] = []
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (typeof resourcesPath === 'string' && resourcesPath) {
    candidates.push(join(resourcesPath, 'app.asar.unpacked', 'node_modules'))
  }
  if (process.execPath) {
    candidates.push(join(dirname(process.execPath), 'resources', 'app.asar.unpacked', 'node_modules'))
  }
  const local = process.env.LOCALAPPDATA || process.env.ProgramW6432 || ''
  if (local) {
    for (const sub of ['DSH Desktop', 'DSH Desktop for OSX', 'Programs/DSH Desktop']) {
      candidates.push(join(local, sub.replace('/', '\\'), 'resources', 'app.asar.unpacked', 'node_modules'))
    }
  }
  return candidates.find((c) => { try { return require('node:fs').existsSync(c) } catch { return false } }) ?? null
}