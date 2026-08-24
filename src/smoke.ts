/** 无头冒烟 + 数据驱动渲染 harness（verifyClient/tempLoad 共用的预检引擎）。
 * 从 index.ts 抽出（P2 拆分）：纯函数区——client 产物探测、VM 沙箱构建、apply/render/data-render 全套检测。
 * 不持有任何模块级可变状态（原 locateClientRoots 对 tempInfos 的访问已参数化为 tempSpec）。 */

import { basename, isAbsolute, join, normalize } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { realCordisGate } from './preflight.js'

export function detectOfficialPeerDeps(packageName: string, profileDir?: string): string[] | undefined {
  if (!profileDir) return undefined
  const manifestPath = join(profileDir, 'node_modules', packageName, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { peerDependencies?: Record<string, string> }
    const peers = manifest.peerDependencies
    if (!peers) return undefined
    return Object.keys(peers).filter((n) => n.startsWith('@deepseek-ai/dsh-'))
  } catch {
    return undefined
  }
}

/** 计算某插件 client 产物可能所在目录（优先级：temp 源目录 → profile node_modules）。
 * 热装插件（tempInfos 有 spec 源路径）常从任意目录临时加载、并不落在 profile node_modules，需按源目录定位。 */
export function locateClientRoots(packageName: string, profileDir?: string, tempSpec?: string): string[] {
  const roots: string[] = []
  if (tempSpec) {
    const raw = tempSpec.replace(/^file:/i, '')
    // 形似路径（含分隔符 / 盘符 / 相对前缀）才作候选；纯 name@ver 为 registry 安装，退回 profile node_modules。
    if (/[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('.')) {
      roots.push(normalize(isAbsolute(raw) ? raw : join(process.cwd(), raw)))
    }
  }
  if (profileDir) roots.push(join(profileDir, 'node_modules', packageName))
  return roots
}

/** 在候选目录里找某插件是否声明 client 板块并定位其产物（声明缺失目录 / 无 package.json 的目录按序跳过）。 */
export function detectClientArtifact(candidateRoots: string[]): { declared: boolean; artifactExists: boolean; artifactSize: number; path?: string } {
  const none = { declared: false, artifactExists: false, artifactSize: 0 }
  for (const root of candidateRoots) {
    const manifestPath = join(root, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        dsh?: { client?: unknown }
        exports?: Record<string, unknown>
      }
      // 判定是否声明 client 板块：dsh.client 存在，或 exports 里有 "./client" 导出。
      const declared = Boolean(manifest.dsh?.client) || Boolean(manifest.exports?.['./client'])
      if (!declared) return none
      // 解析 "./client" 的相对入口（默认 field），退化到常见目录。
      const exp = manifest.exports?.['./client'] as { default?: string } | string | undefined
      const rel = typeof exp === 'string' ? exp : typeof exp === 'object' && exp ? (exp as { default?: string }).default : undefined
      const candidates = rel
        ? [rel]
        : ['./lib/client.js', './client.js', './src/client/index.tsx']
      for (const c of candidates) {
        const p = join(root, ...c.replace(/^\.\//, '').split('/'))
        if (existsSync(p)) {
          try { return { declared, artifactExists: true, artifactSize: statSync(p).size, path: p } } catch { return { declared, artifactExists: true, artifactSize: 0, path: p } }
        }
      }
      return { declared, artifactExists: false, artifactSize: 0 }
    } catch {
      return none
    }
  }
  return none
}

// ---------------------------------------------------------------------------
// client 板块「无头冒烟预检」引擎
//
// 目标：在运行前（不依赖桌面渲染端是否在跑）可感知地发现「热注入没问题、但重载前端就崩」的插件。
// 原理：直接在 Node/kernel 进程里用 node:vm 真实执行该插件已装入的 client bundle——
//   ① load 注册（window.__ModuleLoader__.load 是否按契约注册 entry）
//   ② factory 物化 + apply(ctx) 挂载（apply 抛错即「重载前端崩」的反面根因）
// 任一环抛错即返回带分步原因的诊断，供刷新界面预检 / 热装源头提示。
//
// 已知边界（演进方向，见文档「不许碰清单」与 ANALYSIS §…）：
//   - 不真正挂载渲染组件（需 react-dom + 真实 DOM 才会触发的 useState-of-null / dual-react 类渲染崩，
//     后续可加「SSR 渲染层」抓取，react-dom 自 profile 可解析时启用）；
//   - 官方 dsh 运行时（@deepseek-ai/dsh-client-runtime、dsh-client-ui-slots 等）在预检沙箱以「惰性代理」
//     模拟，真实桌面会注入；故依赖官方钩子用法的错误不会被虚假命中（也暂不能抓）。
// ---------------------------------------------------------------------------
interface SmokeStepOutcome { name: string; ok: boolean; detail: string }

/** 预检结局类别（reloadClient 按此分级渲染，避免把"必挂起"错标成"崩溃"）。
 *  - 'pending'：重载必挂起等待服务、apply 不执行，整页被门禁打回，但**非崩溃**（fixture 属于此类）。
 *  - 'crash' ：注入可达、重载会真实执行，因 apply/render/加载/物化抛错而**真实崩溃**（白屏/失败）。
 *  - 'volatile'：产物缺失/读取失败/未导出 apply/契约不符等"缺东西"，重载行为不稳定，非崩溃但异常。
 *  - 'warn'  ：可安全重载，但存在应知晓的非阻塞提示（如实验室模式不深挖、未知服务名、被门禁屏蔽的潜在缺陷）。
 *  - 'pass'  ：重载安全无任何提示。
 *  ok 仅表示"能否安全 reload"（pending/crash/volatile=false；warn/pass=true），
 *  精确结局由 outcome 表达，前端按 outcome 分组并从'crash'/'pending'得出阻断分组标题。 */
type SmokeOutcome = 'pending' | 'crash' | 'volatile' | 'warn' | 'pass'

export interface ClientSmokeReport {
  name: string
  declared: boolean
  ok: boolean
  /** 真 cordis 门禁后端产出（true）或三态近似（false）。实验室模式的可用性信号。 */
  realGate: boolean
  /** 预检结局类别，前端分组依据（见 SmokeOutcome 释义）。 */
  outcome: SmokeOutcome
  steps: SmokeStepOutcome[]
  /** 顶层失败原因（steps 里亦有对应 err 步）。 */
  error?: string
  /** 不打断重载、但应关注的非阻塞警告：真实重载会按 cordis 语义挂起等待的注入服务、以及被该服务门禁屏蔽的潜在缺陷。 */
  warns?: string[]
}

/** 官方 dsh「web reload 引导期可达」的服务名（可注入 Service 白名单）。
 * 依据与来源：不是拍脑袋、也不是 deskhopprofile 编译产物，而是从 dsh 官方源码树采集——
 * cordis 里「可注入」的唯一判据是 `ctx.get(name) !== undefined`，而它只对**被 `provide` 注册的
 * Service** 成立；`effect/on/track/…` 是 `ctx.mixin()` 产生的 accessor，`_getImpl()` 绝不命中 store，
 * 故不在此列（写进 inject 必然 PENDING(waiting for service: X)，apply 永远不执行）。
 *
 * 采集命令（dsh 版本升级后务必重扫刷新，见 scripts/scan-official-services.mjs）：
 *   node scripts/scan-official-services.mjs \
 *     <dsh-official>/deepseek-harness-v0.1.1-rc.2/packages/client
 * 本轮结果 = 官方源码（rc.2 packages/client 下各 src/）扫出 19 个，另并入 boot 机制保证的 `loader`。
 * 语义：凡不在本集的 inject 名 → 真实 boot 门禁判 `ctx.get(name)===undefined` → entry 挂 pending，
 * apply 不会执行；故其 apply/渲染层崩溃都是被门禁屏蔽的潜在缺陷，不应当作「重载会真实崩」。 */
const RELOAD_REACHABLE_SERVICES = new Set<string>([
  // —— 官方 client 源码 super(ctx,'X') / reflect.provide('X') 采集（rc.2 packages/client）——
  'chatFileMentions', // ui-deliverables
  'clientModules',    // modules  (Service: 静态模块清单/__ModuleLoader__)
  'commandUi',        // ui-commands
  'connection',       // connection
  'conversation',     // ui-conversation
  'conversationEvents', // runtime (conversation/event-registry)
  'conversationViews',  // runtime (conversation/view-registry)
  'inputTriggers',    // ui-input-trigger
  'layout',           // ui-layout
  'locale',           // locale
  'modelDirectories', // ui-model-selection
  'modules',          // modules (client 半边)
  'sessions',         // runtime (sessions/service)
  'settingsSchema',   // ui-settings
  'settingsScope',    // ui-settings
  'slots',            // runtime (SlotRegistry, client-runtime)
  'theme',            // ui-theme
  'uiRenderer',       // ui-renderer (reflect.provide('uiRenderer', …))
  'workspaces',       // runtime (workspaces/service)
  // —— boot 机制保证（非 client 包，但在 web reload 引导期必定注册）——
  'loader',           // boot.ts:114 ctx.plugin(Loader) 注册（web 引导期必可达）
])

/** 「必不可注入」的 cordis ctx 方法名（accessor / mixin 形态，非 provide 注册的 Service）。
 * 依据：cordis 的公开约定 —— `effect/on/once/emit/…` 是 Context 上的方法，不是可注入服务；
 * web 门禁 `ctx.get('effect')` 恒返 undefined ⇒ 插件一旦 inject 它，恒 pending、apply 永不执行。
 * 本集是「硬否定」：只用于把这类必挂起的 inject 名从「可达性」里剔除，其余未知命名走分类降级。 */
const NON_INJECTABLE_CTX_METHODS = new Set<string>([
  'effect', 'track', 'on', 'once', 'off', 'emit', 'parallel', 'serial', 'bail', 'waterfall',
  'inject', 'provider', 'plugin', 'provide', 'accessor', 'mixin', 'isolate', 'intercept', 'filter',
  'set', 'get', 'start', 'stop', 'dispose', 'middleware', 'logger', 'slots.changed',
])

export function smokeErrToString(error: unknown, max = 400): string {
  if (!(error instanceof Error)) return String(error)
  const msg = error.stack ? `${error.message}\n${error.stack.split('\n').slice(1, 5).join('\n')}` : error.message
  return msg.length > max ? msg.slice(0, max) + '…' : msg
}

/** 渲染探测里区分「组件自身 bug」与「无头环境缺浏览器 API」：后者不算插件问题，中性跳过。 */
function isBrowserEnvError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /window|document|navigator|localStorage|sessionStorage|location|history|HTMLElement|Element is not defined/i.test(msg)
}

/** 惰性递归代理：任何 get/调用/构造都返回自身，供「真实桌面注入、本沙箱没有」的官方依赖占位。 */
function recProxy(): any {
  const fn = function (): any { return recProxy() }
  return new Proxy(fn, {
    get: (_t, prop) => (prop === Symbol.toPrimitive ? () => '' : recProxy()),
    apply: () => recProxy(),
    construct: () => recProxy(),
    getPrototypeOf: () => Object.prototype,
  })
}

/** 浏览器帧调度的沙箱降级：真 rAF 用 setTimeout 模拟、craf 用 clearTimeout，避免沙箱缺浏览器全局时 client 的 useEffect 里调 requestAnimationFrame 抛 ReferenceError 假阳性崩溃。 */
function sandboxRaf(cb: (...args: unknown[]) => void): unknown {
  return setTimeout(() => cb(Date.now()), 16)
}
function sandboxCraf(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** 构建模块加载沙箱：window 挂 __ModuleLoader__，另给常见浏览器全局一个宽容代理，避免顶层 DOM 访问误报。 */
function buildClientSandbox(fakeWindow: Record<string, unknown>): Record<string, unknown> {
  const tolerant = new Proxy({}, {
    get: (_t, prop) => (prop === Symbol.toPrimitive ? () => '' : recProxy()),
  })
  const win = fakeWindow as Record<string, unknown>
  const sandbox: Record<string, unknown> = {
    window: win,
    globalThis: win,
    self: win,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch,
    document: tolerant,
    navigator: tolerant,
    location: tolerant,
    localStorage: tolerant,
    sessionStorage: tolerant,
    history: tolerant,
    requestAnimationFrame: sandboxRaf,
    cancelAnimationFrame: sandboxCraf,
    performance: { now: () => Date.now(), timeOrigin: Date.now() },
  }
  sandbox.global = win
  return sandbox
}

/** factory 的 require 实现：react 尽量解析与真实渲染端同源的副本，缺失则退最小 shim；官方 dsh 运行时以惰性代理模拟。 */
function makeClientRequireShim(profileDir: string, packageName: string, steps: SmokeStepOutcome[]): (id: string) => unknown {
  let baseReq: ((id: string) => unknown) | null = null
  try { baseReq = createRequire(join(profileDir, 'package.json')) } catch { baseReq = null }
  // 优先拿「与 react-dom 同源」的 react：否则组件用 profile 本地 react、渲染端 react-dom 用壳那份，
  // 两副本 ReactCurrentDispatcher 分离 ⇒ 干净 hooks 组件也假阳性崩（详 render 步见 resolveRenderOrigin）。
  const origin = resolveRenderOrigin(profileDir)
  let react: { version?: string; createElement?: unknown; Fragment?: unknown } | undefined = origin?.react
  if (react === undefined && baseReq) { try { react = baseReq('react') as never } catch { react = undefined } }
  const jsxRuntime = origin
    ? origin.jsxRuntime
    : react
      ? { jsx: (react as { createElement: unknown }).createElement, jsxs: (react as { createElement: unknown }).createElement, Fragment: react.Fragment }
      : { jsx: (type: unknown, props: unknown, ...kids: unknown[]) => ({ type, props: { ...(props as object), children: kids } }), jsxs: (type: unknown, props: unknown) => ({ type, props }), Fragment: Symbol('fixture-fragment') }
  const seenUnknown = new Set<string>()
  return (id: string): unknown => {
    if (id === 'react') { steps.push({ name: 'require', ok: true, detail: `resolve "${id}" → ${react?.version ? 'react@' + react.version : '最小 shim'}` }); return react ?? jsxRuntime }
    if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') { steps.push({ name: 'require', ok: true, detail: `resolve "${id}" → ${react ? 'react 驱动 jsx shim' : '最小 shim'}` }); return jsxRuntime }
    if (baseReq) {
      try { return baseReq(id) } catch { /* 未解析，走下方惰性占位 */ }
    }
    if (id.startsWith('@deepseek-ai/') && !seenUnknown.has(id)) {
      seenUnknown.add(id)
      steps.push({ name: 'require', ok: true, detail: `依赖 "${id}" 在预检沙箱以惰性代理模拟（真实桌面由渲染端注入）` })
    }
    return recProxy()
  }
}

/** 解析「与真实渲染端同源」的 react + react-dom/server：以 react-dom 的实际落点为锚。
 * 桌面 profile 顶层没有 react-dom 时，`react-dom/server` 会溢出到 DSH 壳 app.asar.unpacked 内嵌的那份；
 * 若此时 react 仍从 profile 本地解析，两者分属不同副本 → ReactCurrentDispatcher 分离 → 任何用 hooks 的
 * 组件渲染都假阳性抛 "Cannot read properties of null (reading 'useState')"，干净基线也被判 crash。
 * 真实渲染端插件组件本就解析到壳 react，故统一从 react-dom/server 所在目录反推其兄弟 react，保证同源
 * （渲染探测由此真正执行：destructure 这类"确定性渲染崩"能被捕获，而不是被同源检取代中性跳过）。 */
function resolveRenderOrigin(profileDir?: string): { react: any; reactDomServer: any; jsxRuntime: any } | null {
  if (!profileDir) return null
  let baseReq: ((id: string) => unknown) | null = null
  try { baseReq = createRequire(join(profileDir, 'package.json')) } catch { baseReq = null }
  if (!baseReq) return null
  let domPath = ''
  try { domPath = (baseReq as unknown as { resolve(id: string): string }).resolve('react-dom/server') } catch { return null }
  let originReq: ((id: string) => unknown) | null = null
  try { originReq = createRequire(domPath) } catch { return null }
  if (!originReq) return null
  try {
    const react = (originReq as unknown as { (id: string): unknown })('react') as { createElement?: unknown; Fragment?: unknown }
    const reactDomServer = (originReq as unknown as { (id: string): unknown })('react-dom/server') as { renderToStaticMarkup?: (n: unknown) => string }
    if (!react || !reactDomServer || typeof reactDomServer.renderToStaticMarkup !== 'function' || typeof react.createElement !== 'function') return null
    return {
      react,
      reactDomServer,
      jsxRuntime: { jsx: react.createElement, jsxs: react.createElement, Fragment: react.Fragment },
    }
  } catch {
    return null
  }
}

/** 无头冒烟预检一个插件的 client bundle（两层：load 注册 + factory/apply）。不依赖桌面渲染端是否在跑。 */
export async function clientSmokeTest(packageName: string, candidateRoots: string[], profileDir?: string, realGate = false, renderData?: unknown[]): Promise<ClientSmokeReport> {
  const steps: SmokeStepOutcome[] = []
  const record = (name: string, ok: boolean, detail: string): void => { steps.push({ name, ok, detail }) }
  /** settle 统一出口。outcome 缺省时按 ok 自动推导：ok=false→'volatile'（具体由调用点覆盖为 crash/pending），ok=true+无warns→'pass'、有warns→'warn'。 */
  const settle = (declared: boolean, ok: boolean, error?: string, warns?: string[], outcome?: SmokeOutcome): ClientSmokeReport => {
    const resolved: SmokeOutcome = outcome ?? (ok ? (warns && warns.length > 0 ? 'warn' : 'pass') : 'volatile')
    return { name: packageName, declared, ok, realGate, outcome: resolved, steps, error, warns }
  }

  if (candidateRoots.length === 0) return settle(false, false, '缺少可定位的目录，无法找 client 产物')
  const artifact = detectClientArtifact(candidateRoots)
  if (!artifact.declared) { record('locate', true, '未声明 client 板块，跳过预检'); return settle(false, true) }
  if (!artifact.path || !artifact.artifactExists || artifact.artifactSize <= 0) {
    record('locate', false, `声明了 client 板块，但产物缺失或为空（多为 client 编译错误）`)
    return settle(true, false, 'client 产物缺失或为空')
  }

  // ① 读取 + 求值（load 注册）
  let code: string
  try { code = readFileSync(artifact.path, 'utf8') } catch (error) { record('read', false, `读取 client 产物失败：${smokeErrToString(error)}`); return settle(true, false, '读取 client 产物失败') }
  record('read', true, `产物已读取（${artifact.artifactSize}B）：${basename(artifact.path)}`)
  const fakeWindow: Record<string, unknown> = {
    __ModuleLoader__: { mode: 'queue', pendingQueue: [] as unknown[], load(reg: unknown): void { (this.pendingQueue as unknown[]).push(reg) } },
  }
  const sandbox = buildClientSandbox(fakeWindow)
  try {
    vm.runInNewContext(code, sandbox, { filename: artifact.path })
  } catch (error) {
    record('load', false, `模块求值抛错：${smokeErrToString(error)}`)
    return settle(true, false, `模块求值抛错：${smokeErrToString(error, 200)}`, undefined, 'crash')
  }
  record('load', true, 'client bundle 求值成功（无顶层抛错）')
  const pending = ((fakeWindow.__ModuleLoader__ as { pendingQueue: unknown[] }).pendingQueue) ?? []
  const registration = pending[0] as { id?: string; factory?: unknown } | undefined
  if (pending.length !== 1 || typeof registration?.factory !== 'function') {
    record('register', false, `期望恰好一次 load 注册，实得 ${pending.length} 次（id=${registration?.id ?? '?'}）`)
    return settle(true, false, 'client 未按装配契约注册（load 次数/工厂形态不符）')
  }
  record('register', true, `已注册 client entry id="${registration.id}"（factory 为函数）`)

  // ② factory 物化 + 导出形状
  let materialized: unknown
  try { materialized = registration.factory(makeClientRequireShim(profileDir, packageName, steps)) } catch (error) {
    record('materialize', false, `factory 物化抛错：${smokeErrToString(error)}`)
    return settle(true, false, `factory 物化抛错：${smokeErrToString(error, 200)}`, undefined, 'crash')
  }
  record('materialize', true, 'factory 物化成功（导出面可读）')
  const exportsObj = materialized as { apply?: unknown; inject?: unknown } | undefined
  if (typeof exportsObj?.apply !== 'function') {
    record('shape', false, `未导出 apply 函数（实得 ${typeof exportsObj?.apply}）`)
    return settle(true, false, 'client 未导出 apply 函数')
  }
  const inject = exportsObj.inject as string[] | undefined
  record('shape', true, `导出 apply + inject=${Array.isArray(inject) ? '[' + inject.join(',') + ']' : '（无）'}`)

  // —— 服务门禁（两模式二选一）——
  // 实验室(realGate=true)：用真实 @deepseek-ai/cordis 的 ctx.get() 判定 inject 可达性（对齐 web/src/boot.ts:149），
  //   `effect/on/…/拼错的服务名` 由真门禁自然判 pending，否认集可删。门禁通过后**继续**执行
  //   apply/渲染/数据驱动渲染全套 VM 检测（全套深挖归属实验室模式）。
  // 基础(realGate=false)：三态近似门禁，只做门禁即停，不深挖 apply/渲染。
  const declaredInject = Array.isArray(exportsObj.inject) ? exportsObj.inject
    : exportsObj.inject && typeof exportsObj.inject === 'object'
      ? Object.keys(exportsObj.inject as Record<string, unknown>)
      : []
  if (realGate) {
    if (!profileDir) {
      record('service-gate', false, '真 cordis 门禁需要 profileDir 以解析真实 cordis，当前缺失')
      return settle(true, false, '真 cordis 门禁不可用：缺少 profileDir')
    }
    const { missing, reachable } = realCordisGate(profileDir, declaredInject, [...RELOAD_REACHABLE_SERVICES])
    if (missing.length > 0) {
      record('service-gate', false, `真 cordis 门禁：inject [${missing.join(', ')}] 在真实 ctx 上不是可注入 Service → 重载将挂起(pending)等待它们，整页被门禁打回，apply 不执行`)
      return settle(true, false, `重载将挂起 pending (waiting for service: ${missing.join(', ')})，整页无法进入`, undefined, 'pending')
    }
    record('service-gate', true, `真 cordis 门禁：inject [${reachable.join(', ')}] 均在真实 ctx 上可达，门禁通过——继续 apply/渲染/数据驱动渲染全套 VM 检测`)
    // 不 return：实验室模式继续深挖（③ apply → 渲染 → 数据驱动渲染）
  } else {
    // —— 注入服务门禁（三态近似，对齐官方 web 门禁 `assertEntriesActive`，web/src/boot.ts:149）——
    // 官方判据：`missing = Object.keys(fiber.inject).filter(s => ctx.get(s) === undefined)`；
    // 缺服务 ⇒ fiber 恒 pending，apply 永不执行；且 pending 会在 assertEntriesActive 里 **throw 打回整页**。
    // 三态分类依据两个集合：
    //   白名单(RELOAD_REACHABLE_SERVICES) = 官方源码采集的 provider 服务名 → 可达
    //   否认集(NON_INJECTABLE_CTX_METHODS) = cordis ctx 方法 → 硬不可达（恒 pending）
    //   两者皆非                                     → 未知服务名 → 保守放行但提示待核对
    // 基础模式：本门禁是最后一步，判定即返回，不深挖。
    const denied = declaredInject.filter((s) => NON_INJECTABLE_CTX_METHODS.has(s))
    const unknownGate = declaredInject.filter((s) => !RELOAD_REACHABLE_SERVICES.has(s) && !NON_INJECTABLE_CTX_METHODS.has(s))
    if (denied.length > 0) {
      // 硬阻断·服务门禁：这些名在官方 ctx 上是方法非服务，`ctx.get()===undefined` 恒成立，
      // 重载必挂 pending 且被 assertEntriesActive 打回整页。apply 不会执行 ⇒ 禁止深挖 apply。
      record('service-gate', false, `inject 含「不可注入的 ctx 方法」[${denied.join(', ')}]：重载将挂起(pending)等待它们，整页被门禁打回，apply 不执行`)
      return settle(true, false, `重载将挂起 pending (waiting for service: ${denied.join(', ')})，整页无法进入`, undefined, 'pending')
    }
    if (unknownGate.length > 0) {
      // 不确定服务名：可能是未采集到的真实服务(官方可达)，也可能拼错/不存在。放行但提示待核对。
      record('service-gate', true, `inject 含未命中白名单/否认集的服务名 [${unknownGate.join(', ')}]：无法确证可达，重载按其可达性判定`)
      return settle(true, true, undefined, [`inject 含未命中白名单/否认集的服务名 [${unknownGate.join(', ')}]：无法确证可达，基础模式仅做门禁、未深挖——如需全套 VM 检测请用实验室模式`])
    }
    record('service-gate', true, declaredInject.length > 0
      ? `inject 全部命中 web 可达服务集 [${declaredInject.join(', ')}]，门禁通过（基础模式仅做门禁，不深挖 apply/渲染）`
      : 'inject 为空（无注入服务），门禁通过（基础模式仅做门禁，不深挖 apply/渲染）')
    return settle(true, true)
  }

  // ③ apply(ctx)：两层核心，apply 抛错=「重载前端时」的根因
  const slotCount = { n: 0 }
  const totalSlots = { n: 0 }
  void slotCount; void totalSlots
  const renderTargets: Array<{ name: string; comp: unknown }> = []
  // 官方已声明的业务 slot key（证据：dsh-official deepseek-harness packages/client 各 ui-* 包 SlotMap merge 的高频引用，
  // 及 ui-slots src/index.ts「root 为 built-in single slot，业务禁注册」）。白名单的意义是**提示而非硬拦**：
  // 官方语义下 inject 一个未声明 key → callback 推迟且永不执行（界面永久不显示）、register 到未声明 slot → throw；
  // 但预检无法确知壳实际装载了哪些声明包，白名单可能不全，故对白名单外 key 采用「乐观执行 + 记录待核对」，
  // 宁可放行、不把干净插件误判为 crash。
  const slotDeclareNotes: string[] = []
  const KNOWN_SLOT_KEYS = new Set([
    'root', 'settings.section', 'settings.general', 'conversation.view', 'conversation.composer',
    'conversation.sidebar', 'shell.overlay',
  ])
  const noteUnknownSlotKey = (key: string, via: 'inject' | 'register'): void => {
    if (KNOWN_SLOT_KEYS.has(key)) return
    const where = via === 'inject' ? 'slots.inject 挂载链' : 'slots.register'
    if (key === 'root') {
      slotDeclareNotes.push(`业务插件 ${where} 到内置 'root' slot（官方仅壳可渲染 root，业务注册会遮蔽壳布局）——潜在界面破坏`)
    } else {
      slotDeclareNotes.push(`${where}依赖的 slot key "${key}" 未命中官方已知声明集：可能是拼错的 key，或依赖未装载的声明包（官方语义：该 slot 未声明时 register 会 throw、inject 的组件永不显示）`)
    }
  }
  // 官方「注册器类」服务（commandUi/inputTriggers）是数据规格、不承载 React 组件。mock 做「记录 + 必填校验 +
  // 同名 fail-loud + 返回 disposer」而非 recProxy 海绵——
  //   · 记录/必填：捕捉缺唯一标识字段这类使注册失效的缺陷（软提示，不误伤）；
  //   · 同名 fail-loud：捕捉「同一插件的 apply 内部同名重复注册」这真实易错场景（官方为 throw，重载会真实抛错）；
  //   · 返回 disposer：apply 依赖返回值的清理链不会被 mock 的 undefined 打断。
  //   同时为这两种服务提供对象，消除 apply 里 ctx.commandUi.register(...) 因 mock 缺服务而被误判 crash 的假阳性。
  //   key 槽位按服务独立（commandUi 的 name 与 inputTriggers 的 trigger 分属不同命名空间，不得互相对撞）。
  const makeRegistrar = (service: 'commandUi' | 'inputTriggers') => {
    const seen = new Set<string>()
    return (spec: unknown): (() => void) => {
      const s = typeof spec === 'object' && spec !== null ? spec as Record<string, unknown> : {}
      const key = typeof s['name'] === 'string'
        ? String(s['name'])
        : typeof (s as { trigger?: unknown })['trigger'] === 'string'
          ? String((s as { trigger: string })['trigger'])
          : undefined
      if (key === undefined) {
        slotDeclareNotes.push(`插件注册项缺少唯一标识字段（commandUi 用 name / inputTriggers 用 trigger，官方必填且唯一）——该项在真实重载中可能无法生效`)
      } else if (seen.has(key)) {
        throw new Error(`[${service}] 重复注册同名 "${key}"：官方同名校验为 fail-loud，重载时将在该项处抛错（同一 apply 内自撞，或与其它插件冲突）`)
      } else {
        seen.add(key)
      }
      return () => {}
    }
  }
  const mockCtx: Record<string, unknown> = {
    slots: {
      // 官方挂载链恒为 effect → slots.inject(key, cb) → slots.register。inject 须在「目标 slot 已声明」时
      // 执行 cb 才会触发注册；只计数不执行会把「按官方规范(inject 包 register)写的插件」整组漏检。
      inject: (key: string, cb: unknown): unknown => {
        slotCount.n++
        if (typeof key === 'string') noteUnknownSlotKey(key, 'inject')
        if (typeof cb !== 'function') return undefined
        const disposable = (cb as () => unknown)()
        return typeof disposable === 'object' && disposable !== null ? disposable : { unregister(): void {} }
      },
      register: (opts: { id?: string; name?: string }, comp: unknown) => {
        totalSlots.n++
        const key = opts?.name ?? opts?.id
        if (typeof key === 'string') noteUnknownSlotKey(key, 'register')
        if (typeof comp === 'function') renderTargets.push({ name: key ?? '?', comp })
        return { unregister(): void {} }
      },
    },
    effect: (fn: unknown) => { const d = (fn as () => unknown)(); return typeof d === 'function' ? d : () => {} },
    on: () => () => {},
    commandUi: {
      register: (spec: unknown) => makeRegistrar('commandUi')(spec),
      decorate: (spec: unknown) => makeRegistrar('commandUi')(spec),
      popupFor: () => ({ consume: (): void => {}, focusComposer: (): void => {}, dispose: (): void => {} }),
    },
    inputTriggers: {
      registerSource: (spec: unknown) => makeRegistrar('inputTriggers')(spec),
      sessionOf: () => ({ dispose: (): void => {} }),
    },
  }
  try {
    exportsObj.apply(mockCtx)
  } catch (error) {
    const detail = smokeErrToString(error)
    record('apply', false, `apply(ctx) 抛错 —— 重载前端时的根因（注入服务均可达，重载会真实触发）：${detail}`)
    return settle(true, false, `apply(ctx) 抛错：${detail.slice(0, 200)}`, undefined, 'crash')
  }
  record('apply', true, `apply(ctx) 成功执行${slotCount.n + totalSlots.n > 0 ? `，注册了 ${slotCount.n + totalSlots.n} 处界面 slot` : '（未注册任何 slot，可能无界面贡献）'}`)

  // ③.5 渲染挂载探测：把 apply 注册进 slots 的组件，用宿主真实 react-dom/server 渲染一遍。
  // 抓「渲染期空指针 / 组件自身崩溃」——这是真实「重载前端时白屏/报错」最常见的一类（渲染才触发、
  // apply 同步不触发），单凭前两步漏检。react-dom 从目标 profile 解析，与实际渲染端同源。
  const renderOrigin = resolveRenderOrigin(profileDir)
  if (renderTargets.length > 0) {
    const renderServer = renderOrigin?.reactDomServer as { renderToStaticMarkup?: (node: unknown) => string } | undefined
    const reactCt = renderOrigin?.react as { createElement?: unknown; useState?: (s: unknown) => unknown } | undefined
    if (!renderServer || typeof renderServer.renderToStaticMarkup !== 'function' || !reactCt || typeof reactCt.createElement !== 'function') {
      record('render', true, `共捕获 ${renderTargets.length} 个界面组件，但预检沙箱从 profile 解析不到 react-dom/server（跳过渲染探测）`)
    } else {
      let rendered = 0
      let skipped = 0
      let broken: { name: string; detail: string } | null = null
      // — react / react-dom 同源探针（防御）—
      // react 已锚定到 react-dom 的 origin（见 resolveRenderOrigin），正常必同源。保留最小 hooks 探针
      // 以防 origin 解析仍出现双副本：探针 useState=null ⇒ 非同源，中性跳过渲染探测，绝不把干净组件判 crash。
      let probeOk = true
      try {
        const probeType = () => { (reactCt as { useState?: (s: unknown) => unknown }).useState?.(0); return null }
        ;(renderServer.renderToStaticMarkup as (n: unknown) => string)((reactCt.createElement as (c: unknown) => unknown)(probeType))
      } catch { probeOk = false }
      if (probeOk) {
        for (const t of renderTargets) {
          if (typeof t.comp !== 'function') continue
          try { (renderServer.renderToStaticMarkup as (n: unknown) => string)((reactCt.createElement as (c: unknown) => unknown)(t.comp)); rendered++ } catch (error) {
            if (isBrowserEnvError(error)) { skipped++; record('render', true, `组件 "${t.name}" 渲染依赖浏览器 API（无头环境缺 ${error instanceof Error ? error.message : ''}），中性跳过`); continue }
            broken = { name: t.name, detail: smokeErrToString(error) }
            break
          }
        }
        if (broken) {
          record('render', false, `组件 "${broken.name}" 真实挂载渲染时崩溃——重载前端白屏/报错的直接根因：${broken.detail}`)
          return settle(true, false, `组件「${broken.name}」渲染挂载崩：${broken.detail.slice(0, 200)}`, undefined, 'crash')
        }
        record('render', true, `用宿主 react-dom 渲染 ${rendered}/${renderTargets.length} 个注册组件（${skipped > 0 ? `${skipped} 个需浏览器 API 已中性跳过` : '均无渲染期崩溃'}）`)
      } else {
        record('render', true, `共捕获 ${renderTargets.length} 个界面组件，但 profile 解析到的 react 与 react-dom 非同一副本（hooks 探针 useState=null，多为顶层缺 react-dom、server 溢出到壳/上级目录）。跳过渲染探测，避免把干净 hooks 组件误判为 crash——真实重载结果以渲染端为准。`)
      }
    }
  } else {
    record('render', true, 'apply 未向 slots 注册组件，跳过渲染探测')
  }

  // ③.5b 数据驱动渲染探测：renderToStaticMarkup 只能触发「首帧即崩」，抓不到「取数→setState→重渲染才崩」。
  // 用 react-test-renderer + act 驱动组件真实 挂载→异步取数→重渲染，捕获数据驱动的渲染崩溃。
  // 样本：调用方传 renderData 则按其给定样本（模拟真实后端/字段结构变更场景）；否则用默认样本（owner 为字符串，与
  // fixture 内核返回形态一致），使干净的记录页基线可正常渲染，而「把 owner 当对象解构」等数据形态变体在此崩溃。
  const driveLoaded = await driveRenderCrashes({
    code,
    profileDir,
    sampleData: renderData && renderData.length > 0 ? renderData : DEFAULT_RENDER_SAMPLE,
  })
  if (driveLoaded.crash) {
    record('data-render', false, `数据驱动渲染崩溃（取数/数据形态触发）：${driveLoaded.crash}`)
    return settle(true, false, `数据驱动渲染崩：${driveLoaded.crash.slice(0, 200)}`, undefined, 'crash')
  }
  if (driveLoaded.notes.length > 0) {
    driveLoaded.notes.forEach((note) => record('data-render', true, note))
  } else {
    record('data-render', true, '数据驱动渲染无异常（挂载→取数→重渲染均未崩）')
  }

  // ④ slot 声明语义提示：白名单外 slot key 或 root 滥用，官方语义下会导致组件永不显示 / 遮蔽壳布局。
  // 定位信息上报但不阻断（outcome 自动 'warn'，ok=true），避免白名单不全时误伤干净插件。
  if (slotDeclareNotes.length > 0) {
    slotDeclareNotes.forEach((note) => record('slot-declare', true, note))
    return settle(true, true, undefined, slotDeclareNotes)
  }

  return settle(true, true)
}

/** 数据驱动渲染探测的默认样本：字段形态与 fixture 内核返回一致（owner 为字符串、含 id/title/status/ts）。
 * 干净的记录页基线渲染 `r.owner`（字符串）正常；而「把 owner 当对象解构 owner.name」等数据形态变体会在取数重渲染时崩。 */
const DEFAULT_RENDER_SAMPLE: unknown[] = [
  { id: 1, title: '接入飞书桥', status: 'done', owner: 'alice', ts: 1710000000000 },
  { id: 2, title: '打通 QQ 网关', status: 'live', owner: 'bob', ts: 1710100000000 },
  { id: 3, title: '预检报告接管命令行', status: 'dev', owner: 'carol', ts: 1710200000000 },
  { id: 4, title: '三态门禁落地', status: 'todo', owner: 'alice', ts: 1710300000000 },
]

/** 数据驱动渲染探测（异步、realm 隔离）。render-drive.mjs 实测结论为硬性前提：
 *  - 组件自由变量 `fetch` 解析到「其定义 sandbox 的全局对象」→ 驱动 sandbox 必须让全局自身持有 fetch，
 *    不得把 globalThis/global/self 指向不含 fetch 的扁平对象，否则取数静默失败 → 假阴性漏检。
 *  - 标准 Web API（URL/URLSearchParams/TextEncoder/AbortController）缺失会让取数在构造 query 时崩。
 *  - react-test-renderer 对渲染错误是 unmount root + console.error，而非外抛到 act → 必须包 ErrorBoundary。
 *  - 取数→setState→重渲染须整体放在单个 async act 内才会被 flush。
 * 返回 { crash }：crash=渲染崩溃描述；null = 渲染无异常。notes 供中性说明。 */
async function driveRenderCrashes(p0: {
  code: string
  profileDir?: string
  sampleData: unknown[]
}): Promise<{ crash: string | null; notes: string[] }> {
  const notes: string[] = []
  if (!p0.profileDir) return { crash: null, notes: [...notes, '无 profileDir，跳过数据驱动渲染探测'] }
  let baseReq: ((id: string) => unknown) | null = null
  try { baseReq = createRequire(join(p0.profileDir, 'package.json')) } catch { baseReq = null }
  if (!baseReq) return { crash: null, notes: [...notes, 'profile 依赖解析不可用，跳过数据驱动渲染探测'] }
  // 组件的 react 必须与 react-test-renderer 内部的 react 是同一份：hooks dispatcher 是 react 模块级单例，
  // 跨副本必分离 → 干净组件也报 `Cannot read properties of null (reading 'useState')`（实测 5 个 fixture 全崩的假阳性）。
  // 故 react 与 renderer 统一从 profile「同根」解析（baseReq），**不可**复用 resolveRenderOrigin 锚定的 react——
  // 那是与 react-dom/server 同源，可能与 profile react 构成双副本，让 react-test-renderer 与组件分属不同 hooks 上下文。
  let react: any
  try { react = baseReq('react') as never } catch { react = undefined }
  let renderer: { act?: (...a: unknown[]) => unknown; create?: (n: unknown) => { toJSON(): unknown } } | undefined
  if (baseReq) { try { renderer = (baseReq('react-test-renderer') as never) as typeof renderer } catch { renderer = undefined } }
  if (!react || typeof react.createElement !== 'function' || typeof react.Component !== 'function' ||
      !renderer || typeof renderer.create !== 'function' || typeof renderer.act !== 'function') {
    return { crash: null, notes: [...notes, 'profile 缺 react-test-renderer/同源 react（需 react@18.3.1 + react-test-renderer@18.3.1），跳过数据驱动渲染探测'] }
  }
  const jsxRuntime = { jsx: react.createElement, jsxs: react.createElement, Fragment: react.Fragment }
  const bound = { err: null as unknown | null }
  type BoundaryBase = new (props: { children?: unknown }) => { props: { children?: unknown } }
  const CompBase = react.Component as unknown as BoundaryBase
  const Boundary = class extends CompBase {
    // react-test-renderer 对渲染错误是 unmount root + console.error 而非外抛到 act，必须包 ErrorBoundary 捕获
    componentDidCatch(err: unknown): void { bound.err = err }
    render(): unknown { return this.props.children }
  }
  // 宿主驱动的渲染工厂：注入 __host，供驱动脚本在沙箱内物化出组件后调用（参数为组件构造器）
  const drive = async (comp: unknown): Promise<{ crash: string | null; state: string }> => {
    let snapshot: { toJSON(): unknown } | null = null
    bound.err = null // 每次重新挂载前清空边界捕获，避免上一次的崩污染本次判定
    try {
      await (renderer!.act as (cb: () => unknown) => unknown)(async () => {
        snapshot = renderer!.create!(react.createElement(Boundary, null, react.createElement(comp)))
        await new Promise((r) => setTimeout(r, 250))
      })
    } catch (err) {
      const msg = err instanceof Error ? `${err.constructor.name}: ${err.message.split('\n')[0]}` : String(err)
      return { crash: msg, state: 'act-throw' }
    }
    if (bound.err) {
      const e = bound.err as Error
      return { crash: e instanceof Error ? `${e.constructor.name}: ${e.message.split('\n')[0]}` : String(e), state: 'boundary' }
    }
    let text = ''
    try { text = JSON.stringify(snapshot?.toJSON()) } catch { /* 序列化失败不阻断 */ }
    const state = /加载中/.test(text) ? 'loading' : /暂无记录/.test(text) ? 'empty' : /加载失败/.test(text) ? 'error' : /rows/.test(text) ? 'rows' : 'ok'
    return { crash: null, state }
  }
  // 沙箱桥最小面：被预检的是未信任代码，沙箱内只暴露驱动必需的 makeShim/drive（react/jsxRuntime 留闭包内），
  // 冻结防篡改。驱动串对 __host 的全部消费即 factory(__host.makeShim()) 与 __host.drive(comp)。
  const driveHost = Object.freeze({
    makeShim: () => (id: string): unknown => {
      if (id === 'react') return react
      if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return jsxRuntime
      return recProxy()
    },
    drive,
  })
  // 驱动沙箱：全局自身持有 fetch stub + Web API + __host；window/self/global 自引用到「含 fetch 的沙箱自身」
  const stubFetch = async (input: string | URL): Promise<unknown> => {
    const u = String(input)
    if (u.includes('/list') || u.includes('list')) {
      // 落地网络层失败大类型的两种注入（与夹具形态无关，普适）：
      //   ok       200 + 正常数据（数据形态崩溃检测）
      //   http500  HTTP 错误体（fetch resolve 但 res.ok=false）→ 判「未校验 res.ok 就消费/吞错」
      //   network  fetch 传输层 reject（抛 TypeError）→ 判「promise rejection 未处理 / 没接 catch」
      ;(sandbox as { __listCalls: number }).__listCalls++
      const mode = (sandbox as { __failMode?: 'ok' | 'http500' | 'network' }).__failMode || 'ok'
      if (mode === 'network') throw new TypeError('Failed to fetch (network)')
      if (mode === 'http500') return { ok: false, status: 500, json: async () => ({ ok: false, code: 500, message: 'internal error' }) }
      return { ok: true, status: 200, json: async () => ({ total: p0.sampleData.length, page: 1, pageSize: p0.sampleData.length || 4, list: p0.sampleData }) }
    }
    if (u.includes('/upsert')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    return { ok: false, status: 404, json: async () => ({ ok: false }) }
  }
  const sandbox: Record<string, unknown> = {
    window: null,
    __failMode: 'ok',
    __listCalls: 0,
    __ModuleLoader__: { pendingQueue: [], load(reg: unknown): void { (this.pendingQueue as unknown[]).push(reg) } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: stubFetch,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    crypto,
    requestAnimationFrame: sandboxRaf,
    cancelAnimationFrame: sandboxCraf,
    performance: { now: () => Date.now(), timeOrigin: Date.now() },
    __host: driveHost,
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.global = sandbox
  sandbox.globalThis = sandbox
  try { vm.runInNewContext(p0.code, sandbox, { filename: 'data-drive' }) } catch (err) {
    return { crash: null, notes: [...notes, `驱动沙箱求值抛错（${err instanceof Error ? err.message : String(err)}），跳过数据驱动`] }
  }
  const pending = (sandbox.__ModuleLoader__ as { pendingQueue: unknown[] }).pendingQueue
  if (pending.length !== 1) return { crash: null, notes: [...notes, `驱动沙箱 load 次数 != 1（${pending.length}），跳过数据驱动`] }
  const factory = (pending[0] as { factory?: unknown }).factory
  const driverCode = `
    /* diag:skip */
    (async () => {
      const factory = window.__ModuleLoader__.pendingQueue[0].factory
      const exp = factory(__host.makeShim())
      if (typeof exp.apply !== 'function') return { crash: null, state: 'no-apply' }
      let comp
      // 与 clientSmokeTest 同律：slots.inject 执行 cb；commandUi/inputTriggers 提供「记录+同名 fail-loud+disposer」，
      // 否则 apply 里 ctx.commandUi.register(...) 会因 mock 缺服务(undefined) 把干净插件误判 crash。
      const registrar = (service) => { const seen = new Set(); return (spec) => {
        const s = spec && typeof spec === 'object' ? spec : {}
        const key = typeof s.name === 'string' ? s.name : typeof s.trigger === 'string' ? s.trigger : undefined
        if (key === undefined) return () => {}
        if (seen.has(key)) throw new Error('[' + service + '] 重复注册同名 "' + key + '"：官方同名校验 fail-loud')
        seen.add(key)
        return () => {}
      } }
      const mockCtx = {
        slots: {
          // 与 clientSmokeTest 同律：inject 按官方「目标 slot 已声明」语义执行 cb（内部会 register→捕获组件），
          // 否则官方 effect→inject→register 写法在数据驱动沙箱里也整组漏检（comp 恒 undefined）。
          inject: (k, cb) => { if (typeof cb !== 'function') return undefined; const d = cb(); return d || { unregister(){} } },
          register: (o, c) => { comp = c; return { unregister(){} } },
        },
        effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {} },
        on: () => () => {},
        commandUi: { register: registrar('commandUi'), decorate: registrar('commandUi'), popupFor: () => ({ consume(){}, focusComposer(){}, dispose(){} }) },
        inputTriggers: { registerSource: registrar('inputTriggers'), sessionOf: () => ({ dispose(){} }) },
      }
      try { exp.apply(mockCtx) } catch (err) { return { crash: 'apply抛错: ' + String(err && err.message || err), state: 'apply' } }
      if (typeof comp !== 'function') return { crash: null, state: 'no-component' }
      // 三档驱动：① 成功样本（数据形态崩溃检测）；② HTTP 500 注入（fetch resolve 但 res.ok=false）→ 判定未校验 res.ok 的消费/吞错形态（B2/B3）；
      // ③ 传输层 rejection 注入（fetch 抛 TypeError）→ 借隔离窗内出现的未处理 Promise rejection 判定漏接 catch（B1）。
      const a = await __host.drive(comp)
      const callsA = window.__listCalls
      window.__failMode = 'http500'
      const http500 = await __host.drive(comp)
      window.__failMode = 'network'
      const network = await __host.drive(comp)
      return { crash: a.crash, state: a.state, http500, network, callsA }
    })()
    /* /diag:skip */
  `
  // 隔离窗口：临时接管宿主进程的 rejection/uncaught——带缺陷客户端（如 B1 无 catch）会产生未消费的 promise
  // rejection，直接冒到宿主级 unhandledRejection 会打崩桌面壳（实测会把承载 verifyClient 的壳进程整个退出）。
  // 同时把「未处理的 Promise rejection」本身作为通用大类信号捕获：任何 promise 链漏接 catch 的插件都会触发，
  // 按事件检测而非按具体语法，普适且与具体报错无关。
  const hushed = { rejections: [] as unknown[], uncaught: [] as unknown[] }
  const savedRej = process.listeners('unhandledRejection')
  const savedErr = process.listeners('uncaughtException')
  const isolation = (on: boolean): void => {
    process.removeAllListeners('unhandledRejection')
    process.removeAllListeners('uncaughtException')
    if (on) {
      process.on('unhandledRejection', (r) => { hushed.rejections.push(r) })
      process.on('uncaughtException', (e) => { hushed.uncaught.push(e) })
    }
    else {
      for (const l of savedRej) process.on('unhandledRejection', l as (...a: unknown[]) => void)
      for (const l of savedErr) process.on('uncaughtException', l as (...a: unknown[]) => void)
    }
  }
  isolation(true)
  try {
    const res = (await vm.runInContext(driverCode, sandbox)) as {
      crash: string | null; state: string
      http500?: { crash: string | null; state: string }
      network?: { crash: string | null; state: string }
      callsA?: number
    }
    if (res?.crash) return { crash: res.crash, notes }
    // 组件在成功样本下根本没发起数据源(list)请求（如纯静态卡片、无取数逻辑）→ 错误注入无意义，中性跳过，不报「疑似吞错」噪音。
    if (!res?.callsA) return { crash: null, notes: [...notes, '组件未发起数据源(list)请求，跳过错误注入'] }
    const h500 = res?.http500
    const net = res?.network
    // ① 未处理的 promise rejection → B1（promise 链漏接 catch，网络失败不被消费而冒到宿主级）。http500/network 任一触发均归因到此。
    const rejections = hushed.rejections.length
    if (rejections > 0) notes.push(`监测到 ${rejections} 次未处理的 Promise rejection——异步错误链漏接 catch（B1，fetch 失败未被消费成 rejection），请人工核验`)
    if (hushed.uncaught.length > 0) notes.push(`监测到 ${hushed.uncaught.length} 次未捕获的异常（uncaughtException），请人工核验`)
    // ② HTTP 500 注入 → 错误路径是否被可靠处理：崩=错误路径未兜底；error 态=干净；非 error 态=疑似吞错/无反馈（B2/B3）。
    if (h500?.crash) return { crash: `异常响应（http500 注入）下组件崩溃——错误路径未可靠处理：${h500.crash}`, notes }
    if (h500?.state === 'error') {
      if (rejections === 0) notes.push('错误注入(http500)：组件进入错误态，错误路径处理正常')
    } else {
      notes.push(`错误注入(http500)：组件未进入错误态(state=${h500?.state ?? '?'})${rejections > 0 ? '（且已归因到 B1 未处理 rejection）' : '——疑似未校验 res.ok，把失败当成功/空渲染（B2 无反馈 / B3 当空吞），请人工核验'}`)
    }
    // ③ 传输层 rejection 注入自身若仍驱动崩溃（罕见）单独上报。
    if (net?.crash) notes.push(`网络注入(rejection)下组件仍崩溃：${net.crash}，请人工核验`)
    return { crash: null, notes }
  } catch (err) {
    return { crash: null, notes: [...notes, `数据驱动探测抛错（${err instanceof Error ? err.message : String(err)}），跳过`] }
  } finally {
    isolation(false)
  }
}

