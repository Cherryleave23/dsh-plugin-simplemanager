/**
 * dsh-plugin-simplemanager — 宿主数据层。
 * 职责：内核版本只读、已安装插件目录扫描、启停的全局层补丁读写、
 * 自持分类/备注/闭包依赖记录 overlay 持久化。不持有 ctx，纯函数 + 文件系统，便于测试。
 */
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
  /** 插件自身声明的依赖（dependencies + peerDependencies，name@range）。用于「探明其依赖」。 */
  dependencies: string[]
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
  /** packageName -> 转正（promote）时补装的闭包依赖名。真卸载据此回收，依赖闭包随装卸完整进退。 */
  closureDeps: Record<string, string[]>
  /** 自定义文件夹的显式排列（id 顺序；内置 official/third 恒在最前）。缺省按创建顺序。 */
  folderOrder: string[]
  /** folderId -> 该文件夹内插件的显式排列（包名顺序）。缺省按目录扫描顺序。 */
  pluginOrder: Record<string, string[]>
  /** 热装安装过的包名集合（tempLoad 真实 pnpmAdd 进 profile node_modules 的包）。
   * 用于跨重启清理热装物理残留：tempLoad 临时语义「重启即消失」，物理包也应随之回收，
   * 否则残留污染目录扫描列表（P-033）。 */
  hotInstalls: string[]
}

export interface SimpleManagerConfig {
  /** 边界情况覆盖：第三方包发布到 @deepseek-ai/ scope、或桌面壳包需强指定官方/第三方。 */
  scopeOverrides: Record<string, PluginScope>
}

const DEFAULT_DATA_DIR = join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh', 'simplemanager')
const KERNEL_SPEC = '@deepseek-ai/dsh/package.json'

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

  // ---- Overlay（分类 + 备注 + 闭包依赖 + 排序）持久化 ----
  readOverlay(): Overlay {
    if (this.overlayCache) return structuredClone(this.overlayCache.data)
    const empty: Overlay = { folders: {}, assignments: {}, notes: {}, aliases: {}, closureDeps: {}, folderOrder: [], pluginOrder: {}, hotInstalls: [] }
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
        closureDeps: parsed.closureDeps ?? {},
        folderOrder: parsed.folderOrder ?? [],
        pluginOrder: parsed.pluginOrder ?? {},
        hotInstalls: parsed.hotInstalls ?? [],
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
      {
        folders: data.folders,
        assignments: data.assignments,
        notes: data.notes,
        aliases: data.aliases,
        closureDeps: data.closureDeps,
        folderOrder: data.folderOrder,
        pluginOrder: data.pluginOrder,
        hotInstalls: data.hotInstalls,
      },
      null,
      2,
    )
    if (this.overlayCache && this.overlayCache.raw === raw) return
    atomicWrite(this.overlayFile, raw)
    this.overlayCache = { raw, data }
  }

  /** 记录某已安装插件转正时补装的闭包依赖名（真卸载据此回收依赖闭包）。 */
  setClosureDeps(packageName: string, deps: string[]): void {
    const overlay = this.readOverlay()
    if (deps.length === 0) delete overlay.closureDeps[packageName]
    else overlay.closureDeps[packageName] = deps
    this.writeOverlay(overlay)
  }

  /** 读取某已安装插件的闭包依赖名记录（无则空数组）。 */
  getClosureDeps(packageName: string): string[] {
    return this.readOverlay().closureDeps[packageName] ?? []
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
            dependencies: declaredDeps(meta),
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
      // 作用域包布局是 node_modules/@scope/pkg：scope 目录直接以 '@' 开头，没有名为 '@' 的容器目录。
      // 之前 join(profileModules,'@') 指向不存在的 node_modules/@，导致所有作用域包（含 @anysearch/…）都扫不到。
      for (const scope of readdirSafe(profileModules)) {
        if (!scope.startsWith('@') || scope === '@types') continue
        for (const inner of readdirSafe(join(profileModules, scope))) {
          const name = scope + '/' + inner
          pushProfileBundle(out, seen, profileModules, name, name, overrides)
        }
      }
    }

    return out
  }

  // ---- 作用域分类 + 元数据解析（供装配驱动的 catalog 按名反查） ----
  /** 按包名分类作用域（主数据源是装配表；本方法对装配表里目录扫描漏掉的包也能正确归类）。 */
  scopeOf(name: string): PluginScope {
    return resolveScope(name, this.readConfig().scopeOverrides)
  }

  /**
   * 按名在解析链（profile → 运行时）探测 package.json，返回元数据以补全装配表条目。
   * 装配表是权威的插件全集，但可能含目录扫描没覆盖的包（如桌面壳顶层第三方 dshmarket），
   * 元数据由这里按名补齐；查不到返回 null。
   */
  describeBundle(name: string): { version: string; description: string; source: PluginBundle['source']; dependencies: string[] } | null {
    const locations: Array<[string, PluginBundle['source']]> = [
      [join(this.profileDir, 'node_modules', name, 'package.json'), 'profile'],
    ]
    const rr = runtimeNodeModules()
    if (rr) locations.push([join(rr, name, 'package.json'), 'runtime'])
    for (const [pkg, source] of locations) {
      if (!existsSync(pkg)) continue
      const meta = readJson(pkg)
      return {
        version: typeof meta.version === 'string' ? meta.version : '',
        description: typeof meta.description === 'string' ? meta.description : '',
        source,
        dependencies: declaredDeps(meta),
      }
    }
    return null
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
   * 把插件写入 / 移出全局层补丁（cordis.patch.yml）。
   *
   * 这是官方「profile 层 patch 最后应用」装配机制本身——桌面壳与 `dsh plugin` 登记的正是这一个文件、
   * 同一份 `- insert:` 块格式与语义，本插件只是按官方装配器产生的稳定格式做最小增删，并非另起旁路。
   * 之所以直接读写而非经 desktopPnpm / `dsh plugin` 命令：插件管家被要求自包含、只消费 dsh 内核
   * （不依赖桌面壳注入服务），故以官方装配器同格式落盘；装配行为与官方命令一致，重启由同一 loader 装配。
   *
   * 写前先备份，write 采用原子写（临时文件 + rename）。返回是否发生了实际变更（已存在/已移除同一 id 时为 false）。
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

  /** 从 profile package.json 的 `dsh.profile.bundles` 装配清单移除包名（官方 `dsh plugin add` 登记处）。
   * 避免卸载后重启时桌面壳仍尝试装配已删除的包而报 `cannot resolve package`。返回是否发生实际变更。 */
  removeBundle(packageName: string): boolean {
    const manifestPath = join(this.profileDir, 'package.json')
    if (!existsSync(manifestPath)) return false
    let manifest: { dsh?: { profile?: { bundles?: string[] } } }
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      return false
    }
    const bundles = manifest.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || !bundles.includes(packageName)) return false
    manifest.dsh!.profile!.bundles = bundles.filter((b) => b !== packageName)
    atomicWrite(manifestPath, JSON.stringify(manifest, null, 2))
    return true
  }

  /** 从 profile 的 bundle 层装配清单 `cordis.yml` 移除该插件的装配 entry（官方 `dsh plugin add`
   * 登记的顶层序列项）。与 patch 层（cordis.patch.yml）/ package.json bundles 不同：官方 bundle 插件
   * （含自装第三方）的启用装配登记在 `cordis.yml`——卸载若不清这层，重启后 loader 仍装配该 entry，
   * buildCatalog 经 `assembledModuleNames` 继续收拢它，插件就会残留在列表且仍可启停（P-038/P-039）。
   * `cordis.yml` 是规整的顶层数组（块起点为无缩进的 `- `，子字段 2 空格缩进），按块精确移除目标。返回是否发生实际变更。 */
  removeBundleEntry(packageName: string): boolean {
    const file = join(this.profileDir, 'cordis.yml')
    if (!existsSync(file)) return false
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split(/\r?\n/)
    const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^(?:-\\s+)?(?:id|name):\\s*['"]?${escaped}['"]?\\s*$`)
    const starts: number[] = []
    for (let i = 0; i < lines.length; i++) if (/^-\s/.test(lines[i])) starts.push(i)
    for (let s = 0; s < starts.length; s++) {
      const start = starts[s]
      const end = s + 1 < starts.length ? starts[s + 1] : lines.length
      const hit = lines.slice(start, end).some((l) => re.test(l.trim()))
      if (!hit) continue
      const eol = raw.includes('\r\n') ? '\r\n' : '\n'
      let body = [...lines.slice(0, start), ...lines.slice(end)].join(eol)
      if (!body.endsWith(eol)) body += eol
      backup(file)
      atomicWrite(file, body)
      return true
    }
    return false
  }

  /** 记录一次热装安装（tempLoad pnpmAdd 成功），供跨重启清理物理残留。 */
  pushHotInstall(packageName: string): void {
    const overlay = this.readOverlay()
    if (overlay.hotInstalls.includes(packageName)) return
    overlay.hotInstalls.push(packageName)
    this.writeOverlay(overlay)
  }

  /** 读取全部热装安装过的包名（持久化）。 */
  readHotInstalls(): string[] {
    return this.readOverlay().hotInstalls
  }

  /** 读取 profile package.json 的 `dsh.profile.bundles` 装配清单（官方渠道登记包名集合）。 */
  readBundles(): Set<string> {
    const manifestPath = join(this.profileDir, 'package.json')
    if (!existsSync(manifestPath)) return new Set()
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
      return new Set(manifest.dsh?.profile?.bundles ?? [])
    } catch {
      return new Set()
    }
  }

  /** 从热装记录里移除一个包名（其物理包已按正式渠道回收，不再待清理）。 */
  forgetHotInstall(packageName: string): void {
    const overlay = this.readOverlay()
    const i = overlay.hotInstalls.indexOf(packageName)
    if (i < 0) return
    overlay.hotInstalls.splice(i, 1)
    this.writeOverlay(overlay)
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
    dependencies: declaredDeps(meta),
  })
}

/** 官方内核判据：仅 `@deepseek-ai/` scope 且非桌面壳产物（对应 deepseek-ai/deepseek-harness 官方仓库内核插件）。 */
export function isOfficialName(name: string): boolean {
  return name.startsWith('@deepseek-ai/') && !isShellName(name)
}

/** 官方系统依赖判定：桌面壳发行内嵌提供，任何情况都不许当作第三方闭包装入/卸载（P-042/P-045）。
 * 仅认可明确的内嵌官方包（@deepseek-ai/dsh-*、@deepseek-ai/cordis、@deepseek-ai/schemastery、schemastery），
 * 不把 @deepseek-ai scope 下的第三方一刀切。 */
export function isOfficialSystemDep(name: string): boolean {
  return (
    name === '@deepseek-ai/cordis' ||
    name === 'schemastery' ||
    name === '@deepseek-ai/schemastery' ||
    name.startsWith('@deepseek-ai/dsh-')
  )
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

export function effectiveFolder(bundle: Pick<PluginBundle, 'name' | 'scope'>, overlay: Overlay): string {
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

/** 提取包声明的依赖（dependencies + peerDependencies），返回 `name@range` 数组（探明其依赖）。 */
function declaredDeps(meta: { dependencies?: unknown; peerDependencies?: unknown }): string[] {
  const out: string[] = []
  const map = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) return
    for (const [name, range] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof range === 'string' && range) out.push(`${name}@${range}`)
    }
  }
  map(meta.dependencies)
  map(meta.peerDependencies)
  return out
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

/** YAML 单引号字符串内转义（`'` → `''`），防止 name 里的引号破坏装配文件结构。 */
function yamlString(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * 行级编辑全局层补丁：插入 / 移除 `- id: <id>` 条目块。
 * 只对官方装配器稳定格式做最小增删：enable 挂在 `- insert:` 块尾或追加新块；disable 移除整条 item 及其子行。
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
    const child = `    - id: ${id}\n      name: '${yamlString(name)}'\n      config: {}`
    // 空数组占位 `[]`：数组本就为空，直接用 insert 块“就地替换”它，绝不能追加到其后（P-014）。
    const emptyIdx = lines.findIndex((l) => l.trim() === '[]')
    if (emptyIdx >= 0) {
      lines[emptyIdx] = '- insert:'
      lines.splice(emptyIdx + 1, 0, child)
      return lines.join('\n')
    }
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
  return normalizeEmpty(lines)
}

/**
 * disable 移除条目后调用：若已无任何 insert 子项、只剩悬空的 `- insert:` 外壳，
 * 收敛为合法顶层空数组 `[]`（避免悬空块让下一次 enable 追加错位 / YAML 解析器不识别）。
 * 存在其它顶层装配项（`- disable:` / `- config:`）时原样保留，交由官方与用户维护。
 */
function normalizeEmpty(lines: string[]): string {
  if (lines.some((l) => /^\s+- id:/.test(l))) return lines.join('\n')
  let sawInsertShell = false
  for (const l of lines) {
    const t = l.trim()
    const indent = l.match(/^(\s*)/)?.[1].length ?? 0
    if (t === '' || t.startsWith('#') || t === '[]') continue
    if (indent === 0 && t.startsWith('- insert:')) {
      sawInsertShell = true
      continue
    }
    return lines.join('\n')
  }
  if (!sawInsertShell) return lines.join('\n')
  const header = lines.filter((l) => {
    const t = l.trim()
    return t === '' || t.startsWith('#')
  })
  return header.map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '') + '\n[]\n'
}