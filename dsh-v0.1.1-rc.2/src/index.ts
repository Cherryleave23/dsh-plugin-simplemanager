/**
 * dsh-plugin-simplemanager — 插件管家（host 侧入口）。
 * 通过 webServer 暴露 `/simplemanager` 数据/操作 API 给桌面壳内 client 面板：
 *   - kernel   ：内核版本（当前 + 官方最新，仅提示不自动更新）
 *   - browse   ：完整状态（内核 + 文件夹 + 插件 + 备注），client 首载
 *   - toggle   ：启停第三方插件（写 profile patch 装配层 + 对运行 entry update({disabled}) 立即热生效）
 *   - refresh  ：重新扫描已安装插件（安装/卸载后可手动刷新）
 *   - folders  ：自定义文件夹增/改/删
 *   - move     ：把插件移动到某个文件夹
 *   - note     ：读写插件备注
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  SimpleManagerHost,
  type KernelChannel,
  type Overlay,
  type PluginBundle,
  type PluginScope,
  effectiveFolder,
  pnpmAdd,
  specPackageName,
} from './host.js'

export const name = 'dsh-plugin-simplemanager'

export const inject = ['webServer']

/** DSH Desktop 宿主公开的 desktopProfiles 服务最小类型面（只读探测用）。 */
interface DesktopProfiles {
  readonly current: { readonly name: string; readonly dir: string }
}

/** 本插件消费的官方 service 最小类型面。 */
type AppContext = Context & {
  webServer: {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => void
  }
}

/** Cordis FiberState 数字枚举 → 人类可读 phase（PENDING=0…UNLOADING=5，DISPOSED=4）。 */
const FIBER_PHASE = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const
type FiberPhaseName = 'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading' | null

/** loader 里一条插件条目的最小类型面（只读探测 + 尽力启发）。 */
interface LoaderEntryLike {
  id?: string
  options?: { name?: string; group?: boolean }
  disabled?: boolean
  /** FiberState 数字；无 fiber 时 undefined。 */
  fiber?: { state?: number } | null
}

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
  /** true = 运行时临时加载（不在已安装扫描目录里、由本面板 loader.create 注入），重启即消失。 */
  temporary: boolean
}

export function apply(ctx: AppContext): void {
  // MAX/MIN 语义：patch 只是"当前是否加入启用清单"，与内核无关。
  const profileDir = resolveProfileDir(ctx)
  const host = new SimpleManagerHost(profileDir, join(homedir(), '.dsh', 'simplemanager'))

  const buildView = (): BrowseView => {
    const overlay = host.readOverlay()
    const catalog = host.scanCatalog()
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
    for (const [id, meta] of Object.entries(overlay.folders)) {
      folders.push({ id, name: meta.name, kind: 'custom', count: plugins.filter((p) => p.folder === id).length })
    }

    return {
      kernel: host.readKernelCurrent(),
      folders,
      plugins,
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
            const current = host.readKernelCurrent()
            const ch = await readKernelChannelsCached(host)
            return send({
              ...current,
              ...ch,
              updatable: channelNewer(ch.latest, current.current),
              updatableNext: channelNewer(ch.next, current.current),
              checkedAt: kernelCacheAt(),
            })
          }

          if (action === 'rename') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            const alias = typeof body.alias === 'string' ? body.alias : ''
            if (!id) return fail('缺少插件 id')
            if (!host.scanCatalog().some((b) => b.name === id)) return fail('插件不存在: ' + id)
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
            if (!host.scanCatalog().some((b) => b.name === id)) return fail('插件不存在: ' + id)
            const allowed: PluginScope[] = ['official', 'shell', 'third']
            const next = allowed.includes(scope as PluginScope) ? (scope as PluginScope) : null
            host.setScopeOverride(id, next)
            return send({ ok: true, ...buildView() })
          }

          if (action === 'browse' || action === 'refresh') {
            // refresh 时强制重新扫描文件系统；browse 每次都是实时扫描，语义等价
            const live = loaderLiveMap(ctx)
            const catalog = host.scanCatalog()
            const _debug = {
              live: { count: live.size, sample: [...live.keys()].slice(0, 12) },
              catalog: {
                count: catalog.length,
                hasAnysearch: catalog.some((b) => b.name.includes('anysearch')),
              },
              loaderKeysWithAnysearch: [...live.keys()].filter((k) => k.toLowerCase().includes('anysearch')),
            }
            return send({ ok: true, ...buildView(), _debug })
          }

          if (action === 'toggle') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            if (!id) return fail('缺少插件 id')
            const bundle = host.scanCatalog().find((b) => b.name === id)
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
              const loader = ctx.get('loader') as LoaderWriteFace | undefined
              try {
                if (loader && typeof loader.update === 'function') {
                  await loader.update(live.entryId, { disabled: !next })
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
            if (target === 'official' || target === 'third' || overlay.folders[target]) overlay.assignments[id] = target
            else delete overlay.assignments[id]
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
              const { entryId, depsApplied, pnpmReason } = await tempLoad(ctx, host, spec)
              return send({ ok: true, entryId, depsApplied, pnpmReason, ...buildView() })
            } catch (error) {
              return fail(error instanceof Error ? error.message : String(error))
            }
          }

          if (action === 'tempRemove') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            if (!id) return fail('缺少插件 id')
            try {
              await tempRemove(ctx, id)
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
function loaderLiveMap(ctx: Context): Map<string, LoaderLive> {
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
  const loader = ctx.get('loader') as { entries?: () => LoaderEntryLike[] } | undefined
  if (!loader || typeof loader.entries !== 'function') return new Map()
  const map = new Map<string, LoaderLive>()
  try {
    for (const entry of loader.entries() ?? []) {
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

function enabledFor(b: PluginBundle, patchEnabled: Set<string>, live: Map<string, LoaderLive>): boolean {
  const state = live.get(b.name)
  if (b.scope === 'official' || b.scope === 'shell') {
    return state === undefined ? true : state.enabled
  }
  return state === undefined ? patchEnabled.has(b.name) : state.enabled
}

/** loader 的最小写面（create/remove/update），与官方 EntryTree 生命接口对齐。 */
interface LoaderWriteFace {
  create(options: { name: string; config?: Record<string, unknown> }, parent?: string | null): Promise<string>
  remove(id: string): Promise<void>
  /** 差异化热更新入口：改 disabled 走 dispose/重建，改 config 走原地热更新。 */
  update(id: string, options: { disabled?: boolean; name?: string; config?: Record<string, unknown> }): Promise<void>
  entries(): Iterable<{ id?: string; options?: { name?: string } }>
}

/** 临时闭包：resolve 名 → { entryId, spec（pnpm add 用的原始 spec） }。临时插件随进程消亡，无需落盘。 */
const tempInfos = new Map<string, { entryId: string; spec: string }>()

/**
 * 运行时临时加载一个可解析的插件（npm 包名 / cordis: 内置 / 本地目录）。
 * 走 loader 根树 create（write 为 no-op，不落盘，重启即消失）。
 * 加载前先做一次普适化依赖获取（pnpm add 到 profile 共享 node_modules），
 * 确保任意插件（即便自带 node_modules 不全）的依赖都能被 resolve；依赖获取失败不阻塞热注入。
 */
async function tempLoad(
  ctx: Context,
  host: SimpleManagerHost | null,
  spec: string,
): Promise<{ entryId: string; depsApplied: boolean; pnpmReason?: string }> {
  const name = spec.trim()
  if (!name) throw new Error('缺少要临时加载的插件名')
  const loader = ctx.get('loader') as LoaderWriteFace | undefined
  if (!loader || typeof loader.create !== 'function') throw new Error('loader 不可用，无法临时加载')
  if (tempInfos.has(name)) throw new Error(`「${name}」已经临时加载过了`)

  let depsApplied = false
  let pnpmReason: string | undefined
  if (host && host.profileDir) {
    const out = pnpmAdd(host.profileDir, name)
    depsApplied = out.ok
    if (!depsApplied) pnpmReason = out.message
  }

  const entryId = await loader.create({ name })
  tempInfos.set(name, { entryId, spec: name })
  return { entryId, depsApplied, pnpmReason }
}

/** 卸载一只临时插件（只接受本面板临时 create 过的 entry）。 */
async function tempRemove(ctx: Context, name: string): Promise<void> {
  const loader = ctx.get('loader') as LoaderWriteFace | undefined
  if (!loader || typeof loader.remove !== 'function') throw new Error('loader 不可用，无法卸载')
  const info = tempInfos.get(name)
  if (!info) throw new Error(`「${name}」不是本面板临时加载的插件，不能从这里卸载`)
  await loader.remove(info.entryId)
  tempInfos.delete(name)
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
  const outcome = pnpmAdd(host.profileDir, info.spec)
  if (!outcome.ok) throw new Error(`依赖安装失败：${outcome.message}`)
  const packageName = specPackageName(info.spec) ?? name
  const assembled = host.setPatchEnabled(packageName, packageName, true)
  // 已持久化装配：从临时闭包移除，重启后由 patch 装配（本次进程内原临时 entry 仍运行至退出）。
  tempInfos.delete(name)
  return { packageName, assembled }
}

/** 读内核发布双通道；实例级缓存避免频繁打 registry（TTL 6h）。 */
async function readKernelChannelsCached(host: SimpleManagerHost): Promise<KernelChannel> {
  const t = kernelCache
  if (t.value && Date.now() - t.at < KERNEL_TTL) return t.value
  const v = await host.readKernelDistTags()
  kernelCache = { value: v, at: Date.now() }
  return v
}

function kernelCacheAt(): number | null {
  return kernelCache.at || null
}

const KERNEL_TTL = 6 * 60 * 60 * 1000
let kernelCache: { value: KernelChannel | null; at: number } = { value: null, at: 0 }

/** 通道版本是否比当前版本更新（null 视为不可比 → false）。 */
function channelNewer(channel: string | null, current: string | null): boolean {
  if (!channel || !current) return false
  return compareSemver(channel, current) > 0
}

interface ParsedSemver {
  base: [number, number, number]
  prerelease: number // -1 = 无预发布标识
}

function parseSemver(v: string): ParsedSemver | null {
  const m = v.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.?(\d+))?/)
  if (!m) return null
  return { base: [+m[1], +m[2], +m[3]], prerelease: m[4] ? +m[4] : -1 }
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1
  for (let i = 0; i < 3; i++) {
    if (pa.base[i] !== pb.base[i]) return pa.base[i] < pb.base[i] ? -1 : 1
  }
  const hasA = pa.prerelease >= 0
  const hasB = pb.prerelease >= 0
  if (hasA !== hasB) return hasA ? -1 : 1
  if (!hasA) return 0
  return pa.prerelease < pb.prerelease ? -1 : pa.prerelease > pb.prerelease ? 1 : 0
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