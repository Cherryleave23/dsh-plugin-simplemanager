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
  /** 自定义文件夹：id -> {name, scope}。scope='shared'=插件管理+工具管理双边可见（共享持久化，两处修改互通）；
   * scope='tool'=仅工具管理可见（用于组织工具相关卡片，不进插件管理页）。内置文件夹 official/third 不落盘，恒为 shared。 */
  folders: Record<string, { name: string; scope?: 'shared' | 'tool' }>
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
  /** 工具管理（扫描分组）：被禁用的工具名集合。禁用后该工具描述不再注入 agent system prompt（省 token）。
   * 键=工具名；每次扫描分组/开关时与真实可见工具对账，已不存在的工具立即清除（无幽灵）。 */
  toolDeny: string[]
  /** 工具管理（拖拽分组）：工具名 -> 手动指定的归属卡片 key（插件包名 或 自定义工具组卡 id）。手动覆盖优先于扫描分组自动归属；
   * 每次扫描重建时，有记录的工具按覆盖值归组，其余仍按扫描结果。改名的工具随真实可见集消失即清理。
   * 空/无记录 = 未分组（默认「未分组/未知」卡）。 */
  toolGroupOverrides: Record<string, string>
  /** 工具管理（自定义工具组卡）：卡 id -> {name, folder?}。folder 仅工具管理文件夹 id（scope='tool'），
   * 用于把该卡归入某个工具管理文件夹下组织；缺省=不归入任何文件夹。资源管理特有容器，不进入插件管理页。 */
  toolCats: Record<string, { name: string; folder?: string }>
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
  /** catalog 扫描缓存：scanCatalog 是全盘目录走查 + 逐包 JSON.parse（阻塞事件循环），
   * 而 buildCatalog 在 9 个路由点被每次请求调用——不缓存则每个 HTTP 请求都全盘重扫。
   * TTL 兜底外部变更（终端手工 pnpm），变更路径（装卸/转正）显式 invalidateCatalog。 */
  private catalogCache: { at: number; data: PluginBundle[] } | null = null
  private static readonly CATALOG_TTL_MS = 4000

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
    const empty: Overlay = { folders: {}, assignments: {}, notes: {}, aliases: {}, closureDeps: {}, folderOrder: [], pluginOrder: {}, hotInstalls: [], toolDeny: [], toolGroupOverrides: {}, toolCats: {} }
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
        toolDeny: parsed.toolDeny ?? [],
        toolGroupOverrides: parsed.toolGroupOverrides ?? {},
        toolCats: parsed.toolCats ?? {},
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
        toolDeny: data.toolDeny,
        toolGroupOverrides: data.toolGroupOverrides,
        toolCats: data.toolCats,
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
  /** 节点变更后强制下次全盘重扫（装卸/转正/卸载等改变 node_modules 的路径调用）。 */
  invalidateCatalog(): void {
    this.catalogCache = null
  }

  scanCatalog(): PluginBundle[] {
    if (this.catalogCache && Date.now() - this.catalogCache.at < SimpleManagerHost.CATALOG_TTL_MS) {
      return this.catalogCache.data
    }
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

    this.catalogCache = { at: Date.now(), data: out }
    return out
  }

  // ---- 作用域分类 + 元数据解析（供装配驱动的 catalog 按名反查） ----
  /** 按包名分类作用域（主数据源是装配表；本方法对装配表里目录扫描漏掉的包也能正确归类）。
   * located：包的物理位置。'runtime'（宿主 resources）→ 壳内包，无视名字启发式一律 shell，
   * 防止无 @deepseek-ai/ 前缀的壳自带包（如 dshmarket）被判 third→孤儿；scopeOverrides 优先级最高。 */
  scopeOf(name: string, located?: PluginBundle['source']): PluginScope {
    const overrides = this.readConfig().scopeOverrides
    if (overrides[name]) return overrides[name]
    // 官方前缀包按既有名单识别（official/shell），不受物理位置影响——防止壳内 @deepseek-ai/* 被位置规则改判。
    if (name.startsWith('@deepseek-ai/')) return resolveScope(name, overrides)
    if (located === 'runtime') return 'shell'
    return resolveScope(name, overrides)
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

  // ---- 装配层写面 · 判据6 收敛注记（已知脆弱，见 MANIFEST「不许碰清单」） ----
  // 运行时装配效果一律走官方服务（ctx.loader.update/remove，见 index.ts）；本集群为跨重启持久化 /
  // 装配清单清理的必要兜底。直写的是官方装配器产生的同格式文件（cordis.patch.yml / cordis.yml /
  // profile package.json bundles），但格式属 loader 内部状态、非公共契约——内核/桌面壳改动格式时此处
  // 正则/清单编辑可能失效。升级适配时先对照 MANIFEST「不许碰清单」对消费面 diff：
  //   官方替代 = `dsh plugin remove` / 桌面壳 `desktopPnpm` 等装配持久化入口；
  //   保留此直写的原因 = 插件要求宿主不可知、只消费 dsh 内核，官方 in-kernel JS API 尚无通用范式。
  // ---- 全局层补丁（cordis.patch.yml）启停 ----
  readPatchEnabledIds(): Set<string> {
    if (!existsSync(this.patchFile)) return new Set()
    const text = readFileSync(this.patchFile, 'utf8')
    const ids = new Set<string>()
    for (const line of text.split(/\r?\n/)) {
      const id = extractPatchId(line)
      if (id) ids.add(id)
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
   * @known-fragile 装配层内部文件直写（见 MANIFEST「不许碰清单」），同格式但非公共契约。
   */
  setPatchEnabled(id: string, name: string, enabled: boolean): boolean {
    if (!existsSync(this.patchFile)) return false
    const text = readFileSync(this.patchFile, 'utf8')
    const next = editPatch(text, id, name, enabled)
    if (next === text) return false
    backup(this.patchFile)
    // 直写理由（规则4豁免）：patch 启停是官方声明式契约（cordis.patch.yml），官方未提供运行时改写 API，
    // 此处直写 + 写前 backup() 快照是唯一官方认可的持久化路径，非装配旁路。
    atomicWrite(this.patchFile, next)
    return true
  }

  /** 从 profile package.json 的 `dsh.profile.bundles` 装配清单移除包名（官方 `dsh plugin add` 登记处）。
   * 避免卸载后重启时桌面壳仍尝试装配已删除的包而报 `cannot resolve package`。返回是否发生实际变更。
   * @known-fragile 装配清单直写（见 MANIFEST「不许碰清单」），其 schema 非公共契约。 */
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
    // 直写理由（规则4豁免）：dsh.profile.bundles 是官方 `dsh plugin add` 的装配登记处，
    // 官方未提供「从登记表移除单包」的运行时 API（remove 是全量装卸）；卸载后同步清登记防幽灵装配，非旁路。
    atomicWrite(manifestPath, JSON.stringify(manifest, null, 2))
    return true
  }

  /** 从 profile 的 bundle 层装配清单 `cordis.yml` 移除该插件的装配 entry（官方 `dsh plugin add`
   * 登记的顶层序列项）。与 patch 层（cordis.patch.yml）/ package.json bundles 不同：官方 bundle 插件
   * （含自装第三方）的启用装配登记在 `cordis.yml`——卸载若不清这层，重启后 loader 仍装配该 entry，
   * buildCatalog 经 `assembledModuleNames` 继续收拢它，插件就会残留在列表且仍可启停（P-038/P-039）。
   * `cordis.yml` 是规整的顶层数组（块起点为无缩进的 `- `，子字段 2 空格缩进），按块精确移除目标。返回是否发生实际变更。
   * @known-fragile 装配清单直写（见 MANIFEST「不许碰清单」），格式非公共契约。 */
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

  /** 判断某插件是否由 **bundle 装配层** 管理（官方 `dsh plugin add` 渠道：profile package.json
   * `dsh.profile.bundles` 清单，或 `cordis.yml` 顶层序列装配项）。与 patch 层（cordis.patch.yml）区分：
   * bundle 层插件重启由该层恢复装配，启停不能写 patch（否则与 cordis.yml 重复装配 → duplicate loader entry id）。
   * @known-fragile 装配清单直读（见 MANIFEST「不许碰清单」），格式非公共契约。 */
  isBundleAssembled(packageName: string): boolean {
    if (this.readBundles().has(packageName)) return true
    const file = join(this.profileDir, 'cordis.yml')
    if (!existsSync(file)) return false
    const raw = readFileSync(file, 'utf8')
    const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^(?:-\\s+)?(?:id|name):\\s*['"]?${escaped}['"]?\\s*$`)
    for (const line of raw.split(/\r?\n/)) if (re.test(line.trim())) return true
    return false
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

/** 从补丁行 `- id: <值>` 提取真实 id。官方装配器对普通包名写裸值；本插件对以 `@` 等保留字符开头的作用域包
 * 用单引号写入（裸写会让 YAML 解析失败）。这里剥掉外层引号还原包名，解析失败返回 null。 */
function extractPatchId(line: string): string | null {
  const m = /^\s+-\s+id:\s*(?:'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"|(\S+))/.exec(line)
  if (!m) return null
  if (m[1] !== undefined) return m[1].replace(/''/g, "'")
  if (m[2] !== undefined) {
    try { return JSON.parse('"' + m[2] + '"') } catch { return m[2] }
  }
  return m[3]
}

/**
 * 行级编辑全局层补丁：插入 / 移除 `- id: <id>` 条目块。
 * 只对官方装配器稳定格式做最小增删：enable 挂在 `- insert:` 块尾或追加新块；disable 移除整条 item 及其子行。
 * 返回新文本；未变更（目标态已满足 / 未找到 insert 区）时返回原文本。
 */
export function editPatch(text: string, id: string, name: string, enable: boolean): string {
  const lines = text.split(/\r?\n/)
  const itemIndex = lines.findIndex((l) => extractPatchId(l) === id)

  if (enable) {
    if (itemIndex >= 0) return text
    // id 也用单引号包裹：`@` 开头的作用域包名裸写会被 YAML 当作保留指示符导致解析失败（见 extractPatchId）。
    const child = `    - id: '${yamlString(id)}'\n      name: '${yamlString(name)}'\n      config: {}`
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