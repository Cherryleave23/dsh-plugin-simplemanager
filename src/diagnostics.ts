/**
 * simplemanager 插件源码「规范治理」静态诊断器。
 *
 * 定位：第三板块「插件诊断」→「代码规范治理」。
 * 只读扫描已装插件的磁盘副本（profile/node_modules/<pkg> 的编译产物 JS），
 * 按《DSH 插件开发质量禁做清单》8 条逐项取证，产出 `✓/⚠/✗` + 证据(行号/片段) + 整改建议。
 *
 * 硬边界：
 *   - 只读、零写面：不修改任何插件源码副本 or 装配层，仅产出治理报告。
 *   - 启发式而非 AST 精确：产物是转译后 ESM，正则/词法扫描足够定位反模式，个别无法确证时降级为 ⚠。
 *   - 官方与壳组件不在此范围（listener 在 index 层过滤，本模块只对给定包的副本取证）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** 一次规则判定的证据：源码文件相对路径 + 行号 + 命中片段(截断)。 */
export interface DiagEvidence {
  file: string
  line: number
  snippet: string
}

export type DiagLevel = 'ok' | 'warn' | 'err'
export const DIAG_RULES = [
  { id: 1, title: 'webServer 路由注册须用 ctx.effect 包裹（宿主随 entry 拆除释放）' },
  { id: 2, title: '资源（定时器/子进程/SSE/BLE 等）随 deactivate 释放' },
  { id: 3, title: '生命周期严格对称（apply 创建 vs 清理回收）' },
  { id: 4, title: '优先官方接口；直写文件须就地注释理由' },
  { id: 5, title: '不改写官方与壳组件（@deepseek-ai/*）' },
  { id: 6, title: '不吞错、不假装清理' },
  { id: 7, title: '包名 dsh- 前缀 + 可解析入口' },
  { id: 8, title: '路由注册用 ctx.effect；非 effect 时 register 到 return 间不留可抛错路径（防半挂孤儿）' },
] as const

/** 单条规则判定结果。evidence 为空表示「未命中反模式」→ 该项通常判 ok。 */
export interface RuleVerdict {
  ruleId: number
  title: string
  level: DiagLevel
  /** 违规/疑点摘要（中文）。ok 时为一段合规说明。 */
  detail: string
  evidence: DiagEvidence[]
  /** 整改建议（针对 err/warn）。 */
  suggest: string
}

export interface PluginDiagnostic {
  name: string
  /** 已装副本 dir（相对 profile）或 null（不可解析）。 */
  pkgDir: string | null
  /** 扫描到的 JS 产物文件数。0 表示未找到可扫描代码。 */
  scanned: number
  /** 包的运行态信号（由 index 层传入）：phase 半挂时置 failed。 */
  runtime: { phase: string | null }
  rules: RuleVerdict[]
  summary: { ok: number; warn: number; err: number }
}

/** 按包名在 profile 下解析副本目录（顶层包 / @scope/pkg 两种布局）。 */
export function resolveInstalledDir(profileDir: string, packageName: string): string | null {
  const dir = join(profileDir, 'node_modules', packageName)
  return existsSync(join(dir, 'package.json')) ? dir : null
}

/** 收集包内要扫描的 JS 产物：以 main 所在目录为主，回退 lib/。 */
function collectJsTargets(pkgDir: string, main: string | undefined): string[] {
  const dirs: string[] = []
  if (main) {
    const entryDir = join(pkgDir, main.replace(/^\.\//, ''))
    const dir = entryDir.endsWith('.js') ? dirnameOf(entryDir) : entryDir
    dirs.push(dir)
  }
  dirs.push(join(pkgDir, 'lib'))
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of dirs) {
    if (seen.has(d) || !existsSync(d)) continue
    seen.add(d)
    for (const f of readdirSync(d)) {
      if (f.endsWith('.js') && !f.endsWith('.map.js')) out.push(join(d, f))
    }
  }
  // 单个入口文件（main 直接指向文件，非目录）
  if (main && main.endsWith('.js')) {
    const p = join(pkgDir, main.replace(/^\.\//, ''))
    if (existsSync(p) && !out.includes(p)) out.push(p)
  }
  return out
}

function dirnameOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(0, i) : '.'
}

interface Line {
  n: number
  text: string
}

/** 把源码按行拆分，供证据定位。 */
function lines(src: string): Line[] {
  return src.split(/\r?\n/).map((text, i) => ({ n: i + 1, text }))
}

function snippetOf(src: string, line: number, max = 96): string {
  const l = lines(src)[line - 1]
  if (!l) return ''
  const t = l.text.trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/** 行级匹配，返回命中（含来自 boot 过滤的扫描文件维度）。 */
function findIn(src: string, re: RegExp): Line[] {
  const rex = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  return lines(src).filter((l) => rex.test(l.text))
}

function lineOf(src: string, partial: string): number {
  const hit = lines(src).find((l) => l.text.includes(partial))
  return hit ? hit.n : 0
}

/** 计算落在任一 `ctx.effect(...)` 调用体内的行号集合（跨行括号配平，只计括号，忽略花括号）。 */
function effectCoveredLines(src: string): Set<number> {
  const set = new Set<number>()
  const L = lines(src)
  let depth = 0
  let active = false
  for (let i = 0; i < L.length; i++) {
    const t = L[i].text
    if (!active) {
      const k = t.indexOf('ctx.effect(')
      if (k >= 0) {
        active = true
        depth = 1
        set.add(i + 1)
        for (const ch of t.slice(k + 'ctx.effect('.length)) {
          if (ch === '(') depth++
          else if (ch === ')') { depth--; if (depth <= 0) { active = false; break } }
        }
      }
      continue
    }
    set.add(i + 1)
    for (const ch of t) {
      if (ch === '(') depth++
      else if (ch === ')') { depth--; if (depth <= 0) { active = false; break } }
    }
  }
  return set
}

/**
 * 规则判定 = 依赖弱耦合的纯函数，便于单测。全部返回 RuleVerdict。
 */
function rule1(sourceName: string, src: string): RuleVerdict {
  const title = 'webServer 路由注册须用 ctx.effect 包裹（宿主随 entry 拆除释放）'
  const regs = findIn(src, /\.register\(\s*\{|webServer\.register\(/)
  if (regs.length === 0) {
    return { ruleId: 1, title, level: 'ok', detail: '未发现 webServer.register 路由注册，无路由泄漏风险。', evidence: [], suggest: '' }
  }
  const covered = effectCoveredLines(src)
  const bad = regs.filter((r) => !covered.has(r.n))
  if (bad.length === 0) {
    return { ruleId: 1, title, level: 'ok', detail: 'webServer.register 均在 ctx.effect 内注册：宿主在 entry 拆除（禁用/卸载）时走 effect 拆除，路由随 entry 释放，可同会话反复热装/热卸。', evidence: [], suggest: '' }
  }
  return {
    ruleId: 1, title, level: 'warn',
    detail: `发现 ${bad.length} 处 webServer.register 未用 ctx.effect 包裹（apply 顶层直接 register + return 卸注册器）：该类返回式 disposer 在本宿主对 disabled/remove 拆除路径不兜底，路由滞留内存，同前缀二次装载必撞 duplicate prefix route。`,
    evidence: bad.map((r) => ({ file: sourceName, line: r.n, snippet: snippetOf(src, r.n) })),
    suggest: "改用 ctx.effect(() => ctx.webServer.register({...}), '<插件>: webServer') 包裹注册，由宿主随 entry 拆除释放路由。",
  }
}

/** 提取 deactivate 返回的清理函数体（顶层 `return () => { ... }` 或 `return () => (...)`）。 */
function extractReturnCleanup(src: string): string | null {
  // 优先成对花括号的箭头函数 return
  const m = src.match(/return\s*\(?\s*\(\)\s*=>\s*\{\s*([\s\S]*?)\n\s*\}/)
  if (m) return m[1]
  const tm = src.match(/return\s*\(?\s*\(\)\s*=>\s*\(([\s\S]*?)\)\s*s?;/)
  if (tm) return tm[1]
  const fm = src.match(/return\s+function\s*\([^)]*\)\s*\{\s*([\s\S]*?)\n\s*\}/)
  if (fm) return fm[1]
  return null
}

function rule2(sourceName: string, src: string): RuleVerdict {
  const title = '资源（定时器/子进程/SSE/BLE 等）随 deactivate 释放'
  const creators = [
    /setInterval\s*\(/,
    /setTimeout\s*\(/,
    /child_process/,
    /\.execFile(?:Sync)?\s*\(/,
    /\.spawn\s*\(/,
    /new\s+Worker\s*\(/,
    /new\s+WebSocket\s*\(/,
    /createConnection\s*\(/,
    /\.createServer\s*\(/,
    /text\/event-stream/,
    /\.gpio\s*\(/,
    /BLE/i,
  ]
  const hits: Line[] = []
  for (const re of creators) hits.push(...findIn(src, re))
  if (hits.length === 0) {
    return { ruleId: 2, title, level: 'ok', detail: '未发现明显资源创建点，无需释放处理。', evidence: [], suggest: '' }
  }
  const disposers = [/clearInterval\s*\(/, /clearTimeout\s*\(/, /\.end\s*\(/, /\.close\s*\(/, /\.destroy\s*\(/, /\.dispose\s*\(/, /\.unref\s*\(/, /\.abort\s*\(/, /\.kill\s*\(/, /\.terminate\s*\(/, /cleanupHost\s*\(/, /dispose\s*\(/]
  const hasDisposer = disposers.some((re) => re.test(src))
  if (!hasDisposer) {
    return {
      ruleId: 2, title, level: 'warn',
      detail: `发现 ${hits.length} 处资源创建（定时器/子进程/长连接等），但全文件未见任何释放原语，疑似资源随拆泄漏。`,
      evidence: hits.slice(0, 3).map((r) => ({ file: sourceName, line: r.n, snippet: snippetOf(src, r.n) })),
      suggest: '确保每类资源在 deactivate 清理体里成对释放（clearInterval/end/close/dispose 等），与创建对称。',
    }
  }
  return {
    ruleId: 2, title, level: 'ok',
    detail: `发现 ${hits.length} 处资源创建，且存在对应释放原语。`,
    evidence: [], suggest: '',
  }
}

function rule3(sourceName: string, src: string): RuleVerdict {
  const title = '生命周期严格对称（apply 创建 vs 清理回收）'
  const createCount = (() => {
    let n = 0
    for (const re of [/\.create\s*\(/, /\.register\s*\(/, /\.addListener\s*\(/, /\.on\s*\(/, /\.use\s*\(/]) n += findIn(src, re).length
    return n
  })()
  const cleanBlock = extractReturnCleanup(src)
  if (!cleanBlock) {
    return { ruleId: 3, title, level: 'ok', detail: '未探测到 apply 级创建/清理可对比（无 deactivate 清理体，视作无挂载资源）。', evidence: [], suggest: '' }
  }
  const cleanCount = (() => {
    let n = 0
    for (const re of [/\.dispose\s*\(/, /\.off\s*\(/, /\.remove\s*\(/, /\.unregister\s*\(/, /\.clear\s*\(/, /\.end\s*\(/, /\.close\s*\(/]) n += findIn(cleanBlock, re).length
    return n
  })()
  // 创建明显多于清理（>8 对 0 视为严重失衡）时给疑点，避免正常 hook 注册误报。
  if (createCount > 0 && cleanCount === 0) {
    return {
      ruleId: 3, title, level: 'warn',
      detail: `apply 内探测到约 ${createCount} 处创建/注册/监听，但 deactivate 清理体内回收调用为 0，生命周期疑似不对称。`,
      evidence: [],
      suggest: '对照 apply 的每处 create/register/on，在清理体内成对回收，保证停因进程无残留。',
    }
  }
  return {
    ruleId: 3, title, level: 'ok',
    detail: `apply 创建约 ${createCount} 处 / 清理回收约 ${cleanCount} 处，比例正常。`,
    evidence: [], suggest: '',
  }
}

function rule4(sourceName: string, src: string): RuleVerdict {
  const title = '优先官方接口；直写文件须就地注释理由'
  const hasFs = /node:fs/.test(src)
  if (!hasFs || !/(writeFileSync|appendFileSync|writeFile|appendFile|atomicWrite)\s*\(/.test(src)) {
    return { ruleId: 4, title, level: 'ok', detail: '未发现对文件系统的写入，无「直写旁路」风险。', evidence: [], suggest: '' }
  }
  const ls = lines(src)
  const asm: Line[] = []
  const plain: Line[] = []
  for (let idx = 0; idx < ls.length; idx++) {
    const l = ls[idx]
    if (!/(writeFileSync|appendFileSync|writeFile|appendFile|atomicWrite)\s*\(/.test(l.text)) continue
    // 上一非空行是否已有 // 注释
    let prevComment = false
    for (let i = idx - 1; i >= 0; i--) {
      const t = ls[i].text.trim()
      if (t === '') continue
      prevComment = t.startsWith('//')
      break
    }
    if (prevComment) continue
    // 该写点目标是否命中装配/登记文件（cordis/patch/bundles/pluginOrder）——命中才升级为 err
    if (/cordis|patch|bundles|pluginOrder/.test(l.text)) asm.push(l)
    else plain.push(l)
  }
  if (asm.length > 0) {
    return {
      ruleId: 4, title, level: 'err',
      detail: `检测到 ${asm.length} 处对装配/登记文件（cordis/patch/bundles/pluginOrder）的直写且未就地注释理由——直写非公共契约更须注明理由。`,
      evidence: asm.slice(0, 3).map((r) => ({ file: sourceName, line: r.n, snippet: snippetOf(src, r.n) })),
      suggest: '优先使用官方运行时接口（ctx.loader.* / webServer / 官方服务）完成装配与登记；确无官方 API 才直写，并在写入处就地注释理由。',
    }
  }
  if (plain.length > 0) {
    return {
      ruleId: 4, title, level: 'warn',
      detail: `检测到 ${plain.length} 处文件写入未就地注释理由；若属业务数据（非装配层）可忽略，若是装配旁路应补注释并改用官方接口。`,
      evidence: plain.slice(0, 3).map((r) => ({ file: sourceName, line: r.n, snippet: snippetOf(src, r.n) })),
      suggest: '业务数据写盘可接受；若涉及装配/登记层，优先官方接口并在写入处注明理由。',
    }
  }
  return { ruleId: 4, title, level: 'ok', detail: '文件写入点均就地注释了理由。', evidence: [], suggest: '' }
}

function rule5(sourceName: string, src: string): RuleVerdict {
  const title = '不改写官方与壳组件（@deepseek-ai/*）'
  // 启发式：对 @deepseek-ai 目录做写入（node:fs 写 path 含 @deepseek-ai），或 patch 官方产物。
  const writesToOfficial = findIn(src, /write(FileSync|File|Sync)?\s*\([^)]*@deepseek-ai/)
  if (writesToOfficial.length > 0) {
    return {
      ruleId: 5, title, level: 'err',
      detail: '检测到对官方组件（@deepseek-ai/*）路径的写入，疑似改写官方/壳组件。',
      evidence: writesToOfficial.map((r) => ({ file: sourceName, line: r.n, snippet: snippetOf(src, r.n) })),
      suggest: '禁止改写官方与壳组件；功能应从装配/注册层实现，官方组件一律只读。',
    }
  }
  return { ruleId: 5, title, level: 'ok', detail: '未发现对 @deepseek-ai/* 官方组件的写入。', evidence: [], suggest: '' }
}

function rule6(sourceName: string, src: string): RuleVerdict {
  const title = '不吞错、不假装清理'
  const emptyCatches = findIn(src, /catch\s*(?:\(\s*\w+\s*\))?\s*\{\s*\}/)
  const ignoreCatches = findIn(src, /catch\s*\([^)]*\)\s*\{\s*\/\*[^]*\/\s*\}/)
  // 疑似「假装清理」：'已卸载/已释放'文案但清理体空
  const pretendMsg = /已卸载|已释放|已回收|unloaded|disposed/.test(src)
  const fakeClean = extractReturnCleanup(src) && /已卸载|已释放|已回收/.test(src) ? findIn(src, /已卸载|已释放|已回收/) : []
  if (emptyCatches.length > 0 || ignoreCatches.length > 0) {
    return {
      ruleId: 6, title, level: 'warn',
      detail: `存在 ${emptyCatches.length + ignoreCatches.length} 处空 catch / /* ignore */ 静默吞错${fakeClean.length ? '；另见疑似「假装清理」文案（已卸载/已释放）但未做真实回收' : ''}。`,
      evidence: [...emptyCatches, ...ignoreCatches].slice(0, 3).map((r) => ({ file: sourceName, line: r.n, snippet: snippetOf(src, r.n) })),
      suggest: '错误应如实向上报告或至少记录；在清理路径里即使 catch 也要真正完成资源释放，不要空吞后再宣称「已卸载」。',
    }
  }
  if (fakeClean.length > 0) {
    return {
      ruleId: 6, title, level: 'warn',
      detail: '出现「已卸载/已释放」类文案但未定位到空 catch/空清理体，需人工确认是否有实际回收动作。',
      evidence: fakeClean.slice(0, 2).map((r) => ({ file: sourceName, line: r.n, snippet: snippetOf(src, r.n) })),
      suggest: '确保「已卸载/已释放」文案对应真实回收；绝不只写文案不动真格。',
    }
  }
  return { ruleId: 6, title, level: 'ok', detail: '未发现空 catch/ignore 吞错或「假装清理」文案。', evidence: [], suggest: '' }
}

function rule7(sourceName: string, pkgName: string, meta: { main?: string; exports?: unknown }): RuleVerdict {
  const title = '包名 dsh- 前缀 + 可解析入口'
  const issues: DiagEvidence[] = []
  if (!/^dsh-/.test(pkgName)) {
    issues.push({ file: 'package.json', line: 0, snippet: `name 缺失 ${pkgName} 不符合 dsh- 前缀` })
  }
  const resolved: string | null = (() => {
    const main = meta.main
    if (typeof main === 'string' && main.trim() !== '') return main
    const exportsObj = meta.exports as Record<string, unknown> | undefined
    const dot = exportsObj && typeof exportsObj === 'object' ? (exportsObj['.'] as Record<string, unknown> | undefined) : undefined
    if (dot && dot.default && typeof dot.default === 'string') return dot.default
    if (dot && dot.require && typeof dot.require === 'string') return dot.require
    if (dot && dot.import && typeof dot.import === 'string') return dot.import
    return null
  })()
  if (!resolved) {
    issues.push({ file: 'package.json', line: 0, snippet: '无可解析入口（main / exports["."].default 缺失）' })
  }
  if (issues.length > 0) {
    return {
      ruleId: 7, title, level: 'err',
      detail: issues.map((i) => i.snippet).join('；'),
      evidence: issues,
      suggest: '包名须为 dsh-<插件名>（小写连字符），且 main / exports["."].default 须指向可解析的启动文件。',
    }
  }
  return { ruleId: 7, title, level: 'ok', detail: `包名 ${pkgName} 符合 dsh- 前缀，入口 ${resolved} 可解析。`, evidence: [], suggest: '' }
}

/**
 * 规则 8（防半挂孤儿）：路由注册一律用 ctx.effect 包裹；非 effect 的顶层 register 到 return 之间不得夹带可抛错步骤。
 * 启发式而非 AST：ctx.effect 包裹注册由宿主随 entry 拆除托管回收（不产生半挂孤儿）→ 跳过；对未用 effect 的顶层 register，
 * 若其后最近 return 之前出现 throw/await/ctx.loader/require 等，该处抛错会令返回的卸注册器交不到 cordis → 半挂孤儿。
 */
function rule8(sourceName: string, src: string): RuleVerdict {
  const title = '路由注册用 ctx.effect；非 effect 时 register 到 return 间不留可抛错路径（防半挂孤儿）'
  const regs = findIn(src, /\.registerUpgrade?\s*\(|\.register\s*\(\s*\{|webServer\.register\(/)
  if (regs.length === 0) {
    return { ruleId: 8, title, level: 'ok', detail: '未发现 register 类资源注册，无半挂孤儿风险。', evidence: [], suggest: '' }
  }
  const applyStart = lineOf(src, 'export function apply') || lineOf(src, 'function apply')
  if (!applyStart) {
    return { ruleId: 8, title, level: 'ok', detail: '未定位 apply 入口函数，跳过半挂启发式（不影响其它规则）。', evidence: [], suggest: '' }
  }
  const covered = effectCoveredLines(src)
  const L = lines(src)
  const ev: DiagEvidence[] = []
  const hit: Line[] = []
  for (const r of regs) {
    if (r.n < applyStart) continue
    // effect 包裹注册由宿主随 entry 拆除托管回收，不产生半挂孤儿 → 跳过。
    if (covered.has(r.n)) continue
    // 该 register 之后、apply 内遇到的首个 return（通常即卸注册器交接）之前的风险段
    let until = 0
    for (let i = r.n; i <= L.length; i++) {
      if (L[i - 1].text.includes('return')) { until = i; break }
    }
    if (!until) continue
    const risk = L.slice(r.n, until - 1).map((l) => l.text).join('\n')
    if (/(throw\s|\bawait\b|\bctx\.loader|hook\.call|require\(|canvas|loadClient)/.test(risk)) {
      hit.push(r)
      ev.push({ file: sourceName, line: r.n, snippet: snippetOf(src, r.n) })
    }
  }
  if (hit.length > 0) {
    return {
      ruleId: 8, title, level: 'warn',
      detail: `apply 内 ${hit.length} 处未用 ctx.effect 包裹的注册点到 return 卸注册器之间含 throw/await/loader/require 等可抛错步骤：此处若抛错，返回的卸注册器交不到 cordis，资源即半挂孤儿（无法自身回收，同前缀重装撞 duplicate route）。`,
      evidence: ev,
      suggest: "改用 ctx.effect(() => ctx.webServer.register({...}), '<插件>: webServer') 包裹注册（宿主托管拆除）；必要时把注册挪到可抛错步骤之后或 try/catch 兜底。",
    }
  }
  return { ruleId: 8, title, level: 'ok', detail: '注册点均在 ctx.effect 内（宿主托管拆除）或到 return 前无显式可抛错路径。', evidence: [], suggest: '' }
}

/**
 * 对已装副本执行完整规范诊断。
 * @returns PluginDiagnostic；入口不可解析时返回空 rules（scanned=0，规则7 给 err）。
 */
export function diagnosePlugin(packageName: string, profileDir: string, runtimePhase: string | null = null): PluginDiagnostic {
  const pkgDir = resolveInstalledDir(profileDir, packageName)
  let pkgJson: { main?: string; exports?: unknown } = {}
  if (pkgDir) {
    try { pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) } catch { /* 忽略坏 manifest */ }
  }
  const summary = { ok: 0, warn: 0, err: 0 }
  const rules: RuleVerdict[] = []

  const phaseIt = (v: RuleVerdict): RuleVerdict => {
    summary[v.level === 'ok' ? 'ok' : v.level === 'warn' ? 'warn' : 'err'] += 1
    return v
  }

  // 规则 7 始终执行（对包名/入口做结构性体检，即使无产物可扫）。
  rules.push(phaseIt(rule7(packageName, packageName, pkgJson)))

  if (!pkgDir) {
    // 未安装副本：无法做源码级扫描，只有结构体检。
    return {
      name: packageName, pkgDir: null, scanned: 0, runtime: { phase: runtimePhase },
      rules, summary,
    }
  }

  const targets = collectJsTargets(pkgDir, pkgJson.main)
  let scanned = 0
  let whole = ''
  const sourceName = 'lib/*.js'
  for (const f of targets) {
    try { whole += '\n' + readFileSync(f, 'utf8') } catch { /* 跳过不可读 */ }
    scanned += 1
  }
  if (scanned > 0) {
    rules.push(phaseIt(rule1(sourceName, whole)))
    rules.push(phaseIt(rule2(sourceName, whole)))
    rules.push(phaseIt(rule3(sourceName, whole)))
    rules.push(phaseIt(rule4(sourceName, whole)))
    rules.push(phaseIt(rule5(sourceName, whole)))
    rules.push(phaseIt(rule6(sourceName, whole)))
    rules.push(phaseIt(rule8(sourceName, whole)))
  } else {
    rules.push(phaseIt({ ruleId: 2, title: '静态扫描', level: 'warn', detail: '未找到可扫描的 JS 产物（lib/ 或 main 指向文件缺失）。', evidence: [], suggest: '确认包内包含编译产物 lib/*.js。' }))
  }

  return {
    name: packageName, pkgDir: relative(profileDir, pkgDir) || pkgDir, scanned, runtime: { phase: runtimePhase },
    rules, summary,
  }
}