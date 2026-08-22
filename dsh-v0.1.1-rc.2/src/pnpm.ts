/**
 * dsh-plugin-simplemanager — 自包含 pnpm 运行器（真注入 / 依赖获取）。
 *
 * 判据 6（官方渠道装卸）：装配/卸载通过 dsh 生态统一使用的 pnpm 在 profile 内落实
 * （hoisted 共享 node_modules），依赖闭包由 pnpm 完整装入/移除，不做手敲产物。
 * 进程层自持，参考 dsh-market 的 dsh-cli.ts 实现要点，但不依赖 dsh-market 包，
 * 也不依赖桌面壳注入服务（desktopPnpm 等）——只消费 dsh 内核，宿主不可知（判据 4/5）。
 *
 * 健壮性覆盖：win32 `.cmd` shim、PATH 充实 + proxy→npm_config_* 转译 + CI 静默抑制、
 * target 白名单防注入、`--reporter=ndjson` 取 pnpm 真实错误、超时杀进程树、
 * 瞬时网络失败重试、release-age 锁恢复、ENOENT/工具缺失改为磁盘判定 + 可操作提示。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isOfficialSystemDep } from './host.js'

export type PluginSpecKind = 'file' | 'registry'

export interface AnchoredSpec {
  /** 传给 pnpm add 的最终参数。 */
  arg: string
  kind: PluginSpecKind
}

export interface PnpmOutcome {
  ok: boolean
  code: number | null
  message: string
  timedOut?: boolean
  /** 本次补装为 profile 直接依赖的闭包依赖名（6 判据「依赖闭包随装卸完整进退」：调用方借此在回滚/卸载时回收）。 */
  installedDeps?: string[]
}

/** 安装/卸载根超时；网络慢 + git 安装可到 10 分钟（覆盖环境变量便于测试）。 */
const INSTALL_TIMEOUT_MS = Number(process.env.DSH_SIMPLEMANAGER_PNPM_TIMEOUT_MS) || 10 * 60 * 1000

// ---------------------------------------------------------------------------
// 工具可发现性（磁盘判定，规避 Windows 控制台码页把 ENOENT 报成「不是内部命令」）
// ---------------------------------------------------------------------------
export function nodeExecutable(argv0: string | undefined = process.argv0, execPath: string = process.execPath): string {
  if (argv0 !== undefined && argv0 !== '' && isAbsolute(argv0) && existsSync(argv0)) return argv0
  return execPath
}

/** 运行本进程的 Node 所在目录；npm/corepack/pnpm 常与之同装，是无需猜测的唯一可靠搜寻位置。 */
export const nodeBinDir = dirname(nodeExecutable())

const EXECUTABLE_SUFFIXES = process.platform === 'win32'
  ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((p) => p !== '')
  : ['']

/** 裸命令名在子进程 PATH 上是否可解析（查磁盘，跨 locale 可靠）。 */
export function toolOnPath(name: string): boolean {
  const sep = process.platform === 'win32' ? ';' : ':'
  for (const dir of (spawnEnv().PATH ?? '').split(sep)) {
    if (dir === '') continue
    for (const suffix of EXECUTABLE_SUFFIXES) {
      if (existsSync(join(dir, name + suffix))) return true
    }
  }
  return false
}

/** 运行时额外可发现的可执行目录（如 npm 全局 bin），成功探测后追加。 */
const extraPathDirs: string[] = []

// ---------------------------------------------------------------------------
// 环境：PATH 充实 + proxy 转译 + CI 静默抑制
// ---------------------------------------------------------------------------

/** 把机器上的 HTTP(S) 代理转成 pnpm 唯一认识的 npm_config_* 形式。 */
export function proxyEnvForPnpm(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const has = (name: string): boolean => {
    const wanted = name.toLowerCase()
    return Object.keys(env).some((k) => k.toLowerCase() === wanted && (env[k] ?? '').trim() !== '')
  }
  const pick = (...names: string[]): string | null => {
    for (const name of names) {
      const raw = env[name]
      if (raw !== undefined && raw.trim() !== '') return raw.trim()
    }
    return null
  }
  const out: NodeJS.ProcessEnv = {}
  const https = pick('https_proxy', 'HTTPS_PROXY') ?? pick('http_proxy', 'HTTP_PROXY')
  const http = pick('http_proxy', 'HTTP_PROXY') ?? https
  if (https !== null && !has('npm_config_https_proxy')) out.npm_config_https_proxy = https
  if (http !== null && !has('npm_config_proxy')) out.npm_config_proxy = http
  const noProxy = pick('no_proxy', 'NO_PROXY')
  if (noProxy !== null && !has('npm_config_noproxy')) out.npm_config_noproxy = noProxy
  return out
}

function spawnEnv(): NodeJS.ProcessEnv {
  // pnpm v9+ 在 `CI` 环境变量为真时会走 self-managed pnpm（corepack）逻辑——按 package.json
  // 的 packageManager 精确 sha 下载并执行 `@pnpm/exe` 二进制（走网络）。但官方 `dsh plugin add`
  // 让 pnpm 直接用 PATH 上已就绪的 11.15.1，不触发自下载。这里**不设 CI**、也不加任何 corepack
  // 相关环境，让 pnpm 复用本机 pnpm 二进制，避免不必要的网络自拾取。
  const sep = process.platform === 'win32' ? ';' : ':'
  const parts = (process.env.PATH ?? '').split(sep).filter((p) => p !== '')
  const candidates = process.platform === 'win32'
    ? [nodeBinDir, ...extraPathDirs]
    : ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), nodeBinDir, ...extraPathDirs]
  for (const bin of candidates) if (!parts.includes(bin)) parts.push(bin)
  return { ...process.env, ...proxyEnvForPnpm(), PATH: parts.join(sep) }
}

/** 记录 npm 全局 bin 目录使后续 spawn 可见（一次性成功探测后调用）。 */
export function rememberGlobalBin(binDir: string): void {
  if (binDir !== '' && isAbsolute(binDir) && !extraPathDirs.includes(binDir)) extraPathDirs.push(binDir)
}

// ---------------------------------------------------------------------------
// pnpm 实装定位（解决 corepack shim 触发 @pnpm/exe 自下载的网络问题）
// ---------------------------------------------------------------------------
// 根因：profile 的 package.json 声明 `packageManager: pnpm@<ver>+sha…`，若 PATH 上的
// `pnpm` 是 corepack shim（corepack/dist/pnpm.js），corepack 会按该精确 sha 去本机缓存
// 找已就绪版本；找不到（DSH 图形进程的缓存路径与我 shell 不同）就联网拉 @pnpm/exe —
// 网络不可达即失败。修复：优先定位机器上**已就绪、且与 profile 声明版本匹配**的 pnpm
// JS 入口（corepack 缓存 `bin/pnpm.cjs` / 桌面捆绑 `bin/pnpm.mjs`），用 node 直接执行，
// 完全不经过 corepack shim，离线可用。仅当找不到已就绪实装时才回退裸 `pnpm` 命令。

export interface PnpmInvocation {
  /** spawn 的可执行文件：node 实装或裸 pnpm 命令。 */
  file: string
  /** 传给 pnpm 的参数前缀（node 实装时为 [entry, ...]，裸命令为空）。 */
  prefixArgs: string[]
  /** note 用：解析到哪种实装。 */
  kind: 'node-cached' | 'node-bundled' | 'command'
}

/** 本机 corepack 缓存的 pnpm 版本目录；按版本号倒序（新版本优先）。 */
const COREPACK_HOMES = process.platform === 'win32'
  ? ['C:\\Program Files\\nodejs\\node_modules\\corepack', '%LOCALAPPDATA%\\node\\corepack', '%HOMEDRIVE%%HOMEPATH%\\AppData\\Local\\node\\corepack', '%HOMEDRIVE%%HOMEPATH%\\.cache\\node\\corepack']
  : ['/opt/homebrew/share/corepack', '/usr/local/share/corepack', join(homedir(), '.local', 'share', 'corepack'), join(homedir(), '.cache', 'node', 'corepack')]

function expandEnvVar(v: string): string {
  return v.replace(/%([^%]+)%/g, (_, k: string) => process.env[k] ?? '')
}

/** 列出某 corepack home 下已缓存的 pnpm JS 入口（`<home>/v1/pnpm/<ver>/bin/pnpm.cjs`）。 */
function cachedPnpmEntries(home: string): Array<{ ver: string; entry: string }> {
  const out: Array<{ ver: string; entry: string }> = []
  const base = join(home, 'v1', 'pnpm')
  let versions: string[]
  try {
    versions = readdirSync(base).filter((x) => /^\d/.test(x))
  } catch {
    return out
  }
  const verSort = (a: string, b: string): number => {
    const pa = a.split('.').map((n) => Number(n) || 0)
    const pb = b.split('.').map((n) => Number(n) || 0)
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0)
    return 0
  }
  versions.sort(verSort)
  for (const ver of versions) {
    for (const bin of ['bin/pnpm.cjs', 'bin/pnpm.mjs']) {
      const entry = join(base, ver, bin)
      if (existsSync(entry)) { out.push({ ver, entry }); break }
    }
  }
  return out
}

/** 桌面壳捆绑的真实 pnpm JS 入口（resources/app.asar.unpacked/node_modules/pnpm/bin/pnpm.mjs）。 */
function bundledPnpmEntry(): { ver: string; entry: string } | null {
  const res = (process as { resourcesPath?: string }).resourcesPath
  const candidates = res ? [res] : []
  candidates.push(join(dirname(process.execPath), 'resources'))
  for (const r of candidates) {
    const pkg = join(r, 'app.asar.unpacked', 'node_modules', 'pnpm', 'package.json')
    if (!existsSync(pkg)) continue
    try {
      const meta = JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }
      const entry = join(r, 'app.asar.unpacked', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
      if (existsSync(entry)) return { ver: String(meta.version ?? ''), entry }
    } catch { /* next */ }
  }
  return null
}

/** 解析 profile 声明的 packageManager 版本（形如 `pnpm@11.15.1+sha…`）。 */
function profilePnpmVersion(profileDir: string): string | null {
  try {
    const meta = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { packageManager?: string }
    const pm = meta.packageManager ?? ''
    const m = /^pnpm@(\d+\.\d+\.\d+)/.exec(pm)
    return m ? m[1] : null
  } catch {
    return null
  }
}

let cachedInvocation: PnpmInvocation | null = null

/**
 * 定位一个真实可用的 node 运行时：
 * - 桌面壳（Electron）宿主里 `process.execPath/argv0` 是应用可执行文件（如 `DSH Desktop.exe`），
 *   当"node"用它去跑 `pnpm.cjs` 等于让 Electron 把它当应用入口启动，装包失效却常以 0 退出。
 * - 因此必须在宿主进程非 node 时，改从系统常见位置 / PATH 挑选真实 `node(.exe)`。
 * - 候选全失败才回退到宿主可执行（最好即所得，保持调用形态兼容）。
 */
let cachedNodeRunner: string | null = null
function pickNodeRunner(): string {
  if (cachedNodeRunner) return cachedNodeRunner
  const isNodeName = (p: string | undefined): p is string => !!p && /node(\.exe)?$/i.test(p)
  const hostExe = nodeExecutable()
  // 1) 宿主本身就是 node（CLI / node 宿主）：直接用。
  if (isNodeName(hostExe) && existsSync(hostExe)) { cachedNodeRunner = hostExe; return hostExe }
  // 2) argv0 指向真实 node。
  if (isNodeName(process.argv0) && existsSync(process.argv0)) { cachedNodeRunner = process.argv0; return process.argv0 }
  // 3) 系统常见 node 安装位置（Windows nvm / 官方安装）。
  const pf = process.env.ProgramW6432 ?? process.env.ProgramFiles ?? 'C:\\Program Files'
  const x86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  for (const dir of [join(pf, 'nodejs'), join(x86, 'nodejs'), join(process.env.APPDATA ?? '', 'nvm')]) {
    const c = join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
    if (isNodeName(c) && existsSync(c)) { cachedNodeRunner = c; return c }
  }
  // 4) PATH 上的 node。
  const sep = process.platform === 'win32' ? ';' : ':'
  for (const dir of (process.env.PATH ?? '').split(sep)) {
    const c = join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
    if (isNodeName(c) && existsSync(c)) { cachedNodeRunner = c; return c }
  }
  // 5) 回退宿主可执行（非 node 时可能失效，但保留原行为）。
  cachedNodeRunner = hostExe
  return hostExe
}

/**
 * 解析一次 pnpm 调用方式。优先已就绪实装（离线），其次桌面捆绑，最后裸命令。
 * 每次成功结果缓存，后续复用（避免重复磁盘扫描）。
 */
function resolvePnpmInvocation(profileDir: string): PnpmInvocation {
  if (cachedInvocation) return cachedInvocation
  const wanted = profilePnpmVersion(profileDir)
  const all: Array<{ ver: string; entry: string; kind: PnpmInvocation['kind'] }> = []
  for (const home of COREPACK_HOMES.map(expandEnvVar)) {
    if (!home) continue
    for (const c of cachedPnpmEntries(home)) all.push({ ...c, kind: 'node-cached' })
  }
  const bundled = bundledPnpmEntry()
  if (bundled) all.push({ ...bundled, kind: 'node-bundled' })
  // 版本匹配优先：corepack 缓存的精确版本 > 任意已就绪版本 > 桌面捆绑 > 裸命令。
  const exact = all.find((c) => c.ver === wanted)
  const anyReady = all.find((c) => c.kind === 'node-cached') ?? all[0]
  const pick = exact ?? anyReady
  cachedInvocation = pick
    ? { file: pickNodeRunner(), prefixArgs: [pick.entry], kind: pick.kind }
    : { file: 'pnpm', prefixArgs: [], kind: 'command' }
  return cachedInvocation
}

/**
 * 按需切换 pnpm 实装解析（供测试/验证时覆盖 cwd 或强制重新探测）。
 * `null` 表示用默认（构造函数传入的 profileDir）。
 */
export function __resetPnpmInvocation(cb: (inv: PnpmInvocation) => PnpmInvocation): void {
  cachedInvocation = null
  const inv = resolvePnpmInvocation(process.cwd())
  cachedInvocation = cb(inv)
}

// ---------------------------------------------------------------------------
// win32 `.cmd` shim 进程启动
// ---------------------------------------------------------------------------
const winCmdShim = process.platform === 'win32'
const COMSPEC = process.env.ComSpec ?? 'cmd.exe'
/** cmd.exe 视为语法字符、即使在 token 内部也需要引用的字符。 */
const CMD_METACHARS = /[\s"&|<>^()%!]/

function quoteCmdArg(arg: string): string {
  if (!CMD_METACHARS.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}
function cmdCommandLine(argv: readonly string[]): string {
  return argv.map(quoteCmdArg).join(' ')
}

/** spawn 命令：非 win 直接 spawn；win `.cmd` shim 走 `cmd.exe /d /s /c` 显式拼引用。 */
function spawnShim(file: string, args: readonly string[], options: Parameters<typeof spawn>[2]): ChildProcess {
  if (process.platform !== 'win32') return spawn(file, [...args], { ...options, shell: false })
  return spawn(COMSPEC, ['/d', '/s', '/c', `"${cmdCommandLine([file, ...args])}"`], {
    ...options,
    shell: false,
    windowsVerbatimArguments: true,
  })
}

// ---------------------------------------------------------------------------
// target 白名单（最后一道注入防线）。
// registry 包名严格走 TARGET_RE（无空格/反斜杠，shell 元字符绝不放行）。
// `file:`/`link:` 本地路径天然含 `\` 与空格（Windows 常见）——由 win cmd 的
// quoteCmdArg 引号兜底使其字面化，故只额外拒绝 cmd 展开型危险字符 `%`/`!`/控制符。
// ---------------------------------------------------------------------------
export const TARGET_RE = /^[A-Za-z0-9@:./_#+~^=-]+$/

/** 校验一个 add target 是否可安全交给 pnpm；不通过返回原因。 */
export function assertSafeTarget(arg: string, kind: PluginSpecKind): string | null {
  if (/[\0\r\n]/.test(arg)) return '含控制字符'
  // 无论哪种 target，`%`/`!` 在 cmd 里即使被引号包裹也会展开，一律拒绝
  if (/[%!]/.test(arg)) return '含 cmd 展开危险字符'
  if (kind === 'file') return null
  if (!TARGET_RE.test(arg)) return '含不允许的字符'
  return null
}

// ---------------------------------------------------------------------------
// 超时/取消：杀整个进程树
// ---------------------------------------------------------------------------
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); return } catch { /* fall */ }
  }
  const signalTree = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* 已退出 */ } }
  }
  // posix 子进程 detached 成独立进程组；SIGTERM 后 5s 升级 SIGKILL，让 pnpm 自行清尾。
  signalTree('SIGTERM')
  const escalate = setTimeout(() => signalTree('SIGKILL'), 5000)
  escalate.unref?.()
}

// ---------------------------------------------------------------------------
// 单次执行：ndjson 取 pnpm 真实错误 + 失败分类
// ---------------------------------------------------------------------------
interface RunResult {
  code: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  pnpmError?: string
  pnpmErrorCode?: string
  networkFail: boolean
  releaseAgeLock: boolean
  spawnError?: string
}

/** 做一次 pnpm <args>（默认追加 ndjson 报告器）。返回结构化结果，不做重试。 */
async function runPnpm(profileDir: string, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  const inv = resolvePnpmInvocation(profileDir)
  let child: ChildProcess
  let settled = false
  try {
    child = spawnShim(inv.file, [...inv.prefixArgs, ...args], {
      cwd: profileDir,
      env: spawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      // posix 用独立进程组，超时/取消可按组整体回收 pnpm 子树
      detached: process.platform !== 'win32',
    })
  } catch (error) {
    return { code: 127, timedOut: false, stdout: '', stderr: String(error), networkFail: false, releaseAgeLock: false, spawnError: String(error) }
  }

  let stdout = ''
  let stderr = ''
  let combined = ''
  let pnpmError: string | undefined
  let pnpmErrorCode: string | undefined
  let lineBuffer = ''
  // 逐行解析 ndjson stdout：pnpm 的 stderr 只有包装行（对每种原因都相同），真实错误在 ndjson 的 {err} 事件里。
  const sink = (text: string): void => {
    combined = (combined + text).slice(-512 * 1024)
    lineBuffer += text
    let nl: number
    while ((nl = lineBuffer.indexOf('\n')) !== -1) {
      const line = lineBuffer.slice(0, nl).trim()
      lineBuffer = lineBuffer.slice(nl + 1)
      if (!line.startsWith('{')) continue
      try {
        const j: unknown = JSON.parse(line)
        const obj = j as { err?: { code?: unknown; message?: unknown }; level?: string; message?: unknown; code?: unknown } | null
        // pnpm 错误节点两种形态：既有嵌套 `err:{code,message}`，也有顶层 `{level:'error',message}`。
        const err = obj && typeof obj === 'object' ? (obj.err && typeof obj.err === 'object' ? obj.err : null) : null
        if (err) {
          if (pnpmErrorCode === undefined && typeof err.code === 'string') pnpmErrorCode = err.code
          if (pnpmError === undefined && typeof err.message === 'string') {
            pnpmError = String(err.message).split('\n').slice(-2).join(' ')
          }
        } else if (obj && typeof obj === 'object' && (obj.level === 'error' || obj.level === 'fatal') && typeof obj.message === 'string') {
          if (pnpmErrorCode === undefined && typeof obj.code === 'string') pnpmErrorCode = obj.code
          if (pnpmError === undefined) pnpmError = String(obj.message).split('\n').slice(-2).join(' ')
        }
      } catch { /* 非 JSON 进度行 */ }
    }
  }
  child.stdout?.on('data', (c: Buffer) => { const t = c.toString(); stdout = (stdout + t).slice(-256 * 1024); sink(t) })
  child.stderr?.on('data', (c: Buffer) => { const t = c.toString(); stderr = (stderr + t).slice(-64 * 1024); sink(t) })

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; killTree(child) }, timeoutMs)

  return new Promise<RunResult>((resolvePromise) => {
    const finish = (extra: Partial<RunResult>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        code: child.exitCode ?? null,
        timedOut,
        stdout,
        stderr,
        networkFail: /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network request|proxy|tunneling/i.test(combined),
        releaseAgeLock: /release ?age|minimumReleaseAge/i.test(combined),
        ...extra,
      })
    }
    child.on('error', (error) => finish({ code: 127, spawnError: error.message }))
    child.on('close', () => finish({}))
  })
}

// ---------------------------------------------------------------------------
// 归一化 spec + 包名解析
// ---------------------------------------------------------------------------

/**
 * 规范化 pnpm add 的 spec：本地路径（绝对或相对）→ `file:<绝对路径>`；
 * `file:`/`link:` 前缀原样透传；其余按 registry 包名。
 */
export function anchorSpec(spec: string, cwd: string = process.cwd()): AnchoredSpec {
  const s = spec.trim()
  if (s.startsWith('file:') || s.startsWith('link:')) return { arg: s, kind: 'file' }
  if (isAbsolute(s)) return { arg: 'file:' + s, kind: 'file' }
  if (/^\.{1,2}([\\/]|$)/.test(s)) return { arg: 'file:' + resolve(cwd, s), kind: 'file' }
  return { arg: s, kind: 'registry' }
}

/** 由 spec（或已装好的 package.json）解析插件真实包名；解析不到返回 null。 */
export function specPackageName(spec: string, cwd: string = process.cwd()): string | null {
  const { arg, kind } = anchorSpec(spec, cwd)
  const tryRead = (base: string): string | null => {
    const meta = readJson(join(base, 'package.json'))
    return typeof meta.name === 'string' && meta.name ? meta.name : null
  }
  if (kind === 'file') {
    const dir = arg.replace(/^file:/, '').replace(/^link:/, '')
    return tryRead(dir)
  }
  // registry 分支兜底：isAbsolute 在宿主导入环境可能退化，这里显式按路径特征再尝试一次——
  // 只要 spec 指向一个真实目录且含 package.json，就返回真实包名（装包坐标优先于包名字面）。
  const looksPath = /[/\\]/.test(spec) || spec.startsWith('.') || /^[A-Za-z]:[\\/]/.test(spec)
  if (!looksPath) return spec.trim()
  const dir = spec.replace(/^file:/, '').replace(/^link:/, '')
  const direct = tryRead(isAbsolute(dir) ? dir : resolve(cwd, dir))
  if (direct) return direct
  return spec.trim()
}

function readJson(file: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
  } catch {
    return {}
  }
}

/**
 * 收集链接插件需要在 profile 级 `pnpm add` 补齐的 registry 依赖闭包。
 * pnpm 对 `file:` 链接包只做软链、不递归解析其声明的依赖——必须把插件自身
 * 声明的 runtime 依赖作为 profile 的直接依赖显式补装，闭包才能落到共享 node_modules。
 * 只收 registry 可解析项；`file:/link:/workspace:/git:` 等本地/自定义解析不属于可获得闭包，
 * 由插件自身携带，跳过。peerDependencies 也补装（插件运行期协约），optional 的跳过。
 */
export function closureSpecs(dir: string): { specs: string[]; names: string[] } {
  const meta = readJson(join(dir, 'package.json'))
  const optionalPeers = new Set(
    Object.entries((meta.peerDependenciesMeta as Record<string, { optional?: boolean }> | undefined) ?? {})
      .filter(([, v]) => v?.optional === true)
      .map(([k]) => k),
  )
  const collect = (raw: unknown, isPeer: boolean): { specs: string[]; names: string[] } => {
    if (typeof raw !== 'object' || raw === null) return { specs: [], names: [] }
    const specs: string[] = []
    const names: string[] = []
    for (const [name, range] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof range !== 'string' || range === '') continue
      if (isPeer && optionalPeers.has(name)) continue
      if (/^(file|link|workspace|git|github|gitlab|http):/i.test(range)) continue
      specs.push(`${name}@${range}`)
      names.push(name)
    }
    return { specs, names }
  }
  const deps = collect(meta.dependencies, false)
  const peers = collect(meta.peerDependencies, true)
  return { specs: [...deps.specs, ...peers.specs], names: [...deps.names, ...peers.names] }
}

/** 解析链接插件的包根目录（`file:`/`link:` 前缀剥离后的绝对路径）。 */
function closureDir(arg: string): string | null {
  const dir = arg.replace(/^file:/i, '').replace(/^link:/i, '')
  if (!isAbsolute(dir)) return null
  return dir
}

// ---------------------------------------------------------------------------
// 对外：安装 / 移除 / 装后校验
// ---------------------------------------------------------------------------

/** pnpm 缺失时的可操作提示（磁盘判定已确认不在任何已搜寻路径上）。 */
function missingPnpmHint(): string {
  const sep = process.platform === 'win32' ? ';' : ':'
  const dirs = (spawnEnv().PATH ?? '').split(sep).filter(Boolean).slice(0, 4).join('、')
  return `没有找到可用的 pnpm（已搜寻 ${nodeBinDir} ${dirs} 等目录）。Windows 请用 \`iwr https://get.pnpm.io/install.ps1 -useb | iex\` 安装；macOS/Linux 用 \`brew install pnpm\` 或 \`npm i -g pnpm\`（若图形界面启动 dsh 找不到 pnpm，请改从终端启动）`
}

/**
 * 在 profile 目录跑 `pnpm add <spec>`：普适化依赖获取（不假设插件自带 node_modules）。
 * 健壮封装见文件头。超时未达 → ok=false + timedOut；pnpm 缺失 → code=127 + 可操作中文提示。
 */
export async function pnpmAdd(profileDir: string, spec: string, options: { timeoutMs?: number; skipOfficialPeers?: boolean } = {}): Promise<PnpmOutcome> {
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS
  const { arg, kind } = anchorSpec(spec)
  const unsafe = assertSafeTarget(arg, kind)
  if (unsafe !== null) {
    return { ok: false, code: 1, message: `不安全的安装目标被拒绝（${unsafe}）: ${JSON.stringify(arg)}` }
  }
  const args = ['add', arg, '--reporter=ndjson']
  // 热装默认关闭 auto-install-peers：避免 pnpm 自动把插件声明的官方业务 peer 拉进 profile
  // （P-033，官方 @deepseek-ai/dsh-* 由发行内嵌提供，profile 重复落盘反而触发 overlay 二次解析限制）。
  if (options.skipOfficialPeers) args.push('--config.auto-install-peers=false')

  // 链接插件的 registry 闭包：成功补装后返回名字供回滚/卸载回收；补装失败则尽力清理已装闭包，避免半装状态。
  const applyClosure = async (dir: string): Promise<PnpmOutcome | null> => {
    const { specs, names } = closureSpecs(dir)
    // 热装跳过官方系统依赖：官方 DSH 内嵌包（@deepseek-ai/cordis、全部 @deepseek-ai/dsh-*、schemastery）由发行
    // 进程内嵌提供，不装进 profile——装进反而触发 overlay 二次解析限制且增慢装卸（P-033、P-045）。从闭包中剔除
    // 并同步缩容 installedDeps。
    const filteredIds = options.skipOfficialPeers
      ? new Set(names.filter((n) => isOfficialSystemDep(n)))
      : new Set<string>()
    const specs_ = filteredIds.size ? specs.filter((s, i) => !(filteredIds.has(names[i]) && isOfficialSystemDep(names[i]))) : specs
    const names_ = filteredIds.size ? names.filter((n) => !filteredIds.has(n)) : names
    if (specs_.length === 0) return { ok: true, code: 0, message: '依赖安装成功（仅保留非官方依赖，官方业务 peer 由发行内嵌提供）', installedDeps: names_ }
    const closure = await runPnpm(profileDir, ['add', ...specs_, '--reporter=ndjson'], timeoutMs)
    if (closure.code === 0 && !closure.timedOut) {
      return { ok: true, code: 0, message: `依赖安装成功（含 ${specs_.length} 项依赖闭包${filteredIds.size ? `，跳过 ${filteredIds.size} 项官方业务 peer` : ''}）`, installedDeps: names_ }
    }
    if (closure.timedOut) {
      return { ok: false, code: closure.code, message: `依赖闭包补装超时（${Math.round(timeoutMs / 60000)} 分钟），请检查网络或到终端重试`, timedOut: true }
    }
    // 补装失败：尽力回收可能已部分写入的闭包依赖，还原子状态给调用方（真实错误走 ndjson 取回）。
    for (const n of names_) await pnpmRemove(profileDir, n, { timeoutMs: Math.min(timeoutMs, 120000) }).catch(() => {})
    const cref = closure.pnpmError ?? closure.spawnError ?? lastLines(closure.stderr ?? '')
    const codeInfo = closure.pnpmErrorCode ? `（${closure.pnpmErrorCode}）` : ''
    return { ok: false, code: closure.code, message: `依赖闭包补装失败${codeInfo}: ${cref || '未知原因'}` }
  }

  let last: RunResult | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await runPnpm(profileDir, args, timeoutMs)
    if (last.code === 0 && !last.timedOut) {
      // pnpm 对 `file:` 链接包只软链、不递归装其自身声明的依赖 → 显式补装 registry 闭包。
      // 插件包根目录缺失（畸形链接）时按无闭包处理，允许裸链接。
      const dir = closureDir(arg)
      if (kind === 'file' && dir !== null) return await applyClosure(dir)
      return { ok: true, code: 0, message: '依赖安装成功', installedDeps: [] }
    }
    if (last.timedOut) return { ok: false, code: last.code, message: `pnpm add 超时（${Math.round(timeoutMs / 60000)} 分钟），请检查网络或到终端重试`, timedOut: true }
    if (last.code === 127 && !toolOnPath('pnpm')) return { ok: false, code: 127, message: missingPnpmHint() }

    const isLastAttempt = attempt === 2
    if (isLastAttempt) break
    if (last.networkFail) continue // 瞬时网络失败：立即重试
    if (last.releaseAgeLock) {
      // pnpm 发布时长锁：加 override 后重跑一次，不再额外重试
      args.push('--config.minimumReleaseAge=0')
      continue
    }
    break // 非可分类失败：不再盲目重试
  }

  const reason = last?.pnpmError ?? last?.spawnError ?? lastLines(last?.stderr ?? '')
  const codeInfo = last?.pnpmErrorCode ? `（${last.pnpmErrorCode}）` : ''
  const fallback = `pnpm 退出码 ${last?.code ?? '未知'} 且未捕获到错误输出（真实错误走 ndjson，可能未落到本次管道）。请到 pnpm 日志或 profile 的 node_modules/.pnpm 校验状态`
  return { ok: false, code: last?.code ?? 1, message: `pnpm add 失败${codeInfo}: ${reason || fallback}` }
}

/** 从 profile 移除一个包及其依赖闭包（回滚 / 卸载用，尽力而为）。 */
export async function pnpmRemove(profileDir: string, packageName: string, options: { timeoutMs?: number } = {}): Promise<PnpmOutcome> {
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS
  if (!/^[A-Za-z0-9@:./_#+~^=-]+$/.test(packageName)) {
    return { ok: false, code: 1, message: `不安全的移除目标被拒绝: ${JSON.stringify(packageName)}` }
  }
  const result = await runPnpm(profileDir, ['remove', packageName, '--reporter=ndjson'], timeoutMs)
  if (result.code === 0 && !result.timedOut) return { ok: true, code: 0, message: '已移除' }
  const reason = result.pnpmError ?? result.spawnError ?? lastLines(result.stderr)
  const fallback = `pnpm 退出码 ${result.code ?? '未知'} 且未捕获到错误输出，请到 pnpm 日志查看`
  return { ok: false, code: result.code, message: reason || fallback }
}

export interface InstallVerify {
  ok: boolean
  reason?: string
}

/**
 * 装后校验：确认包物理落在 profile 共享 node_modules 且包名正确。
 * 不做 dsh 清单强制——本插件登记走「profile 层 patch 最后应用」语义，允许不声明 dsh bundle 的包。
 * 校验不过即提示回滚（由调用方执行 pnpmRemove）。
 */
export function verifyInstalled(profileDir: string, packageName: string): InstallVerify {
  const pkg = join(profileDir, 'node_modules', packageName, 'package.json')
  if (!existsSync(pkg)) return { ok: false, reason: `未在 profile 找到已安装的 ${packageName}` }
  const meta = readJson(pkg)
  if (typeof meta.name !== 'string') return { ok: false, reason: `${packageName} 的 package.json 缺少 name` }
  if (meta.name !== packageName) return { ok: false, reason: `已装包名不匹配: ${meta.name} != ${packageName}` }
  return { ok: true }
}

/** 取文本最后几行做简洁提示。 */
function lastLines(text: string, n = 2): string {
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join(' · ') || ''
}