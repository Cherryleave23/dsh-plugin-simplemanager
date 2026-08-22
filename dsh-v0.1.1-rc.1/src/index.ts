/**
 * dsh-plugin-simplemanager — 插件管家（host 侧入口）。
 * 通过 webServer 暴露 `/simplemanager` 数据/操作 API 给桌面壳内 client 面板：
 *   - kernel   ：内核版本（当前 + 官方最新，仅提示不自动更新）
 *   - browse   ：完整状态（内核 + 文件夹 + 插件 + 备注），client 首载
 *   - toggle   ：启停第三方插件（写入全局层补丁 + 尽力热生效）
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

/** loader 里一条插件条目的最小类型面（只读探测 + 尽力启发）。 */
interface LoaderEntryLike {
  options?: { name?: string }
  disabled?: boolean
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
  source: 'runtime' | 'profile'
  enabled: boolean
  toggleable: boolean
  folder: string
  note: string
  /** 用户自定义显示名（缺省则用 name，UI 层兜底）。 */
  alias: string
}

export function apply(ctx: AppContext): void {
  // MAX/MIN 语义：patch 只是"当前是否加入启用清单"，与内核无关。
  const profileDir = resolveProfileDir(ctx)
  const host = new SimpleManagerHost(profileDir, join(homedir(), '.dsh', 'simplemanager'))

  const buildView = (): BrowseView => {
    const overlay = host.readOverlay()
    const catalog = host.scanCatalog()
    const patchEnabled = host.readPatchEnabledIds()
    const loaderEnabled = loaderEnabledMap(ctx)

    const plugins: PluginView[] = catalog.map((b) => ({
      name: b.name,
      version: b.version,
      description: b.description,
      scope: b.scope,
      source: b.source,
      enabled: enabledFor(b, patchEnabled, loaderEnabled),
      toggleable: b.scope === 'third' || patchEnabled.has(b.name),
      folder: effectiveFolder(b, overlay),
      note: overlay.notes[b.name] ?? '',
      alias: overlay.aliases[b.name] ?? '',
    }))

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
            return send({ ok: true, ...buildView() })
          }

          if (action === 'toggle') {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            if (!id) return fail('缺少插件 id')
            const bundle = host.scanCatalog().find((b) => b.name === id)
            if (!bundle) return fail('插件不存在: ' + id)
            const patchEnabled = host.readPatchEnabledIds()
            const live = loaderEnabledMap(ctx).get(id)
            const next = live === undefined ? !patchEnabled.has(id) : !live
            try {
              host.setPatchEnabled(id, id, next)
              const hotApplied = await hotApplyLoader(ctx, id, next)
              return send({ ok: true, enabled: next, hotApplied })
            } catch (error) {
              return fail(error instanceof Error ? error.message : String(error))
            }
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

          send({ ok: false, error: 'unknown action: ' + action })
        },
      }),
    'dsh-plugin-simplemanager: api',
  )
}

/** loader 的 live enabled 映射（moduleName -> !disabled）。loader 不可用返回空 Map。 */
function loaderEnabledMap(ctx: Context): Map<string, boolean> {
  const loader = ctx.get('loader') as { entries?: () => LoaderEntryLike[] } | undefined
  if (!loader || typeof loader.entries !== 'function') return new Map()
  try {
    const map = new Map<string, boolean>()
    for (const entry of loader.entries() ?? []) {
      const nm = entry?.options?.name
      if (typeof nm === 'string' && nm) map.set(nm, !entry.disabled)
    }
    return map
  } catch {
    return new Map()
  }
}

function enabledFor(b: PluginBundle, patchEnabled: Set<string>, loaderEnabled: Map<string, boolean>): boolean {
  if (b.scope === 'official' || b.scope === 'shell') {
    const live = loaderEnabled.get(b.name)
    return live === undefined ? true : live
  }
  const live = loaderEnabled.get(b.name)
  return live === undefined ? patchEnabled.has(b.name) : live
}

/**
 * 尽力让启停"实时热生效"：优先走 loader.reload()（重读装配后热加载）；
 * 没有配合面时保守返回 hotApplied=false，由 UI 提示"将在重启后生效"。
 */
async function hotApplyLoader(ctx: Context, name: string, enabled: boolean): Promise<boolean> {
  const loader = ctx.get('loader') as { reload?: () => Promise<unknown> | unknown } | undefined
  try {
    if (loader && typeof loader.reload === 'function') {
      await loader.reload()
      return true
    }
  } catch {
    /* 热应用失败，落盘已生效，走重启生效 */
  }
  return false
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