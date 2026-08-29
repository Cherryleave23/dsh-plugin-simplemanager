/**
 * L0 真实探针引擎 ——「外置独立 dsh 子进程 + HTTP/渲染心跳」三态判定，插件自理、零第三方运行时依赖。
 *
 * 设计契约（与 guard 式启动级探针对齐，但做隔离化改造）：
 *   - 对象：一次性隔离副本（不复制真实 profile 的 node_modules），测完销毁并确保子进程树零残留；
 *   - 触发：插件管家内按需（热装/预检/面板发起），永久不解救用系统级开机钩子；
 *   - 判定：HTTP 就绪 + 我方插件挂载的渲染心跳(/probe/api/render-error|booted)，三态 pass/crash/hang；
 *   - 归因：启动日志 → 定位候选插件（候选即挂测对象，直接归因）；
 *   - 现网：真实 profile 只读，结论上报，用户勾选才写禁用，绝不自动改。
 *
 * 环境纪律（每条都是踩过的坑，写进契约）：
 *   - 不复制 node_modules：副本只带装配元数据(依赖声明/锁/补丁) + 干净装配，
 *     `virtualStoreDir` 由 pnpm 重建为自身路径，杜绝 ERR_PNPM_UNEXPECTED_VIRTUAL_STORE / stale link 残留；
 *   - 独立状态根 + 独立端口/环境(DSH_HOME override)，不与运行中桌面内核冲突；
 *   - 结束必杀进程树(taskkill /T /F) + 删副本，保证零残留。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync, readlinkSync, symlinkSync, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import * as http from 'node:http'
import { join, dirname, resolve, sep } from 'node:path'

// ---------------------------------------------------------------------------
// 可移植原语（port from dsh-plugin-guard，按 TS 重写，语义不变）
// ---------------------------------------------------------------------------

function isWin(): boolean {
  return process.platform === 'win32'
}

/** 定点容错解码：剥 BOM，优先严格 UTF-8，回退系统 ANSI(GBK/CP936)（PowerShell 5.1 默认 ANSI）。 */
export function decodeTextRobust(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const be = Buffer.from(buf.subarray(2))
    for (let i = 0; i + 1 < be.length; i += 2) { const t = be[i]; be[i] = be[i + 1]; be[i + 1] = t }
    return be.toString('utf16le')
  }
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const body = hasBom ? buf.subarray(3) : buf
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    try { return new TextDecoder('gbk').decode(body) } catch { return body.toString('utf8') }
  }
}

function readTextRobust(path: string): string {
  try { return decodeTextRobust(readFileSync(path)) } catch { return '' }
}

/** 探测一个空闲 TCP 端口（绑定 0）。 */
export function resolveFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolvePort(port))
    })
  })
}

/** HTTP 健康探测：2xx–4xx 视为可服务（5xx 视为未就绪）。返回同步 Promise<boolean>，绝不抛。 */
export function health(port: number): Promise<boolean> {
  return new Promise((resolveOk) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => {
      res.resume()
      resolveOk(res.statusCode != null && res.statusCode >= 200 && res.statusCode < 500)
    })
    req.on('error', () => resolveOk(false))
    req.on('timeout', () => { req.destroy(); resolveOk(false) })
  })
}

/** 定位可用 dsh 二进制（Windows 为 .cmd，经 cmd.exe 启动）。优先 harness 安装，再看 PATH。 */
export function resolveDshBin(dshHomeDir?: string): string | null {
  const candidates: string[] = []
  if (dshHomeDir) {
    candidates.push(join(dirname(dshHomeDir), 'node_modules', '.bin', isWin() ? 'dsh.cmd' : 'dsh'))
    candidates.push(join(dshHomeDir, 'node_modules', '.bin', isWin() ? 'dsh.cmd' : 'dsh'))
  }
  for (const c of candidates) if (c && existsSync(c)) return c
  if (isWin()) {
    const probe = spawnSync('cmd.exe', ['/d', '/s', '/c', 'dsh --version'], { encoding: 'utf8' })
    if (probe.status === 0) return 'dsh.cmd'
  }
  return null
}

/** Windows cmd token：仅含空白/引号时才加引号，裸名保持不引号以便 cmd 走 PATH 解析。 */
function cmdToken(s: string): string {
  return /[\s"]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s)
}

/** 定位可用 pnpm 启动器。 */
export function resolvePnpmCommand(dshHomeDir?: string): string | null {
  const candidates = [
    process.env.DSH_GUARD_PNPM ?? '',
    'pnpm',
    ...(dshHomeDir ? [join(dirname(dshHomeDir), 'node_modules', '.bin', isWin() ? 'pnpm.cmd' : 'pnpm')] : []),
  ]
  for (const c of candidates) {
    if (!c) continue
    if (c === 'pnpm') {
      const probe = isWin()
        ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'pnpm --version'], { encoding: 'utf8' })
        : spawnSync('pnpm', ['--version'], { encoding: 'utf8' })
      if (probe.status === 0) return c
      continue
    }
    if (existsSync(c)) return c
  }
  return null
}

export interface PnpmResult { ok: boolean; status: number | null; output: string }

/** 运行 pnpm（Windows 经 cmd.exe，参数按 cmdToken 规整）。 */
export function runPnpm(args: string[], cwd: string, pnpmCommand?: string | null): PnpmResult {
  const command = pnpmCommand ?? resolvePnpmCommand()
  if (!command) return { ok: false, status: null, output: 'pnpm 不可用(PATH/DSH_GUARD_PNPM/本地 .bin 均无)' }
  const result = isWin()
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', [cmdToken(command), ...args.map(cmdToken)].join(' ')], { cwd, encoding: 'utf8' as BufferEncoding, timeout: 10 * 60 * 1000 })
    : spawnSync(command, args, { cwd, encoding: 'utf8' as BufferEncoding, timeout: 10 * 60 * 1000 })
  return { ok: result.status === 0, status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 从启动日志抽取被点名的插件名（装载期/树稳定期两种格式）。 */
export function extractFailedPluginNames(logText: string): string[] {
  const names: string[] = []
  if (!logText) return names
  const push = (n: unknown): void => { const t = String(n ?? '').trim(); if (t && !names.includes(t)) names.push(t) }
  const entryRe = /failed to \S+ loader entry \S+ \(([^)]+)\):/gi
  let m: RegExpExecArray | null
  while ((m = entryRe.exec(logText))) push(m[1])
  const settle = logText.match(/plugin\(s\) failed to load:\s*([^;\n]+)/i)
  if (settle) for (const raw of settle[1].split(',')) push(raw.replace(/[()]/g, ''))
  return names
}

/** profile 的已知插件行：补丁 insert 行(可用 disabled 覆盖) + bundle/link 依赖包名(仅信息)。 */
export function profilePluginRows(profileDirPath: string): Array<{ id: string; name: string; patch: boolean }> {
  const rows: Array<{ id: string; name: string; patch: boolean }> = []
  const seen = new Set<string>()
  const add = (id: string, name: string, patch: boolean): void => {
    if (!id || seen.has(id)) return
    seen.add(id)
    rows.push({ id, name: name || id, patch })
  }
  try {
    const raw = readFileSync(join(profileDirPath, 'cordis.patch.yml'), 'utf8')
    // 与 host.ts extractPatchId 同风格：正则剥外层引号还原真实包名，识别置入补丁的 plugin 行。
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s+-\s+id:\s*(?:'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"|(\S+))/.exec(line)
      if (!m) continue
      const id = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] !== undefined ? m[2] : m[3]
      add(id, id, true)
    }
  } catch { /* 补丁解析失败 -> 无补丁行 */ }
  try {
    const pkg = JSON.parse(readFileSync(join(profileDirPath, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: string[] } }
      dependencies?: Record<string, string>
    }
    const bundles = pkg?.dsh?.profile?.bundles
    if (Array.isArray(bundles)) for (const b of bundles) add(b, b, false)
    const deps = pkg?.dependencies ?? {}
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && spec.trim().toLowerCase().startsWith('link:')) add(name, name, false)
    }
  } catch { /* ignore */ }
  return rows
}

/** 清理 node_modules 里指向 node_modules 之外、且不再是 link: 依赖/bundle 的孤儿符号链接（绝不删目标）。 */
export function cleanupStaleBundleLinks(profileDirPath: string): string[] {
  const nm = join(profileDirPath, 'node_modules')
  if (!existsSync(nm)) return []
  let pkg: { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } } | null = null
  try { pkg = JSON.parse(readFileSync(join(profileDirPath, 'package.json'), 'utf8')) } catch { /* broken -> 视为全 stale */ }
  const valid = new Set<string>()
  if (pkg) {
    const deps = pkg.dependencies ?? {}
    for (const [n, spec] of Object.entries(deps)) if (typeof spec === 'string' && spec.trim().toLowerCase().startsWith('link:')) valid.add(n)
    const bundles = pkg?.dsh?.profile?.bundles
    if (Array.isArray(bundles)) for (const b of bundles) valid.add(b)
  }
  const removed: string[] = []
  const scan = (base: string, prefix: string): void => {
    let entries: string[] = []
    try { entries = readdirSync(base) } catch { return }
    for (const name of entries) {
      const p = join(base, name)
      let st
      try { st = lstatSync(p) } catch { continue }
      if (st.isDirectory() && !st.isSymbolicLink() && name.startsWith('@')) { scan(p, name); continue }
      if (!st.isSymbolicLink()) continue
      let target = ''
      try { target = readlinkSync(p) } catch { continue }
      const abs = resolve(dirname(p), target)
      if (abs === nm || abs.startsWith(nm + sep)) continue
      const full = prefix ? `${prefix}/${name}` : name
      if (valid.has(full)) continue
      try { rmSync(p, { recursive: true, force: true }); removed.push(full) } catch { /* best effort */ }
    }
  }
  scan(nm, '')
  return removed
}

function sha256File(path: string): string {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex') } catch { return '' }
}

// ---------------------------------------------------------------------------
// 隔离副本构造（环境纪律核心：绝不复制真实 profile 的 node_modules）
// ---------------------------------------------------------------------------

/** 探针候选名单项：批量探针时全部候选共存于同一个隔离实例。 */
export interface ProbeCandidate {
  /** 插件真实包名（从 spec 解析）。 */
  name: string
  /** 插件源目录（file: 装配指向）。 */
  dir: string
}

export interface IsolatedProfileSpec {
  /** 隔离副本目录（探针自已建，测完销毁）。 */
  dir: string
  /** 副本内 profile 目录（home/profiles/web，pnpm 装配与实例 cwd 均在此）。 */
  profileDir: string
  /** 副本内隔离 home 根（实例 DSH_HOME 指向此处，profiles 解析彻底离开真实 home）。 */
  homeDir: string
  /** 本次共存装配的候选名单（file: 指向各自源目录）。 */
  candidates: ProbeCandidate[]
  logDir: string
}

/** 从真实 profile 的装配元数据派生隔离副本：copy 依赖清单/补丁，不 copy node_modules。
 * `candidates` 为批量候选名单——全部共存于同一个隔离实例（一次装配/一个内核/一个 URL），
 * 探测插件间真实共存效果。`companions` 为「当前环境其余已加载第三方插件」（name → 装配 spec），
 * 与候选一起放进副本，实现全量协同探测。返回 { dir, profileDir, homeDir, candidates, logDir }；任何失败抛 Error。 */
export function makeIsolatedProfile(
  baseProfileDir: string,
  stateRoot: string,
  candidates: ProbeCandidate[],
  companions?: Array<{ name: string; spec: string }>,
): IsolatedProfileSpec {
  const probeRoot = join(stateRoot, 'probe')
  mkdirSync(probeRoot, { recursive: true })
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const dir = join(probeRoot, `op-${stamp}`)
  const logDir = join(probeRoot, `logs-${stamp}`)
  // 隔离 home：实例的 DSH_HOME 指向 op/home（profile 名固定 web，`dsh web` 即 --profile web）。
  // 此前不设隔离 home 时子进程继承父内核 DSH_HOME，`dsh web` 实际服务真实 profiles/web，
  // 候选从未被装配加载（实测「探针 pass 但浏览器里没有插件」的根因）。
  const homeDir = join(dir, 'home')
  const profileDir = join(homeDir, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(logDir, { recursive: true })
  // 共享运行时可达性:官方 @deepseek-ai/* 由内核运行时闭包提供(真实 home 的
  // profiles/node_modules 是指向 dsh 内核 apps/cli node_modules 的 junction 投影)。
  // 探针隔离 home 若缺这条链,loader 会按 baseUrl(隔离 profile)上溯解析、命不中官方包,
  // ClientModuleRegistry 便定位不到 @deepseek-ai/dsh-client-modules → bootstrap 批次为空 →
  // 页面报 "HTML did not preload ...client.js"。故在隔离 home 建到真实共享运行时的只读 junction。
  const sharedModuleRoot = join(dirname(baseProfileDir), 'node_modules')
  if (existsSync(join(sharedModuleRoot, '@deepseek-ai', 'dsh-client-modules'))) {
    const probeShared = join(homeDir, 'profiles', 'node_modules')
    try { symlinkSync(sharedModuleRoot, probeShared, isWin() ? 'junction' : 'dir') } catch { /* 建链失败退化为现状,不阻断 */ }
  }

  // 装配元数据：锁定同源官方依赖 + 全部候选插件(以 file: 指向其源，非 link:，内存判据)。
  const basePkg = JSON.parse(readFileSync(join(baseProfileDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    lockfileVersion?: unknown
    dsh?: unknown
  }
  const deps: Record<string, string> = { ...(basePkg.dependencies ?? {}) }
  const candidateList = (Array.isArray(candidates) ? candidates : []).filter(
    (c) => c && typeof c.name === 'string' && typeof c.dir === 'string',
  )
  const candidateNames = new Set(candidateList.map((c) => c.name))
  for (const c of candidateList) {
    delete deps[c.name]
    deps[c.name] = `file:${c.dir}`
  }
  // 全量协同：把当前环境其余已加载第三方插件一并放进副本。
  // 已声明在 profile 的项（含原 link:）原样携带；漏声明（临时加载/热装副本）由 companions 补装。
  if (companions) {
    for (const c of companions) {
      if (!c || !c.name || !c.spec) continue
      if (deps[c.name] !== undefined || candidateNames.has(c.name)) continue
      deps[c.name] = c.spec
    }
  }
  const probePkg: Record<string, unknown> = {
    name: 'dsh-simplemanager-probe',
    private: true,
    type: 'module',
    dependencies: deps,
  }
  if (basePkg.dsh) probePkg.dsh = basePkg.dsh
  // 装配登记：候选/伴随插件此前只进 dependencies、不进任何装配层，实例从不加载它们。
  // 声明了 dsh.bundle.patch 的包走 bundle 层（与 simplemanager 自身在主 profile 的装配方式同构）；
  // 普通插件包走用户 patch 的 `- insert:` 行（与 pm_promote 落盘格式同构）。
  const profileManifest = (probePkg.dsh && typeof probePkg.dsh === 'object' ? (probePkg.dsh as { profile?: Record<string, unknown> }).profile : undefined) ?? {}
  const baseBundles = Array.isArray(profileManifest.bundles) ? [...(profileManifest.bundles as string[])] : []
  const bundleAdds: string[] = []
  const insertAdds: Array<{ id: string; name: string }> = []
  const declare = (name?: string) => {
    const spec = name ? deps[name] : undefined
    if (typeof spec !== 'string' || spec === '') return
    if (baseBundles.includes(name!) || bundleAdds.includes(name!)) return
    let meta: { name?: string; dsh?: { bundle?: { patch?: string } } } = {}
    try {
      meta = JSON.parse(readFileSync(join(spec.replace(/^(file|link):/, ''), 'package.json'), 'utf8'))
    } catch { /* 清单不可读则按普通插件处理 */ }
    if (meta && meta.dsh && meta.dsh.bundle && meta.dsh.bundle.patch) bundleAdds.push(name!)
    else insertAdds.push({ id: typeof meta?.name === 'string' ? meta.name : name!, name: name! })
  }
  for (const c of candidateList) declare(c.name)
  for (const c of companions ?? []) declare(c?.name)
  if (bundleAdds.length > 0)
    probePkg.dsh = { ...(probePkg.dsh as Record<string, unknown> ?? {}), profile: { ...profileManifest, bundles: [...baseBundles, ...bundleAdds] } }
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(probePkg, null, 2)}\n`, 'utf8')
  // 副本自洽 workspace 根：本目录放空 packages，pnpm 停在副本，不再上溯到祖先 workspace
  // （如 home 残留的 pnpm-workspace.yaml，会把依赖误判装进祖先项目而非隔离副本）。
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8')
  // 官方 peer 由内核运行时提供、公共 registry 拉不到（如 @deepseek-ai/dsh-* @0.1.2-alpha.x 发行内嵌）：
  // 关闭 auto-install-peers，装配阶段不把候选/伴随插件的官方 peer 当真依赖去 npm 拉（会 NO_MATCHING_VERSION），
  // 运行时由探针实例的 DSH 内核按 peer 提供者解析——即 tempLoad「skipOfficialPeers」在隔离装配里的等价物。
  writeFileSync(join(profileDir, '.npmrc'), 'auto-install-peers=false\nstrict-peer-dependencies=false\n', 'utf8')

  // 补丁：完整复制真实补丁，确证候选能否在真实装配语义下装载（不 copy node_modules 是唯一的取舍）；
  // 普通插件包没有 bundle patch 可声明，追加 `- insert:` 行补登记（格式与官方装配器一致）。
  let patchText = ''
  try {
    patchText = readFileSync(join(baseProfileDir, 'cordis.patch.yml'), 'utf8')
  } catch { patchText = '# (probe: no base patch)\n' }
  // bundle 化条目去重：被加进副本 bundles 的包，若已转正过（复制来的 patch 里有其 insert 行），
  // 会 bundle+patch 双重登记 → duplicate loader entry id。对齐 reconcilePatchResidual 语义：
  // bundle 化条目从 patch 层剥离（只剥「- id: 后紧跟 name:」的稳定两项格式，其余行不动）。
  if (bundleAdds.length > 0) {
    const bundleSet = new Set(bundleAdds)
    const lines = patchText.split(/\r?\n/)
    const kept: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const nm = i + 1 < lines.length ? lines[i + 1].match(/^\s+name:\s*(.*?)\s*$/) : null
      if (/^\s*-\s+id:\s*/.test(lines[i]) && nm && bundleSet.has(nm[1].replace(/^["']|["']$/g, ''))) {
        i++
        continue
      }
      kept.push(lines[i])
    }
    patchText = kept.join('\n')
  }
  // insert 行去重：复制的真实补丁里已登记过的 id 不再追加。候选/伴随若此前已 promote 过
  // （真实补丁里已有其 insert 行），追加会产生重复 loader entry id → cordis:include 启动即崩。
  const patchIds = new Set<string>()
  for (const m of patchText.matchAll(/^\s*-?\s*id:\s*['"]?([^'"\n]+?)['"]?\s*$/gm)) patchIds.add(m[1].trim())
  const pendingInserts = insertAdds.filter((e) => !patchIds.has(e.id) && !patchIds.has(e.name))
  if (pendingInserts.length > 0) {
    const block = pendingInserts.map((e) => `    - id: ${e.id}\n      name: ${e.name}`).join('\n')
    if (/\[\]\s*$/.test(patchText)) patchText = patchText.replace(/\[\]\s*$/, `- insert:\n${block}\n`)
    else patchText = patchText.replace(/\s*$/, `\n- insert:\n${block}\n`)
  }
  writeFileSync(join(profileDir, 'cordis.patch.yml'), patchText, 'utf8')

  // 配置快照：把真实 home 的 settings.yaml、.credentials.yaml 一次性只读拷进隔离 home，
  // 候选插件前端（供应商管理/模型选择等）即能看到真实配置与密钥。只复制不链接：隔离实例的
  // 一切写入都落在副本，真实 home 全程零接触。storages/会话不携带（工作区与会话身份留在真实实例）。
  const homeRoot = dirname(dirname(baseProfileDir)) // <home>/profiles/web → <home>
  for (const f of ['settings.yaml', '.credentials.yaml']) {
    try {
      if (existsSync(join(homeRoot, f))) copyFileSync(join(homeRoot, f), join(homeDir, f))
    } catch { /* 单个文件失败不阻断探针 */ }
  }

  return { dir, profileDir, homeDir, candidates: candidateList, logDir }
}

// ---------------------------------------------------------------------------
// spawn 与三态等待
// ---------------------------------------------------------------------------

export interface ProbeOptions {
  /** 批量候选名单：全部共存于同一个隔离实例（一次装配/一个内核/一个 URL）；优先于 candidate/candidateDir。 */
  candidates?: ProbeCandidate[]
  /** 单元候选（candidates 缺省时的兼容形态）。 */
  candidate?: string
  /** 候选插件源目录(用于 file: 装配与归因)。 */
  candidateDir?: string
  /** 真实 profile 目录（派生装配元数据 + 归因 patch 行）。 */
  profileDir: string
  /** 插件管家状态根，用于承载隔离副本与日志。 */
  stateRoot: string
  /** 全量协同：当前环境其余已加载第三方插件（name→装配 spec），与候选一起装入隔离副本。 */
  companions?: Array<{ name: string; spec: string }>
  /** DSH_HOME override（隔离状态根）；缺省继承当前环境。 */
  dshHome?: string
  /** keep 模式：判定通过后保留隔离实例与副本，供人工浏览器检查（不清理）。 */
  keep?: boolean
  port?: number
  firstWaitSec?: number
  renderSettleSec?: number
  timeoutSec?: number
}

export type ProbeOutcome = 'pass' | 'crash' | 'hang' | 'render-crash' | 'error'

export interface ProbeReport {
  outcome: ProbeOutcome
  port: number
  healthy: boolean
  rendered: boolean
  culprit: { id: string | null; name: string } | null
  error?: string
  bootLogTail: string
  elapsedMs: number
  steps: string[]
  /** keep 模式：判定通过后保留隔离实例与副本（默认测完即清、零残留）。 */
  kept?: boolean
  keptPid?: number
  keptPort?: number
  keptUrl?: string
  keptDir?: string
}

let _probeSeq = 0

function spawnDetached(cmdLine: string[], cwd: string, outLog: string, errLog: string, env?: NodeJS.ProcessEnv): ChildProcess {
  const child = isWin()
    ? spawn('cmd.exe', ['/d', '/s', '/c', cmdLine.join(' ')], { cwd, stdio: [ 'ignore', 'pipe', 'pipe' ], env: env ?? process.env })
    : spawn(cmdLine[0], cmdLine.slice(1), { cwd, stdio: [ 'ignore', 'pipe', 'pipe' ], env: env ?? process.env })
  const so = createWriteStream(outLog, { flags: 'a' })
  const se = createWriteStream(errLog, { flags: 'a' })
  if (child.stdout) child.stdout.pipe(so)
  if (child.stderr) child.stderr.pipe(se)
  return child
}

function killTree(child: ChildProcess): void {
  if (child.pid && !child.killed) {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']) } catch { /* best effort */ }
    try { child.kill() } catch { /* best effort */ }
  }
}

/** 三态等待：'ok'(HTTP 就绪) | 'crashed'(进程已退，立即回滚) | 'timeout'(仍在跑但未就绪)。
 * 崩溃分支要求「未健康 + 进程已死」双满足，避免被 detach 的健康子进程误杀。 */
async function waitBoot(proc: ChildProcess, port: number, seconds: number): Promise<'ok' | 'crashed' | 'timeout'> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    if (await health(port)) return 'ok'
    if (proc.exitCode !== null) return 'crashed'
    if (Date.now() >= deadline) return 'timeout'
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** 消费我方插件挂载的渲染心跳：pass(render-error) / crash(render-error true) / unconfirmed(无心跳无崩溃)。
 * 404/非 JSON = 我方插件未在场 -> 视为无渲染判定，返回 pass（HTTP 层已通）。 */
async function renderHeartbeat(port: number, seconds: number): Promise<'ok' | 'render-crash' | 'unconfirmed'> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const verdict = await pollRenderOnce(port)
    if (verdict === 'ok' || verdict === 'render-crash') return verdict
    if (Date.now() >= deadline) return 'unconfirmed'
    await new Promise((r) => setTimeout(r, 500))
  }
}
function pollRenderOnce(port: number): Promise<'ok' | 'render-crash' | 'unconfirmed' | 'poll'> {
  return new Promise((resolveV) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/probe/api/render-error', timeout: 2000 }, (res) => {
      res.resume()
      if (res.statusCode === 404) return resolveV('ok')
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { renderError?: boolean; booted?: boolean }
          const hasSignal = 'renderError' in parsed || 'booted' in parsed
          if (!hasSignal) return resolveV('ok')
          if (parsed.renderError) return resolveV('render-crash')
          if (parsed.booted) return resolveV('ok')
          return resolveV('poll')
        } catch {
          return resolveV('ok')
        }
      })
    })
    req.on('error', () => resolveV('poll'))
    req.on('timeout', () => { req.destroy(); resolveV('poll') })
  })
}

async function latestLogTail(logDir: string, pattern: string, tail: number): Promise<string> {
  let files: string[] = []
  try { files = readdirSync(logDir).filter((f) => f.includes(pattern)).sort() } catch { return '' }
  if (files.length === 0) return ''
  const lines = readTextRobust(join(logDir, files.at(-1)!)).split(/\r?\n/)
  return lines.slice(-tail).join('\n')
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

export interface RunProbeResult extends ProbeReport {
  spec: IsolatedProfileSpec | null
  specError?: string
  pnpmLog?: string
}

/** 执行一次 L0 探针：造隔离副本 → 干净装配全部候选（共存一实例） → spawn 外置独立实例 → 三态 + 渲染心跳 → 归因 → 必清残留。 */
export async function runProbe(opts: ProbeOptions): Promise<RunProbeResult> {
  const t0 = Date.now()
  const port = opts.port ?? (await resolveFreePort())
  const firstWaitSec = opts.firstWaitSec ?? 60
  const renderSettleSec = opts.renderSettleSec ?? 20
  // keep 模式：判定通过后保留隔离实例与副本，供人工在浏览器打开检查（keptUrl/keptPid/keptDir 回传）。
  const keep = opts.keep === true
  // 批量候选：candidates 数组共存同一实例；兼容旧的单元候选（candidate/candidateDir）形态。
  const candidates: ProbeCandidate[] = Array.isArray(opts.candidates) && opts.candidates.length > 0
    ? opts.candidates
    : (opts.candidate ? [{ name: opts.candidate, dir: opts.candidateDir ?? '' }] : [])
  const steps: string[] = []
  const defaultReport: RunProbeResult = {
    outcome: 'error', port, healthy: false, rendered: false, culprit: null, bootLogTail: '', elapsedMs: 0, steps, spec: null,
  }
  const fail = (outcome: ProbeOutcome, error?: string): RunProbeResult => ({
    ...defaultReport, outcome, error, elapsedMs: Date.now() - t0,
  })

  // ① 隔离副本 + 干净装配
  let spec: IsolatedProfileSpec
  try {
    spec = makeIsolatedProfile(opts.profileDir, opts.stateRoot, candidates, opts.companions)
    steps.push(`隔离副本就绪: ${spec.dir}`)
    steps.push(`候选(${spec.candidates.length}): ${spec.candidates.map((c) => c.name).join(', ')}`)
  } catch (error) {
    steps.push(`隔离副本失败: ${String(error)}`)
    return fail('error', `隔离副本构造失败: ${String(error)}`)
  }

  const pnpm = resolvePnpmCommand(opts.dshHome)
  // 官方 peer（@deepseek-ai/dsh-* 发行内嵌、registry 拉不到）不 auto-install：.npmrc 之外再压一个 CLI flag
  // （优先级最高，免疫任何用户/全局 .npmrc 覆盖）。运行时由探针实例内核按 peer 提供者满足。
  const pnpmRes = runPnpm(['install', '--prefer-offline', '--config.auto-install-peers=false', '--config.strict-peer-dependencies=false'], spec.profileDir, pnpm)
  if (!pnpmRes.ok) {
    steps.push(`依赖装配失败(status=${String(pnpmRes.status)})`)
    rmSync(spec.dir, { recursive: true, force: true })
    return fail('error', `隔离副本依赖装配失败(pnpm status=${String(pnpmRes.status)}): ${pnpmRes.output.slice(0, 400)}`)
  }
  steps.push(`依赖装配完成(${pnpmRes.output.length > 80 ? pnpmRes.output.slice(0, 80) + '…' : pnpmRes.output || 'ok'})`)

  // ② spawn 外置独立实例
  const bin = resolveDshBin(opts.dshHome)
  if (!bin) {
    rmSync(spec.dir, { recursive: true, force: true })
    steps.push('未定位 dsh 二进制')
    return fail('error', '未在 harness/PATH 找到 dsh 二进制')
  }
  const env: Record<string, string | undefined> = { ...process.env }
  // 丢弃父内核注入的全部 DSH_* 运行时身份（DSH_SESSION_JSONL / DSH_SESSION_ID / DSH_WEB_URL 等），
  // 隔离实例不得写回真实会话；home 一并换成隔离副本（profiles 解析只落在副本）。
  for (const key of Object.keys(env)) {
    if (key.startsWith('DSH_')) delete env[key]
  }
  env.DSH_HOME = spec.homeDir
  const outLog = join(spec.logDir, `server-${++_probeSeq}.out.log`)
  const errLog = join(spec.logDir, `server-${++_probeSeq}.err.log`)
  const cmdLine = [`${bin}`, 'web', '--port', String(port)]
  const child = spawnDetached(cmdLine, spec.profileDir, outLog, errLog, env)
  steps.push(`已启动隔离实例(pid=${child.pid ?? '?'}, port=${port})`)

  // ③ 三态判定
  const boot = await waitBoot(child, port, firstWaitSec)
  let healthy = false
  let rendered = false
  if (boot === 'ok') {
    healthy = true
    const render = await renderHeartbeat(port, renderSettleSec)
    if (render === 'ok') rendered = true
    if (render === 'render-crash') {
      killTree(child)
      const bootLogTail = await latestLogTail(spec.logDir, 'server-', 60)
      const culprit = diagnose(profilePluginRows(opts.profileDir), `${bootLogTail}\n${readTextRobust(errLog)}`)
      rmSync(spec.dir, { recursive: true, force: true })
      steps.push('渲染层崩溃：已杀树+回收副本')
      return { ...defaultReport, outcome: 'render-crash', healthy, rendered: false, culprit, bootLogTail, elapsedMs: Date.now() - t0 }
    }
    steps.push(rendered ? '渲染心跳就绪' : 'HTTP 就绪、渲染心跳未确认(我方插件未在场则属正常)')
  } else if (boot === 'crashed') {
    steps.push('进程先于就绪即退出')
  } else {
    steps.push(`超时未就绪(${firstWaitSec}s)`)
  }

  const keepAlive = keep && boot === 'ok'
  if (!keepAlive) killTree(child)
  const bootLogTail = await latestLogTail(spec.logDir, 'server-', 60)
  const culpritText = boot === 'ok' ? '' : `${bootLogTail}\n${readTextRobust(errLog)}`

  // ④ 归因
  let culprit: ProbeReport['culprit'] = null
  if (boot !== 'ok') culprit = diagnose(profilePluginRows(opts.profileDir), culpritText)

  // ⑤ 销毁副本（零残留；keep 模式且判定通过时保留实例与副本供人工浏览）
  if (!keepAlive) rmSync(spec.dir, { recursive: true, force: true })

  if (boot === 'crashed' || boot === 'timeout') {
    const stepsError = boot === 'crashed' ? '启动崩溃：进程提前退出' : '启动挂起：HTTP 未就绪'
    if (boot === 'timeout') steps.push(stepsError)
    return { ...defaultReport, outcome: boot === 'crashed' ? 'crash' : 'hang', healthy, rendered: false, culprit, bootLogTail, error: stepsError, elapsedMs: Date.now() - t0 }
  }
  if (keepAlive) {
    const keptUrl = `http://127.0.0.1:${port}`
    steps.push(`keep 模式：实例保持运行 ${keptUrl}（pid=${child.pid ?? '?'}）；关闭: taskkill /PID ${child.pid ?? '?'} /T /F；回收副本: 删除 ${spec.dir}`)
    return { ...defaultReport, outcome: 'pass', healthy, rendered, culprit, bootLogTail, elapsedMs: Date.now() - t0, spec, kept: true, keptPid: child.pid, keptPort: port, keptUrl, keptDir: spec.dir }
  }
  return { ...defaultReport, outcome: 'pass', healthy, rendered, culprit, bootLogTail, elapsedMs: Date.now() - t0, spec }
}

function diagnose(rows: Array<{ id: string; name: string; patch: boolean }>, logText: string): { id: string | null; name: string } | null {
  const names = extractFailedPluginNames(logText)
  if (names.length === 0) return null
  for (const name of names) {
    const row = rows.find((r) => r.patch && (r.name === name || r.id === name))
    if (row) return { id: row.id, name }
  }
  return { id: null, name: names[0] }
}

/** 探针报告分步校验（供前端/agent 使用）。 */
export function describeOutcome(r: ProbeReport): string {
  switch (r.outcome) {
    case 'pass': return r.rendered ? '通过：隔离实例健康且渲染就绪' : '通过：隔离实例 HTTP 就绪(渲染心跳未在场)'
    case 'crash': return `崩溃：启动即退出${r.culprit ? `，归因: ${r.culprit.name}` : ''}`
    case 'hang': return `挂起：${r.error ?? 'HTTP 未就绪'}`
    case 'render-crash': return `渲染崩溃${r.culprit ? `，归因: ${r.culprit.name}` : ''}`
    default: return `探针异常：${r.error ?? '未知'}`
  }
}