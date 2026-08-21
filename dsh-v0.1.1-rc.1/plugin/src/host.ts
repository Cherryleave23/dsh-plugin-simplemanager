/**
 * dsh-plugin-simplemanager — 宿主数据层。
 * 职责：内核版本读取/检测、已安装插件目录扫描、启停的全局层补丁读写、
 * 自持分类/备注 overlay 持久化。不持有 ctx，纯函数 + 文件系统，便于测试。
 */
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'

export type PluginScope = 'official' | 'shell' | 'third'

export interface PluginBundle {
  /** 包名，如 `dsh-msg-link` / `@deepseek-ai/dsh-session`。 */
  name: string
  version: string
  description: string
  /** official = 官方内核自带；shell = 桌面壳/客户端运行时（非内核，归第三方文件夹）；third = 用户安装的第三方 bundle。 */
  scope: PluginScope
  /** runtime = 官方运行时自带；profile = 当前 profile 安装。 */
  source: 'runtime' | 'profile'
}

export interface KernelChannel {
  latest: string | null
  next: string | null
}

export interface Overlay {
  /** 自定义文件夹：id -> {name}。内置文件夹 official/third 不落盘。 */
  folders: Record<string, { name: string }>
  /** entry(id/包名) -> 文件夹 id（覆盖默认 scope 路由）。 */
  assignments: Record<string, string>
  /** entry(id/包名) -> 备注。 */
  notes: Record<string, string>
  /** entry(id/包名) -> 显示名别名（不改 package.json，仅 UI 展示覆盖）。 */
  aliases: Record<string, string>
}

export interface SimpleManagerConfig {
  /** 边界情况覆盖：第三方包发布到 @deepseek-ai/ scope、或桌面壳包需强指定官方/第三方。 */
  scopeOverrides: Record<string, PluginScope>
}

const DEFAULT_DATA_DIR = join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh', 'simplemanager')
const KERNEL_SPEC = '@deepseek-ai/dsh/package.json'
/** npm 包文档端点：一次取到 dist-tags（latest/next 双发布通道），直连失败降级到镜像。 */
const REGISTRY_URLS = [
  'https://registry.npmjs.org/@deepseek-ai/dsh',
  'https://registry.npmmirror.com/@deepseek-ai/dsh',
]

export class SimpleManagerHost {
  readonly profileDir: string
  readonly dataDir: string
  readonly patchFile: string
  private overlayFile: string
  private overlayCache: { raw: string; data: Overlay } | null = null
  private configFile: string
  private configCache: { raw: string; data: SimpleManagerConfig } | null = null

  constructor(profileDir: string, dataDir: string = DEFAULT_DATA_DIR) {
    this.profileDir = profileDir
    this.dataDir = dataDir
    this.patchFile = join(profileDir, 'cordis.patch.yml')
    this.overlayFile = join(dataDir, 'data.json')
    this.configFile = join(dataDir, 'config.json')
  }

  // ---- 数据目录（自持数据按工程约定放在 ~/.dsh/simplemanager） ----
  private ensureDataDir(): void {
    mkdirSync(this.dataDir, { recursive: true })
  }

  // ---- Overlay（分类 + 备注）持久化 ----
  readOverlay(): Overlay {
    if (this.overlayCache) return structuredClone(this.overlayCache.data)
    const empty: Overlay = { folders: {}, assignments: {}, notes: {}, aliases: {} }
    if (!existsSync(this.overlayFile)) {
      this.overlayCache = { raw: '', data: empty }
      return structuredClone(empty)
    }
    try {
      const raw = readFileSync(this.overlayFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<Overlay>
      const data: Overlay = {
        folders: parsed.folders ?? {},
        assignments: parsed.assignments ?? {},
        notes: parsed.notes ?? {},
        aliases: parsed.aliases ?? {},
      }
      this.overlayCache = { raw, data }
      return structuredClone(data)
    } catch {
      this.overlayCache = { raw: '', data: empty }
      return structuredClone(empty)
    }
  }

  writeOverlay(data: Overlay): void {
    this.ensureDataDir()
    const raw = JSON.stringify(
      { folders: data.folders, assignments: data.assignments, notes: data.notes, aliases: data.aliases },
      null,
      2,
    )
    if (this.overlayCache && this.overlayCache.raw === raw) return
    atomicWrite(this.overlayFile, raw)
    this.overlayCache = { raw, data }
  }

  // ---- Config（作用域覆盖等边界配置）持久化 ----
  readConfig(): SimpleManagerConfig {
    if (this.configCache) return structuredClone(this.configCache.data)
    const empty: SimpleManagerConfig = { scopeOverrides: {} }
    if (!existsSync(this.configFile)) {
      this.configCache = { raw: '', data: empty }
      return structuredClone(empty)
    }
    try {
      const raw = readFileSync(this.configFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<SimpleManagerConfig>
      const data: SimpleManagerConfig = { scopeOverrides: parsed.scopeOverrides ?? {} }
      this.configCache = { raw, data }
      return structuredClone(data)
    } catch {
      this.configCache = { raw: '', data: empty }
      return structuredClone(empty)
    }
  }

  setScopeOverride(name: string, scope: PluginScope | null): boolean {
    const data = this.readConfig()
    if (scope === null) {
      if (!Object.prototype.hasOwnProperty.call(data.scopeOverrides, name)) return false
      delete data.scopeOverrides[name]
    } else {
      data.scopeOverrides[name] = scope
    }
    this.ensureDataDir()
    const raw = JSON.stringify(data, null, 2)
    atomicWrite(this.configFile, raw)
    this.configCache = { raw, data }
    return true
  }

  // ---- 内核版本 ----
  readKernelCurrent(): { current: string | null; source: string } {
    const candidate = rawResolve(KERNEL_SPEC, this.profileDir)
    if (candidate) {
      const version = readJsonField(candidate, 'version')
      if (version) return { current: String(version), source: 'resolve' }
    }
    const runtimeRoot = runtimeNodeModules()
    const fallback = runtimeRoot && join(runtimeRoot, '@deepseek-ai', 'dsh', 'package.json')
    if (fallback && existsSync(fallback)) {
      const version = readJsonField(fallback, 'version')
      if (version) return { current: String(version), source: 'runtime' }
    }
    return { current: null, source: 'none' }
  }

  /** 读取内核发布双通道：latest = 稳定线（npm latest dist-tag），next = 官方预发布线（@next 通道）。 */
  async readKernelDistTags(): Promise<KernelChannel> {
    for (const url of REGISTRY_URLS) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 5000)
        const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
        clearTimeout(timer)
        if (!res.ok) continue
        const data = (await res.json()) as { 'dist-tags'?: { latest?: unknown; next?: unknown } }
        const tags = data['dist-tags']
        if (!tags) return { latest: null, next: null }
        return {
          latest: typeof tags.latest === 'string' && tags.latest ? tags.latest : null,
          next: typeof tags.next === 'string' && tags.next ? tags.next : null,
        }
      } catch {
        /* 离线/超时降级到下一 registry；全部失败返回 null（UI 显示获取失败） */
      }
    }
    return { latest: null, next: null }
  }

  // ---- 插件目录扫描（不含 live enabled；enabled 由 index 层合并 loader） ----
  scanCatalog(): PluginBundle[] {
    const out: PluginBundle[] = []
    const seen = new Set<string>()
    const overrides = this.readConfig().scopeOverrides
    const runtimeRoot = runtimeNodeModules()

    if (runtimeRoot) {
      const officialDir = join(runtimeRoot, '@deepseek-ai')
      if (existsSync(officialDir)) {
        for (const inner of readdirSafe(officialDir)) {
          if (!/^dsh-|^cordis-plugin-/.test(inner)) continue
          const pkg = join(officialDir, inner, 'package.json')
          if (!existsSync(pkg)) continue
          const meta = readJson(pkg)
          const name = '@deepseek-ai/' + inner
          seen.add(name)
          out.push({
            name,
            version: String(meta.version ?? ''),
            description: typeof meta.description === 'string' ? meta.description : '',
            scope: resolveScope(name, overrides),
            source: 'runtime',
          })
        }
      }
    }

    const profileModules = join(this.profileDir, 'node_modules')
    if (existsSync(profileModules)) {
      // 顶层 bundle
      for (const top of readdirSafe(profileModules)) {
        if (/^\./.test(top) || top === '@types') continue
        if (!top.startsWith('@')) {
          pushProfileBundle(out, seen, profileModules, top, undefined, overrides)
        }
      }
      const scoped = join(profileModules, '@')
      if (existsSync(scoped)) {
        for (const scope of readdirSafe(scoped)) {
          for (const inner of readdirSafe(join(scoped, scope))) {
            const name = '@' + scope + '/' + inner
            pushProfileBundle(out, seen, profileModules, name.replace(/^@/, ''), name, overrides)
          }
        }
      }
    }

    return out
  }

  // ---- 全局层补丁（cordis.patch.yml）启停 ----
  readPatchEnabledIds(): Set<string> {
    if (!existsSync(this.patchFile)) return new Set()
    const text = readFileSync(this.patchFile, 'utf8')
    const ids = new Set<string>()
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s+-\s+id:\s*(\S+)/)
      if (m) ids.add(m[1])
    }
    return ids
  }

  /**
   * 把插件写入 / 移出全局层补丁。写前先备份，write 采用原子写（临时文件 + rename）。
   * 返回是否发生了实际变更（已存在/已移除同一 id 时为 false）。
   */
  setPatchEnabled(id: string, name: string, enabled: boolean): boolean {
    if (!existsSync(this.patchFile)) return false
    const text = readFileSync(this.patchFile, 'utf8')
    const next = editPatch(text, id, name, enabled)
    if (next === text) return false
    backup(this.patchFile)
    atomicWrite(this.patchFile, next)
    return true
  }
}

function pushProfileBundle(
  out: PluginBundle[],
  seen: Set<string>,
  modulesRoot: string,
  rel: string,
  name: string | undefined,
  overrides: Record<string, PluginScope>,
): void {
  const resolvedName = name ?? rel
  if (seen.has(resolvedName)) return
  const pkg = join(modulesRoot, rel, 'package.json')
  if (!existsSync(pkg)) return
  const meta = readJson(pkg)
  // 只有声明了 dsh.bundle.patch 的 bundle 才是可管理的第三方插件
  if (!meta.dsh?.bundle?.patch) return
  seen.add(resolvedName)
  out.push({
    name: resolvedName,
    version: String(meta.version ?? ''),
    description: typeof meta.description === 'string' ? meta.description : '',
    scope: resolveScope(resolvedName, overrides),
    source: 'profile',
  })
}

/** 官方内核判据：仅 `@deepseek-ai/` scope 且非桌面壳产物（对应 deepseek-ai/deepseek-harness 官方仓库内核插件）。 */
export function isOfficialName(name: string): boolean {
  return name.startsWith('@deepseek-ai/') && !isShellName(name)
}

/** 桌面壳/客户端运行时产物识别：这些归"壳/third"，不算官方内核插件。启发式名单，可被 scopeOverrides 覆盖。 */
export function isShellName(name: string): boolean {
  if (!name.startsWith('@deepseek-ai/')) return false
  const n = name.slice('@deepseek-ai/'.length)
  return (
    n === 'dsh-shell' ||
    n === 'dsh-shell-env' ||
    n === 'dsh-app-boot' ||
    n === 'dsh-cordis-client-runner' ||
    n === 'dsh-cordis-host-runner' ||
    n === 'dsh-launch-environment' ||
    n === 'dsh-host-frontend-static' ||
    n === 'dsh-host-plugin-inventory' ||
    n === 'dsh-web' ||
    n === 'dsh-web-app' ||
    n === 'dsh-web-frontend' ||
    n.startsWith('dsh-client-')
  )
}

export function resolveScope(name: string, overrides: Record<string, PluginScope>): PluginScope {
  const ov = overrides[name]
  if (ov) return ov
  if (name.startsWith('@deepseek-ai/')) return isShellName(name) ? 'shell' : 'official'
  return 'third'
}

export function defaultFolderFor(scope: PluginScope): string {
  return scope === 'official' ? 'official' : 'third'
}

export function effectiveFolder(bundle: PluginBundle, overlay: Overlay): string {
  return overlay.assignments[bundle.name] ?? defaultFolderFor(bundle.scope)
}

/** 运行时官方内核 node_modules 根（Desktop 为 resources/app.asar.unpacked/node_modules）。 */
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
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 优先用 Node 解析（宿主进程内 @deepseek-ai/dsh 可解析），失败返回 null。 */
function rawResolve(spec: string, profileDir: string): string | null {
  const scopes = [import.meta.url]
  if (profileDir) scopes.push(join(profileDir, 'node_modules', 'x.js'))
  for (const from of scopes) {
    try {
      const require = createRequire(from)
      return require.resolve(spec)
    } catch {
      /* next scope */
    }
  }
  return null
}

function readJsonField(file: string, field: string): string {
  try {
    const obj = readJson(file)
    const value = obj[field]
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir) as string[]
  } catch {
    return []
  }
}

function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

function backup(file: string): void {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    renameSync(file, file + '.bak-' + stamp)
  } catch {
    /* 备份失败不阻断；下一次写会再尝试 */
  }
}

/**
 * 行级编辑全局层补丁：插入 / 移除 `- id: <id>` 条目块。
 * 返回新文本；未变更（目标态已满足 / 未找到 insert 区）时返回原文本。
 */
export function editPatch(text: string, id: string, name: string, enable: boolean): string {
  const lines = text.split(/\r?\n/)
  const itemIndex = lines.findIndex((l) => {
    const m = l.match(/^\s+-\s+id:\s*(\S+)/)
    return m ? m[1] === id : false
  })

  if (enable) {
    if (itemIndex >= 0) return text
    const child = `    - id: ${id}\n      name: '${name}'\n      config: {}`
    const insertIdx = lines.findIndex((l) => l.trim().startsWith('- insert:'))
    if (insertIdx < 0) {
      const sep = text.endsWith('\n') ? '' : '\n'
      return text + sep + '- insert:\n' + child + '\n'
    }
    let lastChildEnd = insertIdx
    for (let k = insertIdx + 1; k < lines.length; k++) {
      const l = lines[k]
      if (l.trim() === '' || /^\s*#/.test(l)) {
        lastChildEnd = k
        continue
      }
      const indent = (l.match(/^(\s*)/)?.[1] ?? '').length
      if (indent < 4) break
      lastChildEnd = k
    }
    lines.splice(lastChildEnd + 1, 0, child)
    return lines.join('\n')
  }

  if (itemIndex < 0) return text
  const itemIndent = (lines[itemIndex].match(/^(\s*)/)?.[1] ?? '').length
  let end = itemIndex
  for (let k = itemIndex + 1; k < lines.length; k++) {
    const l = lines[k]
    if (l.trim() === '') continue
    const indent = (l.match(/^(\s*)/)?.[1] ?? '').length
    if (l.trim().startsWith('-') || indent <= itemIndent) break
    end = k
  }
  lines.splice(itemIndex, end - itemIndex + 1)
  return lines.join('\n')
}