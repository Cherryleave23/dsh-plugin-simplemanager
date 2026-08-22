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
import { basename, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import {
  SimpleManagerHost,
  type Overlay,
  type PluginBundle,
  type PluginScope,
  effectiveFolder,
} from './host.js'
import { pnpmAdd, pnpmRemove, specPackageName, verifyInstalled } from './pnpm.js'

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
  /** 按 entryId 反查 entry 节点（读 fiber 状态供观测）。 */
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

interface PluginView {
  name: string
  version: string
  description: string
  scope: 'official' | 'shell' | 'third'
  source: 'runtime' | 'profile' | 'temp'
  enabled: boolean
  toggleable: boolean
  folder: string
  note: string
  /** 用户自定义显示名（缺省则用 name，UI 层兜底）。 */
  alias: string
  /** 运行时状态：active=已活跃 / failed=启动失败 / pending=待加载 / loading=加载中 / disposed=已卸载 / unloading=卸载中 / null=无 fiber。 */
  state: FiberPhaseName
  /** 插件自身声明的依赖（name@range）；临时插件为本次补装的闭包依赖。点击卡片展开可见。 */
  dependencies: string[]
  /** true = 运行时临时加载（不在已安装扫描目录里、由本面板 loader.create 注入），重启即消失。 */
  temporary: boolean
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

    // catalog（已安装）里每个 bundle 的视图
    const plugins: PluginView[] = catalog.map((b) => ({
      name: b.name,
      version: b.version,
      description: b.description,
      scope: b.scope,
      source: b.source,
      enabled: enabledFor(b, patchEnabled, live),
      toggleable: b.scope === 'third' || patchEnabled.has(b.name),
      folder: effectiveFolder(b, overlay),
      note: overlay.notes[b.name] ?? '',
      alias: overlay.aliases[b.name] ?? '',
      state: live.get(b.name)?.phase ?? null,
      dependencies: b.dependencies,
      temporary: false,
    }))

    // 仅本面板会话里 tempLoad 临时 create 过、且不在已安装扫描目录中的 entry
    // → 运行时临时插件（重启即消失）。已装未装配 / cordis: 内置不算临时，不展示为临时。
    const catalogNames = new Set(plugins.map((p) => p.name))
    for (const [name, { enabled, phase }] of live) {
      if (name.startsWith('cordis:') || name === '@deepseek-ai/cordis-plugin-loader') continue
      if (catalogNames.has(name)) continue
      if (!tempInfos.has(name)) continue
      plugins.push({
        name,
        version: '',
        description: '',
        scope: 'third',
        source: 'temp',
        enabled,
        toggleable: true,
        folder: effectiveFolder({ name, scope: 'third' }, overlay),
        note: '',
        alias: '',
        state: phase,
        dependencies: tempInfos.get(name)?.installedDeps ?? [],
        temporary: true,
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

          if (action === 'toggle') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            if (!id) return fail('缺少插件 id')
            const bundle = buildCatalog(ctx, host).find((b) => b.name === id)
            if (!bundle) return fail('插件不存在: ' + id)
            const patchEnabled = host.readPatchEnabledIds()
            const live = loaderLiveMap(ctx).get(id)
            const next = live === undefined ? !patchEnabled.has(id) : !live.enabled
            // 持久化装配层：仍写 profile patch（insert 增删），保证重启后装配状态正确。
            host.setPatchEnabled(id, id, next)
            // 运行时热启停：对已装配 entry 做 update({ disabled }) 立即生效（非 reload，reload 不具备）。
            // 停=dispose 保留条目；启=重新启动 fiber。找不到运行 entry（未装配）则仅落盘、走重启装配。
            let hotApplied = false
            if (live?.entryId) {
              try {
                if (typeof ctx.loader.update === 'function') {
                  await ctx.loader.update(live.entryId, { disabled: !next })
                  hotApplied = true
                }
              } catch {
                hotApplied = false // 运行时更新失败，落盘已生效，走重启生效
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
            if (!spec.trim()) return fail('缺少要临时加载的插件名')
            try {
              const { depsApplied, pnpmReason, hotApplied, packageName } = await tempLoad(ctx, host, spec)
              return send({ ok: true, depsApplied, pnpmReason, hotApplied, packageName, ...buildView() })
            } catch (error) {
              return fail(error instanceof Error ? error.message : String(error))
            }
          }

          if (action === 'tempRemove') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            if (!id) return fail('缺少插件 id')
            try {
              await tempRemove(ctx, host, id)
              return send({ ok: true, ...buildView() })
            } catch (error) {
              return fail(error instanceof Error ? error.message : String(error))
            }
          }

          if (action === 'promote') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            if (!id) return fail('缺少插件 id')
            try {
              const { packageName, assembled } = await promote(ctx, host, id)
              return send({ ok: true, packageName, assembled, requiresRestart: true, ...buildView() })
            } catch (error) {
              return fail(error instanceof Error ? error.message : String(error))
            }
          }

          if (action === 'uninstall') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            if (!id) return fail('缺少插件 id')
            try {
              const { packageName } = await uninstall(ctx, host, id)
              return send({ ok: true, packageName, ...buildView() })
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
    out.push({
      name,
      version: described?.version ?? '',
      description: described?.description ?? '',
      scope: host.scopeOf(name),
      source: described?.source ?? 'runtime',
      dependencies: described?.dependencies ?? [],
    })
  }
  return out
}

function enabledFor(b: PluginBundle, patchEnabled: Set<string>, live: Map<string, LoaderLive>): boolean {
  const state = live.get(b.name)
  if (b.scope === 'official' || b.scope === 'shell') {
    return state === undefined ? true : state.enabled
  }
  return state === undefined ? patchEnabled.has(b.name) : state.enabled
}

/** 临时闭包：resolve 名 → { entryId, spec（pnpm add 用原始 spec）, installedDeps（本次补装闭包依赖） }。
 * 临时插件随进程消亡、不写 patch，无需落盘；转正（promote）才写 patch 持久化。 */
const tempInfos = new Map<string, { entryId: string; spec: string; installedDeps: string[] }>()

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
): Promise<{ depsApplied: boolean; pnpmReason?: string; hotApplied: boolean; packageName: string; entryId?: string; state?: string; officialPeers?: string[] }> {
  const name = spec.trim()
  if (!name) throw new Error('缺少要临时加载的插件名')

  // 1) 真实装包 + 拉齐依赖闭包（普适化依赖获取）。依赖获取失败如实带回来，不阻塞后续 create 尝试。
  let depsApplied = false
  let pnpmReason: string | undefined
  let installedDeps: string[] = []
  if (host && host.profileDir) {
    // 热装跳过官方业务 peer：不把 @deepseek-ai/dsh-* 装进 profile，让桌面壳 overlay 回落选发行 install 来源，
    // 规避其对「动态热装」官方 peer 二次解析的限制（P-033 设计，官方业务包由发行内嵌提供、无需 profile 重复安装）。
    const out = await pnpmAdd(host.profileDir, name, { skipOfficialPeers: true })
    depsApplied = out.ok
    if (!depsApplied) pnpmReason = out.message
    else installedDeps = out.installedDeps ?? []
  }
  // packageName = 插件真实包名（装包后由 package.json 解析，路径/registry 均可）。
  const packageName = specPackageName(name, host?.profileDir ?? undefined) ?? name
  if (tempInfos.has(packageName)) throw new Error(`「${packageName}」已经临时加载过了`)
  if (typeof ctx.loader.create !== 'function') throw new Error('loader.create 不可用，无法运行时热装')

  // 官方业务 peer 探测：若插件 peer 依赖含 @deepseek-ai/dsh-*（会被桌面壳 overlay 管理），
  // 提示热装可能触发 overlay 解析限制（C-observed，桌面壳 module-resolution 对动态热装 peer 二次解析未完整覆盖；
  // 纯 cordis/schemastery 工具包不属于此类）。探测不阻塞，透出给调用方供 UI 告警。
  const officialPeers = detectOfficialPeerDeps(packageName, host?.profileDir ?? undefined)

  // 2) 运行时热装：create 的 promise resolve = entry 装配/apply 成功；import 或 apply 失败时 reject（versus P-015 实测 123ms 返回）。
  let entryId: string
  try {
    entryId = await ctx.loader.create({ name: packageName, config: {}, disabled: false })
  } catch (error) {
    // 热装失败：将原文透出（如私有依赖未获取），提示先解决依赖后再试；不残留 tempInfos。
    // 若前置装包未成功，则把安装结果一并透出——装包失败才是热装失败的根因时不能再藏为"无法解析包"。
    const reason = error instanceof Error ? error.message : String(error)
    const installNote = depsApplied
      ? ''
      : `（前置依赖/包安装未成功：${pnpmReason ?? '包未装入 profile'}，故无法被 loader 解析装配）`
    let nodeModulesHit = '?'
    try {
      if (host?.profileDir) nodeModulesHit = String(existsSync(join(host.profileDir, 'node_modules', packageName)))
    } catch { /* 探测失败即 ? */ }
    console.log(`[dsh-simplemanager] tempLoad 热装失败 profileDir=${host?.profileDir} depsApplied=${depsApplied} nodeModulesHit=${nodeModulesHit} spec=${name}`)
    const officialNote = officialPeers && officialPeers.length > 0
      ? '. 注意：该插件依赖官方业务包 ' + officialPeers.join('/') + '，桌面壳对动态热装的官方 peer 解析有限制，建议改用官方渠道安装后再用。'
      : ''
    throw new Error(`运行时热装失败（${packageName}）nodeModulesHit=${nodeModulesHit} exec=${basename(process.execPath)}/argv0=${basename(process.argv0 ?? '?')} profileDir=${host?.profileDir}${installNote}${officialNote}：${reason}`)
  }

  // 3) 读 fiber 态供 UI 观测（create 成功但非 active 的极少数情况也如实上报）。
  let state: string | undefined
  try {
    const e = ctx.loader.resolve?.(entryId)
    const raw = e?.fiber?.state
    if (typeof raw === 'number' && raw >= 0 && raw < FIBER_PHASE.length) state = FIBER_PHASE[raw]
  } catch { /* 读态失败不影响结果 */ }

  // 4) 镜像临时态（面板展示、卸载引用计数用）。spec 保留原始输入，供 promote 原样 re-add。
  tempInfos.set(packageName, { entryId, spec: name, installedDeps })
  host?.pushHotInstall(packageName)
  return { depsApplied, pnpmReason, hotApplied: true, packageName, entryId, state, officialPeers }
}

/** 探测插件的「官方业务 peer」：peerDependencies 中含 `@deepseek-ai/dsh-*`（被桌面壳 overlay 管理，
 * 动态热装对此类 peer 的二次解析存在桌面壳限制，见 C-observed）。纯工具包 cordis/schemastery 不算。
 * 读不到 manifest 或无可疑 peer 时返回 undefined/空数组，不抛错。 */
function detectOfficialPeerDeps(packageName: string, profileDir?: string): string[] | undefined {
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

/** 卸载一只临时插件（只接受本面板临时 create 过的 entry）。顺带回收本次临时加载补装的闭包依赖：
 * 仅当该依赖不再被其他活跃临时插件引用时才 `pnpm remove`（引用计数），保证依赖闭包随装卸完整进退。 */
async function tempRemove(ctx: AppContext, host: SimpleManagerHost | null, name: string): Promise<void> {
  if (typeof ctx.loader.remove !== 'function') throw new Error('loader 不可用，无法卸载')
  const info = tempInfos.get(name)
  if (!info) throw new Error(`「${name}」不是本面板临时加载的插件，不能从这里卸载`)
  await ctx.loader.remove(info.entryId)
  tempInfos.delete(name)
  host?.forgetHotInstall(name)
  if (host && host.profileDir && info.installedDeps.length > 0) {
    for (const dep of info.installedDeps) {
      const neededByOther = [...tempInfos.values()].some((o) => o.installedDeps.includes(dep))
      if (neededByOther) continue
      await pnpmRemove(host.profileDir, dep).catch(() => { /* 回收尽力而为，失败不阻断卸载 */ })
    }
  }
}

/**
 * 真注入：把一只临时插件持久化装配进 profile。
 * 1) pnpm add <spec> —— 把插件物理装入共享 node_modules 并装齐依赖闭包（普适化依赖获取）；
 * 2) 写 profile 层 patch（setPatchEnabled）把插件真实包名登记进装配清单 → 重启后被 loader 装配。
 * 登记走官方「profile 层 patch 最后应用」语义，不依赖插件是否声明 dsh.bundle.patch。
 */
async function promote(ctx: Context, host: SimpleManagerHost, name: string): Promise<{ packageName: string; assembled: boolean }> {
  const info = tempInfos.get(name)
  if (!info) throw new Error(`「${name}」不是本面板临时加载的插件，无法转正`)
  const packageName = specPackageName(info.spec) ?? name
  const outcome = await pnpmAdd(host.profileDir, info.spec)
  if (!outcome.ok) {
    // 闭包补装失败时 pnpmAdd 已尽力回收闭包；此处把已链接的插件本身也回收，转正失败不残留。
    await pnpmRemove(host.profileDir, packageName).catch(() => {})
    throw new Error(`依赖安装失败：${outcome.message}`)
  }
  const verify = verifyInstalled(host.profileDir, packageName)
  if (!verify.ok) {
    // 校验不过回滚：插件包 + 本次补装的全部闭包依赖一并移除，依赖闭包完整进退。
    await pnpmRemove(host.profileDir, packageName)
    for (const dep of outcome.installedDeps ?? []) await pnpmRemove(host.profileDir, dep).catch(() => {})
    throw new Error(`安装校验未通过，已回滚：${verify.reason}`)
  }
  const assembled = host.setPatchEnabled(packageName, packageName, true)
  // 记录本次转正补装的闭包依赖，供真卸载（uninstall）回收——依赖闭包随装卸完整进退。
  host.setClosureDeps(packageName, outcome.installedDeps ?? [])
  // 已转正为正式装配，不再算待清理的手热装残留。
  host.forgetHotInstall(packageName)
  // 已持久化装配：从临时闭包移除，重启后由 patch 装配（本次进程内原临时 entry 仍运行至退出）。
  tempInfos.delete(name)
  return { packageName, assembled }
}

/**
 * 真卸载：把一只已安装（persistent）的第三方插件完整移除。
 * 纪律（判据 6「依赖闭包随装卸完整进退」+ 官方渠道）：
 *   - 仅允许卸载 profile 层第三方插件；官方内核/壳运行时组件拒绝（护住基础功能）；
 *   - 先移除 profile 层 patch 装配登记（与启用同源，官方「最后应用」语义），运行时 entry 存活则一并销毁（热卸）;
 *   - 再 pnpm remove 物理移除插件包 + 按引用回收补装的依赖闭包（其他已装插件/活跃临时插件仍需则保留）；
 *   - 最后清理该插件的自持数据（文件夹分配/备注/别名/闭包记录），不留残留。
 */
async function uninstall(ctx: AppContext, host: SimpleManagerHost, name: string): Promise<{ packageName: string }> {
  const bundle = buildCatalog(ctx, host).find((b) => b.name === name)
  if (!bundle) throw new Error('插件不存在: ' + name)
  if (bundle.scope === 'official') throw new Error('官方内核插件不可从面板卸载')
  if (bundle.scope === 'shell') throw new Error('桌面壳组件不可从面板卸载')
  const packageName = bundle.name

  // 1) 移除装配：patch 登记移除 + 若在运行则销毁当前 entry（热卸载）。临时 create 的 entry 一并清出临时闭包。
  const live = loaderLiveMap(ctx).get(name)
  if (live?.entryId && typeof ctx.loader.remove === 'function') {
    await ctx.loader.remove(live.entryId).catch(() => {})
  }
  tempInfos.delete(packageName)
  host.setPatchEnabled(packageName, packageName, false)
  // 官方渠道登记清理：从 package.json 的 bundles 装配清单移除，避免重启解析已删包报错（P-033 顺带发现）。
  host.removeBundle(packageName)

  // 2) 物理移除 + 依赖闭包按引用回收。
  const closure = host.getClosureDeps(packageName)
  await pnpmRemove(host.profileDir, packageName)
  host.forgetHotInstall(packageName)
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
    for (const dep of closure) {
      if (stillNeeded.has(dep)) continue
      await pnpmRemove(host.profileDir, dep).catch(() => { /* 回收尽力而为 */ })
    }
  }
  host.setClosureDeps(packageName, [])

  // 3) 清理自持数据不残留。
  const overlay = host.readOverlay()
  delete overlay.notes[packageName]
  delete overlay.aliases[packageName]
  delete overlay.assignments[packageName]
  host.writeOverlay(overlay)
  return { packageName }
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
