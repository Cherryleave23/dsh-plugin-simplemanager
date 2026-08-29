/**
 * dsh-plugin-simplemanager — 插件管家（host 侧入口）。
 * 通过 webServer 暴露 `/simplemanager` 数据/操作 API 给桌面壳内 client 面板：
 *   - kernel   ：内核版本（只读当前版本，不联网）
 *   - browse   ：完整状态（内核 + 文件夹 + 插件状态 + 依赖 + 备注），client 首载
 *   - toggle   ：启停第三方插件（写 profile patch 装配层 + 对运行 entry update({disabled}) 立即热生效）
 *   - tempLoad / tempRemove / promote ：运行时热插拔 + 转真注入
 *   - uninstall：真卸载（移除磁盘包 + 依赖闭包 + 装配登记 + 自持数据）
 *   - refresh  ：重新扫描已安装插件（安装/卸载后可手动刷新）
 *   - folders / move ：自定义文件夹分组管理
 *   - note / rename / scope ：插件备注 / 显示名 / 作用域覆盖
 */
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  SimpleManagerHost,
  type Overlay,
  type PluginBundle,
  type PluginScope,
  effectiveFolder,
  isOfficialSystemDep,
} from './host.js'
import { pnpmAdd, pnpmRemove, specPackageName, verifyInstalled } from './pnpm.js'
import { detectClientArtifact, detectOfficialPeerDeps, locateClientRoots } from './smoke.js'
import { runProbe, describeOutcome, type ProbeCandidate, type ProbeOptions, type RunProbeResult } from './probe.js'
import { evictPackageModuleCaches } from './module-cache.js'
import { registerAgentTools, type AgentOps, type OpResult, type OpStep, type ProbeDTO, type ReloadClientDTO, type StatusDTO } from './agent-tools.js'

export const name = 'dsh-plugin-simplemanager'

export const inject = ['webServer', 'loader', 'skills']

/** DSH Desktop 宿主公开的 desktopProfiles 服务最小类型面（只读探测用）。 */
interface DesktopProfiles {
  readonly current: { readonly name: string; readonly dir: string }
}

/** 官方 Cordis 核心 loader 服务最小类型面（读 entries + 写 create/remove/update，与 EntryTree 生命接口对齐）。 */
interface LoaderService {
  create(options: { name: string; config?: Record<string, unknown>; disabled?: boolean }, parent?: string | null): Promise<string>
  remove(id: string): Promise<void>
  /** 差异化热更新入口：改 disabled 走 dispose/重建，改 config 走原地热更新。 */
  update(id: string, options: { disabled?: boolean; name?: string; config?: Record<string, unknown> }): Promise<void>
  /** 按 entryId 反查 entry 节点（读 fiber 状态供观测）。create 的 promise 已 await 装配/apply（apply 失败即 reject，
   * 根因在 error.cause 链），故此处仅用于成功后的运行态观测，不做失败判定。 */
  resolve?(id: string): { fiber?: { state?: number } | null }
  entries(): Iterable<{ id?: string; options?: { name?: string; group?: boolean }; disabled?: boolean; fiber?: { state?: number } | null }>
  /** Node 内部模块加载器（官方 HMR 同款缓存驱逐钥匙；v1=Node 22/23、v2=Node 24+）。宿主经
   * node-addon-require-builtin 暴露时可用；不可用时 tempLoad 的模块缓存驱逐静默降级为现状。 */
  internal?: { version?: 'v1' | 'v2'; loadCache?: unknown }
}

/** 本插件消费的官方 service 最小类型面。inject 只声明全环境通用的核心服务（webServer / loader）；
 * 宿主专属能力（desktopProfiles、pluginInventory）走 ctx.get 动态探测（§5 host-specific capabilities 动态探测）。 */
type AppContext = Context & {
  webServer: {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => void
  }
  loader: LoaderService
}

/** Cordis FiberState 数字枚举 → 人类可读 phase（PENDING=0…UNLOADING=5，DISPOSED=4）。 */
const FIBER_PHASE = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const
type FiberPhaseName = 'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading' | null

/** loader 存活态的捕获：enabled + fiberPhase（active/failed/pending…）。 */
interface LoaderLive {
  enabled: boolean
  phase: FiberPhaseName
  /** loader 树内的 entry id，供 update({ disabled }) 热启停定位。无则 undefined。 */
  entryId?: string
}

interface FoldersView {
  id: string
  name: string
  kind: 'official' | 'third' | 'custom'
  count: number
  /** 作用域：shared=插件管理+工具管理双边可见；tool=仅工具管理可见（自定义 folder 有效；内置 official/third 恒为 shared）。 */
  scope: 'shared' | 'tool'
}

interface BrowseView {
  kernel: { current: string | null; source: string }
  folders: FoldersView[]
  plugins: PluginView[]
}

/** 来源轴（唯一状态轴，标准 = 真实装配数据）。优先级：scope → 会话热装 → 持久层 → 物理残留。 */
type PluginSource = 'official' | 'shell' | 'temporary' | 'persistent' | 'orphan'
/** 运行态 chip（标准 = loader entry.enabled + fiber.phase）。 */
type PluginRuntime = 'active' | 'disabled' | 'failed' | 'pending' | 'loading' | 'disposed' | 'unloading' | 'none'

interface PluginView {
  name: string
  version: string
  description: string
  scope: 'official' | 'shell' | 'third'
  /** 来源轴：official/shell=内核与壳；temporary=本会话热装（重启即消失）；persistent=patch∪bundle 命中（跨重启存活）；
   * orphan=物理在但无持久层/热装（残留隔离，不可启停、只能清理或重装）。 */
  source: PluginSource
  /** 启停真值（官方/壳无运行时默认 true；第三方回落持久层）。供 toggle/aria 用。 */
  enabled: boolean
  /** 运行态：active/loading/pending 对应活态；disabled=已停用；failed/…=fiber phase；none=无 runtime entry（未装配）。 */
  runtime: PluginRuntime
  folder: string
  /** 用户备注（overlay.notes）。 */
  note: string
  /** 用户自定义显示名（缺省则用 name，UI 层兜底）。 */
  alias: string
  /** 插件自身声明的依赖（name@range）；临时插件为本次补装的闭包依赖。点击卡片展开可见。 */
  dependencies: string[]
  /** 状态框可点击启停（官方/壳 + 孤儿为 false）。 */
  toggleable: boolean
  /** 显示「卸载」/「清理」动作按钮（持久第三方 → 卸载；孤儿 → 清理）。 */
  removable: boolean
  /** 显示「转正」（仅临时）。 */
  promoteable: boolean
  /** 显示「✕」临时卸载（仅临时）。 */
  tempRemoveable: boolean
  /** 「转正·待重启」注记（promotedPending 命中，仅会话内）。 */
  pendingRestart: boolean
}

export function apply(ctx: AppContext): void {
  // MAX/MIN 语义：patch 只是"当前是否加入启用清单"，与内核无关。
  const profileDir = resolveProfileDir(ctx)
  const host = new SimpleManagerHost(profileDir, join(homedir(), '.dsh', 'simplemanager'))

  // 启动清理热装物理残留（P-033）：热装 tempLoad 会真实 pnpmAdd 进 profile node_modules，但临时语义
  // 「重启即消失」不止登记装配、也必须回收物理包，否则残留污染目录扫描列表。仅回收「记录在 hotInstalls、
  // 当前不在装配中」的残留，绝不动源码目录。启动后延后执行，等装配定型再判断。
  const cleanupHotResidue = (): void => {
    const resign = async (c: AppContext, h: SimpleManagerHost): Promise<void> => {
      try {
        const still = new Set<string>()
        for (const [, info] of tempInfos) still.add(specPackageName(info.spec) ?? info.spec)
        const patchEnabled = h.readPatchEnabledIds()
        const bundles = h.readBundles()
        const live = loaderLiveMap(c)
        for (const pkg of h.readHotInstalls()) {
          // 正在装配（在 live 存活态 / patch 启用 / bundles 清单）或本会话仍临时持有 → 不是残留，跳过。
          if (live.has(pkg) || patchEnabled.has(pkg) || bundles.has(pkg) || still.has(pkg)) {
            h.forgetHotInstall(pkg)
            continue
          }
          if (h.profileDir) {
            await pnpmRemove(h.profileDir, pkg).catch(() => { /* 清理尽力而为，失败不阻断 */ })
          }
          h.forgetHotInstall(pkg)
        }
        // P-052 兜底：清空热装换键副本目录 .dsh-hot（该目录专放同名热装的临时副本，仅服务于当次热装，
        // 重启后必不在装配；tempRemove 已删的部分这里再兜底一次，保证零残留且不碰源码目录）。
        if (h.profileDir) {
          const hotRoot = join(h.profileDir, '.dsh-hot')
          try { rmSync(hotRoot, { recursive: true, force: true }) } catch { /* 兜底尽力而为 */ }
        }
      } catch { /* 启动清理失败不影响宿主启动 */ }
    }
    void resign(ctx, host).then(() => {}, () => {})
  }
  setTimeout(cleanupHotResidue, 4000)

  // 启动统一对账「已 bundle 装配却残留在 patch 的条目」：这类第三方经官方 `dsh plugin add` 升级为
  // bundle 层装配（cordis.yml / dsh.profile.bundles）后，patch 里旧 insert 即冗余双重登记，会与 bundle 层
  // 组合成 `duplicate loader entry id`（历史 P-014 同款）。此前仅 toggle 时惰性清理（下次拨开关才触发），
  // 残留可能长期留存；启动即全量对账回收一次，从源头杜绝重复装配。只清 bundle 化条目，绝不碰 patch 装配的第三方。
  const reconcilePatchResidual = (): void => {
    try {
      for (const id of host.readPatchEnabledIds()) {
        if (host.isBundleAssembled(id)) host.setPatchEnabled(id, id, false)
      }
    } catch { /* 对账失败不影响宿主启动 */ }
  }
  setTimeout(reconcilePatchResidual, 5000)

  // —— 面向 agent 的闭环工具注册（v6）——
  // DSH 进程内 agent 只能调用 ctx.tools.register 注入的工具。registerAgentTools 内部用 ctx.get('tools')
  // 动态探测：仅在有 tools 服务的宿主注册，无 agent 场景静默跳过、不改加载行为。注册即 effect（返回 disposer）。
  ctx.effect(() => {
    const disposers = registerAgentTools(ctx, makeAgentOps(ctx, host))
    // 随包内嵌「pm-manage」skill：agent 需要插件热装调试时按需读取，平时不加载详参（渐进披露）。
    // 宿主 AppContext 类型未声明 skills，此处运行时收窄；无该服务的宿主优雅跳过，不改加载行为。
    const skillService = (ctx as unknown as { skills?: { register(_s: unknown): () => void } }).skills
    if (skillService?.register) {
      const skillDir = dirname(fileURLToPath(import.meta.url))
      let skillContent = ''
      try { skillContent = readFileSync(join(skillDir, 'skill', 'main.md'), 'utf8') } catch { /* 缺文件则降级为空内容 */ }
      disposers.push(skillService.register({
        name: 'pm-manage',
        description: '当需要临时热装/同名重装第三方插件取新代码进行调试、热卸、转正、卸载、热装前预检，或刷新界面让新的插件前端对用户可见时，读取本指南按正确顺序编排 pm_* 工具。',
        whenToUse: '要动 pm_* 插件的生命周期（热装/热卸/转正/卸载/预检）或刷新前端时',
        source: 'dsh-plugin-simplemanager',
        content: skillContent,
        resourceBase: { kind: 'directory', path: join(skillDir, 'skill') },
        invocation: { modelInvocable: true, userInvocable: false },
      }))
    }
    return () => { for (const d of disposers) d() }
  })

  const buildView = (): BrowseView => {
    const overlay = host.readOverlay()
    const catalog = buildCatalog(ctx, host)
    const patchEnabled = host.readPatchEnabledIds()
    const live = loaderLiveMap(ctx)

    // 来源轴 + 运行态（标准 = 真实装配数据，见 PluginView 注释）。判断顺序：scope → 会话热装 → 持久层 → 物理残留。
    const sourceOf = (b: PluginBundle): PluginSource => {
      if (b.scope !== 'third') return b.scope
      if (tempInfos.has(b.name)) return 'temporary'
      if (patchEnabled.has(b.name) || host.isBundleAssembled(b.name)) return 'persistent'
      return 'orphan'
    }

    // 「本进程替身」判定：某运行时 entry 名 = <逻辑名>-hotN，且逻辑名已持久化（patch/bundles）时，
    // 它是该持久原名在本进程的热装替身（换键转正后的副本仍在 active 供调试）——本进程不把它当 orphan、
    // 不渲染独立卡，其运行态并入原名卡；重启后副本物理/目录由启动守护 P-052 回收。
    const isPersistentName = (n: string): boolean => patchEnabled.has(n) || host.isBundleAssembled(n)
    const proxyNames = new Set<string>()
    const proxyLive = new Map<string, { enabled: boolean; phase?: string }>()
    for (const [n, e] of live) {
      if (n.startsWith('cordis:') || n === '@deepseek-ai/cordis-plugin-loader') continue
      const m = /^(.+)-hot\d+$/.exec(n)
      if (!m || !isPersistentName(m[1])) continue
      proxyNames.add(n)
      proxyLive.set(m[1], { enabled: e.enabled, phase: e.phase })
    }

    // catalog（已安装）里每个 bundle 的视图。卸载后（recentlyUninstalled）不再渲染为残留卡片，
    // 让"卸载完即从列表消失"恢复为直觉预期；热装恢复会即时清理该标记（见 tempLoad/uninstall 对称逻辑）。
    const plugins: PluginView[] = catalog
      .filter((b) => !recentlyUninstalled.has(b.name) && !proxyNames.has(b.name))
      .map((b) => {
      const isThird = b.scope === 'third'
      const source = sourceOf(b)
      const ln = live.get(b.name) ?? proxyLive.get(b.name)
      const persistent = patchEnabled.has(b.name) || host.isBundleAssembled(b.name)
      const enabled = !isThird ? (ln === undefined ? true : ln.enabled) : (ln === undefined ? persistent : ln.enabled)
      const runtime: PluginRuntime =
        source === 'orphan' ? 'none'
          : ln === undefined ? (enabled ? 'none' : 'disabled')
          : !ln.enabled ? 'disabled'
          : ((ln.phase ?? 'loading') as PluginRuntime)
      return {
        name: b.name,
        version: b.version,
        description: b.description,
        scope: b.scope,
        source,
        enabled,
        runtime,
        folder: effectiveFolder(b, overlay),
        note: overlay.notes[b.name] ?? '',
        alias: overlay.aliases[b.name] ?? '',
        dependencies: b.dependencies,
        toggleable: isThird && source !== 'orphan',
        removable: isThird && (source === 'persistent' || source === 'orphan'),
        promoteable: source === 'temporary',
        tempRemoveable: source === 'temporary',
        pendingRestart: promotedPending.has(b.name),
      }
    })

    // 仅 live、不在已安装扫描目录中的临时 entry → 运行时临时插件（重启即消失）。
    // 已在 catalog 渲染的同名项（含 source='temporary'），此处跳过避免重复。
    const catalogNames = new Set(plugins.map((p) => p.name))
    for (const [name, { enabled, phase }] of live) {
      if (name.startsWith('cordis:') || name === '@deepseek-ai/cordis-plugin-loader') continue
      if (!tempInfos.has(name)) continue
      if (catalogNames.has(name)) continue
      const info = tempInfos.get(name)
      plugins.push({
        name,
        version: '',
        description: '',
        scope: 'third',
        source: 'temporary',
        enabled,
        runtime: !enabled ? 'disabled' : (phase ?? 'loading'),
        folder: effectiveFolder({ name, scope: 'third' }, overlay),
        note: '',
        alias: '',
        dependencies: info?.installedDeps ?? [],
        toggleable: true,
        removable: false,
        promoteable: true,
        tempRemoveable: true,
        pendingRestart: false,
      })
    }

    const count = (id: string, scope: 'official' | 'third'): number =>
      plugins.filter((p) => effectiveFolder(p, overlay) === id).length
    const folders: FoldersView[] = []
    for (const id of ['official', 'third']) {
      const scope = id === 'official' ? 'official' : 'third'
      folders.push({
        id,
        name: scope === 'official' ? '官方内置' : '第三方插件',
        kind: scope,
        count: count(id, scope),
        scope: 'shared',
      })
    }
    // 自定义文件夹按 folderOrder 显式排列（未登记的补按创建顺序追加）。
    const customIds = Object.keys(overlay.folders)
    const orderedCustom = [
      ...overlay.folderOrder.filter((id) => overlay.folders[id]),
      ...customIds.filter((id) => !overlay.folderOrder.includes(id)),
    ]
    for (const id of orderedCustom) {
      const meta = overlay.folders[id]
      folders.push({ id, name: meta.name, kind: 'custom', count: plugins.filter((p) => p.folder === id).length, scope: meta.scope ?? 'shared' })
    }

    // 文件夹内插件顺序：按 pluginOrder[folder] 显式排列（未登记的保持目录扫描顺序）。
    const orderedPlugins = orderPlugins(plugins, overlay)

    return {
      kernel: host.readKernelCurrent(),
      folders,
      plugins: orderedPlugins,
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/simplemanager',
        handler: async (req: any, res: any) => {
          const send = (obj: unknown): void => {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(obj))
          }
          const fail = (error: string): void => send({ ok: false, error })

          let pathname = '/'
          try {
            pathname = new URL(req.url ?? '/', 'http://x').pathname
          } catch {
            /* ignore */
          }
          const action = pathname.replace(/^\/simplemanager\/?/, '').replace(/\/$/, '')

          if (action === 'kernel' || action === '') {
            // 只读当前内核版本（不再联网查发布通道）。
            return send({ ok: true, ...host.readKernelCurrent() })
          }

          if (action === 'tempSteps') {
            // 步骤引擎快照：按 runId 返回该次操作的 plan + 各步状态（前端先渲染骨架，再逐步追踪）。
            const q = new URL(req.url ?? '/', 'http://x')
            const runId = q.searchParams.get('run') ?? ''
            if (!runId) return send({ ok: false, error: '缺少 run 参数' })
            return send(snapshotRun(runId))
          }

          if (action === 'probe/api/render-error') {
            // L0 探针渲染心跳只读端点：主进程 runProbe 经此轮询被探测实例的渲染态。
            // 状态是「被探测实例自身进程内」的模块级变量，主进程侧只为对齐契约返回空态。
            if (req.method === 'POST') {
              const body = await readJsonBody(req)
              if (body && typeof body === 'object' && (body as { renderError?: unknown }).renderError) probeRender.renderError = true
              return send({ ok: true })
            }
            return send({ booted: probeRender.booted, renderError: probeRender.renderError })
          }

          if (action === 'probe/api/booted') {
            // L0 探针渲染心跳上报：隔离实例客户端成功根挂载后 POST booted，渲染崩溃则 POST renderError。
            const body = await readJsonBody(req)
            if (body && typeof body === 'object') {
              const b = body as { booted?: unknown; renderError?: unknown }
              if (b.booted) probeRender.booted = true
              if (b.renderError) probeRender.renderError = true
            }
            return send({ ok: true })
          }

          if (action === 'beginStep') {
            // 预创建一次步骤 run：返回 runId + plan（前端据此先渲染「共几步、是哪几步」骨架，再发起真实操作并轮询实时状态）。
            const body = await readJsonBody(req)
            const op = typeof body.action === 'string' ? body.action : ''
            if (!ALL_PLANS[op]) return send({ ok: false, error: '未知步骤计划: ' + op })
            const runId = beginPlan(op, ALL_PLANS[op])
            return send({ ok: true, runId, plan: ALL_PLANS[op] })
          }

          if (action === 'pickdir') {
            // 宿主不可知：动态探测官方 directoryPicker seam（native 有 pick / browse 有 list）。
            // ctx.get 默认 strict 会在服务缺失时 throw，需 try/catch 包裹并把探测结果带回，避免整请求 400。
            let capability: Record<string, unknown> | undefined
            let pickerKind: string | 'missing' | 'no-capability' = 'missing'
            try {
              const picker = (ctx as { directoryPicker?: { capability?(): Record<string, unknown> } }).directoryPicker
              if (picker && typeof picker.capability === 'function') {
                capability = picker.capability()
                pickerKind = pickerKind === 'missing' ? 'direct' : pickerKind
              }
            } catch { /* direct 探测失败，回退标记 */ }
            if (pickerKind === 'direct' && capability) {
              /* 已取到 */
            } else {
              try {
                const picked = (ctx as { get?(n: string, strict?: boolean): unknown }).get?.('directoryPicker', false)
                const svc = picked as { capability?(): Record<string, unknown> } | undefined
                if (svc && typeof svc.capability === 'function') {
                  capability = svc.capability()
                  pickerKind = 'get-nonstrict'
                }
              } catch { /* ignore */ }
            }
            const keys = capability ? Object.keys(capability) : []
            const kind = capability?.kind as string | undefined
            if (capability && typeof capability.pick === 'function') {
              try {
                const ac = new AbortController()
                const path = await (capability as { pick(s: AbortSignal): Promise<string | null> }).pick(ac.signal)
                ac.abort()
                return send({ ok: true, path: path ?? null, kind, source: pickerKind })
              } catch (error) {
                return send({ ok: false, available: true, kind, source: pickerKind, error: '目录选择失败: ' + (error instanceof Error ? error.message : String(error)) })
              }
            }
            return send({ ok: false, available: false, kind, keys, source: pickerKind, error: '当前环境不支持原生目录选择' })
          }

          if (action === 'listdir') {
            // 应用内目录浏览：消费官方 browse/similar 后端的 list(path) 列一级子目录。
            // 仅当 pick 不可用（browse 应用内选择）时才有意义；返回 breadcrumbs + entries。
            const body = await readJsonBody(req)
            const path = typeof body.path === 'string' && body.path ? body.path : undefined
            let capability: { list?(p: string | undefined, s: AbortSignal): Promise<unknown> } | undefined
            try {
              const svc = (ctx as { directoryPicker?: { capability?(): unknown } }).directoryPicker
              const cap = svc?.capability?.() as { list?: (p: string | undefined, s: AbortSignal) => Promise<unknown> } | undefined
              capability = cap
            } catch { /* ignore */ }
            if (!capability || typeof capability.list !== 'function') {
              try {
                const picked = (ctx as { get?(n: string, strict?: boolean): unknown }).get?.('directoryPicker', false)
                const cap = (picked as { capability?(): unknown })?.capability?.() as
                  | { list?: (p: string | undefined, s: AbortSignal) => Promise<unknown> }
                  | undefined
                capability = cap
              } catch { /* ignore */ }
            }
            if (!capability || typeof capability.list !== 'function') {
              return send({ ok: false, error: '当前环境不支持应用内目录浏览' })
            }
            // 首层盘符枚举（判据4 宿主不可知）：win32 上 path 缺省时返回「此电脑」根层列出所有可用盘符；
            // 其它平台无盘符概念，直接走官方 list(undefined)（回 home）。
            if (path === undefined && process.platform === 'win32') {
              const home = homedir()
              const rootName = '此电脑'
              const drives: { name: string; path: string; hidden: boolean }[] = []
              for (let ch = 65; ch <= 90; ch++) {
                const letter = String.fromCharCode(ch)
                const drivePath = `${letter}:\\`
                try {
                  await stat(drivePath)
                  drives.push({ name: `${letter}:`, path: drivePath, hidden: false })
                } catch {
                  /* 盘符不存在或不可访问，跳过 */
                }
              }
              if (drives.length > 0) {
                return send({
                  ok: true,
                  level: {
                    path: '',
                    roots: true,
                    home,
                    crumbs: [{ name: rootName, path: '', hidden: false }],
                    entries: drives,
                    truncated: false,
                  },
                })
              }
              // 未枚举到盘符（异常），回退官方 list(home)
            }
            try {
              const ac = new AbortController()
              const level = await capability.list(path, ac.signal)
              ac.abort()
              return send({ ok: true, level })
            } catch (error) {
              return send({ ok: false, error: '目录读取失败: ' + (error instanceof Error ? error.message : String(error)) })
            }
          }

          if (action === 'rename') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            const alias = typeof body.alias === 'string' ? body.alias : ''
            if (!id) return fail('缺少插件 id')
            if (!buildCatalog(ctx, host).some((b) => b.name === id)) return fail('插件不存在: ' + id)
            const overlay = host.readOverlay()
            if (alias.trim() === '') delete overlay.aliases[id]
            else overlay.aliases[id] = alias.trim()
            host.writeOverlay(overlay)
            return send({ ok: true, ...buildView() })
          }

          if (action === 'scope') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            const scope = typeof body.scope === 'string' ? body.scope : ''
            if (!id) return fail('缺少插件 id')
            if (!buildCatalog(ctx, host).some((b) => b.name === id)) return fail('插件不存在: ' + id)
            const allowed: PluginScope[] = ['official', 'shell', 'third']
            const next = allowed.includes(scope as PluginScope) ? (scope as PluginScope) : null
            host.setScopeOverride(id, next)
            return send({ ok: true, ...buildView() })
          }

          if (action === 'browse' || action === 'refresh') {
            // refresh 时强制重新扫描文件系统；browse 每次都是实时扫描，语义等价。
            return send({ ok: true, ...buildView() })
          }

          // 工具管理「列出工具」（默认形态）：扫出全部可见工具，仅按手动拖拽归属 + 自定义工具组卡分组（不做源码归组）。
          // 未手动归属的工具全部进 unassigned（默认「未分组/未知」大聚合卡）。解耦「扫出」与「归组」。
          if (action === 'listTools') {
            const v = buildToolView(ctx, host, { scan: false })
            return send({ ok: true, toolCats: v.toolCats, cards: v.cards, unassigned: v.unassigned })
          }

          // 工具管理「扫描分组」（增强按钮）：在默认形态基础上，额外对选中的第三方插件做源码注册扫描，
          // 把可判定的工具自动归到对应插件卡。body.plugins（可选）= 只扫这些插件（前端「勾选卡片再确定」）；
          // 缺省 = 扫描全部第三方插件。手动拖拽归属优先于扫描。
          if (action === 'scanToolGroups') {
            const body = await readJsonBody(req)
            const selected: string[] = Array.isArray(body.plugins)
              ? body.plugins.filter((x: unknown): x is string => typeof x === 'string')
              : []
            const v = buildToolView(ctx, host, { scan: true, onlyPlugins: selected.length ? selected : undefined, persistScan: true })
            return send({ ok: true, toolCats: v.toolCats, cards: v.cards, unassigned: v.unassigned })
          }

          // 工具管理「自定义工具组卡」增删改（工具管理特有，不进入插件管理页）。folder 参数（可选）：
          // 把该卡归入某个工具管理文件夹（scope='tool'）下；缺省不归入任何文件夹。
          if (action === 'addToolCat' || action === 'renameToolCat' || action === 'removeToolCat' || action === 'moveToolCat') {
            const body = await readJsonBody(req)
            const ov = host.readOverlay()
            const cats = { ...(ov.toolCats ?? {}) }
            if (action === 'addToolCat') {
              const name = (typeof body.name === 'string' ? body.name : '').trim()
              if (!name) return fail('缺少工具组卡名称')
              const folder = typeof body.folder === 'string' && ov.folders[body.folder] && ov.folders[body.folder].scope === 'tool' ? body.folder : ''
              const id = `cat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
              cats[id] = folder ? { name, folder } : { name }
              host.writeOverlay({ ...ov, toolCats: cats })
              return send({ ok: true, id, name, folder })
            }
            if (action === 'renameToolCat') {
              const id = typeof body.id === 'string' ? body.id : ''
              const name = (typeof body.name === 'string' ? body.name : '').trim()
              if (!id || !cats[id]) return fail('工具组卡不存在')
              if (!name) return fail('工具组卡名称不能为空')
              cats[id] = { ...cats[id], name }
              host.writeOverlay({ ...ov, toolCats: cats })
              return send({ ok: true, id, name, folder: cats[id].folder ?? '' })
            }
            // removeToolCat：删除卡片，并把曾归属到它的工具引用清空（回未分组）。
            // moveToolCat：把已有工具组卡移动到某「工具管理文件夹」（scope='tool'），folder='' = 移出到「工具组卡片」区。
            const id = typeof body.id === 'string' ? body.id : ''
            if (!id || !cats[id]) return fail('工具组卡不存在')
            if (action === 'moveToolCat') {
              const folder = typeof body.folder === 'string' && (body.folder === '' || (ov.folders[body.folder] && ov.folders[body.folder].scope === 'tool'))
                ? body.folder
                : ''
              cats[id] = folder ? { ...cats[id], folder } : { name: cats[id].name }
              host.writeOverlay({ ...ov, toolCats: cats })
              return send({ ok: true, id, folder: cats[id].folder ?? '' })
            }
            delete cats[id]
            const overrides = { ...(ov.toolGroupOverrides ?? {}) }
            for (const [tool, key] of Object.entries(overrides)) {
              if (key === id) delete overrides[tool]
            }
            host.writeOverlay({ ...ov, toolCats: cats, toolGroupOverrides: overrides })
            return send({ ok: true })
          }

          if (action === 'setToolGroup') {
            // 工具管理「拖拽改归属」：持久化 toolGroupOverrides（工具名 -> 归属卡片 key：
            // 插件包名 / 自定义工具组卡 id / 空=回未分组）。
            const body = await readJsonBody(req)
            const tool = typeof body.tool === 'string' ? body.tool : ''
            const owner = typeof body.owner === 'string' ? body.owner : ''
            if (!tool) return fail('缺少工具名')
            const ov = host.readOverlay()
            const overrides = { ...(ov.toolGroupOverrides ?? {}) }
            if (owner === '') delete overrides[tool]
            else overrides[tool] = owner
            host.writeOverlay({ ...ov, toolGroupOverrides: overrides })
            return send({ ok: true, tool, owner: overrides[tool] ?? '' })
          }

          if (action === 'setToolEnabled') {
            // 工具管理开关：单工具（name）或整插件（names 数组，卡牌级总开关全开/全关）。写 overlay toolDeny
            // 持久化；并对每个 agent 的热工具视图调 tools.restrict({deny}) 真禁注入（能力可用时）。
            const body = await readJsonBody(req)
            const name = typeof body.name === 'string' ? body.name : ''
            const enabled = body.enabled !== false
            const names = Array.isArray(body.names) ? body.names.filter((x: unknown): x is string => typeof x === 'string') : []
            const targets = names.length > 0 ? names : name ? [name] : []
            const appliedNames = names.length > 0 ? null : name
            if (targets.length === 0) return fail('缺少工具名')
            const ov = host.readOverlay()
            const deny = new Set(ov.toolDeny)
            for (const t of targets) {
              if (enabled) deny.delete(t)
              else deny.add(t)
            }
            host.writeOverlay({ ...ov, toolDeny: [...deny] })
            // 整插件开关：对所有目标应用同一 deny 方向（per-tool restrict 覆盖各自状态；批量按统一态设，单工具状态保留由前端以 names 各自传入）
            let applied = false
            for (const t of targets) {
              const ok = applyToolRestrict(ctx, t, !enabled)
              if (ok) applied = true
            }
            return send({ ok: true, name: appliedNames, names: names.length > 0 ? targets : undefined, enabled, deny: [...deny], applied })
          }

          if (action === 'toggle') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            if (!id) return fail('缺少插件 id')
            const bundle = buildCatalog(ctx, host).find((b) => b.name === id)
            if (!bundle) return fail('插件不存在: ' + id)

            const patchEnabled = host.readPatchEnabledIds()
            const live = loaderLiveMap(ctx).get(id)
            // —— 来源轴统一判定（与 buildView 同口径，标准 = 真实装配数据）——
            // 孤儿残留（物理在、无持久层、非会话热装）一律拒绝启停：防止热的孤儿被一键启停"复活"成持久安装。
            const isSessionTemp = tempInfos.has(id)
            const persistent = patchEnabled.has(id) || host.isBundleAssembled(id)
            const sourceOf: PluginSource = bundle.scope === 'official' || bundle.scope === 'shell' ? bundle.scope
              : isSessionTemp ? 'temporary'
              : persistent ? 'persistent'
              : 'orphan'
            if (sourceOf === 'orphan') return fail('孤儿残留插件不可启停：请先「清理」移除残留，或重新正式安装')

            // 当前启停态：运行时（loader/pluginInventory 权威，含 disabled 条目）为准；无运行态回落持久层登记。
            // （patch.has(id) 只判「是否在启用清单」，会漏掉「曾被停用、已不在 patch 集合」的 patch 插件，故并入 bundle。）
            const currentlyEnabled = live === undefined ? persistent : live.enabled
            const next = !currentlyEnabled

            // —— 持久化装配层（判据6 收敛，见 MANIFEST「不许碰清单」）——
            // 决定持久装配面（写不写 patch）：
            //   - bundle 层插件（官方 `dsh plugin add` 装配进 cordis.yml / bundles）→ 永不写 patch，
            //     重启由该层恢复；如有旧版误写进 patch 的条目则清掉，防 duplicate loader entry id；
            //   - 会话临时插件（tempLoad，重启即消失）→ 不写 patch，toggle 仅运行时；
            //   - 其余（promote 转正 / 持久安装的第三方）→ patch 即本面板持久装配面，启/停都写 patch。
            const bundleMerged = sourceOf === 'persistent' && host.isBundleAssembled(id)
            const patchWritable = !bundleMerged && !isSessionTemp
            if (patchWritable) {
              host.setPatchEnabled(id, id, next)
            } else if (bundleMerged && patchEnabled.has(id)) {
              host.setPatchEnabled(id, id, false) // 清理旧版误写进 patch 的 bundle 条目
            }

            // —— 运行时热启停 ——
            // 停用后的 entry 仍留在 loader 树（disabled、fiber 置空），用 update({disabled:false}) 即可重新启动 fiber；
            // 树里已无该 entry（如装配文件重载被移除）则对非 bundle 插件用 create 热装，避免运行时装配被跳过。
            let hotApplied = false
            const entryId = live?.entryId ?? findLoaderEntryId(ctx, id)
            if (next) {
              if (entryId) {
                try {
                  if (typeof ctx.loader.update === 'function') {
                    await ctx.loader.update(entryId, { disabled: false })
                    hotApplied = true
                  }
                } catch {
                  hotApplied = false // 运行时重启失败，落盘已生效，走重启生效
                }
              } else if (!bundleMerged && typeof ctx.loader.create === 'function') {
                try {
                  // 装配表里没有该 entry → 官方 create 热装配；persistable 则补写 patch，重启保持一致。
                  await ctx.loader.create({ name: id, config: {}, disabled: false })
                  if (patchWritable && !patchEnabled.has(id)) host.setPatchEnabled(id, id, true)
                  hotApplied = true
                } catch {
                  hotApplied = false // 运行时热装失败，落盘/patch 已生效，走重启生效
                }
              }
            } else if (entryId) {
              try {
                if (typeof ctx.loader.update === 'function') {
                  await ctx.loader.update(entryId, { disabled: true })
                  hotApplied = true
                }
              } catch {
                hotApplied = false // 运行时停用失败，落盘已生效，走重启生效
              }
            }
            return send({ ok: true, enabled: next, hotApplied, ...buildView() })
          }

          if (action === 'folders') {
            const body = await readJsonBody(req)
            const act = typeof body.action === 'string' ? body.action : ''
            const overlay = host.readOverlay()
            if (act === 'create') {
              const nodeName = typeof body.name === 'string' ? body.name.trim() : ''
              if (!nodeName) return fail('文件夹名不能为空')
              if (/^(official|third)$/.test(nodeName) || Object.values(overlay.folders).some((f) => f.name === nodeName))
                return fail('文件夹名重复')
              // 作用域：'tool' = 仅工具管理可见；缺省/其它 = shared（插件管理+工具管理双边可见）。
              const folderScope: 'shared' | 'tool' = body.scope === 'tool' ? 'tool' : 'shared'
              const id = 'cf-' + Date.now().toString(36)
              overlay.folders[id] = { name: nodeName, scope: folderScope }
              overlay.folderOrder.push(id)
              host.writeOverlay(overlay)
              return send({ ok: true, ...buildView() })
            }
            if (act === 'up' || act === 'down') {
              const id = typeof body.id === 'string' ? body.id : ''
              if (!overlay.folders[id]) return fail('文件夹不存在')
              const delta = act === 'up' ? -1 : 1
              overlay.folderOrder = overlay.folderOrder.filter((x) => overlay.folders[x])
              const at = overlay.folderOrder.indexOf(id)
              if (at >= 0) moveIn(overlay.folderOrder, at, delta)
              host.writeOverlay(overlay)
              return send({ ok: true, ...buildView() })
            }
            if (act === 'order') {
              // 拖拽整体重排：ids 必须恰好是全部自定义文件夹 id 的一个排列（防越权注入）。
              const ids = Array.isArray(body.ids) ? body.ids.filter((x: unknown): x is string => typeof x === 'string') : []
              const customIds = Object.keys(overlay.folders)
              const sameSet = ids.length === customIds.length && customIds.every((x) => ids.includes(x))
              if (!sameSet) return fail('文件夹排序被拒绝：id 集合与当前自定义文件夹不一致')
              overlay.folderOrder = ids
              host.writeOverlay(overlay)
              return send({ ok: true, ...buildView() })
            }
            if (act === 'rename') {
              const id = typeof body.id === 'string' ? body.id : ''
              const nodeName = typeof body.name === 'string' ? body.name.trim() : ''
              if (!overlay.folders[id]) return fail('文件夹不存在')
              if (!nodeName) return fail('文件夹名不能为空')
              overlay.folders[id].name = nodeName
              host.writeOverlay(overlay)
              return send({ ok: true, ...buildView() })
            }
            if (act === 'delete') {
              const id = typeof body.id === 'string' ? body.id : ''
              if (id === 'official' || id === 'third') return fail('内置文件夹不可删除')
              if (!overlay.folders[id]) return fail('文件夹不存在')
              // 被删除文件夹内的插件回落到「第三方插件」
              for (const k of Object.keys(overlay.assignments)) if (overlay.assignments[k] === id) delete overlay.assignments[k]
              delete overlay.folders[id]
              overlay.folderOrder = overlay.folderOrder.filter((x) => x !== id)
              delete overlay.pluginOrder[id]
              // 若删除的是工具管理文件夹（scope='tool'），把归入它的工具组卡释放回「不归入任何文件夹」
              if (overlay.toolCats) {
                const cats = { ...overlay.toolCats }
                for (const c of Object.values(cats)) if (c.folder === id) delete c.folder
                overlay.toolCats = cats
              }
              host.writeOverlay(overlay)
              return send({ ok: true, ...buildView() })
            }
            return fail('未知文件夹操作: ' + act)
          }

          if (action === 'move') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            const target = typeof body.folder === 'string' ? body.folder : ''
            if (!id) return fail('缺少插件 id')
            const overlay = host.readOverlay()
            const prev = overlay.assignments[id] ?? effectiveFolder({ name: id, scope: 'third' }, { ...overlay })
            if (target === 'official' || target === 'third' || overlay.folders[target]) overlay.assignments[id] = target
            else delete overlay.assignments[id]
            // 移动后若进入有显式顺序的文件夹，追加到该文件夹顺序末尾，保证可排序。
            const landed = overlay.assignments[id] ?? effectiveFolder({ name: id, scope: 'third' }, { ...overlay })
            if (landed && prev !== landed) {
              const order = overlay.pluginOrder[landed] ?? []
              if (!order.includes(id)) overlay.pluginOrder[landed] = [...order, id]
            }
            host.writeOverlay(overlay)
            return send({ ok: true, ...buildView() })
          }

          if (action === 'reorder') {
            const body = await readJsonBody(req)
            const folder = typeof body.folder === 'string' ? body.folder : ''
            const overlay = host.readOverlay()
            // 整体拖拽重排：ids 必须是该文件夹内当前成员集合的一个排列（防越权注入）。
            if (Array.isArray(body.ids)) {
              const ids = body.ids.filter((x: unknown): x is string => typeof x === 'string')
              if (!folder) return fail('缺少文件夹')
              const members = folderMemberOrder(buildView().plugins, folder, overlay)
              const sameSet = ids.length === members.length && members.every((n) => ids.includes(n))
              if (!sameSet) return fail('插件排序被拒绝：id 集合与该文件夹成员不一致')
              overlay.pluginOrder[folder] = ids
              host.writeOverlay(overlay)
              return send({ ok: true, ...buildView() })
            }
            const id = typeof body.id === 'string' ? body.id : ''
            const dir = typeof body.dir === 'string' ? body.dir : ''
            if (!id || !folder) return fail('缺少插件 id / 文件夹')
            if (dir !== 'up' && dir !== 'down') return fail('未知排序方向')
            if (!buildCatalog(ctx, host).some((b) => b.name === id) && !tempInfos.has(id)) return fail('插件不存在: ' + id)
            const plugins = buildView().plugins
            const order = folderMemberOrder(plugins, folder, overlay)
            const at = order.indexOf(id)
            if (at < 0) return fail('插件不在该文件夹: ' + id)
            moveIn(order, at, dir === 'up' ? -1 : 1)
            overlay.pluginOrder[folder] = order
            host.writeOverlay(overlay)
            return send({ ok: true, ...buildView() })
          }

          if (action === 'note') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            const note = typeof body.note === 'string' ? body.note : ''
            if (!id) return fail('缺少插件 id')
            const overlay = host.readOverlay()
            if (note.trim() === '') delete overlay.notes[id]
            else overlay.notes[id] = note
            host.writeOverlay(overlay)
            return send({ ok: true, ...buildView() })
          }

          if (action === 'tempLoad') {
            const body = await readJsonBody(req)
            const spec = typeof body.name === 'string' ? body.name : ''
            const runId = typeof body.runId === 'string' ? body.runId : ''
            if (!spec.trim()) return fail('缺少要临时加载的插件名')
            host?.invalidateCatalog() // 装载改变 node_modules，后续 buildView 必须重扫（含失败回滚路径）
            try {
              const { depsApplied, pnpmReason, hotApplied, packageName } = await tempLoad(ctx, host, spec, runId)
              return send({ ok: true, depsApplied, pnpmReason, hotApplied, packageName, runId, ...buildView() })
            } catch (error) {
              return fail(error instanceof Error ? error.message : String(error))
            }
          }

          if (action === 'tempRemove') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            const runId = typeof body.runId === 'string' ? body.runId : ''
            if (!id) return fail('缺少插件 id')
            host?.invalidateCatalog() // 卸载改变 node_modules，后续 buildView 必须重扫
            try {
              const out = await tempRemove(ctx, host, id, runId)
              return send({ ok: true, runId: out.runId, ...buildView() })
            } catch (error) {
              return fail(error instanceof Error ? error.message : String(error))
            }
          }

          if (action === 'requestReload') {
            // agent 触发「刷新渲染进程」：仅登记信号，不做任何检测（护栏由 agent 自行编排）。
            const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
            pendingReload = { ts: Date.now(), nonce }
            return send({ ok: true, nonce })
          }

          if (action === 'reloadSignal') {
            // 前端轮询消费：有有效信号则读后清空并回报；过期陈旧信号一并清掉。
            const p = pendingReload
            if (p && Date.now() - p.ts <= RELOAD_SIGNAL_TTL) {
              pendingReload = null
              return send({ ok: true, pending: true, nonce: p.nonce })
            }
            if (p) pendingReload = null
            return send({ ok: false, pending: false })
          }

          if (action === 'promote') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            const runId = typeof body.runId === 'string' ? body.runId : ''
            if (!id) return fail('缺少插件 id')
            host?.invalidateCatalog() // 转正重装包，后续 buildView 必须重扫
            try {
              const { packageName, assembled } = await promote(ctx, host, id, runId)
              return send({ ok: true, packageName, assembled, runId, requiresRestart: true, ...buildView() })
            } catch (error) {
              return fail(error instanceof Error ? error.message : String(error))
            }
          }

          if (action === 'uninstall') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            const runId = typeof body.runId === 'string' ? body.runId : ''
            const clearData = body.clearData === true
            if (!id) return fail('缺少插件 id')
            host?.invalidateCatalog() // 卸载移除包，后续 buildView 必须重扫
            try {
              const { packageName } = await uninstall(ctx, host, id, runId, clearData)
              return send({ ok: true, packageName, runId, ...buildView() })
            } catch (error) {
              return fail(error instanceof Error ? error.message : String(error))
            }
          }

          send({ ok: false, error: 'unknown action: ' + action })
        },
      }),
    'dsh-plugin-simplemanager: api',
  )
}

/** plugin-inventory 服务最小面：官方 `PluginInventoryGateway.list()`（host 同步可用）。 */
interface PluginInventoryFace {
  list(): { entries?: Array<{ entryId?: string; moduleName?: string; enabled?: boolean; fiberPhase?: string | null }> }
}

/** loader 存活态捕获（moduleName / !disabled + fiberPhase）。优先走官方 pluginInventory（权威且在 host 生效），
 * 失败回退 loader 直读；两者均不可用返回空 Map。 */
function loaderLiveMap(ctx: AppContext): Map<string, LoaderLive> {
  const pinv = ctx.get('pluginInventory') as PluginInventoryFace | undefined
  if (pinv && typeof pinv.list === 'function') {
    const map = new Map<string, LoaderLive>()
    try {
      const entries = pinv.list().entries
      if (entries) {
        for (const e of entries) {
          const nm = e?.moduleName
          if (typeof nm !== 'string' || !nm) continue
          map.set(nm, {
            enabled: !!e.enabled,
            phase: (e.fiberPhase ?? null) as FiberPhaseName,
            entryId: e.entryId,
          })
        }
      }
      return map
    } catch {
      /* fallthrough to loader 直读 */
    }
  }
  const map = new Map<string, LoaderLive>()
  try {
    for (const entry of ctx.loader.entries() ?? []) {
      const nm = entry?.options?.name
      if (typeof nm !== 'string' || !nm) continue
      const rawState = entry.fiber?.state
      const phase: FiberPhaseName =
        typeof rawState === 'number' && rawState >= 0 && rawState < FIBER_PHASE.length
          ? (FIBER_PHASE[rawState] as FiberPhaseName)
          : null
      map.set(nm, { enabled: !entry.disabled, phase, entryId: entry.id ?? nm })
    }
    return map
  } catch {
    return new Map()
  }
}

/** 从 loader/pluginInventory 的装配表提取已组建条目的 moduleName 全集。 */
function assembledModuleNames(ctx: AppContext): Set<string> {
  const names = new Set<string>()
  const pinv = ctx.get('pluginInventory') as PluginInventoryFace | undefined
  if (pinv && typeof pinv.list === 'function') {
    try {
      for (const e of pinv.list().entries ?? []) {
        if (typeof e?.moduleName === 'string' && e.moduleName) names.add(e.moduleName)
      }
      return names
    } catch {
      /* fallthrough to loader 直读 */
    }
  }
  try {
    for (const entry of ctx.loader.entries() ?? []) {
      const n = entry.options?.name
      if (typeof n === 'string' && n) names.add(n)
    }
  } catch {
    /* ignore */
  }
  return names
}

/**
 * 在 loader 装配树里按 moduleName 查找首个非 group 的 entry id。
 * 直接遍历 `ctx.loader.entries()`（含 disabled、fiber 为 undefined 的条目，见 loader tree.entries()），
 * 不依赖 pluginInventory（其返回的 entryId 与 entry.id 恒等，但个别宿主可能过滤 disabled），
 * 供启停时精确定位已装配 entry（停用后仍留在树中，启用时 `update({disabled:false})` 即可重启 fiber）。
 */
function findLoaderEntryId(ctx: AppContext, moduleName: string): string | undefined {
  try {
    for (const entry of ctx.loader.entries()) {
      if (entry?.options?.name === moduleName && !entry.options.group) return entry.id
    }
  } catch {
    /* ignore */
  }
  return undefined
}

/** 数组内移动：delta=-1 上移、+1 下移，越界则原位不动。返回 indexOf 目标位置。 */
function moveIn(arr: string[], index: number, delta: number): number {
  const j = index + delta
  if (j < 0 || j >= arr.length || delta === 0) return index
  ;[arr[index], arr[j]] = [arr[j], arr[index]]
  return j
}

/** 按 pluginOrder[folder] 稳定排列每文件夹内的插件（未登记项保持原顺序）。 */
function orderPlugins(plugins: PluginView[], overlay: Overlay): PluginView[] {
  const rank = new Map<string, number>()
  const captured = new Map<string, number>()
  for (const p of plugins) captured.set(p.name, captured.size)
  // 计算每项相对其所属文件夹的排名：显式登记靠前，未登记按出现顺序续排。
  const folderOf = new Map(plugins.map((p) => [p.name, p.folder] as const))
  for (const p of plugins) {
    const order = overlay.pluginOrder[p.folder]
    if (order) {
      const pos = order.indexOf(p.name)
      if (pos >= 0) {
        rank.set(p.name, pos)
        continue
      }
    }
    rank.set(p.name, 1e9 + (captured.get(p.name) ?? 0))
  }
  return plugins
    .map((p, i) => ({ p, r: rank.get(p.name) ?? 1e9 + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.p)
}

/**
 * 算出某文件夹内的当前插件顺序（含未登记项，按目录扫描顺序续排），
 * 供 reorder 持久化该文件夹的显式 pluginOrder。
 */
function folderMemberOrder(plugins: PluginView[], folder: string, overlay: Overlay): string[] {
  const members = plugins.filter((p) => p.folder === folder).map((p) => p.name)
  const explicit = (overlay.pluginOrder[folder] ?? []).filter((n) => members.includes(n))
  const rest = members.filter((n) => !explicit.includes(n))
  return [...explicit, ...rest]
}

/** 装配驱动的 pluginBundle 全集：枚举=装配表（loader/pluginInventory 权威），目录扫描仅作元数据来源。 */
function buildCatalog(ctx: AppContext, host: SimpleManagerHost): PluginBundle[] {
  const meta = new Map(host.scanCatalog().map((b) => [b.name, b]))
  const names = new Set<string>([...meta.keys(), ...assembledModuleNames(ctx)])
  const out: PluginBundle[] = []
  for (const name of names) {
    if (name.startsWith('cordis:') || name === '@deepseek-ai/cordis-plugin-loader') continue
    const known = meta.get(name)
    if (known) {
      out.push(known)
      continue
    }
    const described = host.describeBundle(name)
    // 壳内包防误判（P-046）：物理位于宿主 resources（或装配表里有、盘上无处可寻=壳内打包产物）的条目
    // 不是第三方插件——无 @deepseek-ai/ 前缀的壳自带包（如 dshmarket）按名字判会落 third→「孤儿」，
    // 卡片带「清理」按钮会诱导误删壳文件。物理位置优先于名字启发式；scopeOverrides 显式覆盖仍最高。
    const located = described?.source ?? 'runtime'
    out.push({
      name,
      version: described?.version ?? '',
      description: described?.description ?? '',
      scope: host.scopeOf(name, located),
      source: located,
      dependencies: described?.dependencies ?? [],
    })
  }
  return out
}

/** 探针「全量协同」伴随清单：取当前环境已加载的第三方插件（装配表驱动），排除候选（单名或批量名单）
 * 与已在 profile 声明的项，其余以可解析的本地物理源（temp 源目录 / profile node_modules）link 进隔离副本，
 * 一次装配整个环境做兼容探测。 */
function collectProbeCompanions(ctx: AppContext, host: SimpleManagerHost, profileDir: string, candidate: string | string[]): Array<{ name: string; spec: string }> {
  const excludedRaw = Array.isArray(candidate) ? candidate : [candidate]
  const excluded = new Set<string>(excludedRaw)
  // 热装换键副本（<name>-hotN）与候选是同一逻辑插件：排除时按「去 -hotN 后缀」比较，
  // 否则探针会把候选自己的旧码副本当伴随 link 进隔离实例（其产物注册 id 仍是逻辑名，混装冲突）。
  const isExcluded = (name: string): boolean => excluded.has(name) || excluded.has(name.replace(/-hot\d+$/, ''))
  const out: Array<{ name: string; spec: string }> = []
  if (!profileDir || !existsSync(join(profileDir, 'package.json'))) return out
  let declared = new Set<string>()
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    declared = new Set(Object.keys(pkg?.dependencies ?? {}))
  } catch { /* 不可读则视为无已声明项 */ }
  for (const b of buildCatalog(ctx, host)) {
    if (b.scope !== 'third' || isExcluded(b.name) || declared.has(b.name)) continue
    let spec: string | null = null
    const t = tempInfos.get(b.name)
    if (t?.spec) {
      const d = packageSourceDir(t.spec)
      if (d && existsSync(d)) spec = `link:${d}`
    }
    if (!spec) {
      const nm = join(profileDir, 'node_modules', b.name)
      if (existsSync(nm)) spec = `link:${nm}`
    }
    if (spec) out.push({ name: b.name, spec })
  }
  return out
}

/** 临时闭包：resolve 名 → { entryId, spec（pnpm add 用原始 spec）, installedDeps（本次补装闭包依赖）}。
 * 临时插件随进程消亡、不写 patch，无需落盘；转正（promote）才写 patch 持久化。 */
const tempInfos = new Map<string, { entryId: string; spec: string; installedDeps: string[]; hotCopy?: string; baseDir?: string }>()
/** 已转正待重启的插件（本次进程 entry 仍运行至退出；重启后由 patch 装配为持久）。会话级内存，重启即空。 */
const promotedPending = new Set<string>()
/** 本会话成功卸载、但装配/物理层可能仍在收敛（loader 未即时拆除 / 桌面壳复核写回）而仍残留在列表的包名。
 * 装配层收敛以重启为判定（P-039），此集用于 buildView 把这类残留正确标记为「已卸载、不可启停」，而非正常可装可启停插件。 */
const recentlyUninstalled = new Set<string>()

/** 本进程内已热装过（含已 tempRemove 掉）的包名集合：同名热装判定用，进程生命周期，不随 tempRemove 清除。
 * 依据 P-052：宿主拿不到 Node 内部 loadCache（Electron no-realm）且模块地图按 specifier 键控、
 * 进程内无公开失效手段——同名包本进程加载过后，重装同 specifier 必命中旧模块缓存。此集合驱动 tempLoad
 * 的「自动换键」：二次同名热装时改写包 name 换全新 specifier 以取新码。 */
const seenLocalNames = new Set<string>()
/** 自动换键的单调序号：dsh-xx → dsh-xx-hot1 → dsh-xx-hot2 … */
let hotSeq = 0
/** 热装换键生成的临时副本登记：新包名 → 副本目录（profile/.dsh-hot/<新名>）。tempRemove/uninstall 与
 * P-033 启动清扫据此回收副本，保证换键零残留、源码目录不被触碰。 */
const hotCopyDirs = new Map<string, string>()

// —— 工具管理（扫描分组 + 开关）——
/** 工具管理单个工具元数据：name + 启用态 + 描述 + 参数 schema（JSON Schema 子集），UI 只读展示。 */
interface ToolMeta {
  name: string
  enabled: boolean
  description: string
  parameters?: { type?: string; properties?: Record<string, unknown> }
}
// 枚举当前 tools 全局视图的全部可见工具名。tools.view() 缺省 scope=global 视图，第三方注册的所有工具都在。
// 返回 name -> definition；definition 顶层含 name/description/parameters（JSON Schema 子集）等，详情直读无需扫源码。
function listVisibleTools(ctx: Context): Map<string, Record<string, unknown>> {
  const tools = (ctx as { get?(k: string): unknown }).get?.('tools') as
    | { view?(scope?: unknown): { visible?: Map<string, unknown> } }
    | undefined
  if (!tools || typeof tools.view !== 'function') return new Map()
  const visible = tools.view().visible
  const out = new Map<string, Record<string, unknown>>()
  if (!visible) return out
  for (const [name, def] of visible) out.set(name, (def && typeof def === 'object' ? def : {}) as Record<string, unknown>)
  return out
}

/** 从工具 definition 提取便于 UI 展示的描述与参数 schema（JSON Schema 子集）。definition 可能为空/异形，安全兜底。 */
function describeTool(def: Record<string, unknown>): { description: string; parameters: Record<string, unknown> | undefined } {
  const description = typeof def.description === 'string' ? def.description : ''
  const parameters =
    def.parameters && typeof def.parameters === 'object' ? (def.parameters as Record<string, unknown>) : undefined
  return { description, parameters }
}

/** 工具管理统一视图构造（解耦「扫出工具」与「归组」）：
 * - scan=false（默认 listTools）：不做事前源码扫描——第三方插件卡恒常驻（复用插件管理文件夹排布由前端叠加），
 *   工具只按用户手动拖拽的 toolGroupOverrides 归属进卡片；未归属工具全部进 unassigned（「未分组/未知」大聚合卡）。
 * - scan=true（增强 scanToolGroups）：额外对第三方插件做源码注册扫描，把可判定的工具自动归到对应插件卡。
 *   onlyPlugins（可选）= 只扫这些插件（前端「勾选卡片再确定」），缺省扫全部第三方。手动拖拽归属优先于扫描。
 *   persistScan（可选）= 扫描完成后把本次归属并入 toolGroupOverrides 并清理失效旧记录，使「扫过一次后刷新/重启分组仍在」。
 * 返回 toolCats + 卡片(cards: 常驻 plugin/toolcat) + unassigned。归属 key 校验：仅当是已知插件或有同名自定义卡才有效，
 * 否则该工具回未分组（避免悬空引用）。 */
function buildToolView(
  ctx: AppContext,
  host: SimpleManagerHost,
  opts: { scan: boolean; onlyPlugins?: string[]; persistScan?: boolean },
): {
  toolCats: Array<{ id: string; name: string; folder?: string }>
  cards: Array<{ kind: 'plugin' | 'toolcat'; key: string; tools: ToolMeta[] }>
  unassigned: ToolMeta[]
} {
  const overlay = host.readOverlay()
  const visibleTools = listVisibleTools(ctx)
  const liveNames = new Set(visibleTools.keys())
  const deny = new Set(overlay.toolDeny)
  const cats = overlay.toolCats ?? {}
  const overrides = overlay.toolGroupOverrides ?? {}
  const catalog = buildCatalog(ctx, host)
  const pluginNameSet = new Set(catalog.map((b) => b.name))
  const metaOf = (n: string): ToolMeta => {
    const d = describeTool(visibleTools.get(n) ?? {})
    return { name: n, enabled: !deny.has(n), description: d.description, parameters: d.parameters }
  }
  // 1) 归属：先烙手动覆盖，再做源码归属（仅 scan=true 且未被手动固化时）。
  const assigned = new Map<string, string>()
  for (const [tool, key] of Object.entries(overrides)) {
    if (!liveNames.has(tool)) continue
    if (!key || !cats[key] && !pluginNameSet.has(key)) continue // 悬空引用丢弃 → 未分组
    assigned.set(tool, key)
  }
  if (opts.scan) {
    const profileDir = host.profileDir ?? ''
    const third = catalog.filter((b) => b.scope === 'third')
    // onlyPlugins：只扫用户勾选的那几款插件（前端「选卡→确定」）；缺省扫全部第三方。
    const scanTargets = opts.onlyPlugins && opts.onlyPlugins.length
      ? third.filter((b) => opts.onlyPlugins!.includes(b.name))
      : third
    const scanAssigned = new Map<string, string>()
    for (const b of scanTargets) {
      const pkgDir = profileDir ? join(profileDir, 'node_modules', b.name) : ''
      if (!pkgDir) continue
      let found: string[] = []
      try { if (existsSync(pkgDir)) found = scanToolNamesInPackage(pkgDir) } catch { found = [] }
      for (const n of found) {
        if (liveNames.has(n) && !assigned.has(n)) {
          assigned.set(n, b.name)
          scanAssigned.set(n, b.name)
        }
      }
    }
    // 持久化扫描归属：把本次扫描打到的归属并入 toolGroupOverrides 并清理失效旧记录（工具已不存在 / 归属卡已消失），
    // 使「扫过一次后刷新/重启分组仍在」，也与 buildToolView 顶部对 toolGroupOverrides 的清理语义保持一致。
    if (opts.persistScan && (scanAssigned.size > 0 || Object.keys(overrides).length > 0)) {
      const ov = host.readOverlay()
      const merged = { ...overrides }
      for (const [n, key] of scanAssigned) merged[n] = key
      for (const t of Object.keys(merged)) {
        if (!liveNames.has(t)) delete merged[t]
        else if (merged[t] && !cats[merged[t]] && !pluginNameSet.has(merged[t])) delete merged[t]
      }
      host.writeOverlay({ ...ov, toolGroupOverrides: merged })
    }
  }
  // 2) 组装卡片：第三方插件卡常驻（即使暂无工具，按插件管理文件夹排布由前端叠加）+ 自定义工具组卡常驻。
  const cardsMap = new Map<string, { kind: 'plugin' | 'toolcat'; key: string; tools: ToolMeta[] }>()
  for (const b of catalog) {
    if (b.scope !== 'third') continue
    cardsMap.set(b.name, { kind: 'plugin', key: b.name, tools: [] })
  }
  const unassigned: ToolMeta[] = []
  for (const n of liveNames) {
    const m = metaOf(n)
    const key = assigned.get(n)
    if (!key) { unassigned.push(m); continue }
    const tgt = cardsMap.get(key)
    if (tgt) tgt.tools.push(m)
    else if (cats[key]) cardsMap.set(key, { kind: 'toolcat', key, tools: [m] })
    else unassigned.push(m) // 归属悬空回未分组
  }
  // 自定义工具组卡常驻（即使暂时无工具，供拖拽落点），并带上 folder（归入工具管理文件夹用）。
  const toolCats = Object.entries(cats).map(([id, c]) => ({ id, name: c.name, folder: c.folder ?? '' }))
  for (const { id } of toolCats) {
    if (!cardsMap.has(id)) cardsMap.set(id, { kind: 'toolcat', key: id, tools: [] })
  }
  const cards = [...cardsMap.values()]
    .map((c) => ({ ...c, tools: c.tools.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => (a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind === 'plugin' ? -1 : 1))
  unassigned.sort((a, b) => a.name.localeCompare(b.name))
  return { toolCats, cards, unassigned }
}

/** 扫描单个已装插件产物目录，提取 tools.register / defineTool 的 name 字符串字面量作为该插件注册的工具名。
 * 递归扫 packageRoot 下 {lib,client,src,dist,build,runtime}/**.js；只抓 `name: "…"` / `name:'…'` 字面量，
 * 且位于 tools.register( 或 defineTool( 上下文内（粗粒度：同一作用块内出现 name 即视为工具声明）。
 * 工厂封装（name: opts.name）等动态名抓不到——那是分组兜底的归属范围。 */
function scanToolNamesInPackage(packageRoot: string, seen = new Set<string>(), fileCount = 0): string[] {
  if (fileCount > 400) return [] // 防止失控递归扫海量文件
  if (seen.has(packageRoot)) return []
  seen.add(packageRoot)
  const found = new Set<string>()
  let dirEntries: string[] = []
  try { dirEntries = readdirSync(packageRoot, 'utf8') } catch { return [] }
  for (const entry of dirEntries) {
    const full = join(packageRoot, entry)
    if (['node_modules', '.git', '.dsh-hot'].includes(entry)) continue
    let st: { isDirectory(): boolean; isFile(): boolean }
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      fileCount += countFilesQuick(full)
      for (const n of scanToolNamesInPackage(full, seen, fileCount)) found.add(n)
      continue
    }
    if (!entry.endsWith('.js') && !entry.endsWith('.mjs') && !entry.endsWith('.cjs')) continue
    let text = ''
    try { text = readFileSync(full, 'utf8') } catch { continue }
    const nameRe = /\b(name)\s*:\s*['"]([^'"]+)['"]/g
    const callRe = /(?:tools\.register|defineTool)\s*\(/g
    // 从每个 register/defineTool 调用处向后找最近的 name 字面量（粗粒度聚类）。
    let m: RegExpExecArray | null
    let lastRegEnd = -1
    while ((m = nameRe.exec(text)) !== null) {
      const name = m[2]
      const idx = m.index
      // 是否落在某个 register/defineTool 调用词之后（且距上一个不算远）。
      let nearCall = lastRegEnd >= 0 && idx >= lastRegEnd && idx - lastRegEnd < 4000
      callRe.lastIndex = 0
      let cm: RegExpExecArray | null
      let candidatePos = -1
      while ((cm = callRe.exec(text)) !== null) {
        if (cm.index <= idx) { candidatePos = cm.index + 0 } else break
      }
      if (candidatePos >= 0 && idx - candidatePos < 4000) {
        nearCall = true
        lastRegEnd = idx + name.length
      }
      if (nearCall) found.add(name)
    }
  }
  return [...found]
}

/** 快速统计目录内 js 文件数（仅用于深度/规模护栏）。 */
function countFilesQuick(dir: string): number {
  let n = 0
  try {
    for (const e of readdirSync(dir)) {
      if (['node_modules', '.git', '.dsh-hot'].includes(e)) continue
      try {
        const st = statSync(join(dir, e))
        if (st.isDirectory()) n += countFilesQuick(join(dir, e))
        else if (e.endsWith('.js') || e.endsWith('.mjs')) n++
      } catch { /* 忽略 */ }
    }
  } catch { /* 无法读取则计 0 */ }
  return n
}

/** 对每个运行的 agent 热工具视图应用/解除某工具的 deny（真禁注入）。能力不可用（拿不到 agents 或 scoped ctx）
 * 时返回 false，且不抛——开关持久化照常落 overlay，restrict 由宿主能力决定。 */
function applyToolRestrict(ctx: Context, name: string, deny: boolean): boolean {
  let agents: { get?(id: string): unknown; store?: unknown } | undefined
  try { agents = (ctx as { get?(k: string): unknown }).get?.('agents') as typeof agents } catch { agents = undefined }
  if (!agents || typeof agents.get !== 'function') return false
  // agents 服务暴露 entry 的方式因宿主而异：尝试遍历 store / 或假定其上有可迭代会话。无法枚举则只尽力。
  const candidates = new Set<unknown>()
  try {
    const store = (agents as { store?: unknown }).store
    if (store && typeof store === 'object') {
      for (const v of Object.values(store as Record<string, unknown>)) {
        const entry = v as { session?: unknown; agent?: unknown }
        if (entry?.agent) candidates.add(entry.agent)
        else if (entry?.session) candidates.add(entry.session)
      }
    }
  } catch { /* 枚举失败则走空 */ }
  if (candidates.size === 0) {
    // 兜底：尝试取任意单一 agent ctx（若 agents 直接挂在 ctx 上）。
    try {
      const anyAgent = (agents as { requireInitiator?(): unknown }).requireInitiator?.()
      if (anyAgent) candidates.add(anyAgent)
    } catch { /* 忽略 */ }
  }
  if (candidates.size === 0) return false
  let appliedAny = false
  for (const ag of candidates) {
    const scopeCtx = ((ag as { ctx?: unknown }).ctx ?? (ag as { scope?: { ctx?: unknown } }).scope?.ctx) as
      | { tools?: { restrict?(f: { deny: string[] }): unknown } }
      | undefined
    if (!scopeCtx || typeof scopeCtx.tools?.restrict !== 'function') continue
    try {
      scopeCtx.tools.restrict({ deny: deny ? [name] : [] })
      appliedAny = true
    } catch { /* 该 agent 视图不接受则跳过 */ }
  }
  return appliedAny
}

/** 由 tempLoad 入参解析本地包源目录（file:/link:/绝对路径）；裸名（registry）返回 null，不可换键。 */
function packageSourceDir(spec: string): string | null {
  const s = spec.trim()
  let p = s
  if (s.startsWith('file:')) p = s.slice('file:'.length)
  else if (s.startsWith('link:')) p = s.slice('link:'.length)
  else if (!/^[A-Za-z]:[\\/]|^(\/|\\)/.test(s)) return null
  return p || null
}

/** 由 tempLoad 入参解析「逻辑插件名」（去尾 -hotN）：用于单实例连携链检测「同逻辑名是否已有活动实例」。
 * 本地包目录优先读源 package.json.name（与 tempLoad 换键判定同一来源）；裸名回落 spec 包名。 */
function logicBaseOfSpec(spec: string, host: SimpleManagerHost | null): string {
  const srcDir = packageSourceDir(spec)
  if (srcDir && existsSync(srcDir)) {
    try {
      const m = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8')) as { name?: string }
      if (m.name) return m.name.replace(/-hot\d+$/, '')
    } catch { /* 不可读则落到包名回落 */ }
  }
  return (specPackageName(spec.trim(), host?.profileDir ?? undefined) ?? spec.trim()).replace(/-hot\d+$/, '')
}

/** 复制源包目录为临时换取键副本，并改写副本 package.json.name；返回副本目录。全程只碰副本，源码零改动。 */
function makeHotCopy(srcDir: string, profileDir: string, basePackageName: string): string {
  const hotRoot = join(profileDir, '.dsh-hot')
  mkdirSync(hotRoot, { recursive: true })
  const next = `${basePackageName}-hot${++hotSeq}`
  const dst = join(hotRoot, next)
  rmSync(dst, { recursive: true, force: true })
  // 只排全场景必然垃圾项，不再猜 dist/build——它们对多数插件是中间产物，但可能是别的插件运行时命脉（如 ego-browser 的前端），一刀切会误伤。
  cpSync(srcDir, dst, {
    recursive: true,
    filter: (s) => {
      const n = basename(s)
      return n !== 'node_modules' && n !== '.git' && n !== '.dsh-hot'
    },
  })
  const pkgJsonPath = join(dst, 'package.json')
  if (!existsSync(pkgJsonPath)) throw new Error(`副本缺少 package.json（源 ${srcDir} 非有效插件包）`)
  const meta = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: string }
  meta.name = next
  writeFileSync(pkgJsonPath, JSON.stringify(meta, null, 2) + '\n')
  return dst
}

/** —— 步骤引擎（热插拔操作的过程追踪）——
 * 以「预定义步骤计划 + 每个步骤独立状态」的方式输出操作进度，供前端：
 *   1) 操作开始前拿到计划（共多少步、分别是哪几步）；
 *   2) 操作进行中逐步追踪每步状态（pending→running→ok/err）与耗时。
 * 一个 run 对应一次操作（tempLoad/promote/tempRemove/uninstall）。数据小、单会话，模块级即可。
 * level：info 中性 / ok 成功 / warn 警告 / err 失败。 */
interface StepPlanItem {
  /** 步骤稳定标识（jsdoc 顺序，前端按序渲染骨架）。 */
  key: string
  label: string
}
interface StepState {
  key: string
  label: string
  status: 'idle' | 'running' | 'ok' | 'err'
  t0?: number
  elapsed?: string
  note?: string
}
interface StepLine {
  t: string
  level: 'info' | 'ok' | 'warn' | 'err'
  text: string
}
interface StepRun {
  startedAt: number
  plan: StepPlanItem[]
  states: Map<string, StepState>
  lines: StepLine[]
  done: boolean
}

let _runSeq = 0
const _runs = new Map<string, StepRun>()

/** L0 探针渲染心跳状态（模块级）：仅新 spawn 的隔离实例进程内自持，主进程侧只读契约对齐。
 * 隔离实例内经 POST /simplemanager/probe/api/booted|render-error 写入，runProbe 经 GET render-error 读取。 */
const probeRender = { booted: false, renderError: false }

/** agent 触发的「刷新渲染进程」请求（前端轮询消费）。nonce 去重、读后清空、TTL 防陈旧。
 * 仅登记「触发」，无任何检测——插件能否干净启动由 agent 用 pm_probe 真实探针判定。 */
let pendingReload: { ts: number; nonce: string } | null = null
/** 刷新信号的有效窗口：agent 登记后前端须在此时间内轮询到，否则视为陈旧丢弃。 */
const RELOAD_SIGNAL_TTL = 10_000

/** 各种操作对应的步骤计划（beginStep 预创建前端骨架、真实操作按步推进用）。 */
const ALL_PLANS: Record<string, StepPlanItem[]> = {
  tempLoad: [
    { key: 'deps', label: '安装插件与依赖闭包' },
    { key: 'resolve', label: '解析插件包名' },
    { key: 'assemble', label: 'loader 运行时装配并启动' },
    { key: 'state', label: '读取 entry 运行状态' },
    { key: 'finish', label: '登记临时态并完成' },
  ],
  tempRemove: [
    { key: 'unload', label: '从运行时卸载 entry' },
    { key: 'deps', label: '回收未被引用的闭包依赖' },
    { key: 'finish', label: '完成临时卸载' },
  ],
  promote: [
    { key: 'deps', label: '安装依赖闭包' },
    { key: 'verify', label: '校验安装' },
    { key: 'register', label: '登记装配清单' },
    { key: 'finish', label: '完成转正' },
  ],
  uninstall: [
    { key: 'deregister', label: '移除装配登记（patch + bundles）' },
    { key: 'remove', label: '物理移除包与依赖闭包' },
    { key: 'data', label: '清理自持数据' },
    { key: 'finish', label: '完成真卸载' },
  ],
}
const _stepTime = (): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

/** 建立一次操作的计划：返回 runId（生成 run 快照，所有步骤置 idle）。 */
function beginPlan(action: string, plan: StepPlanItem[]): string {
  _runSeq += 1
  const runId = `${action}:${_runSeq}`
  const states = new Map<string, StepState>()
  for (const p of plan) states.set(p.key, { key: p.key, label: p.label, status: 'idle' })
  _runs.set(runId, { startedAt: Date.now(), plan, states, lines: [], done: false })
  return runId
}

/** 更新某一步骤状态：置 running（记开始）/ 推进 ok|err（记耗时、可附完成备注）。额外追加一条行供尾部看板。 */
function markStep(run: StepRun, key: string, status: 'running' | 'ok' | 'err', note?: string): void {
  const s = run.states.get(key)
  if (!s) return
  if (status === 'running') {
    s.status = 'running'
    s.t0 = Date.now()
    run.lines.push({ t: _stepTime(), level: 'info', text: `→ ${s.label} …` })
    return
  }
  // ok / err
  s.status = status
  if (s.t0) s.elapsed = `${((Date.now() - s.t0) / 1000).toFixed(1)}s`
  if (note) s.note = note
  const level = status === 'ok' ? 'ok' : 'err'
  run.lines.push({ t: _stepTime(), level, text: `${status === 'ok' ? '✓' : '✗'} ${s.label}${s.elapsed ? `（${s.elapsed}）` : ''}${note ? `：${note}` : ''}` })
}

/** 追加一条不绑定具体步骤的自由日志行。 */
function appendNote(run: StepRun, level: 'info' | 'ok' | 'warn' | 'err', text: string): void {
  run.lines.push({ t: _stepTime(), level, text })
}

/** 终态：标记整个 run 结束。 */
function finishRun(run: StepRun): void {
  run.done = true
}

/** run 快照（plan + 各步状态 + 尾部行 + 是否完成），供前端逐步增量渲染。 */
function snapshotRun(runId: string): { ok: boolean; runId?: string; done?: boolean; plan?: StepPlanItem[]; states?: StepState[]; lines?: StepLine[] } {
  const run = _runs.get(runId)
  if (!run) return { ok: false }
  return { ok: true, runId, done: run.done, plan: run.plan, states: [...run.states.values()], lines: run.lines }
}

/**
 * 运行时临时加载一个可解析的插件（npm 包名 / 本地目录），并**热装启动**（不重启）。
 * 流程（P-015 实证的官方运行时装配入口）：
 *   1) pnpm add <spec> 普适化依赖获取（无论插件自带 node_modules 与否都装齐闭包到 profile 共享 node_modules）；
 *   2) 包名解析（specPackageName，路径/registry 均可）；
 *   3) `ctx.loader.create({ name: 包名, config, disabled:false })` 在已启动的 Cordis root 内装配并启动 entry
 *      —— name 必须是 loader 可 import 的 bare specifier（包名），**禁止本地 file 路径**（C-05，file 路径曾致 create 挂起）。
 * 临时语义：**不写 patch**（重启即消失），转正由 promote 负责持久化。
 */
async function tempLoad(
  ctx: AppContext,
  host: SimpleManagerHost | null,
  spec: string,
  runId: string,
): Promise<{ depsApplied: boolean; pnpmReason?: string; hotApplied: boolean; packageName: string; entryId?: string; state?: string; officialPeers?: string[]; runId: string; hasClient: boolean }> {
  const name = spec.trim()
  if (!name) throw new Error('缺少要临时加载的插件名')

  // 0) runId 由调用方（handler）先经 beginPlan 预创建（前端先拿到 runId 才能轮询 plan 骨架与实时状态）。
  const run = _runs.get(runId)
  if (!run) throw new Error('run 未建立: ' + runId)
  const fail = (text: string): void => {
    appendNote(run, 'err', text)
    finishRun(run)
  }

  // 1) 依赖闭包在 resolve/换键之后装配（见下 deps 步）。
  let depsApplied = false
  let pnpmReason: string | undefined
  let installedDeps: string[] = []

  // 2) 解析真实包名 + 自动换键（须在 pnpmAdd/装配之前）。
  // P-052 机制：宿主拿不到 Node 内部 loadCache（Electron no-realm），模块地图按 specifier 键控、
  // 进程内无公开失效手段——同名包本进程加载过（含已 tempRemove）时，重装同 specifier 必命中旧模块缓存。
  // 故检测到「本进程已加载过同名」且入参为本地包目录时：复制一份临时副本（profile/.dsh-hot/<新名>）并
  // 改写副本 package.json.name 换到全新 specifier 取新码——新 specifier + 新 realpath 双重换键，必读新盘；
  // 源码目录全程零改动。换键原因以 warn + resolve note 透明告知 agent。
  markStep(run, 'resolve', 'running')
  let packageName = specPackageName(name, host?.profileDir ?? undefined) ?? name
  let rekeyNote: string | undefined
  let hotCopyDir: string | undefined
  if (host?.profileDir && seenLocalNames.has(packageName)) {
    const srcDir = packageSourceDir(name)
    if (srcDir && existsSync(srcDir)) {
      try {
        const srcMeta = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8')) as { name?: string }
        const base = String(srcMeta.name ?? packageName).replace(/-hot\d+$/, '')
        hotCopyDir = makeHotCopy(srcDir, host.profileDir, base)
        packageName = String((JSON.parse(readFileSync(join(hotCopyDir, 'package.json'), 'utf8')) as { name?: string }).name)
        hotCopyDirs.set(packageName, hotCopyDir)
        rekeyNote = `同名「${base}」已在本进程加载过：宿主无法回收 Node 模块缓存，已自动复制临时副本「${packageName}」并改写其包名以换取全新 specifier。副本名带 -hotN 且按新名字装配，可能带来：① 注册/存储用包名做键的插件状态（session、channel 路由、持久目录）会落在「副本名下」，与原名的数据隔离、不互通；② 若 packJson 或签名/产物内引用自身原名，改名后可能失配（license/Map 校验类）。副本用后即删（pm_tempRemove）不累积，转正(pm_promote)后以原名持久、不再用副本。`
      } catch (e) {
        rekeyNote = `同名「${packageName}」已在本进程加载过，但复制换键失败：${e instanceof Error ? e.message : String(e)}；本轮仍会命中旧模块缓存`
      }
    } else {
      rekeyNote = `同名「${packageName}」已在本进程加载过，但入参非本地包目录，无法复制换键；本轮仍会命中旧模块缓存`
    }
  }
  seenLocalNames.add(packageName)
  markStep(run, 'resolve', 'ok', rekeyNote ? `${packageName}（已自动复制换键）` : packageName)
  if (rekeyNote) appendNote(run, 'warn', rekeyNote)
  if (tempInfos.has(packageName)) { fail(`「${packageName}」已经临时加载过了`); throw new Error(`「${packageName}」已经临时加载过了`) }
  if (typeof ctx.loader.create !== 'function') { fail('loader.create 不可用，无法运行时热装'); throw new Error('loader.create 不可用，无法运行时热装') }

  // 1) 真实装包 + 拉齐依赖闭包。依赖获取失败即中止：不再继续 loader.create，避免把「装一半」的
  //    半残实例挂进运行内核（依赖未到位 → create 仍可能 apply 成功 → 路由/服务被占、且残留为
  //    无法回收的幽灵 active 实例，P-036/P-043 实证）。
  markStep(run, 'deps', 'running')
  if (host && host.profileDir) {
    // 换键时以副本目录为 file: 源（pnpm 依副本新 name 装配）；否则用原始 spec。
    // 热装跳过官方业务 peer：不把 @deepseek-ai/dsh-* 装进 profile，让桌面壳 overlay 回落选发行 install 来源，
    // 规避其对「动态热装」官方 peer 二次解析的限制（P-033 设计，官方业务包由发行内嵌提供、无需 profile 重复安装）。
    const specForInstall = hotCopyDir ? 'file:' + hotCopyDir : name
    const out = await pnpmAdd(host.profileDir, specForInstall, { skipOfficialPeers: true })
    depsApplied = out.ok
    if (!depsApplied) {
      pnpmReason = out.message
      markStep(run, 'deps', 'err', out.message)
      fail(`依赖安装失败（${pnpmReason}）——失败即中止，未装配插件；请先解决上述依赖后再加载`)
      throw new Error(`依赖安装失败（${pnpmReason}）`)
    }
    installedDeps = out.installedDeps ?? []
    markStep(run, 'deps', 'ok', installedDeps.length > 0 ? `含补装 ${installedDeps.length} 包` : undefined)
  } else {
    markStep(run, 'deps', 'err', 'profileDir 缺失，无法安装依赖')
    fail('profileDir 缺失，无法安装依赖——失败即中止，未装配插件')
    throw new Error('profileDir 缺失，无法安装依赖')
  }

  // 官方业务 peer 探测：含 @deepseek-ai/dsh-* 时提示桌面壳 overlay 解析限制（不阻塞）。
  const officialPeers = detectOfficialPeerDeps(packageName, host?.profileDir ?? undefined)
  if (officialPeers && officialPeers.length > 0) {
    appendNote(run, 'warn', `该插件依赖官方业务包 ${officialPeers.join('/')}，桌面对动态热装的官方 peer 解析可能受限`)
  }

  // client 板块前置探测：声明了 client 但产物缺失/为空 → 刷新渲染器会整体导入坏 client 而崩溃（P-041）。
  // 只做存在性校验并强警告，不阻断宿主侧装配（宿主 entry 与渲染端 client 彼此独立）。
  const clientArt = detectClientArtifact(locateClientRoots(packageName, host?.profileDir ?? undefined, tempInfos.get(packageName)?.spec))
  if (clientArt.declared) {
    if (clientArt.artifactExists && clientArt.artifactSize > 0) {
      appendNote(run, 'info', `该插件带 client 板块（web），渲染端刷新时将按装配框架整体导入它；client 资产已就绪（${clientArt.artifactSize}B）`)
    } else {
      appendNote(run, 'err', `该插件声明了 client 板块，但 client 产物缺失或为空（多为 client 编译错误）：刷新渲染器会整体导入坏 client，导致整页报错需回滚重启。请先修复并重新构建 client 后再刷新；当前仅宿主侧已装配、建议不要刷新界面`)
    }
  }

  // 3) 运行时热装：create 的 promise resolve = entry 装配/apply 成功；import 或 apply 失败时 reject。
  markStep(run, 'assemble', 'running')
  // P-052 模块缓存驱逐：tempRemove/uninstall 只拆装配树与磁盘包，不清 Node ESM loadCache——
  // 同名包在本进程加载过又重装回同一路径时，create 的 import() 命中旧 ModuleJob，装配的是旧代码、
  // 顶层副作用也不重跑（probe 残留/channel 复活的根因，实测复现：拆净+改码+重装仍取旧版）。
  // 故装配前按包真实目录驱逐 loadCache + require.cache（HMR partialReload 同款术），让 import
  // 未命中、读盘取新码。只清包自身目录，共享依赖不动（保持单实例）；不可用时降级为旧行为不阻断。
  // P-052 CTX 诊断：无条件打印驱逐判定链上的实际变量，定位「同名热装不生效」墙上哪一处。
  // 保留原分支逻辑；诊断信息始终进装配日志（标记 [evict-dx]），不论 evicted 是否 0、是否命中 if。
  const __dx = [`[evict-dx] node=${process.versions.node}`, `electron=${process.versions.electron ?? '-'}`, `inElectron=${!!process.versions.electron}`, `exec=${basename(process.execPath)}/argv0=${basename(process.argv0 ?? '?')}`, `profileDir=${String(host?.profileDir)}`, `packageName=${packageName}`]
  const pkgDir = host?.profileDir ? join(host.profileDir, 'node_modules', packageName) : ''
  __dx.push(`pkgDir=${pkgDir}`, `exists=${pkgDir ? existsSync(pkgDir) : false}`)
  if (host?.profileDir && pkgDir && existsSync(pkgDir)) {
    let realDir = pkgDir
    try { realDir = realpathSync(pkgDir) } catch { /* realpath 失败退回表面路径 */ }
    __dx.push(`realDir=${realDir}`)
    const ev = evictPackageModuleCaches(ctx.loader, realDir)
    __dx.push(`evict={ok:${ev.ok}, src:${ev.source}, esm:${ev.evictedEsm}, cjs:${ev.evictedCjs}${ev.reason ? ', reason:' + ev.reason : ''}${ev.diagnosis ? ', why:' + ev.diagnosis : ''}}`)
    appendNote(run, 'info', __dx.join(' · '))
    if (!ev.ok) {
      console.log(`[dsh-simplemanager] 模块缓存驱逐不可用（${ev.reason}）：同名重装将命中旧模块缓存`)
    } else if (ev.evictedEsm + ev.evictedCjs > 0) {
      appendNote(run, 'info', `已驱逐同名旧模块缓存 ${ev.evictedEsm + ev.evictedCjs} 条（ESM ${ev.evictedEsm} / CJS ${ev.evictedCjs}），本次装配取磁盘新码`)
    }
  } else {
    appendNote(run, 'info', __dx.join(' · '))
  }
  // collectRun 只携带步骤状态 note、不含 info 级 lines——merged 到 resolve 步 note，
  // 让 agent 在 OpResult.steps 里直接读到 [evict-dx]（resolve 必先于 create 成功，任何路径可见）。
  const _dxNote = `[evict-dx] ${__dx.join(' · ')}`
  const _rs = run.states.get('resolve')
  if (_rs) _rs.note = _rs.note ? `${_rs.note} · ${_dxNote}` : _dxNote
  // P-043 失败清理基准：create 前既有 entry id。create 抛错后按包名再探一次，凡本次新出现的半挂 entry
  // 一律拆掉（apply 失败的重叠实例会占用路由/服务/资源），既有健康实例（装前已存在）保持不动，避免误杀。
  let entryIdBeforeCreate: string | undefined
  try { entryIdBeforeCreate = findLoaderEntryId(ctx, packageName) } catch { /* ignore */ }
  let entryId: string
  try {
    entryId = await ctx.loader.create({ name: packageName, config: {}, disabled: false })
    markStep(run, 'assemble', 'ok')
  } catch (error) {
    try {
      const staleId = findLoaderEntryId(ctx, packageName)
      if (typeof staleId === 'string' && staleId !== entryIdBeforeCreate && typeof ctx.loader.remove === 'function') {
        await ctx.loader.remove(staleId).catch(() => {})
        appendNote(run, 'warn', `已清理本次装配失败的半挂 entry ${staleId}`)
      }
    } catch { /* 清理尽力而为 */ }
    // 装配失败即回滚物理残留（P-015 装失败零残留）：本次 deps 步真实 pnpmAdd 进 profile node_modules 的
    // 主包 + 闭包依赖，create 抛错时一并回收——否则该包无 tempInfos/hotInstall 登记，P-033 启动清扫也扫不到，
    // 物理包残留在重启后被 scanCatalog 渲染成「未装配-孤儿」卡片（P-043 只拆了 entry，不拆物理包）。
    if (host?.profileDir && depsApplied) {
      await pnpmRemove(host.profileDir, packageName).catch(() => {})
      for (const dep of installedDeps) await pnpmRemove(host.profileDir, dep).catch(() => {})
      appendNote(run, 'warn', `装配失败已回滚：回收本次热装的物理包 ${packageName} 及 ${installedDeps.length} 个闭包依赖，node_modules 零残留`)
    }
    // 官方 loader 对 apply/import 错会用 { cause } 包装（failed to apply loader entry <id> (<name>): …），
    // 剥 cause 链取最底层 message 才是插件自身的根因；两者不同时并列保留 loader 上下文便于定位。
    let root: unknown = error
    while (root instanceof Error && root.cause) root = root.cause
    const detail = root instanceof Error ? root.message : String(root)
    const context = error instanceof Error && error.message && error.message !== detail
      ? `；loader 上下文：${error.message}`
      : ''
    const reason = detail + context
    const installNote = depsApplied
      ? ''
      : `（前置依赖/包安装未成功：${pnpmReason ?? '包未装入 profile'}，故无法被 loader 解析装配）`
    let nodeModulesHit = '?'
    try {
      if (host?.profileDir) nodeModulesHit = String(existsSync(join(host.profileDir, 'node_modules', packageName)))
    } catch { /* 探测失败即 ? */ }
    markStep(run, 'assemble', 'err', reason)
    const officialNote = officialPeers && officialPeers.length > 0
      ? '. 注意：该插件依赖官方业务包 ' + officialPeers.join('/') + '，桌面壳对动态热装的官方 peer 解析有限制，建议改用官方渠道安装后再用。'
      : ''
    // 诊断字段（nodeModulesHit/exec/argv0/profileDir）只进服务端日志，不堆进用户可见错误，避免 flash/日志冗长重复。
    console.log(`[dsh-simplemanager] tempLoad 热装失败 profileDir=${host?.profileDir} depsApplied=${depsApplied} nodeModulesHit=${nodeModulesHit} exec=${basename(process.execPath)}/argv0=${basename(process.argv0 ?? '?')} spec=${name} rootCause=${detail}`)
    const errText = `运行时热装失败（${packageName}）${installNote}${officialNote}：${reason}`
    fail(errText)
    throw new Error(errText)
  }

  // 4) 读 fiber 态供 UI 观测（create 成功但非 active 的极少数情况也如实上报）。
  markStep(run, 'state', 'running')
  let state: string | undefined
  try {
    const e = ctx.loader.resolve?.(entryId)
    const raw = e?.fiber?.state
    if (typeof raw === 'number' && raw >= 0 && raw < FIBER_PHASE.length) state = FIBER_PHASE[raw]
  } catch { /* 读态失败不影响结果 */ }
  markStep(run, 'state', 'ok', state ?? 'active')

  // 5) 镜像临时态（面板展示、卸载引用计数用）。spec 保留原始输入，供 promote 原样 re-add；换键时
  //    spec 记录为副本 file: 源，使 tempRemove 依副本新名正确拆 entry + 清物理。
  markStep(run, 'finish', 'running')
  tempInfos.set(packageName, { entryId, spec: hotCopyDir ? 'file:' + hotCopyDir : name, installedDeps, hotCopy: hotCopyDir, baseDir: hotCopyDir ? (packageSourceDir(name) ?? undefined) : undefined })
  host?.pushHotInstall(packageName)
  // 热装 = 重新安装该插件：清掉本会话的「已卸载待消失」标记，否则 buildView 会把它过滤掉，点了热装却不见卡。
  // 注意不能靠「live 是否命中」判断——「卸载但装配未拆干净、待重启消失」的插件一样 live 命中，
  // 那正是要继续过滤的场合，故须显式删除该标记。
  recentlyUninstalled.delete(packageName)
  markStep(run, 'finish', 'ok', state ?? 'active')
  finishRun(run)
  return { depsApplied, pnpmReason, hotApplied: true, packageName, entryId, state, officialPeers, runId, hasClient: clientArt.declared }
}

/** 探测插件的「官方业务 peer」：peerDependencies 中含 `@deepseek-ai/dsh-*`（被桌面壳 overlay 管理，
 * 动态热装对此类 peer 的二次解析存在桌面壳限制，见 C-observed）。纯工具包 cordis/schemastery 不算。
 * 读不到 manifest 或无可疑 peer 时返回 undefined/空数组，不抛错。 */
/** 卸载一只临时插件（只接受本面板临时 create 过的 entry）。顺带回收本次临时加载补装的闭包依赖：
 * 仅当该依赖不再被其他活跃临时插件引用时才 `pnpm remove`（引用计数），保证依赖闭包随装卸完整进退。 */
async function tempRemove(ctx: AppContext, host: SimpleManagerHost | null, name: string, runId: string): Promise<{ runId: string }> {
  const run = _runs.get(runId)
  if (!run) throw new Error('run 未建立: ' + runId)
  const fail = (text: string): void => { appendNote(run, 'err', text); finishRun(run) }
  if (typeof ctx.loader.remove !== 'function') { fail('loader 不可用，无法卸载'); throw new Error('loader 不可用，无法卸载') }
  const info = tempInfos.get(name)
  if (!info) { fail(`「${name}」不是本面板临时加载的插件，不能从这里卸载`); throw new Error(`「${name}」不是本面板临时加载的插件，不能从这里卸载`) }

  markStep(run, 'unload', 'running')
  // P-044 先在运行时断开再物理移出：update({disabled:true}) 会联动卸载该 entry 已装入宿主/注入的服务
  // （含 webserver/SessionPointerResolver 等按 scope 注册的资源），随后再 loader.remove 移出装配树。
  // 仅 remove 一删了之时，已注册的 webserver 路由（如 prefix /api/recorder）不会随 entry 解绑，
  // 致同类插件「热装→X卸载→热装」稳定撞 duplicate prefix route（实测 100% 复现）。
  if (typeof ctx.loader.update === 'function') {
    try { await ctx.loader.update(info.entryId, { disabled: true }) } catch { /* 尽力而为，不阻断卸载 */ }
  }
  // loader.remove 尽力而为：半挂/已被 update 联动销毁/deactivate 抛错时 remove 可能抛错，但绝不能因此中断
  // 后续的物理 pnpmRemove 与登记擦除——否则 node_modules 残留 → 重启后被 scanCatalog 渲染成「未装配-孤儿」卡片。
  try { await ctx.loader.remove(info.entryId) } catch (e) {
    appendNote(run, 'warn', `loader.remove 未能彻底拆除 entry（${e instanceof Error ? e.message : String(e)}），已继续物理/登记回收`)
  }
  markStep(run, 'unload', 'ok')
  tempInfos.delete(name)
  host?.forgetHotInstall(name)

  // hostOverlay 级擦除（对齐 uninstall）：host 级注入服务/装配登记/闭包映射/工具分组随卸载一起清，
  // 避免「热装→卸载→再热装」时宿主上残留脏装配与配置数据。setPatchEnabled/removeBundle* 对非持久临时插件
  // 本是无操作，但同一份 host 登记方法在少数被持久化过的临时副本上必须同步清，防止调试脏数据复现。
  if (host) {
    host.setPatchEnabled(name, name, false)
    host.removeBundle(name)
    host.removeBundleEntry(name)
    // 闭包映射归零，杜绝宿主上挂接的闭包引用残留。
    host.setClosureDeps(name, [])
    // 自持数据清理（与 uninstall 的 data 块同源）：别名/备注/装配指派/工具分组引用随卸载一并擦除，
    // 避免「热装→卸载→再热装」时宿主上残留脏装配与配置数据。
    const overlay = host.readOverlay()
    delete overlay.notes[name]
    delete overlay.aliases[name]
    delete overlay.assignments[name]
    if (overlay.toolGroupOverrides) {
      for (const [tool, key] of Object.entries(overlay.toolGroupOverrides)) {
        if (key === name) delete overlay.toolGroupOverrides[tool]
      }
    }
    host.writeOverlay(overlay)
  }

  markStep(run, 'deps', 'running')
  if (host && host.profileDir) {
    // 主包物理：临时卸载即回收，装卸对称（与 promote/uninstall 移除装配登记后回收文件一致）。
    // 仅当仍被其他活跃临时插件或持久装配间接依赖其包名时才保留。P-041 同根：物理随装配状态进退，
    // 不再把「node_modules 里有该包」误当持久装配遗留为幽灵条目。
    const packageName = specPackageName(info.spec) ?? name
    const stillNeeded = new Set<string>()
    for (const [, o] of tempInfos) for (const d of o.installedDeps) stillNeeded.add(specPackageName(d) ?? d)
    for (const b of buildCatalog(ctx, host)) {
      if (b.name === packageName) continue
      for (const d of b.dependencies) stillNeeded.add(specPackageName(d) ?? d)
    }
    if (!stillNeeded.has(packageName)) {
      await pnpmRemove(host.profileDir, packageName).catch(() => { /* 回收尽力而为，失败不阻断卸载 */ })
      // 物理兜底（与 uninstall 一致）：pnpm remove 只删它登记过的包；若该包是历史 file: 真拷贝留下的
      // 孤儿目录（pnpm-lock 无记录），pnpm 删不掉，重启后会被 scanCatalog 扫回标成 source=profile。
      // 对确认不再被需要的临时插件物理目录强删，保证调试「热装→卸载→再热装」零残留。
      const pkgPhysical = join(host.profileDir, 'node_modules', packageName)
      if (existsSync(pkgPhysical)) {
        try { rmSync(pkgPhysical, { recursive: true, force: true }) } catch { /* 物理兜底尽力而为 */ }
      }
    }
    if (info.installedDeps.length > 0) {
      for (const dep of info.installedDeps) {
        const neededByOther = [...tempInfos.values()].some((o) => o.installedDeps.includes(dep))
        if (neededByOther) continue
        await pnpmRemove(host.profileDir, dep).catch(() => { /* 回收尽力而为，失败不阻断卸载 */ })
      }
    }
    // 换键副本回收：热装换键时生成的 .dsh-hot/<新名> 副本随卸载即删，致零残留（源码目录不受影响）。
    if (info.hotCopy) {
      try { rmSync(info.hotCopy, { recursive: true, force: true }) } catch { /* 清理尽力而为 */ }
      hotCopyDirs.delete(packageName)
    }
  }
  markStep(run, 'deps', 'ok')

  markStep(run, 'finish', 'running')
  markStep(run, 'finish', 'ok', name)
  finishRun(run)
  return { runId }
}

/**
 * 真注入：把一只临时插件持久化装配进 profile。
 * 1) pnpm add <spec> —— 把插件物理装入共享 node_modules 并装齐依赖闭包（普适化依赖获取）；
 * 2) 写 profile 层 patch（setPatchEnabled）把插件真实包名登记进装配清单 → 重启后被 loader 装配。
 * 登记走官方「profile 层 patch 最后应用」语义，不依赖插件是否声明 dsh.bundle.patch。
 */
async function promote(ctx: Context, host: SimpleManagerHost, name: string, runId: string): Promise<{ packageName: string; assembled: boolean; runId: string }> {
  const run = _runs.get(runId)
  if (!run) throw new Error('run 未建立: ' + runId)
  const fail = (text: string): void => { appendNote(run, 'err', text); finishRun(run) }
  const info = tempInfos.get(name)
  if (!info) { fail(`「${name}」不是本面板临时加载的插件，无法转正`); throw new Error(`「${name}」不是本面板临时加载的插件，无法转正`) }
  // B5：热装换键（-hotN）是为绕开进程内模块缓存而改的临时身份，转正必须回到逻辑原名持久——
  // 否则会把 -hotN 写进 patch，重启后持久身份错成「xxx-hotN」且与盘上 base 包不符导致悬空。
  // baseDir 记的是换键前的原始源目录，promote 以它为 file: 源安装，持久装配的就是真正的逻辑插件。
  const persistName = (specPackageName(info.spec) ?? name).replace(/-hot\d+$/, '')
  const persistSpec = info.baseDir ? 'file:' + info.baseDir : info.spec
  const packageName = persistName

  // 冲突检测（判据6：不重复物理安装、不覆盖已持久装配）。同名「已持久装配」存在 → 阻止转正，避免覆盖已装文件/装配冲突。
  // 注意：热装(tempLoad) 会真实把包链进 profile node_modules，因此 scanCatalog() 必定能扫到本包——而它正是本次要转正的
  // 对象自身的物理文件，不代表「已持久安装」。真正代表持久装配的是 bundles 装配清单 + patch 启用层（P-041 误判修复）。
  markStep(run, 'deps', 'running')
  const persistent =
    host.readBundles().has(packageName) ||
    host.readPatchEnabledIds().has(packageName)
  if (persistent) {
    markStep(run, 'deps', 'err', `「${packageName}」已是持久安装，无需转正`)
    fail(`「${packageName}」已是持久安装的插件，不能转正（避免与已装文件/装配冲突）`)
    throw new Error(`「${packageName}」已是持久安装的插件，不能转正`)
  }
  // 与 tempLoad 一致跳过官方业务 peer：官方 @deepseek-ai/dsh-* 由桌面壳发行内嵌提供，
  // 不装进 profile、也不记入 closureDeps——否则卸载时会把官方核心依赖当可回收闭包逐个
  // pnpm remove，破坏基础功能（P-042，promote 曾漏传 skipOfficialPeers）。
  const outcome = await pnpmAdd(host.profileDir, persistSpec, { skipOfficialPeers: true })
  if (!outcome.ok) {
    // 闭包补装失败时 pnpmAdd 已尽力回收闭包；此处把已链接的插件本身也回收，转正失败不残留。
    await pnpmRemove(host.profileDir, packageName).catch(() => {})
    markStep(run, 'deps', 'err', outcome.message)
    fail(`转正失败：依赖安装失败（${outcome.message}）`)
    throw new Error(`依赖安装失败：${outcome.message}`)
  }
  markStep(run, 'deps', 'ok')

  markStep(run, 'verify', 'running')
  const verify = verifyInstalled(host.profileDir, packageName)
  if (!verify.ok) {
    // 校验不过回滚：插件包 + 本次补装的全部闭包依赖一并移除，依赖闭包完整进退。
    await pnpmRemove(host.profileDir, packageName)
    for (const dep of outcome.installedDeps ?? []) await pnpmRemove(host.profileDir, dep).catch(() => {})
    markStep(run, 'verify', 'err', verify.reason)
    fail(`转正失败：安装校验未通过（${verify.reason}）`)
    throw new Error(`安装校验未通过，已回滚：${verify.reason}`)
  }
  markStep(run, 'verify', 'ok')

  markStep(run, 'register', 'running')
  const assembled = host.setPatchEnabled(packageName, packageName, true)
  markStep(run, 'register', 'ok', '重启后生效')
  // 记录本次转正补装的闭包依赖，供真卸载（uninstall）回收——依赖闭包随装卸完整进退。
  host.setClosureDeps(packageName, outcome.installedDeps ?? [])
  // 已转正为正式装配，不再算待清理的手热装残留（普通热装按原名 forget）。
  // 注意：换键副本名**保留**在 hotInstalls——它是「原名的本进程替身」，本进程仍 active 供 agent 继续调试；
  // 重启后副本物理包 + .dsh-hot 目录由启动守护 P-052 统一回收（此时 patch 已按原名持久，副本不再是任何装配源）。
  if (!info.hotCopy) host.forgetHotInstall(packageName)
  // 已持久化装配：从临时闭包移除，改记为「已转正待重启」，重启后由 patch 装配为持久
  // （本次进程内副本 entry 继续 active 运行至退出，UI 以 promoted 档位标记，避免与持久安装混淆）。
  tempInfos.delete(name)
  promotedPending.add(packageName)

  markStep(run, 'finish', 'running')
  markStep(run, 'finish', 'ok', packageName)
  finishRun(run)
  return { packageName, assembled, runId }
}

/**
 * 真卸载：把一只已安装（persistent）的第三方插件完整移除。
 * 纪律（判据 6「依赖闭包随装卸完整进退」+ 官方渠道）：
 *   - 仅允许卸载 profile 层第三方插件；官方内核/壳运行时组件拒绝（护住基础功能）；
 *   - 先移除 profile 层 patch 装配登记（与启用同源，官方「最后应用」语义），运行时 entry 存活则一并销毁（热卸）;
 *   - 再 pnpm remove 物理移除插件包 + 按引用回收补装的依赖闭包（其他已装插件/活跃临时插件仍需则保留）；
 *   - 最后清理该插件的自持数据（文件夹分配/备注/别名/闭包记录），不留残留。
 */
async function uninstall(ctx: AppContext, host: SimpleManagerHost, name: string, runId: string, clearData = false): Promise<{ packageName: string; runId: string }> {
  const run = _runs.get(runId)
  if (!run) throw new Error('run 未建立: ' + runId)
  const fail = (text: string): void => { appendNote(run, 'err', text); finishRun(run) }
  const bundle = buildCatalog(ctx, host).find((b) => b.name === name)
  if (!bundle) { fail('插件不存在: ' + name); throw new Error('插件不存在: ' + name) }
  if (bundle.scope === 'official') { fail('官方内核插件不可从面板卸载'); throw new Error('官方内核插件不可从面板卸载') }
  if (bundle.scope === 'shell') { fail('桌面壳组件不可从面板卸载'); throw new Error('桌面壳组件不可从面板卸载') }
  const packageName = bundle.name

  // 0) 移除装配：patch 登记移除 + 若在运行则销毁当前 entry（热卸载）。
  markStep(run, 'deregister', 'running')
  const live = loaderLiveMap(ctx).get(name)
  if (live?.entryId && typeof ctx.loader.remove === 'function') {
    await ctx.loader.remove(live.entryId).catch(() => {})
  }
  tempInfos.delete(packageName)
  host.setPatchEnabled(packageName, packageName, false)
  // 官方渠道登记清理：从 package.json 的 bundles 装配清单移除，避免重启解析已删包报错（P-033 顺带发现）。
  host.removeBundle(packageName)
  // 官方 bundle 层装配清单（cordis.yml）清理：官方 `dsh plugin add` 的自装/第三方插件登记于此，卸载若不清，
  // 重启后 loader 仍由该清单装配 entry → 插件残留在列表且仍可启停（P-039）。
  host.removeBundleEntry(packageName)
  markStep(run, 'deregister', 'ok')

  // 1) 物理移除 + 依赖闭包按引用回收。
  markStep(run, 'remove', 'running')
  let closure = host.getClosureDeps(packageName)
  if (closure.length === 0 && bundle.dependencies.length > 0) {
    // 非管家记录来源（外部安装的第三方）：以其 manifest 声明的直接依赖作为回收候选，
    // 交由下方「按引用保护」判定——仍在被其他插件/活跃临时插件/其他闭包使用则保留，仅回收独占闭包。
    closure = bundle.dependencies.map((d) => specPackageName(d) ?? d).filter((x): x is string => x.length > 0)
  }
  await pnpmRemove(host.profileDir, packageName)
  host.forgetHotInstall(packageName)
  // 兜底物理清理：pnpm remove 只删它登记过的包；若该包在 profile node_modules 是 pnpm 不识别的
  // 孤儿目录（pnpm-lock 无记录，历史 file: 真拷贝所致），pnpm 删不掉、重启后 scanCatalog 又会把它
  // 扫回列表标成 source=profile。此处对确认卸载的第三方包物理目录强删，杜绝卸载后残留（P-043）。
  const pkgPhysical = join(host.profileDir, 'node_modules', packageName)
  if (existsSync(pkgPhysical)) {
    // force:true 目录不存在时不抛错；递归删除该第三方包物理目录，pnpm 未识别的孤儿目录也能清掉。
    rmSync(pkgPhysical, { recursive: true, force: true })
  }
  if (closure.length > 0) {
    const stillNeeded = new Set<string>()
    const mark = (spec: string): void => {
      const bare = specPackageName(spec) ?? spec
      if (bare) stillNeeded.add(bare)
    }
    for (const b of buildCatalog(ctx, host)) {
      if (b.name === packageName) continue
      for (const d of b.dependencies) mark(d)
    }
    for (const [, info] of tempInfos) for (const d of info.installedDeps) mark(d)
    for (const [pn, deps] of Object.entries(host.readOverlay().closureDeps)) {
      if (pn === packageName) continue
      for (const d of deps) mark(d)
    }
    let removed = 0
    for (const dep of closure) {
      // 官方系统依赖绝不回收（P-042 兜底）：即使 closureDeps 因历史脏数据/未来缺陷混入官方内嵌包，
      // 也直接跳过，防止物理删除 + 清掉 profile 声明导致重启崩 (基础功能红线)。
      if (isOfficialSystemDep(dep)) continue
      if (stillNeeded.has(dep)) continue
      await pnpmRemove(host.profileDir, dep).catch(() => { /* 回收尽力而为 */ })
      removed += 1
    }
    markStep(run, 'remove', 'ok', removed > 0 ? `移除了 ${removed} 个未被引用的依赖` : '闭包依赖全部仍被引用，未移除')
  } else {
    markStep(run, 'remove', 'ok')
  }
  host.setClosureDeps(packageName, [])

  // 2) 清理自持数据不残留。
  markStep(run, 'data', 'running')
  const overlay = host.readOverlay()
  delete overlay.notes[packageName]
  delete overlay.aliases[packageName]
  delete overlay.assignments[packageName]
  // 卸载插件后，资源管理里归到该插件卡片的工具引用一并清空（回未分组），避免悬空卡片。
  if (overlay.toolGroupOverrides) {
    for (const [tool, key] of Object.entries(overlay.toolGroupOverrides)) {
      if (key === packageName) delete overlay.toolGroupOverrides[tool]
    }
  }
  host.writeOverlay(overlay)
  // 用户要求「同时清除该插件缓存/配置」时：删除插件落在 home/.dsh 下的数据目录候选。
  // 候选取「完整包名 / 去 dsh- 前缀短名 / 去 @scope 作用域短名」三种、去重后只删存在的，
  // 且限定在 ~/.dsh 直接子目录，绝不触碰 profileDir / node_modules，也不删 any 无关目录。
  // 无论命中与否都写一条日志，保证"清除缓存"这一步在卸载日志里有据可查（不再是静默步骤）。
  if (clearData) {
    const homeData = join(homedir(), '.dsh')
    const shortName = packageName.slice(packageName.lastIndexOf('/') + 1)
    const names = [packageName, packageName.replace(/^dsh-/, ''), shortName]
    const candidates = [...new Set(names)]
      .map((c) => join(homeData, c))
      .filter((p) => existsSync(p))
    if (candidates.length === 0) {
      appendNote(run, 'info', '未发现该插件独立的自持数据目录，无需额外清理（已清除装配登记与备注/分类）')
    }
    for (const p of candidates) {
      try {
        rmSync(p, { recursive: true, force: true })
        appendNote(run, 'ok', `已清除插件本地数据目录：${p}`)
      } catch (e) {
        appendNote(run, 'warn', `清理本地数据目录失败（因异常跳过，不阻断卸载）：${String(e)}`)
      }
    }
  }
  markStep(run, 'data', 'ok')

  // 卸载成功：清掉历史热插拔档位残留（promoted 的「待重启」徽标对该已卸载插件不再成立），
  // 并记入本会话 recentlyUninstalled——若 loader 未能即时拆除 / 桌面壳复核写回导致列表仍显示该条目，
  // buildView 会据此把残留正确标记为「已卸载、不可启停」，而非正常可装可启停插件（P-039）。
  promotedPending.delete(packageName)
  recentlyUninstalled.add(packageName)

  markStep(run, 'finish', 'running')
  markStep(run, 'finish', 'ok', packageName)
  finishRun(run)
  return { packageName, runId }
}

/**
 * 内核切换已移除：桌面壳捆绑内核，无法运行时切换；内核升级一律走官方发行渠道。
 */
function resolveProfileDir(ctx: Context): string {
  const profiles = ctx.get('desktopProfiles') as DesktopProfiles | undefined
  if (profiles?.current?.dir && typeof profiles.current.dir === 'string') return profiles.current.dir
  // web/CLI 无桌面壳服务：用插件自身安装位置反推所在 profile，避免回退到进程 cwd
  // （进程 cwd 可能是 pnpm workspace 根，会让 pnpm add 误判「加到 workspace root」而拒绝）。
  const selfHome = homeProfileDir()
  if (selfHome) return selfHome
  // 补充：`link:` 装配时（profile 的 package.json 里 dependencies 用 link: 指向插件源码目录，
  // 如 `"dsh-plugin-simplemanager": "link:D:/.../preview"`），Node 会把 import.meta.url 解析成
  // 源码真实路径、里面不含 node_modules，homeProfileDir 必然落空。此时扫描 DSH 家目录下所有
  // profile，找「node_modules/<本插件名> 的符号链接真实指向 == 本插件真实包根」的那个 profile。
  const linkedHome = linkedProfileDir()
  if (linkedHome) return linkedHome
  return process.cwd()
}

/** 插件被装配在 <profile>/node_modules/<包>/lib 下，从自身 URL 反推其所在 profile 目录。 */
function homeProfileDir(): string | null {
  try {
    const self = fileURLToPath(import.meta.url)
    const i = self.indexOf('node_modules')
    if (i <= 0) return null
    const home = self.slice(0, i).replace(/[\\/]$/, '')
    return home.length ? home : null
  } catch {
    return null
  }
}

/** `link:` 装配反推：找到把本插件以符号链接装进自己 node_modules 的那个 profile 目录。 */
function linkedProfileDir(): string | null {
  try {
    const self = fileURLToPath(import.meta.url)
    // 本插件真实包根：从 lib/<entry>.js 向上走到第一个含 package.json 的目录。
    let root = dirname(self)
    while (root && root !== dirname(root) && !existsSync(join(root, 'package.json'))) root = dirname(root)
    if (!root || !existsSync(join(root, 'package.json'))) return null
    const selfRoot = realpathSync(root)
    const selfName = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string }).name
    if (typeof selfName !== 'string' || selfName === '') return null
    const home = process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh')
    const profilesRoot = join(home, 'profiles')
    if (!existsSync(profilesRoot)) return null
    const same = (a: string, b: string): boolean =>
      process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
    for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const nm = join(profilesRoot, entry.name, 'node_modules', selfName)
      if (!existsSync(nm)) continue
      try {
        if (same(realpathSync(nm), selfRoot)) return join(profilesRoot, entry.name)
      } catch {
        // 坏链接/权限异常：跳过该 profile 继续扫描
      }
    }
    return null
  } catch {
    return null
  }
}

function readJsonBody(req: any): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.trim() === '' ? {} : (JSON.parse(text) as Record<string, unknown>))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * —— 面向 agent 的执行器（v6）——
 * 在 apply 闭包内构造，封装现有热插拔闭环（tempLoad/tempRemove/promote/uninstall）与只读体检
 * （status），供 agent-tools.ts 的 defineTool 薄装配。无 tools 宿主静默不注册。
 *
 * 每个变更操作都先 beginPlan 建 run 再调底层函数，返回时统一收敛为 OpResult（逐步结果 + 终态 +
 * 是否残留），并把该 run 从内存清走（agent 一次性会话，不留无人消费的 run 快照）。
 */
function makeAgentOps(ctx: AppContext, host: SimpleManagerHost): AgentOps {
  /** 从 run 快照收敛出 OpResult 的 steps / 残留判定，并回收该 run。 */
  const collectRun = (action: OpResult['action'], runId: string): { steps: OpStep[]; hasErr: boolean; errNote?: string } => {
    const run = _runs.get(runId)
    _runs.delete(runId)
    if (!run) return { steps: [], hasErr: false }
    const steps: OpStep[] = [...run.states.values()].map((s) => ({
      key: s.key,
      status: s.status,
      elapsed: s.elapsed,
      note: s.note,
    }))
    const errStep = steps.find((s) => s.status === 'err')
    return { steps, hasErr: steps.length > 0 && !!errStep, errNote: errStep?.note }
  }

  const status = (name: string): StatusDTO => {
    const key = name.trim()
    const bundle = host ? buildCatalog(ctx, host).find((b) => b.name === key) : undefined
    const live = loaderLiveMap(ctx).get(key)
    const info = tempInfos.get(key)
    const scope = (bundle?.scope ?? 'third') as StatusDTO['scope']
    const persistent =
      !!host && (host.isBundleAssembled(key) || host.readPatchEnabledIds().has(key))
    const isTemp = !!info
    const present = !!(bundle || isTemp || live)

    let phase: StatusDTO['phase']
    if (!present) phase = 'absent'
    else if (isTemp) phase = 'temporary'
    else if (scope === 'third' && !persistent) phase = 'orphan'
    else phase = 'persistent'

    // 运行态轴（fiber），与 phase 来源轴解耦——避免临时态用 phase 盖掉真实 fiber（B4）。
    let runtime: StatusDTO['runtime']
    if (!present || !live) runtime = 'none'
    else if (live.enabled === false) runtime = 'disabled'
    else runtime = (live.phase ?? 'loading') as StatusDTO['runtime']

    let hotLoadable = true
    let reason: string | null = null
    if (!key) { hotLoadable = false; reason = '缺少插件名' }
    else if (scope === 'official' || scope === 'shell') { hotLoadable = false; reason = '官方/壳组件不可热装' }
    else if (isTemp) { hotLoadable = false; reason = '已临时加载，先 pm_tempRemove 或 pm_promote' }
    else if (persistent) { hotLoadable = false; reason = '已是持久安装，无需热装' }

    return {
      name: key,
      present,
      phase,
      runtime,
      scope,
      hotLoadable,
      reason,
      depCount: info?.installedDeps.length ?? 0,
      // status 是同步快照，守卫未命中的具体服务名不在此详查：agent 需要时用 pm_probe 真实探针实测。
      pendingServices: [],
      cleanupable: scope === 'third' && !!bundle && !isTemp && !persistent,
      entryId: live?.entryId ?? info?.entryId ?? null,
    }
  }

  const tempLoadOps = async (spec: string): Promise<OpResult> => {
    const runId = beginPlan('tempLoad', ALL_PLANS.tempLoad)
    let packageName: string | undefined
    let hasClient: boolean | undefined
    try {
      // 自动连携链（单实例保障）：调用前先检查同逻辑名（去 -hotN）是否已有活动临时实例；
      // 有则先自动 tempRemove 再装载，保证「同名再装」不双开——换键不再叠加新实例（P-052 机制下只留一个最新键）。
      const base = logicBaseOfSpec(spec, host)
      const run = _runs.get(runId)
      const stale = base ? [...tempInfos.keys()].filter((k) => k.replace(/-hot\d+$/, '') === base) : []
      if (stale.length > 0) {
        const unloaded: string[] = []
        for (const oldName of stale) {
          const r = await tempRemoveOps(oldName)
          if (r.ok) unloaded.push(oldName)
        }
        if (unloaded.length > 0 && run) {
          appendNote(run, 'info', `检测到既有临时实例「${unloaded.join('、')}」，已自动卸载后再重新热装（单实例保障，避免同名双开）`)
        }
      }
      const r = await tempLoad(ctx, host, spec, runId)
      packageName = r.packageName
      hasClient = r.hasClient
    } catch (error) {
      const { steps, errNote } = collectRun('tempLoad', runId)
      return { ok: false, action: 'tempLoad', outcome: 'fail', steps, residue: true, error: errNote ?? (error instanceof Error ? error.message : String(error)) }
    }
    const { steps, hasErr, errNote } = collectRun('tempLoad', runId)
    // 已装配但 entry 在 loader 门禁挂起 → not 真可调试，终态标记 pending 让 agent 知晓。
    const live = packageName ? loaderLiveMap(ctx).get(packageName) : undefined
    const outcome: OpResult['outcome'] = live?.phase === 'pending' ? 'pending' : 'pass'
    // 仅带前端板块的插件才给 reload 引导：本次改动若要用户在面板查看/检查新前端则需 pm_reloadClient；
    // 纯内核改动、用户无需查看时不出现。是否「需要用户看」由 agent 判断。
    const hint = hasClient
      ? '本插件带前端板块：若本次改动需要用户在面板查看/检查新前端（如新增卡片/组件/入口等可见内容），调用 pm_reloadClient 重载界面后在面板显现；若只是内部逻辑改动、用户无需查看，则无需重载。'
      : undefined
    return { ok: !hasErr, action: 'tempLoad', packageName, outcome, steps, residue: hasErr, error: errNote, hint }
  }

  const tempRemoveOps = async (name: string): Promise<OpResult> => {
    const runId = beginPlan('tempRemove', ALL_PLANS.tempRemove)
    try {
      await tempRemove(ctx, host, name, runId)
    } catch (error) {
      const { steps, errNote } = collectRun('tempRemove', runId)
      return { ok: false, action: 'tempRemove', outcome: 'fail', steps, residue: true, error: errNote ?? (error instanceof Error ? error.message : String(error)) }
    }
    const { steps, hasErr, errNote } = collectRun('tempRemove', runId)
    return { ok: !hasErr, action: 'tempRemove', packageName: name, outcome: hasErr ? 'fail' : 'pass', steps, residue: hasErr, error: errNote }
  }

  const promoteOps = async (name: string): Promise<OpResult> => {
    const runId = beginPlan('promote', ALL_PLANS.promote)
    let packageName: string | undefined
    try {
      packageName = (await promote(ctx, host, name, runId)).packageName
    } catch (error) {
      const { steps, errNote } = collectRun('promote', runId)
      return { ok: false, action: 'promote', outcome: 'fail', steps, residue: true, error: errNote ?? (error instanceof Error ? error.message : String(error)) }
    }
    const { steps, hasErr, errNote } = collectRun('promote', runId)
    return { ok: !hasErr, action: 'promote', packageName, outcome: hasErr ? 'fail' : 'pass', steps, residue: hasErr, error: errNote }
  }

  const uninstallOps = async (name: string, clearData = false): Promise<OpResult> => {
    const runId = beginPlan('uninstall', ALL_PLANS.uninstall)
    let packageName: string | undefined
    try {
      packageName = (await uninstall(ctx, host, name, runId, clearData)).packageName
    } catch (error) {
      const { steps, errNote } = collectRun('uninstall', runId)
      return { ok: false, action: 'uninstall', outcome: 'fail', steps, residue: true, error: errNote ?? (error instanceof Error ? error.message : String(error)) }
    }
    const { steps, hasErr, errNote } = collectRun('uninstall', runId)
    return { ok: !hasErr, action: 'uninstall', packageName, outcome: hasErr ? 'fail' : 'pass', steps, residue: hasErr, error: errNote }
  }

  const reloadClient = (): ReloadClientDTO => {
    const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    pendingReload = { ts: Date.now(), nonce }
    return { ok: true, nonce, note: '已登记刷新渲染进程请求；面板可见时前端轮询到即重载（仅刷新渲染进程，不重启内核，会话与热装状态保留，零检测）' }
  }

  const probeProfileDir = host?.profileDir ?? ''
  const resolveProbeCandidate = (name: string | undefined, spec?: string): { candidateName: string; srcDir: string | undefined } => {
    // 候选源：显式 spec（本地路径/file:/link:/registry 包名）优先——probe 不依赖 tempLoad 登记；
    // 未传 spec 时按包名回落：已热装 temp 源 → profile node_modules。
    let candidateName = typeof name === 'string' ? name.trim() : ''
    let srcDir: string | undefined
    if (typeof spec === 'string' && spec.trim() !== '') {
      const s = spec.trim()
      candidateName = specPackageName(s, probeProfileDir) ?? candidateName
      srcDir = packageSourceDir(s) ?? (candidateName ? join(probeProfileDir, 'node_modules', candidateName) : undefined)
    } else {
      const tempSpec = tempInfos.get(candidateName)?.spec
      srcDir = tempSpec ? packageSourceDir(tempSpec) : (candidateName ? join(probeProfileDir, 'node_modules', candidateName) : undefined)
    }
    return { candidateName, srcDir }
  }
  const probeDto = (r: RunProbeResult, plugins: string[]): ProbeDTO => ({
    ok: r.outcome === 'pass',
    plugins,
    outcome: r.outcome,
    rendered: r.rendered,
    culprit: r.culprit ?? undefined,
    steps: r.steps,
    summary: describeOutcome(r),
    error: r.error,
    elapsedMs: r.elapsedMs,
    kept: r.kept ?? undefined,
    keptPid: r.keptPid ?? undefined,
    keptPort: r.keptPort ?? undefined,
    keptUrl: r.keptUrl ?? undefined,
    keptDir: r.keptDir ?? undefined,
  })
  // 一组候选共存于同一个隔离实例：一次 pnpm 装配、一个内核、一个 URL——
  // 探测的是插件间的真实共存效果，而非逐个单点。
  const probeSet = async (candidates: ProbeCandidate[], keep: boolean): Promise<ProbeDTO> => {
    const r = await runProbe({
      candidates,
      profileDir: probeProfileDir,
      stateRoot: host.dataDir,
      companions: collectProbeCompanions(ctx, host, probeProfileDir, candidates.map((c) => c.name)),
      keep,
    })
    return probeDto(r, candidates.map((c) => c.name))
  }
  const probe = async (name: string | undefined, keep: boolean, spec?: string): Promise<ProbeDTO> => {
    const { candidateName, srcDir } = resolveProbeCandidate(name, spec)
    if (!candidateName || !srcDir || !existsSync(srcDir)) {
      return { ok: false, plugins: candidateName ? [candidateName] : [], outcome: 'error', rendered: false, steps: [], summary: `候选插件源目录不存在: ${srcDir ?? (candidateName || '(未提供 name/spec)')}`, error: '候选插件源目录不存在', elapsedMs: 0 }
    }
    return await probeSet([{ name: candidateName, dir: srcDir }], keep)
  }
  // 批量探针：specs 全部共存于同一个隔离实例。解析失败的 spec 单独列入 unresolved 不拖垮其余；
  // 同名去重（先到先得）。
  const probeMany = async (specs: string[], keep: boolean): Promise<ProbeDTO> => {
    const t0 = Date.now()
    const list = (Array.isArray(specs) ? specs : []).map((s) => (typeof s === 'string' ? s.trim() : '')).filter((s) => s !== '')
    if (list.length === 0)
      return { ok: false, plugins: [], unresolved: [], action: 'probe-batch', outcome: 'error', rendered: false, steps: [], summary: 'specs 为空', elapsedMs: 0 }
    const resolved: ProbeCandidate[] = []
    const unresolved: Array<{ spec: string; name?: string; reason: string }> = []
    for (const s of list) {
      const { candidateName, srcDir } = resolveProbeCandidate(undefined, s)
      if (candidateName && srcDir && existsSync(srcDir) && !resolved.some((c) => c.name === candidateName))
        resolved.push({ name: candidateName, dir: srcDir })
      else
        unresolved.push({ spec: s, name: candidateName || undefined, reason: !candidateName ? '无法解析包名' : (!srcDir || !existsSync(srcDir)) ? '源目录不存在' : '与候选列表重复' })
    }
    if (resolved.length === 0)
      return { ok: false, plugins: [], unresolved, action: 'probe-batch', outcome: 'error', rendered: false, steps: [], summary: '无有效候选', elapsedMs: Date.now() - t0 }
    const r = await probeSet(resolved, keep)
    return { ...r, unresolved: unresolved.length > 0 ? unresolved : undefined }
  }

  return { status, tempLoad: tempLoadOps, tempRemove: tempRemoveOps, promote: promoteOps, uninstall: uninstallOps, reloadClient, probe, probeMany }
}
