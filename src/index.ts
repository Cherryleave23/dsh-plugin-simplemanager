/**
 * dsh-plugin-simplemanager — 插件管家（host 侧入口）。
 * 通过 webServer 暴露 `/simplemanager` 数据/操作 API 给桌面壳内 client 面板：
 *   - kernel   ：内核版本（只读当前版本，不联网）
 *   - browse   ：完整状态（内核 + 文件夹 + 插件状态 + 依赖 + 备注），client 首载
 *   - toggle   ：启停第三方插件（写 profile patch 装配层 + 对运行 entry update({disabled}) 立即热生效）
 *   - tempLoad / tempRemove / promote ：运行时热插拔 + 转真注入
 *   - uninstall：真卸载（移除磁盘包 + 依赖闭包 + 装配登记 + 自持数据）
 *   - diagnostics：按禁做清单扫已装插件副本库的源码规范，产出治理报告（只读）
 *   - refresh  ：重新扫描已安装插件（安装/卸载后可手动刷新）
 *   - folders / move ：自定义文件夹分组管理
 *   - note / rename / scope ：插件备注 / 显示名 / 作用域覆盖
 */
import { homedir } from 'node:os'
import { basename, isAbsolute, join, normalize } from 'node:path'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import vm from 'node:vm'
import { createRequire } from 'node:module'
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
import { diagnosePlugin, resolveInstalledDir } from './diagnostics.js'
import { realCordisGate } from './preflight.js'
import { clientSmokeTest, detectClientArtifact, detectOfficialPeerDeps, locateClientRoots, smokeErrToString, type ClientSmokeReport } from './smoke.js'

export const name = 'dsh-plugin-simplemanager'

export const inject = ['webServer', 'loader']

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
      } catch { /* 启动清理失败不影响宿主启动 */ }
    }
    void resign(ctx, host).then(() => {}, () => {})
  }
  setTimeout(cleanupHotResidue, 4000)

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

    // catalog（已安装）里每个 bundle 的视图。卸载后（recentlyUninstalled）不再渲染为残留卡片，
    // 让"卸载完即从列表消失"恢复为直觉预期；热装恢复会即时清理该标记（见 tempLoad/uninstall 对称逻辑）。
    const plugins: PluginView[] = catalog
      .filter((b) => !recentlyUninstalled.has(b.name))
      .map((b) => {
      const isThird = b.scope === 'third'
      const source = sourceOf(b)
      const ln = live.get(b.name)
      const persistent = patchEnabled.has(b.name) || host.isBundleAssembled(b.name)
      const enabled = !isThird ? (ln === undefined ? true : ln.enabled) : (ln === undefined ? persistent : ln.enabled)
      const runtime: PluginRuntime =
        source === 'orphan' ? 'none'
          : ln === undefined ? (enabled ? 'none' : 'disabled')
          : !ln.enabled ? 'disabled'
          : (ln.phase ?? 'loading')
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
      folders.push({ id, name: meta.name, kind: 'custom', count: plugins.filter((p) => p.folder === id).length })
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

          if (action === 'verifyClient') {
            // 刷新界面前的 client 无头冒烟预检：在 kernel 进程真实执行各插件 client bundle（load 注册 + apply），
            // 提前发现「热注入没问题、但重载前端就崩」的插件，并给出分步根因。不依赖桌面渲染端是否在跑。
            // mode='real-cordis'（实验室）走真 cordis 门禁（仅门禁不深挖）；缺省/other 走三态门禁+apply 深挖。
            const body = await readJsonBody(req)
            const raw = body.names
            const names = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === 'string' && n.trim() !== '') : []
            const realGate = body.mode === 'real-cordis'
            const profileDir = host?.profileDir ?? undefined
            const renderData = Array.isArray(body.renderData) ? (body.renderData as unknown[]) : undefined
            let results: ClientSmokeReport[]
            try {
              results = await Promise.all(names.map((n) => clientSmokeTest(n, locateClientRoots(n, profileDir, tempInfos.get(n)?.spec), profileDir, realGate, renderData)))
            } catch (error) {
              return send({ ok: false, error: `预检执行异常：${smokeErrToString(error)}` })
            }
            return send({ ok: true, results })
          }

          if (action === 'diagnostics') {
            // 第三板块「代码规范治理」：按禁做清单扫已装插件副本库，逐条取证 + 运行态信号佐证。只读、零写面。
            const body = await readJsonBody(req)
            const raw = body.names
            const names = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === 'string' && n.trim() !== '') : []
            const rawFolders = body.folders
            const folderIds = (Array.isArray(rawFolders) ? rawFolders : []).filter((f): f is string => typeof f === 'string' && f !== '')
            const profileDir = host?.profileDir ?? ''
            const bundles = buildCatalog(ctx, host)
            // 始终以装配表（catalog）为权威全集；请求缺省时诊断全部第三方插件。
            // 官方/壳组件排除用 resolveScope 判定的 b.scope（与「插件管理分类」「重载预检名单」同一官方口径），
            // 不再依赖 isOfficialSystemDep——它只认 @deepseek-ai/dsh-* + cordis + schemastery，
            // 会漏掉不以 dsh- 前缀的 @deepseek-ai 官方包，导致「官方插件混入诊断」（统一判定见 MANIFEST）。
            // folders 可选过滤：前端「诊断范围」多选文件夹时，只诊断落在所选文件夹内的第三方插件；
            // 未传 folders(=空数组)则诊断全部第三方。
            let targets = names
            if (targets.length === 0) {
              const thirdBundles = bundles.filter((b) => b.scope === 'third')
              if (folderIds.length > 0 && host) {
                const overlay = host.readOverlay()
                targets = thirdBundles
                  .filter((b) => folderIds.includes(effectiveFolder(b, overlay)))
                  .map((b) => b.name)
              } else {
                targets = thirdBundles.map((b) => b.name)
              }
            }
            const live = loaderLiveMap(ctx)
            const report = targets.map((n) => diagnosePlugin(n, profileDir, live.get(n)?.phase ?? null))
            return send({ ok: true, report })
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
              const id = 'cf-' + Date.now().toString(36)
              overlay.folders[id] = { name: nodeName }
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

/** 临时闭包：resolve 名 → { entryId, spec（pnpm add 用原始 spec）, installedDeps（本次补装闭包依赖）}。
 * 临时插件随进程消亡、不写 patch，无需落盘；转正（promote）才写 patch 持久化。 */
const tempInfos = new Map<string, { entryId: string; spec: string; installedDeps: string[] }>()
/** 已转正待重启的插件（本次进程 entry 仍运行至退出；重启后由 patch 装配为持久）。会话级内存，重启即空。 */
const promotedPending = new Set<string>()
/** 本会话成功卸载、但装配/物理层可能仍在收敛（loader 未即时拆除 / 桌面壳复核写回）而仍残留在列表的包名。
 * 装配层收敛以重启为判定（P-039），此集用于 buildView 把这类残留正确标记为「已卸载、不可启停」，而非正常可装可启停插件。 */
const recentlyUninstalled = new Set<string>()

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
): Promise<{ depsApplied: boolean; pnpmReason?: string; hotApplied: boolean; packageName: string; entryId?: string; state?: string; officialPeers?: string[]; runId: string }> {
  const name = spec.trim()
  if (!name) throw new Error('缺少要临时加载的插件名')

  // 0) runId 由调用方（handler）先经 beginPlan 预创建（前端先拿到 runId 才能轮询 plan 骨架与实时状态）。
  const run = _runs.get(runId)
  if (!run) throw new Error('run 未建立: ' + runId)
  const fail = (text: string): void => {
    appendNote(run, 'err', text)
    finishRun(run)
  }

  // 1) 真实装包 + 拉齐依赖闭包。依赖获取失败即中止：不再继续 loader.create，避免把「装一半」的
  //    半残实例挂进运行内核（依赖未到位 → create 仍可能 apply 成功 → 路由/服务被占、且残留为
  //    无法回收的幽灵 active 实例，P-036/P-043 实证）。
  let depsApplied = false
  let pnpmReason: string | undefined
  let installedDeps: string[] = []
  markStep(run, 'deps', 'running')
  if (host && host.profileDir) {
    // 热装跳过官方业务 peer：不把 @deepseek-ai/dsh-* 装进 profile，让桌面壳 overlay 回落选发行 install 来源，
    // 规避其对「动态热装」官方 peer 二次解析的限制（P-033 设计，官方业务包由发行内嵌提供、无需 profile 重复安装）。
    const out = await pnpmAdd(host.profileDir, name, { skipOfficialPeers: true })
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

  // 2) packageName = 插件真实包名（装包后由 package.json 解析，路径/registry 均可）。
  markStep(run, 'resolve', 'running')
  const packageName = specPackageName(name, host?.profileDir ?? undefined) ?? name
  markStep(run, 'resolve', 'ok', packageName)
  if (tempInfos.has(packageName)) { fail(`「${packageName}」已经临时加载过了`); throw new Error(`「${packageName}」已经临时加载过了`) }
  if (typeof ctx.loader.create !== 'function') { fail('loader.create 不可用，无法运行时热装'); throw new Error('loader.create 不可用，无法运行时热装') }

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

  // 5) 镜像临时态（面板展示、卸载引用计数用）。spec 保留原始输入，供 promote 原样 re-add。
  markStep(run, 'finish', 'running')
  tempInfos.set(packageName, { entryId, spec: name, installedDeps })
  host?.pushHotInstall(packageName)
  // 热装 = 重新安装该插件：清掉本会话的「已卸载待消失」标记，否则 buildView 会把它过滤掉，点了热装却不见卡。
  // 注意不能靠「live 是否命中」判断——「卸载但装配未拆干净、待重启消失」的插件一样 live 命中，
  // 那正是要继续过滤的场合，故须显式删除该标记。
  recentlyUninstalled.delete(packageName)
  markStep(run, 'finish', 'ok', state ?? 'active')
  finishRun(run)
  return { depsApplied, pnpmReason, hotApplied: true, packageName, entryId, state, officialPeers, runId }
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
    }
    if (info.installedDeps.length > 0) {
      for (const dep of info.installedDeps) {
        const neededByOther = [...tempInfos.values()].some((o) => o.installedDeps.includes(dep))
        if (neededByOther) continue
        await pnpmRemove(host.profileDir, dep).catch(() => { /* 回收尽力而为，失败不阻断卸载 */ })
      }
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
  const packageName = specPackageName(info.spec) ?? name

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
  const outcome = await pnpmAdd(host.profileDir, info.spec, { skipOfficialPeers: true })
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
  // 已转正为正式装配，不再算待清理的手热装残留。
  host.forgetHotInstall(packageName)
  // 已持久化装配：从临时闭包移除，改记为「已转正待重启」，重启后由 patch 装配为持久
  // （本次进程内原临时 entry 仍运行至退出，UI 以 promoted 档位标记，避免与持久安装混淆）。
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
  return process.cwd()
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
