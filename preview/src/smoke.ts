/** 无头冒烟预检引擎（verifyClient/tempLoad 共用的预检入口）。
 * 从 index.ts 抽出（P2 拆分）：纯函数区——client 产物探测、入口契约检测、注入服务门禁。
 * 不持有任何模块级可变状态（原 locateClientRoots 对 tempInfos 的访问已参数化为 tempSpec）。
 *
 * 预检语义（演进：砍掉 VM mock 深挖，收敛为「真实 cordis 门禁」，真实运行判定交 guard 式探针兜底）：
 *   - 只在 kernel 进程里「读 + 求值 + 物化」client bundle 以判定**装配契约**（load 注册单例、factory 导出 apply/inject），不 mock 运行；
 *   - 注入服务可达性用**真实 @deepseek-ai/cordis 的 ctx.get()** 判定（对齐 web/src/boot.ts:149），
 *     cordis 无法从 profile 解析时回退三态近似（可达白名单 + 否定集）；
 *   - 不再执行 apply(ctx)/渲染/数据驱动的 VM 深挖——那些是虚构 mock 环境，保真度差且误伤干净插件；
 *     「真实是否崩溃」交给独立子进程的真实试运行（guard 式启动级探针，见文档「真实探针兜底」）。
 */

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
// 目标：在运行前（不依赖桌面渲染端是否在跑）可感知地发现「热注入没问题、但重载前端就崩/挂」的插件。
// 原理：在 Node/kernel 进程里读 + 求值该插件已装入的 client bundle，判定——
//   ① load 注册（window.__ModuleLoader__.load 是否按契约注册单例 entry）
//   ② factory 物化 + 导出形状（能否读出 apply/inject，供门禁取 inject 名）
//   ③ 注入服务门禁（真实 cordis ctx.get 判定 inject 可达性；不可解析回退三态近似）
// 任一环失败即返回带分步原因的诊断，供刷新界面预检 / 热装源头提示。
//
// 已明确不做：不 mock 运行 apply(ctx)、不真实挂载渲染、不数据驱动渲染——保真度低且误伤干净插件。
// 真实运行判定（是否在真实重载/启动时崩）交给独立的 guard 式启动级探针（外部子进程试运行 + 心跳回滚）。
// ---------------------------------------------------------------------------
interface SmokeStepOutcome { name: string; ok: boolean; detail: string }

/** 预检结局类别（reloadClient 按此分级渲染，避免把"必挂起"错标成"崩溃"）。
 *  - 'pending'：重载必挂起等待服务、apply 不执行，整页被门禁打回，但**非崩溃**（fixture 属于此类）。
 *  - 'crash' ：注入可达、重载会真实执行，因加载/物化抛错而**真实崩溃**（产物坏/契约不符）。
 *  - 'volatile'：产物缺失/读取失败/未导出 apply/契约不符等"缺东西"，重载行为不稳定，非崩溃但异常。
 *  - 'warn'  ：可安全重载，但存在应知晓的非阻塞提示（门禁近似判定、被门禁屏蔽的潜在缺陷）。
 *  - 'pass'  ：重载安全无任何提示。
 *  ok 仅表示"能否安全 reload"（pending/crash/volatile=false；warn/pass=true），
 *  精确结局由 outcome 表达，前端按 outcome 分组并从'crash'/'pending'得出阻断分组标题。 */
type SmokeOutcome = 'pending' | 'crash' | 'volatile' | 'warn' | 'pass'

export interface ClientSmokeReport {
  name: string
  declared: boolean
  ok: boolean
  /** 预检结局类别，前端分组依据（见 SmokeOutcome 释义）。 */
  outcome: SmokeOutcome
  steps: SmokeStepOutcome[]
  /** 顶层失败原因（steps 里亦有对应 err 步）。 */
  error?: string
  /** 不打断重载、但应关注的非阻塞警告：真实重载会按 cordis 语义挂起等待的注入服务、门禁近似判定的未知服务名等。 */
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
 * 语义：真实 cordis 可解析时本集合仅作为「可注册的注入 Service 名义集」喂给真门禁；不可解析时退化为近似可达面。 */
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
 * 本集只在「真实 cordis 不可解析、仅作三态近似」时用于区分「硬不可达」与「未知名」，其余走真门禁。 */
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
  // 两副本 ReactCurrentDispatcher 分离 ⇒ 干净 hooks 组件也假阳性崩（物化 factory 读导出形状时的执行参照）。
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
 * 真实渲染端插件组件本就解析到壳 react，故统一从 react-dom/server 所在目录反推其兄弟 react，保证同源，
 * 使 factory 物化/导出形状判定不被双副本 hooks 假阳性干扰。 */
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

/** 无头冒烟预检一个插件的 client bundle（装配契约 + 注入服务门禁）。不依赖桌面渲染端是否在跑。 */
export async function clientSmokeTest(packageName: string, candidateRoots: string[], profileDir?: string): Promise<ClientSmokeReport> {
  const steps: SmokeStepOutcome[] = []
  const record = (name: string, ok: boolean, detail: string): void => { steps.push({ name, ok, detail }) }
  /** settle 统一出口。outcome 缺省时按 ok 自动推导：ok=false→'volatile'（具体由调用点覆盖为 crash/pending）；ok=true+无warns→'pass'、有warns→'warn'。 */
  const settle = (declared: boolean, ok: boolean, error?: string, warns?: string[], outcome?: SmokeOutcome): ClientSmokeReport => {
    const resolved: SmokeOutcome = outcome ?? (ok ? (warns && warns.length > 0 ? 'warn' : 'pass') : 'volatile')
    return { name: packageName, declared, ok, outcome: resolved, steps, error, warns }
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

  // ② factory 物化 + 导出形状（读出 apply/inject，供门禁取 inject 名；不执行 apply）
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

  // ③ 注入服务门禁（真实 cordis 优先，回退三态近似）
  // 真 cordis：用真实 @deepseek-ai/cordis 的 ctx.get() 判定 inject 可达性（对齐 web/src/boot.ts:149），
  //   `effect/on/…/拼错的服务名` 由真门禁自然判 pending，否定集可删。
  // 真 cordis 不可从 profile 解析 → 回退三态近似：可达白名单 + 否定(方法名)集，未知名放行提示待核对。
  // 这里即预检终点，**不再 mock 运行 apply/渲染/数据驱动渲染**——真实是否崩溃交给 guard 式独立探针。
  const declaredInject = Array.isArray(exportsObj.inject) ? exportsObj.inject
    : exportsObj.inject && typeof exportsObj.inject === 'object'
      ? Object.keys(exportsObj.inject as Record<string, unknown>)
      : []
  const gate = realCordisGate(profileDir, declaredInject, [...RELOAD_REACHABLE_SERVICES])
  const missing = gate.missing
  if (missing.length > 0) {
    if (gate.usedReal) {
      record('service-gate', false, `真实 cordis 门禁：inject [${missing.join(', ')}] 在真实 ctx 中不是可注入 Service → 重载将挂起(pending)等待它们，整页被门禁打回，apply 不执行`)
      return settle(true, false, `重载将挂起 pending (waiting for service: ${missing.join(', ')})，整页无法进入`, undefined, 'pending')
    }
    // 近似回退：否认集(方法名)→硬不可达判 pending；其余未知名→放行但提示待核对。
    const denied = missing.filter((s) => NON_INJECTABLE_CTX_METHODS.has(s))
    const unknown = missing.filter((s) => !NON_INJECTABLE_CTX_METHODS.has(s))
    if (denied.length > 0) {
      record('service-gate', false, `近似门禁：inject 含「不可注入的 ctx 方法」[${denied.join(', ')}]（profile 解析不到真实 cordis，按否定集判定）→ 重载将挂起(pending)，整页被门禁打回，apply 不执行`)
      return settle(true, false, `重载将挂起 pending (waiting for service: ${denied.join(', ')})，整页无法进入`, undefined, 'pending')
    }
    if (unknown.length > 0) {
      record('service-gate', true, `近似门禁：inject 含未命中可达集的名称 [${unknown.join(', ')}]（profile 解析不到真实 cordis，仅近似判定）——无法确证可达`)
      return settle(true, true, undefined, [`profile 无法解析真实 cordis，已按近似门禁放行未知服务名 [${unknown.join(', ')}]——重载按其真实可达性判定`])
    }
  }
  record('service-gate', true, declaredInject.length > 0
    ? (gate.usedReal
        ? `真实 cordis 门禁：inject [${declaredInject.join(', ')}] 均在真实 ctx 上可达，门禁通过`
        : `近似门禁：inject 全部命中可达服务集 [${declaredInject.join(', ')}]（profile 解析不到真实 cordis，近似判定），门禁通过`)
    : (gate.usedReal
        ? 'inject 为空（无注入服务），真实 cordis 门禁通过'
        : 'inject 为空（无注入服务），近似门禁通过'))
  return settle(true, true)
}