/**
 * dsh-plugin-simplemanager — 插件管家（client 面板）。
 * 注册进「设置」作为独立板块（slot: settings.section，id: simplemanager，导航名「桌面管家」）。
 * 面板内三栏：插件管理 / 插件热插拔（含可复制操作日志）/ 插件诊断（占位）。
 * 布局：左侧文件夹列表（官方内置 / 第三方插件 / 自定义），右侧插件卡片网格；
 * 支持拖拽移动分类、内联编辑备注、一键启停、运行时热插拔 / 转正 / 真卸载，点击卡片展开查看依赖。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent } from 'react'

export const name = 'dsh-plugin-simplemanager'
export const inject = ['slots']

/**
 * 本插件消费的 slots 服务最小类型面。官方真实类型是 `dsh-client-runtime` 的 `SlotRegistry`，
 * 但该包非本插件依赖、且经 `declare module` 扩展注入（独立工程内解析不到），故按实际调用结构性收窄。
 */
type SlotsService = {
  inject(key: string, callback: () => unknown): () => void
  register(...args: unknown[]): unknown
}

type AppClientContext = {
  slots: SlotsService
  get(name: string): unknown
}

interface KernelInfo {
  current: string | null
  source: string
}

interface Folder {
  id: string
  name: string
  kind: 'official' | 'third' | 'custom'
  count: number
}

interface Plugin {
  name: string
  version: string
  description: string
  scope: 'official' | 'shell' | 'third'
  /** 来源轴：官方/壳/临时/持久/孤儿（标准 = 真实装配数据）。 */
  source: 'official' | 'shell' | 'temporary' | 'persistent' | 'orphan'
  enabled: boolean
  /** 运行态：active/loading/pending 活态；disabled 已停用；failed…=fiber phase；none 未装配。 */
  runtime: 'active' | 'disabled' | 'failed' | 'pending' | 'loading' | 'disposed' | 'unloading' | 'none'
  folder: string
  note: string
  alias: string
  /** 插件自身声明的依赖（name@range）；临时插件为本次补装的闭包依赖。点击卡片展开可见。 */
  dependencies: string[]
  /** 状态框可点击启停（官方/壳 + 孤儿为 false）。 */
  toggleable: boolean
  /** 显示「卸载」/「清理」动作按钮。 */
  removable: boolean
  /** 显示「转正」（仅临时）。 */
  promoteable: boolean
  /** 显示「✕」临时卸载（仅临时）。 */
  tempRemoveable: boolean
  /** 「转正·待重启」注记。 */
  pendingRestart: boolean
}

interface Browse {
  ok: boolean
  folders: Folder[]
  plugins: Plugin[]
}

// —— 第三板块「代码规范治理」诊断类型（镜像内核 diagnostics.ts）——
type DiagLevel = 'ok' | 'warn' | 'err'
interface DiagRule {
  ruleId: number
  title: string
  level: DiagLevel
  detail: string
  evidence: Array<{ file: string; line: number; snippet: string }>
  suggest: string
}
interface PluginDiagnostic {
  name: string
  pkgDir: string | null
  scanned: number
  runtime: { phase: string | null }
  rules: DiagRule[]
  summary: { ok: number; warn: number; err: number }
}

/** 统一确认弹窗请求。withClearData=true 时额外显示「同时清除缓存/配置」开关节。 */
interface AskReq {
  title: string
  message: string
  okText?: string
  danger?: boolean
  withClearData?: boolean
  resolve: (r: { ok: boolean; clearData: boolean }) => void
}

const API = '/simplemanager'

/** —— 操作日志持久 store ——
 * 日志存模块级 + sessionStorage 双层：模块级保证退出/进入设置页、切换页签不丢；
 * 同步到 sessionStorage 保证点「重载界面」（window.location.reload 触发模块重求值）也不丢。
 * 只有用户手动「清空」才消失。组件通过 subscribe 订阅刷新。 */
interface LogEntry {
  time: string
  level: 'info' | 'ok' | 'warn' | 'err'
  text: string
}
const LOG_STORE_KEY = 'dsh-plugin-simplemanager.logs'
/** 从 sessionStorage 恢复上次的日志（reload 后模块重求值也能接上）。 */
function restoreLogStore(): LogEntry[] {
  try {
    const raw = window.sessionStorage.getItem(LOG_STORE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as LogEntry[]) : []
  } catch {
    return []
  }
}
const logStore: LogEntry[] = restoreLogStore()
/** 步骤骨架 + 实时状态：当前进行中的一次操作步骤（run），null = 无进行中/上次操作已结算。 */
interface StepView {
  runId: string
  plan: Array<{ key: string; label: string }>
  states: Record<string, { status: 'idle' | 'running' | 'ok' | 'err'; elapsed?: string; note?: string }>
  done: boolean
  title: string
}
let stepView: StepView | null = null
let logSubscribe: (() => void) | null = null

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  return (await res.json()) as T
}

async function browse(): Promise<Browse> {
  return await api<Browse>(`${API}/browse`)
}

/** client 无头冒烟预检：单步结果（load 注册 / apply 等），ok=false 的那步即重载崩溃根因。 */
interface SmokeStepOutcome { name: string; ok: boolean; detail: string }
/** 预检结局类别，reloadClient 按此分组渲染，避免把"必挂起"错标成"崩溃"（详见后端同类定义）。 */
type SmokeOutcome = 'pending' | 'crash' | 'volatile' | 'warn' | 'pass'
/** client 无头冒烟预检：单个插件的整体结论。ok = 能否安全 reload；outcome = 精确结局类别。 */
interface ClientSmokeReport {
  name: string
  declared: boolean
  ok: boolean
  /** 真 cordis 门禁后端产出（true）或三态近似（false）。 */
  realGate: boolean
  outcome: SmokeOutcome
  steps: SmokeStepOutcome[]
  error?: string
  /** 非阻塞警告：重载会挂起等待的注入服务、被服务门禁屏蔽的潜在缺陷、实验室模式说明。 */
  warns?: string[]
}

/** 重载预检后端模式：three-state=三态门禁（默认）；real-cordis=真 cordis 门禁（实验室，仅门禁不深挖）。 */
type PreflightMode = 'three-state' | 'real-cordis'
const PREFLIGHT_MODE_KEY = 'dsh-plugin-simplemanager:preflightMode'

/** 目录浏览层级（官方 directoryPicker.list 返回面）。 */
interface DirLevel {
  path: string
  home: string
  crumbs: { name: string; path: string; hidden: boolean }[]
  entries: { name: string; path: string; hidden: boolean }[]
  truncated: boolean
  /** true = 首层盘符根层（"此电脑"），仅是跳板，不可加载。 */
  roots?: boolean
}

async function listdir(path?: string): Promise<{ ok: boolean; level?: DirLevel; error?: string }> {
  return await api(`${API}/listdir`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}

export function apply(ctx: AppClientContext): void {
  // 作为设置里的独立板块呈现（设置 → 桌面管家）：
  // 用官方 settings.section slot（list scope=root），在设置导航列生成独立入口，
  // 而非嵌进官方「插件」section 的 plugins.tab。id/order/label 决定导航位。
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'simplemanager',
        order: 15,
        label: () => '插件管家',
        inject: () => ({ hooks: {} }),
      },
      SimpleManagerTab,
    ),
  )
}

/** 模块级拖拽信号（纯命令式，不参与渲染）：来源 id 与类型，供子组件 FolderRow/PluginCard 判定落点行为。 */
const dragName = { current: '' as string }
const dragKind = { current: '' as 'plugin' | 'folder' | '' }
/** 拖拽悬停目标上的落点相位：目标中点前半=插入到其前，后半=插入到其后。 */
const dragPhase = { current: 'before' as 'before' | 'after' }

function browserDragging(): boolean {
  return dragKind.current !== ''
}

function SimpleManagerTab(_props: Record<string, unknown>): JSX.Element | null {
  const [ready, setReady] = useState(false)
  const [folders, setFolders] = useState<Folder[]>([])
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [active, setActive] = useState('third')
  const [kernel, setKernel] = useState<KernelInfo | null>(null)
  const [flash, setFlash] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [tempInput, setTempInput] = useState('')
  const [tempBusy, setTempBusy] = useState(false)
  /** 顶部导航：manage=插件管理 / hotswap=插件热插拔 / diagnose=插件诊断。 */
  const [tab, setTab] = useState<'manage' | 'hotswap' | 'diagnose'>('manage')
  /** 操作日志条目（时间戳 + 级别 + 文本）：视图镜像持久 store，供热插拔栏查看与整段复制。 */
  const [logs, setLogs] = useState<LogEntry[]>(logStore.slice())
  /** 当前步骤骨架 + 实时状态（镜像 stepView）。 */
  const [steps, setSteps] = useState<StepView | null>(stepView)
  const logRef = useRef<HTMLDivElement>(null)
  /** 运行时临时加载的目录浏览器状态：browsePath 当前层目录；dirLevel 该层列表。 */
  const [browsePath, setBrowsePath] = useState<string | undefined>(undefined)
  const [dirLevel, setDirLevel] = useState<DirLevel | null>(null)
  /** 目录选择弹窗是否打开（改造1：从内联改为独立弹层）。 */
  const [dirPickerOpen, setDirPickerOpen] = useState(false)
  /** 重载前预检发现风险时的确认弹窗（report=展示文本，resolve=用户是否仍要重载）。 */
  const [riskAsk, setRiskAsk] = useState<{ report: string; resolve: (v: boolean) => void } | null>(null)
  /** 插件搜索关键词（改造3：匹配重命名名 alias / 原名 name）。 */
  const [query, setQuery] = useState('')
  /** 当前拖拽悬停的落点 key（"folder:<id>" / "plugin:<name>"），用于落点高亮显示（改造2）。 */
  const [hoverTarget, setHoverTarget] = useState('')
  /** 当前拖拽悬停的落点相位（目标中点前/后），用于插入指示条（改造：拖拽排序放宽）。 */
  const [dropPhase, setDropPhase] = useState<'before' | 'after' | ''>('')
  /** 第三板块：代码规范治理诊断结果（按插件聚合）。 */
  const [diag, setDiag] = useState<PluginDiagnostic[]>([])
  const [diagBusy, setDiagBusy] = useState(false)
  // 诊断范围（多选文件夹，localStorage 持久化，避免每次手动勾选）。空数组 = 全部第三方。
  const [diagFolders, setDiagFolders] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('dsh-plugin-simplemanager:diagFolders')
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string')
      }
    } catch { /* 解析失败退回全量诊断 */ }
    return []
  })
  /** 统一确认弹窗（dsh 客户端风格卡片）：替代浏览器原生 confirm，支持可选「同时清除缓存」开关。 */
  const [ask, setAsk] = useState<AskReq | null>(null)
  const [askClearData, setAskClearData] = useState(false)

  const refresh = useCallback(async () => {
    const view = await browse()
    const kb = await api<KernelInfo>(`${API}/kernel`)
    setFolders(view.folders)
    setPlugins(view.plugins)
    setKernel(kb)
    setReady(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 诊断范围选择持久化到 localStorage（跨重启保留，不用每次勾选）。
  useEffect(() => {
    try { localStorage.setItem('dsh-plugin-simplemanager:diagFolders', JSON.stringify(diagFolders)) } catch { /* ignore */ }
  }, [diagFolders])

  // 重载预检后端模式：默认三态门禁；真 cordis 门禁为实验室模式（开启前需确认，见 setPreflightMode）。
  const [preflightMode, setPreflightModeState] = useState<PreflightMode>(() => {
    try {
      const raw = localStorage.getItem(PREFLIGHT_MODE_KEY)
      if (raw === 'real-cordis') return 'real-cordis'
    } catch { /* 解析失败退回三态 */ }
    return 'three-state'
  })
  useEffect(() => {
    try { localStorage.setItem(PREFLIGHT_MODE_KEY, preflightMode) } catch { /* ignore */ }
  }, [preflightMode])
  /** 切换预检模式：切到实验室（真 cordis）前先弹提醒说明风险，确认后才开启。 */
  const setPreflightMode = async (next: PreflightMode): Promise<void> => {
    if (next === preflightMode) return
    if (next === 'real-cordis') {
      const { ok } = await askConfirm({
        title: '开启实验室模式',
        message: '真 cordis 门禁（实验室）：用真实 @deepseek-ai/cordis 判定注入服务可达性，并在门禁通过后继续跑 apply/渲染/数据驱动渲染全套 VM 检测（检测最全）。\n\n'
          + '· 相比基础模式（仅三态门禁、不深挖 apply/渲染），实验室额外执行 apply 深挖 + 数据驱动渲染探测，能抓取基础模式漏过的渲染/异步错误；\n'
          + '· 依赖 profile 中可解析的真实 cordis（解析不到会回退三态近似）；\n'
          + '· 门禁通过后继续深挖，检测更全但耗时更长。\n\n是否开启？',
        okText: '开启',
      })
      if (!ok) return
    }
    setPreflightModeState(next)
    pushLog('info', `重载预检模式切换为 ${next === 'real-cordis' ? '真 cordis 门禁（实验室）' : '三态门禁（默认）'}`)
  }

  // 订阅日志/步骤 store：任何写入触发组件重渲染（含组件重挂载时同步 latest）。
  useEffect(() => {
    logSubscribe = () => {
      setLogs(logStore.slice())
      setSteps(stepView)
    }
    setLogs(logStore.slice())
    setSteps(stepView)
    return () => {
      logSubscribe = null
    }
  }, [])

  const activePlugins = useMemo(
    () => plugins.filter((p) => (p.folder || 'third') === active),
    [plugins, active],
  )

  // 改造3：按查询词在重命名名(alias) 与原名(name) 上做不区分大小写的子串模糊过滤。
  const filteredPlugins = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return activePlugins
    return activePlugins.filter((p) => {
      const hay = `${p.alias} ${p.name}`.toLowerCase()
      // 逐字符模糊匹配：query 的字符须按序出现在 hay 中（模糊），而非仅子串。
      let i = 0
      for (const ch of q) {
        i = hay.indexOf(ch, i)
        if (i < 0) return false
        i += 1
      }
      return true
    })
  }, [activePlugins, query])

  const activeFolderMeta = folderOf(folders, active)

  const notify = (msg: string): void => {
    setFlash(msg)
    window.setTimeout(() => setFlash(''), 4000)
  }

  /** 追加一条操作日志到持久 store（自动附加时间戳 + 广播刷新），并滚动到底部。 */
  const pushLog = (level: 'info' | 'ok' | 'warn' | 'err', text: string): void => {
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    logStore.push({ time, level, text })
    if (logStore.length > 2000) logStore.splice(0, logStore.length - 2000)
    try { window.sessionStorage.setItem(LOG_STORE_KEY, JSON.stringify(logStore)) } catch { /* storage 不可用时仅保留内存 */ }
    logSubscribe?.()
    setLogs(logStore.slice())
    requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }))
  }

  /** 复制当前全部日志到剪贴板，组内做提示。 */
  const copyLogs = (): void => {
    if (logs.length === 0) return
    const text = logs.map((l) => `[${l.time}] ${l.text}`).join('\n')
    // 复制成功不再弹顶部绿色提示（操作日志已承载反馈），仅失败保留错误提示。
    const done = (): void => { /* noop */ }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        void navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done))
        return
      }
    } catch { /* 走 fallback */ }
    fallbackCopy(text, done)
  }

  /** 剪贴板 API 不可用时的兜底：临时 textarea + 选中 + execCommand。 */
  const fallbackCopy = (text: string, done: () => void): void => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      done()
    } catch {
      notify('日志复制失败：浏览器限制了剪贴板访问')
    }
    document.body.removeChild(ta)
  }

  /** 复制预检风险报告到剪贴板（复用日志兜底逻辑），组内做提示。 */
  const copyRiskReport = (text: string): void => {
    // 复制成功不弹顶部绿色提示，失败保留错误提示。
    const done = (): void => { /* noop */ }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        void navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done))
        return
      }
    } catch { /* 走 fallback */ }
    fallbackCopy(text, done)
  }

  const clearLogs = (): void => {
    logStore.length = 0
    try { window.sessionStorage.removeItem(LOG_STORE_KEY) } catch { /* 忽略 */ }
    stepView = null
    logSubscribe?.()
    setLogs([])
    setSteps(null)
  }

  /** 第三板块：一键体检——静态扫全部第三方已装插件副本库，按禁做清单逐条取证。只读。 */
  const toggleDiagFolder = (id: string): void => {
    setDiagFolders((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const runDiagnostics = async (): Promise<void> => {
    if (diagBusy) return
    setDiagBusy(true)
    pushLog('info', '开始代码规范体检（扫描所选文件夹内的第三方插件副本库）…')
    try {
      const r = await api<{ ok: boolean; report?: PluginDiagnostic[]; error?: string }>(`${API}/diagnostics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ names: [], folders: diagFolders }),
      })
      if (!r.ok || !r.report) {
        notify(r.error ?? '体检失败')
        pushLog('err', `代码规范体检失败：${r.error ?? '未知原因'}`)
        return
      }
      setDiag(r.report)
      const err = r.report.flatMap((p) => p.rules).filter((x) => x.level === 'err').length
      const warn = r.report.flatMap((p) => p.rules).filter((x) => x.level === 'warn').length
      pushLog(err || warn ? 'warn' : 'ok', `体检完成：${r.report.length} 个插件 · 违规 ${err} 项 / 疑点 ${warn} 项`)
    } catch (e) {
      notify('体检请求失败')
      pushLog('err', `代码规范体检请求异常：${String(e)}`)
    } finally {
      setDiagBusy(false)
    }
  }

  /** 把诊断结果序列化为报告文本（供复制）。仅含非 ok 项，保留证据行号。 */
  const formatDiagReport = (list: PluginDiagnostic[] = diag): string => {
    if (list.length === 0) return '（尚未进行体检，或当前无诊断结果）'
    const out: string[] = []
    for (const p of list) {
      const issues = p.rules.filter((r) => r.level !== 'ok')
      out.push(`## ${p.name}${p.pkgDir ? `\n副本：${p.pkgDir}` : ''}${p.runtime.phase === 'failed' ? '\n⚠ 运行态：failed（启动失败，需重装）' : ''}`)
      if (issues.length === 0) {
        out.push('✓ 全部规则通过')
        continue
      }
      for (const r of issues) {
        const mark = r.level === 'err' ? '✗ 违规' : '⚠ 疑点'
        out.push(`- [${mark}] 规则${r.ruleId} ${r.title}`)
        out.push(`  说明：${r.detail}`)
        for (const ev of r.evidence) out.push(`  证据：${ev.file}${ev.line ? ':' + ev.line : ''} ${ev.snippet}`)
        if (r.suggest) out.push(`  建议：${r.suggest}`)
      }
    }
    return out.join('\n')
  }

  const copyDiagReport = (): void => {
    if (diag.length === 0) return
    const text = formatDiagReport()
    // 复制成功不弹顶部绿色提示，失败保留错误提示。
    const done = (): void => { /* noop */ }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        void navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done))
        return
      }
    } catch { /* 走 fallback */ }
    fallbackCopy(text, done)
  }

  /** 打开统一确认弹窗（dsh 客户端风格卡片），返回用户的选择。
   * 所有关闭路径（确认/取消/背景点击/✕）都经同一包装 resolve：先 setAsk(null) 收起弹窗、再 resolve 结果，
   * 避免只 resolve 不关窗导致弹窗残留、按钮"按了没反应"。 */
  const askConfirm = (opts: { title: string; message: string; okText?: string; danger?: boolean; withClearData?: boolean }): Promise<{ ok: boolean; clearData: boolean }> => {
    setAskClearData(false)
    return new Promise<{ ok: boolean; clearData: boolean }>((resolve) => {
      setAsk({
        ...opts,
        resolve: (r: { ok: boolean; clearData: boolean }) => { setAsk(null); resolve(r) },
      })
    })
  }

  /** 后端步进 level 字符串 → 前端日志着色级别（未知等级兜底 info）。 */
  const mapStepLevel = (level: string): 'info' | 'ok' | 'warn' | 'err' => {
    if (level === 'ok' || level === 'warn' || level === 'err') return level
    return 'info'
  }

  const call = async (action: string, body: Record<string, unknown>): Promise<boolean> => {
    const r = await api<{ ok: boolean; error?: string }>(`${API}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (r.ok) {
      await refresh()
      return true
    }
    notify(r.error ?? '操作失败')
    return false
  }

  const toggle = async (p: Plugin): Promise<void> => {
    const r = await api<{ ok: boolean; error?: string; hotApplied?: boolean; enabled?: boolean }>(
      `${API}/toggle`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.name }) },
    )
    if (!r.ok) {
      notify(r.error ?? '启停失败')
      pushLog('err', `启停 ${p.name} 失败：${r.error ?? '未知原因'}`)
      return
    }
    await refresh()
    const applied = r.hotApplied ? '已热生效' : '重启后生效'
    // 启停成功信息已在下方操作日志记录，不再弹顶部绿色提示。
    pushLog(r.enabled ? 'ok' : 'info', `${r.enabled ? '启用' : '停用'}插件 ${p.name}（${applied}）`)
  }

  const tempLoad = async (): Promise<void> => {
    const name = tempInput.trim()
    if (!name) return
    setTempBusy(true)
    const t0 = Date.now()
    try {
      const { data: r, runId } = await withSteps<{ ok: boolean; error?: string; depsApplied?: boolean; hotApplied?: boolean; pnpmReason?: string }>(
        'tempLoad',
        '临时加载插件',
        (rid) =>
          api(`${API}/tempLoad`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, runId: rid }),
          }),
      )
      const t1 = Date.now()
      if (r.ok) {
        pushLog(r.depsApplied ? 'ok' : 'warn', `内核装配完成（${((t1 - t0) / 1000).toFixed(1)}s）：${r.depsApplied ? '依赖已装齐' : `依赖获取失败（${r.pnpmReason ?? '未知'}）`}`)
        if (r.hotApplied) {
          pushLog('ok', '已在运行期启用（无需重启）')
          setTempInput('')
        } else {
          pushLog('info', '已装配，重启后生效')
          setTempInput('')
        }
        const t2 = Date.now()
        await refresh()
        pushLog('info', `界面刷新完成（${((Date.now() - t2) / 1000).toFixed(1)}s），共耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      } else {
        notify(r.error ?? '临时加载失败')
        // 错误详情已由步骤引擎的 run.lines 记录进日志，此处仅顶部 toast 一句话提示，不重复入日志。
      }
    } finally {
      setTempBusy(false)
    }
  }

  /** 步骤引擎快照：按 run 拉取 plan + 各步状态 + 尾部行。前端据此逐步追踪。 */
  const fetchSteps = async (runId: string): Promise<{
    ok: boolean
    done?: boolean
    plan?: Array<{ key: string; label: string }>
    states?: Array<{ key: string; label: string; status: string; elapsed?: string; note?: string }>
    lines?: Array<{ t: string; level: string; text: string }>
  }> => {
    try {
      return await api<{
        ok: boolean
        done?: boolean
        plan?: Array<{ key: string; label: string }>
        states?: Array<{ key: string; label: string; status: string; elapsed?: string; note?: string }>
        lines?: Array<{ t: string; level: string; text: string }>
      }>(`${API}/tempSteps?run=${encodeURIComponent(runId)}`)
    } catch {
      return { ok: false }
    }
  }

  /** 预创建一次操作步骤 run：返回 runId + plan（触发 store 渲染「共 X 步：…」骨架）。 */
  const beginStep = async (action: string, title: string): Promise<string> => {
    const r = await api<{ ok: boolean; runId?: string; plan?: Array<{ key: string; label: string }> }>(`${API}/beginStep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    if (!r.ok || !r.runId) throw new Error('无法建立步骤计划')
    stepView = {
      runId: r.runId,
      plan: r.plan ?? [],
      states: {},
      done: false,
      title,
    }
    logSubscribe?.()
    setSteps(stepView)
    pushLog('info', `—— ${title}：共 ${r.plan?.length ?? 0} 步 ——`)
    return r.runId
  }

  /**
   * 以「步骤引擎」方式执行一次后台操作：
   * 1) 先 beginStep 预创建 run，拿到 runId + plan 渲染「共几步、分别是哪几步」骨架；
   * 2) 携带 runId 执行真实操作；
   * 3) 执行期间轮询 tempSteps 逐步更新每步状态（pending→running→ok/err）+ 耗时，并写入尾部日志。
   * 失败/成功都结算骨架。返回操作回调的结果。
   */
  const withSteps = async <T,>(action: string, title: string, run: (runId: string) => Promise<T>): Promise<{ data: T; runId: string }> => {
    const runId = await beginStep(action, title)
    // 实时追踪：在真实操作执行期间就启动轮询，逐步刷新每步状态（而非等操作完成才一次性拿到）。
    pollSteps(runId)
    const fail = (text: string): void => {
      // 错误详情已由服务端 run.lines 的 fail() 记录进日志，此处只结算骨架，避免同一错误重复入日志。
      if (stepView?.runId === runId) {
        stepView.done = true
        logSubscribe?.()
        setSteps(stepView)
      }
    }
    let data: T
    try {
      data = await run(runId)
      // 操作返回：标记 sketch 结算（done）。
      if (stepView?.runId === runId) {
        stepView.done = true
        logSubscribe?.()
        setSteps(stepView)
      }
      return { data, runId }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
      throw error
    }
  }
  /** 延后启动轮询（不与 withSteps 的同步路径耦合），每间隔拉一次快照增量更新 stepView。 */
  const pollSteps = (runId: string): void => {
    const timer = window.setInterval(async () => {
      const snap = await fetchSteps(runId)
      if (!snap.ok) return
      if (snap.plan && (!stepView || stepView.runId !== runId)) {
        stepView = { runId, plan: snap.plan, states: {}, done: snap.done ?? false, title: stepView?.title ?? '操作' }
      }
      const cur = stepView
      if (!cur || cur.runId !== runId) return
      const states = { ...cur.states }
      for (const s of snap.states ?? []) {
        const prev = states[s.key]
        states[s.key] = {
          status: (s.status as 'idle' | 'running' | 'ok' | 'err') ?? 'idle',
          elapsed: s.elapsed,
          note: s.note,
        }
        // 骨架进度只更新 status/耗时（stepView 卡片渲染），不再在此 pushLog——
        // 否则与下方 done 时 snap.lines 全量 push 形成双通道，同一 step 会被写两遍、顺序错乱（P-049 复现纠正）。
      }
      cur.states = states
      cur.done = snap.done ?? cur.done
      if (cur.done) {
        window.clearInterval(timer)
        snap.lines?.forEach((l) => pushLog(mapStepLevel(l.level), l.text))
        setSteps(cur)
      } else {
        logSubscribe?.()
        setSteps(cur)
      }
    }, 400)
  }

  /** 重载 CLIENT 层前，对「活跃插件」做无头冒烟预检请求（kernel 进程真实执行 client bundle 的 load 注册 + apply）。
   * mode='real-cordis'（实验室）走真 cordis 门禁（仅门禁不深挖）；缺省/other 走三态门禁+apply 深挖。 */
  const preflightClients = async (names: string[], mode: PreflightMode): Promise<ClientSmokeReport[]> => {
    try {
      const r = await api<{ ok?: boolean; results: ClientSmokeReport[] }>(`${API}/verifyClient`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ names, mode }),
      })
      return r.results ?? []
    } catch {
      return []
    }
  }

  /** 展开一条预检报告的每步详情（1 行 1 步，缩进对齐），ok=false 那步即重载崩根因。 */
  const renderReportSteps = (r: ClientSmokeReport): string =>
    r.steps.map((s) => `   ${s.ok ? '✓' : '✗'} ${s.name}：${s.detail}`).join('\n')

  /** 重载 CLIENT 层：先对活跃插件做无头冒烟预检，抓到「热注入没问题、但重载前端会崩」的插件就警告并列分步根因，
   * 当前策略为「警告 + 仍允许重载」（硬阻止为未来方向）。静态存在性检查拦不住这类运行时错误，只能靠冒烟预检。 */
  const reloadClient = async (): Promise<void> => {
    // 重载引导期会重新 apply 的插件都要预检：不仅 active，含引导中(pending/loading)与异常(failed)。
    // 只预检 active 会漏掉「死在引导期、重载才崩」的高危插件（引擎独立重放 client，对非 active 不误报）。
    // 排除 @deepseek-ai/* 官方核心：它们由壳以完整浏览器环境原生加载、重载必不崩，而 vm 冒烟沙箱
    // 缺 URLSearchParams/provide 等环境会对其 apply 产生假阳性，故仅对第三方/自研插件做完整冒烟。
    const preflightNames = plugins
      .filter(
        (p) =>
          p.runtime != null &&
          !p.name.startsWith('@deepseek-ai/') &&
          ['active', 'pending', 'loading', 'failed'].includes(p.runtime),
      )
      .map((p) => p.name)
    const base = '重载界面（仅刷新渲染进程，不重启内核）？\n当前会话与内核热装状态都会保留。'

    if (preflightNames.length === 0) {
      const { ok } = await askConfirm({ title: '重载界面', message: base, okText: '重载' })
      if (!ok) return
      window.location.reload()
      return
    }

    const modeLabel = preflightMode === 'real-cordis' ? '真 cordis 门禁（实验室）' : '三态门禁'
    pushLog('info', `—— 重载界面前：${preflightNames.length} 个待重载插件 client 无头冒烟预检开始（${modeLabel}）——`)
    const reports = await preflightClients(preflightNames, preflightMode)
    // 用 outcome 精确分级，而非把 ok 当"崩溃"二值：
    //   阻断(pending/crash)：重载必失败——fixture 的"必挂起"与"真实崩溃"同级，都是重载进不去/白屏。
    //   关注(volatile/warn)：可重载但应知晓——缺 client 产物、实验室模式说明、未知服务名等。
    //   pass：安全。
    const blockers = reports.filter((r) => r.declared && (r.outcome === 'pending' || r.outcome === 'crash'))
    // 关注项里拆出"模式级说明"（如实验室不深挖），与"插件级缺陷"区分，避免混在一个列表。
    const concernees = reports.filter((r) =>
      r.declared && (r.outcome === 'volatile' || r.outcome === 'warn') &&
      (r.warns ?? []).some((w) => !w.startsWith('实验室模式')),
    )
    // 纯模式说明（不指向具体插件缺陷）单独展示
    const modeNotes = reports
      .filter((r) => (r.warns ?? []).some((w) => w.startsWith('实验室模式')))
      .flatMap((r) => (r.warns ?? []).filter((w) => w.startsWith('实验室模式')))

    if (blockers.length === 0 && concernees.length === 0 && modeNotes.length === 0) {
      pushLog('ok', `预检通过：${reports.length} 个待重载插件均无重载失败风险`)
      const { ok } = await askConfirm({ title: '重载界面', message: `${base}\n预检 ${reports.length} 个待重载插件，均无重载失败风险。`, okText: '重载' })
      if (!ok) return
      window.location.reload()
      return
    }

    const blockerDetail = blockers
      .map((r) => {
        const tag = r.outcome === 'pending' ? '必挂起' : r.outcome === 'crash' ? '真实崩溃' : '异常'
        return `· ${r.name}（${tag}）\n${renderReportSteps(r)}${r.error ? `\n   根因：${r.error}` : ''}`
      })
      .join('\n')
    const concernDetail = concernees
      .map((r) => `· ${r.name}\n${renderReportSteps(r)}\n${(r.warns ?? []).filter((w) => !w.startsWith('实验室模式')).map((w) => `   ⚠ ${w}`).join('\n')}`)
      .join('\n')
    const msgParts: string[] = []
    if (blockers.length > 0) {
      msgParts.push(`· ${blockers.length} 个插件的 client 重载**将失败**（必挂起或真实崩溃，整页被门禁打回或白屏）：\n${blockerDetail}`)
      pushLog('warn', `预检发现 ${blockers.length} 个插件重载将失败（${blockers.map((b) => b.name).join('、')}）`)
    }
    if (concernees.length > 0) {
      msgParts.push(`· ${concernees.length} 个插件重载时可继续，但需关注（缺 client 产物或存在潜在缺陷）：\n${concernDetail}`)
      pushLog('warn', `${concernees.length} 个插件重载需关注（${concernees.map((c) => c.name).join('、')}）`)
    }
    if (modeNotes.length > 0) {
      msgParts.push(`· 模式说明：\n${modeNotes.map((w) => `   ⚠ ${w}`).join('\n')}`)
    }
    const warnMsg = `重载界面预检报告：\n\n${msgParts.join('\n\n')}`
    // 应用内弹窗确认（而非 window.confirm）：提供「复制报告」一键拷贝，便于去插件处定位修改。
    // 与旧版一致：默认警示但允许继续重载。
    const proceed = await new Promise<boolean>((resolve) => setRiskAsk({ report: warnMsg, resolve }))
    if (!proceed) return
    pushLog('info', '用户选择继续：仍按原样重载界面')
    window.location.reload()
  }

  const openBrowser = async (path?: string): Promise<void> => {
    const r = await listdir(path)
    if (!r.ok || !r.level) {
      notify(r.error ?? '目录读取失败')
      return
    }
    setBrowsePath(r.level.path)
    setDirLevel(r.level)
  }

  // 开启应用内目录浏览（进入 home 层），以独立弹窗展示。
  const startTempBrowse = async (): Promise<void> => {
    setDirPickerOpen(true)
    await openBrowser(undefined)
  }

  const closeDirPicker = (): void => {
    setDirPickerOpen(false)
    setDirLevel(null)
  }

  // 从浏览器当前目录临时加载插件（根层/空路径为跳板，禁用）。
  const loadFromBrowse = (): void => {
    if (!browsePath) {
      notify('尚未进入目标目录（browsePath 为空），请先进入插件包根目录')
      return
    }
    if (dirLevel?.roots) {
      notify('当前在盘符根层，请先进入具体插件目录再加载')
      return
    }
    setTempInput(browsePath)
    void tempLoad().then(closeDirPicker)
  }

  const descend = async (childPath: string): Promise<void> => {
    await openBrowser(childPath)
  }

  // 在弹窗中跳转到用户输入的任意绝对路径浏览（支持其它盘符直达）。
  const jumpToInputPath = (): void => {
    const p = tempInput.trim()
    if (!p) return
    setBrowsePath(p)
    void openBrowser(p)
  }

  const promote = async (p: Plugin): Promise<void> => {
    const { ok } = await askConfirm({
      title: '转正插件',
      message: `真注入插件「${p.name}」？\n将安装其依赖闭包并写入 profile 装配清单，重启后持久生效（本次进程结束前仍为临时）。`,
      okText: '确认转正',
    })
    if (!ok) return
    const { data: r, runId } = await withSteps<{ ok: boolean; error?: string; packageName?: string }>('promote', '转正插件', (rid) =>
      api(`${API}/promote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.name, runId: rid }) }),
    )
    if (r.ok) {
      // 转正成功信息已在操作日志记录，不再弹顶部绿色提示。
      pushLog('ok', `已转正插件「${r.packageName ?? p.name}」，重启后生效`)
      await refresh()
    } else {
      notify(r.error ?? '转正失败')
      // 错误详情已由步骤引擎的 run.lines 记录进日志，此处仅顶部 toast 一句话提示，不重复入日志。
    }
  }

  const tempRemove = async (p: Plugin): Promise<void> => {
    const { ok } = await askConfirm({
      title: '卸载临时插件',
      message: `卸载临时插件「${p.name}」？仅当前进程移除，不影响磁盘。`,
      okText: '确认卸载',
    })
    if (!ok) return
    const { data: r, runId } = await withSteps<{ ok: boolean; error?: string }>('tempRemove', '卸载临时插件', (rid) =>
      api(`${API}/tempRemove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.name, runId: rid }) }),
    )
    if (r.ok) {
      // 成功信息已在操作日志记录，不再弹顶部绿色提示。
      pushLog('ok', `已卸载临时插件 ${p.name}`)
      await refresh()
    } else {
      notify(r.error ?? '卸载失败')
      // 错误详情已由步骤引擎的 run.lines 记录进日志，此处仅顶部 toast 一句话提示，不重复入日志。
    }
  }

  const uninstall = async (p: Plugin): Promise<void> => {
    const { ok, clearData } = await askConfirm({
      title: '真卸载插件',
      message: `将从磁盘移除「${p.name}」的包与依赖闭包、从装配清单注销并清理备注/分类——此操作不可通过面板撤销，重启后不再装配。\n确定继续吗？`,
      okText: '确认卸载',
      danger: true,
      withClearData: true,
    })
    if (!ok) return
    const { data: r, runId } = await withSteps<{ ok: boolean; error?: string; packageName?: string }>('uninstall', '真卸载插件', (rid) =>
      api(`${API}/uninstall`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.name, runId: rid, clearData }) }),
    )
    if (r.ok) {
      // 成功信息已在操作日志记录，不再弹顶部绿色提示。
      pushLog('ok', `已真卸载「${r.packageName ?? p.name}」${clearData ? '，已清除本地数据目录' : ''}`)
      await refresh()
    } else {
      notify(r.error ?? '卸载失败')
      // 错误详情已由步骤引擎的 run.lines 记录进日志，此处仅顶部 toast 一句话提示，不重复入日志。
    }
  }

  const move = (pluginName: string, folder: string): void => {
    if (pluginName) void call('move', { id: pluginName, folder })
  }

  /** 插件卡片拖拽重排：在 active 文件夹内把 dragged 插入到 target 之前（before）/之后（after），整体提交。 */
  const reorderPluginDrop = (dragged: string, target: string, phase: 'before' | 'after'): void => {
    const from = activePlugins.findIndex((p) => p.name === dragged)
    const to = activePlugins.findIndex((p) => p.name === target)
    if (from < 0 || to < 0 || from === to) return
    const ids = activePlugins
      .map((p) => p.name)
      .filter((n) => n !== dragged)
    const targetIdx = ids.indexOf(target)
    ids.splice(phase === 'before' ? targetIdx : targetIdx + 1, 0, dragged)
    void call('reorder', { folder: active, ids })
  }

  /** 文件夹行拖拽重排：在自定义文件夹序列内把 dragged 插入到 target 之前/之后，整体提交。 */
  const reorderFolderDrop = (dragged: string, target: string, phase: 'before' | 'after'): void => {
    const custom = folders.filter((f) => f.kind === 'custom')
    const ids = custom.map((f) => f.id)
    const from = ids.indexOf(dragged)
    const to = ids.indexOf(target)
    if (from < 0 || to < 0 || from === to) return
    const filtered = ids.filter((n) => n !== dragged)
    const targetIdx = filtered.indexOf(target)
    filtered.splice(phase === 'before' ? targetIdx : targetIdx + 1, 0, dragged)
    void call('folders', { action: 'order', ids: filtered })
  }

  const saveNote = async (p: Plugin, note: string): Promise<void> => {
    await call('note', { id: p.name, note })
  }

  const createFolder = async (): Promise<void> => {
    const nameText = newName.trim()
    if (!nameText) return
    if (await call('folders', { action: 'create', name: nameText })) {
      setCreating(false)
      setNewName('')
    }
  }

  const renameFolder = async (f: Folder, nextName: string): Promise<void> => {
    const nameText = nextName.trim()
    if (nameText) await call('folders', { action: 'rename', id: f.id, name: nameText })
  }

  const deleteFolder = async (f: Folder): Promise<void> => {
    const { ok } = await askConfirm({
      title: '删除文件夹',
      message: `删除文件夹「${f.name}」？其中的插件将移回「第三方插件」。`,
      okText: '确认删除',
      danger: true,
    })
    if (ok) {
      if (await call('folders', { action: 'delete', id: f.id })) setActive('third')
    }
  }

  const renamePlugin = async (p: Plugin, alias: string): Promise<void> => {
    await call('rename', { id: p.name, alias })
  }

  if (!ready) return <div style={s.center}>{'加载中…'}</div>

  return (
    <div style={s.root}>
      <div style={s.stickyTop}>
      <div style={s.kernelBanner}>
        <span style={s.kernelCol}>
          <span style={s.kernelTitle}>{'当前内核版本'}</span>
          <code style={s.kernelVersion}>{kernel?.current ?? '未知'}</code>
        </span>
        <span style={s.kernelDot}>{'·'}</span>
        <span style={s.kernelCol}>
          <span style={s.kernelTitle}>{'来源'}</span>
          <span style={s.kernelChannel}>{kernel?.source === 'resolve' ? 'profile 解析' : kernel?.source === 'runtime' ? '运行内置' : '未知'}</span>
        </span>
      </div>

      <div style={s.tabBar}>
        {(
          [
            ['manage', '插件管理'],
            ['hotswap', '插件热插拔'],
            ['diagnose', '插件诊断'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            style={{ ...s.tabBtn, ...(tab === key ? s.tabBtnActive : {}) }}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
        <button style={s.tabClear} title="清空插件诊断/热插拔操作日志" onClick={() => { if (logs.length === 0) return; clearLogs() }}>{'⧉ 清空日志'}</button>
      </div>
      </div>

      {tab === 'manage' && (
        <div style={s.body}>
          <aside style={s.sidebar}>
            <div style={s.sidebarTitle}>
              <span>{'文件夹'}</span>
              <button style={s.iconBtn} title="新建文件夹" onClick={() => setCreating(true)}>{'+'}</button>
            </div>

            {creating && (
              <div style={s.createBox}>
                <input
                  style={s.input}
                  autoFocus
                  value={newName}
                  placeholder="文件夹名"
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void createFolder()
                  }}
                />
                <button style={s.primaryBtn} onClick={() => void createFolder()}>{'确定'}</button>
              </div>
            )}

            {folders.map((f) => (
              <FolderRow
                key={f.id}
                folder={f}
                active={active === f.id}
                hover={hoverTarget === `folder:${f.id}`}
                onSelect={() => setActive(f.id)}
                onHoverChange={(h) => setHoverTarget(h ? `folder:${f.id}` : '')}
                onDragStart={() => {
                  if (f.kind === 'custom') {
                    dragName.current = f.id
                    dragKind.current = 'folder'
                  }
                }}
                onDragEnd={() => {
                  dragName.current = ''
                  dragKind.current = ''
                  setHoverTarget('')
                  setDropPhase('')
                }}
                onDrop={(phase) => {
                  const kind = dragKind.current
                  const id = dragName.current
                  dragName.current = ''
                  dragKind.current = ''
                  setHoverTarget('')
                  setDropPhase('')
                  if (!id) return
                  if (kind === 'plugin') move(id, f.id)
                  else if (kind === 'folder' && f.kind === 'custom') reorderFolderDrop(id, f.id, phase)
                }}
                onRename={(n) => void renameFolder(f, n)}
                onDelete={() => void deleteFolder(f)}
              />
            ))}
          </aside>

          <section style={s.cards}>
            {flash && <div style={s.flash}>{flash}</div>}
            <div style={s.cardsHeader}>
              <h3 style={s.cardsTitle}>{activeFolderMeta?.name ?? '文件夹'}</h3>
              <span style={s.cardsCount}>{`${filteredPlugins.length} 个插件`}</span>
              <input
                style={s.searchBox}
                value={query}
                placeholder="搜索别名 / 插件名…"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {filteredPlugins.length === 0 ? (
              <div style={s.empty}>
                {query.trim() ? `没有匹配「${query.trim()}」的插件（匹配重命名名 / 原名）` : '此文件夹暂没有插件。拖拽左侧其它文件夹的插件卡片到这里，即可重新分类。'}
              </div>
            ) : (
              <div style={s.grid}>
                {filteredPlugins.map((p) => (
                  <PluginCard
                    key={p.name}
                    plugin={p}
                    hover={hoverTarget === `plugin:${p.name}`}
                    phase={dropPhase}
                    onHoverChange={(h) => setHoverTarget(h ? `plugin:${p.name}` : '')}
                    onPhaseChange={(ph) => setDropPhase((prev) => (prev === ph ? prev : ph))}
                    onDragStart={() => {
                      dragName.current = p.name
                      dragKind.current = 'plugin'
                    }}
                    onDragEnd={() => {
                      dragName.current = ''
                      dragKind.current = ''
                      setHoverTarget('')
                      setDropPhase('')
                    }}
                    onDropBefore={(phase) => {
                      const dragged = dragName.current
                      dragName.current = ''
                      dragKind.current = ''
                      setHoverTarget('')
                      setDropPhase('')
                      if (!dragged) return
                      if (dragged !== p.name) reorderPluginDrop(dragged, p.name, phase)
                    }}
                    onToggle={() => void toggle(p)}
                    onSaveNote={(n) => void saveNote(p, n)}
                    onRename={(alias) => void renamePlugin(p, alias)}
                    onPromote={() => void promote(p)}
                    onTempRemove={() => void tempRemove(p)}
                    onUninstall={() => void uninstall(p)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {tab === 'hotswap' && (
        <div style={s.hotswapPanel}>
          {flash && <div style={s.flash}>{flash}</div>}
          <div style={s.hotswapHead}>
            <span style={s.hotswapTitle}>{'运行时临时加载插件'}</span>
            <span style={s.hotswapHint}>{'临时插件仅当前进程有效，重启即消失；依赖会在共享 node_modules 中补装。'}</span>
          </div>

          <div style={s.tempRow}>
            <input
              style={{ ...s.input, flex: 1 }}
              value={tempInput}
              placeholder="输入插件目录路径（含 package.json 的包根目录），如 D:\\plugins\\my-plugin"
              onChange={(e) => setTempInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void tempLoad()
                if (e.key === 'Escape') setTempInput('')
              }}
            />
            <button style={s.ghostBtn} onClick={() => void startTempBrowse()} title="应用内浏览目录选择">{'浏览目录…'}</button>
            <button style={s.primaryBtn} disabled={tempBusy} onClick={() => void tempLoad()}>
              {tempBusy ? '加载中…' : '临时加载'}
            </button>
            <button style={s.reloadClientBtn} title="只刷新渲染进程，让热加载插件的 client 卡片立即显示（不重启内核）" onClick={reloadClient}>{'↻ 重载界面'}</button>
            <div
              role="switch"
              aria-checked={preflightMode === 'real-cordis'}
              style={s.preflightSwitch}
              title={preflightMode === 'real-cordis'
                ? '重载预检：实验室模式（开启）——真 cordis 门禁 + apply/渲染/数据驱动渲染全套 VM 检测，检测最全。点击关闭回默认。'
                : '重载预检：默认模式（关闭）——仅三态门禁，不深挖 apply/渲染。点击开启实验室模式（检测最全，需确认）。'}
              onClick={() => void setPreflightMode(preflightMode === 'real-cordis' ? 'three-state' : 'real-cordis')}
            >
              <span style={preflightMode === 'real-cordis' ? s.preflightSwitchTrackOn : s.preflightSwitchTrackOff}>
                <span style={preflightMode === 'real-cordis' ? s.preflightSwitchKnobOn : s.preflightSwitchKnobOff} />
              </span>
              <span style={s.preflightSwitchLabel}>
                {'实验室模式'}
                <span style={s.preflightSwitchSub}>
                  {preflightMode === 'real-cordis' ? '真 cordis 门禁·全套 VM 检测' : '三态门禁·仅门禁'}
                </span>
              </span>
            </div>
          </div>

          <div style={s.logBox}>
            <div style={s.logHead}>
              <span style={s.logTitle}>{'操作日志'}</span>
              <span style={s.logCount}>{`${logs.length} 条`}</span>
              <span style={s.logActions}>
                <button style={s.ghostBtnSm} onClick={copyLogs} title="复制整段日志到剪贴板">{'⧉ 复制日志'}</button>
                <button style={s.ghostBtnSm} onClick={() => { if (logs.length) clearLogs() }} title="清空日志">{'清空'}</button>
              </span>
            </div>
            {steps && (
              <div style={s.stepBox}>
                <div style={s.stepHead}>
                  <span style={s.stepTitle}>{steps.title}</span>
                  <span style={s.stepHint}>{`共 ${steps.plan.length} 步 · ${steps.plan.filter((p) => (steps.states[p.key]?.status ?? 'idle') === 'ok').length}/${steps.plan.length} 完成${steps.done ? ' · 已结束' : ''}`}</span>
                </div>
                <div style={s.stepList}>
                  {steps.plan.map((p) => {
                    const st = steps.states[p.key]?.status ?? 'idle'
                    const meta = steps.states[p.key]
                    const okColor = 'var(--dsw-color-success, #27ae60)'
                    const errColor = 'var(--dsw-color-error, #e74c3c)'
                    const runColor = '#3b82f6'
                    const icon = st === 'ok' ? '✓' : st === 'err' ? '✗' : st === 'running' ? '●' : '○'
                    const iconColor = st === 'ok' ? okColor : st === 'err' ? errColor : st === 'running' ? runColor : 'var(--dsw-alias-label-tertiary)'
                    return (
                      <div key={p.key} style={s.stepRow}>
                        <span style={{ ...s.stepIcon, color: iconColor, ...(st === 'running' ? s.stepIconRunning : {}) }}>{icon}</span>
                        <span style={s.stepLabel}>{p.label}</span>
                        <span style={s.stepRight}>
                          {st === 'running' && <span style={{ ...s.stepMeta, color: runColor }}>{'进行中…'}</span>}
                          {meta?.elapsed && <span style={s.stepMeta}>{meta.elapsed}</span>}
                          {meta?.note && (
                          <span style={{ ...s.stepMeta, ...s.stepNote, color: st === 'err' ? errColor : undefined }} title={meta.note}>
                            {st === 'err' ? '失败' : ''}
                          </span>
                        )}
                        </span>
                      </div>
                    )
                  })}
                </div>
                <style>{'@keyframes smStepPulse{0%,100%{opacity:0.35}50%{opacity:1}}'}</style>
              </div>
            )}
            <div style={s.logView} ref={logRef}>
              {logs.length === 0 ? (
                <span style={s.logEmpty}>{'暂无日志。进行临时加载 / 转正 / 卸载等操作后，这里会记录详细过程与耗时。'}</span>
              ) : (
                logs.map((l, i) => (
                  <div key={i} style={s.logRow}>
                    <span style={s.logTime}>{l.time}</span>
                    <span style={logStyle(l.level)}>{l.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'diagnose' && (
        <div style={s.diagnosePanel}>
          <div style={s.diagHead}>
            <div style={s.diagHeadText}>
              <span style={s.diagnoseTitle}>{'代码规范治理'}</span>
              <span style={s.diagHint}>{'只读扫描已装第三方插件的编译产物（副本库），按《DSH 插件开发质量禁做清单》8 条逐项取证；不改任何源码与装配层。'}</span>
            </div>
            <button style={s.diagRunBtn} onClick={() => void runDiagnostics()} disabled={diagBusy}>
              {diagBusy ? '体检中…' : '⛁ 一键体检'}
            </button>
          </div>

          <div style={s.diagFolderBar}>
            <span style={s.diagFolderLabel}>{'诊断范围'}</span>
            <label style={s.diagChip}>
              <input
                type="checkbox"
                checked={diagFolders.length === 0}
                onChange={() => setDiagFolders([])}
                style={s.checkbox}
              />
              <span>{'全部第三方'}</span>
            </label>
            {folders.map((f) => (
              <label key={f.id} style={s.diagChip}>
                <input
                  type="checkbox"
                  checked={diagFolders.includes(f.id)}
                  onChange={() => toggleDiagFolder(f.id)}
                  style={s.checkbox}
                />
                <span>{f.name}</span>
              </label>
            ))}
          </div>

          {diag.length === 0 ? (
            <div style={s.diagnoseEmpty}>{'尚未体检。点击「一键体检」扫描全部第三方插件副本库，这里会按插件展示治理卡：✗ 违规 / ⚠ 疑点 均带证据行号与整改建议。'}</div>
          ) : (
            <div style={s.diagSummaryBar}>
              <span style={s.diagSummaryText}>{`共体检 ${diag.length} 个插件`}</span>
              <span style={s.diagSummaryEll}>
                <span style={{ color: 'var(--dsw-color-error, #e74c3c)' }}>{`✗ 违规 ${diag.flatMap((p) => p.rules).filter((r) => r.level === 'err').length}`}</span>
                <span style={{ color: 'var(--dsw-color-warning, #f39c12)' }}>{`⚠ 疑点 ${diag.flatMap((p) => p.rules).filter((r) => r.level === 'warn').length}`}</span>
                <span style={{ color: 'var(--dsw-color-success, #27ae60)' }}>{`✓ 通过 ${diag.flatMap((p) => p.rules).filter((r) => r.level === 'ok').length}`}</span>
              </span>
              <button style={s.ghostBtnSm} onClick={copyDiagReport} title="复制全部非通过项的治理报告到剪贴板">{'⧉ 复制报告'}</button>
            </div>
          )}

          <div style={s.diagList}>
            {diag.map((p) => {
              const issues = p.rules.filter((r) => r.level !== 'ok')
              const err = p.rules.filter((r) => r.level === 'err').length
              const warn = p.rules.filter((r) => r.level === 'warn').length
              const face = err > 0 ? 'err' : warn > 0 ? 'warn' : 'ok'
              const faceColor = face === 'err' ? 'var(--dsw-color-error, #e74c3c)' : face === 'warn' ? 'var(--dsw-color-warning, #f39c12)' : 'var(--dsw-color-success, #27ae60)'
              return (
                <div key={p.name} style={{ ...s.diagCard, borderLeft: `3px solid ${faceColor}` }}>
                  <div style={s.diagCardHead}>
                    <span style={s.diagCardName}>{p.name}</span>
                    <span style={{ ...s.diagCardBadge, color: faceColor }}>{face === 'ok' ? '✓ 通过' : face === 'warn' ? '⚠ 有疑点' : '✗ 有违规'}</span>
                    {p.runtime.phase === 'failed' && <span style={{ ...s.diagCardBadge, color: 'var(--dsw-color-error, #e74c3c)' }}>{'半挂(failed)'}</span>}
                    <span style={s.diagCardMeta}>{`${p.scanned} 个文件 · 规则 ${p.rules.length} 条`}</span>
                  </div>
                  <div style={s.diagRuleList}>
                    {issues.length === 0 ? (
                      <span style={s.diagRuleDetail}>{'全部规则通过'}</span>
                    ) : (
                      issues.map((r) => (
                        <div key={r.ruleId} style={s.diagRuleRow}>
                          <span style={{ ...s.diagRuleMark, color: r.level === 'err' ? 'var(--dsw-color-error, #e74c3c)' : 'var(--dsw-color-warning, #f39c12)' }}>
                            {r.level === 'err' ? '✗' : '⚠'}
                          </span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={s.diagRuleTitle}>{`规则${r.ruleId} · ${r.title}`}</div>
                            <div style={s.diagRuleDetail}>{r.detail}</div>
                            {r.suggest && <div style={{ ...s.diagRuleDetail, color: 'var(--dsw-alias-label-tertiary)' }}>{`建议：${r.suggest}`}</div>}
                            {r.evidence.map((ev, i) => (
                              <div key={i} style={s.diagEvid} title={ev.snippet}>{
                                ev.line
                                  ? `📄 ${ev.file}:${ev.line}  ${ev.snippet}`
                                  : `📄 ${ev.snippet}`
                              }</div>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {dirPickerOpen && (
        <div style={s.modalMask} onClick={closeDirPicker}>
          <div style={s.modalPanel} onClick={(e) => e.stopPropagation()}>
            <div style={s.modalHead}>
              <span style={s.modalTitle}>{'选择要临时加载的插件目录'}</span>
              <button style={s.iconBtnSm} title="关闭" onClick={closeDirPicker}>{'✕'}</button>
            </div>
            <div style={s.tempRow}>
              <input
                style={{ ...s.input, flex: 1 }}
                value={tempInput}
                placeholder="输入盘符/绝对路径直达，如 D:\\ 或 D:\\plugins"
                onChange={(e) => setTempInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') jumpToInputPath()
                }}
              />
              <button style={s.ghostBtn} onClick={jumpToInputPath} title="跳到输入的路径浏览">{'浏览'}</button>
              <button style={s.primaryBtn} disabled={tempBusy} onClick={() => void tempLoad()} title="直接按路径临时加载插件">{'临时加载'}</button>
            </div>
            <div style={s.dirCrumbs}>
              <span
                style={{ ...s.dirCrumb, fontWeight: 600 }}
                title="回到所有盘符列表"
                onClick={() => void descend('')}
              >
                {'此电脑'}
              </span>
              {!dirLevel?.roots && dirLevel?.crumbs.slice(1).map((c, i) => (
                <span key={`${c.path}-${i}`} style={s.dirCrumb} title={c.path} onClick={() => void descend(c.path)}>
                  {' › '}
                  {c.name}
                </span>
              ))}
            </div>
            <div style={s.dirList}>
              {!dirLevel ? (
                <span style={s.empty}>{'读取目录中…'}</span>
              ) : dirLevel.entries.length === 0 ? (
                <span style={s.empty}>{'此目录没有子目录'}</span>
              ) : (
                dirLevel.entries.map((e) => (
                  <div key={e.path} style={e.hidden ? { ...s.dirRow, opacity: 0.55 } : s.dirRow} onClick={() => void descend(e.path)}>
                    <span style={s.dirName}>{e.name}</span>
                    <span style={s.tempHint}>{e.hidden ? '· 隐藏' : ''}</span>
                  </div>
                ))
              )}
            </div>
            <button
              style={{ ...s.primaryBtn, width: '100%' }}
              disabled={tempBusy}
              onClick={loadFromBrowse}
            >
              {dirLevel?.roots ? '加载当前目录' : `加载当前目录：${browsePath ?? '（尚未选择）'}`}
            </button>
          </div>
        </div>
      )}
      {riskAsk && (
        <div style={s.modalMask} onClick={() => { riskAsk.resolve(false); setRiskAsk(null) }}>
          <div style={{ ...s.modalPanel, maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
            <div style={s.modalHead}>
              <span style={s.modalTitle}>{'⚠ 重载前预检发现风险'}</span>
              <button style={s.iconBtnSm} title="取消（不重载）" onClick={() => { riskAsk.resolve(false); setRiskAsk(null) }}>{'✕'}</button>
            </div>
            <div
              style={{
                fontSize: 12,
                margin: '12px 0',
                padding: 10,
                borderRadius: 6,
                background: 'var(--dsw-alias-bg-mask)',
                color: 'var(--dsw-alias-label-secondary)',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.6,
                maxHeight: 240,
                overflow: 'auto',
              }}
            >
              {riskAsk.report}
            </div>
            <div style={s.tempRow}>
              <button style={s.ghostBtn} onClick={() => copyRiskReport(riskAsk.report)} title="复制完整预检报告到剪贴板，方便去插件处定位修改">{'⧉ 复制报告'}</button>
              <div style={{ flex: 1 }} />
              <button style={s.ghostBtn} onClick={() => { riskAsk.resolve(false); setRiskAsk(null) }}>{'取消'}</button>
              <button style={s.primaryBtn} onClick={() => { riskAsk.resolve(true); setRiskAsk(null) }} title="仍按原样刷新渲染进程，可先复制报告去修复">{'仍要重载'}</button>
            </div>
          </div>
        </div>
      )}
      {ask && (
        <div style={s.modalMask} onClick={() => ask.resolve({ ok: false, clearData: askClearData })}>
          <div style={s.modalPanel} onClick={(e) => e.stopPropagation()}>
            <div style={s.modalHead}>
              <span style={s.modalTitle}>{ask.title}</span>
              <button style={s.iconBtnSm} title="取消" onClick={() => ask.resolve({ ok: false, clearData: askClearData })}>{'✕'}</button>
            </div>
            <div style={s.modalBody}>{ask.message}</div>
            {ask.withClearData && (
              <div style={s.checkboxRow}>
                <input
                  type="checkbox"
                  checked={askClearData}
                  onChange={(e) => setAskClearData(e.target.checked)}
                  style={s.checkbox}
                />
                <span style={s.checkboxLabel}>{'同时清除该插件的本地配置与缓存（不可恢复）'}</span>
              </div>
            )}
            <div style={s.modalFooter}>
              <button style={s.ghostBtn} onClick={() => ask.resolve({ ok: false, clearData: askClearData })}>{'取消'}</button>
              <button style={{ ...s.primaryBtn, ...(ask.danger ? s.dangerBtn : {}) }} onClick={() => ask.resolve({ ok: true, clearData: askClearData })}>
                {ask.okText || '确认'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function folderOf(folders: Folder[] | undefined, id: string): Folder | undefined {
  return folders?.find((f) => f.id === id)
}

interface RootProps {
  folder: Folder
  active: boolean
  hover: boolean
  onSelect(): void
  onDrop(phase: 'before' | 'after'): void
  onHoverChange(hovering: boolean): void
  onDragStart(): void
  onDragEnd(): void
  onRename(nameText: string): void
  onDelete(): void
}

function FolderRow(p: RootProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [nameText, setNameText] = useState(p.folder.name)

  const commit = (): void => {
    setEditing(false)
    p.onRename(nameText)
  }

  return (
    <div
      style={{ ...s.folder, ...(p.active ? s.folderActive : {}), ...(p.hover ? s.folderOver : {}) }}
      draggable={p.folder.kind === 'custom'}
      onDragStart={p.onDragStart}
      onDragEnd={p.onDragEnd}
      onDragEnter={(e) => {
        if (!dragKind.current) return
        e.preventDefault()
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        dragPhase.current = e.clientY < r.top + r.height / 2 ? 'before' : 'after'
        p.onHoverChange(true)
      }}
      onDragLeave={() => p.onHoverChange(false)}
      onDragOver={(e) => {
        if (!dragKind.current) return
        e.preventDefault()
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        dragPhase.current = e.clientY < r.top + r.height / 2 ? 'before' : 'after'
      }}
      onDrop={(e) => {
        if (!dragKind.current) return
        e.preventDefault()
        p.onDrop(dragPhase.current)
      }}
      onClick={p.onSelect}
    >
      {editing ? (
        <input
          style={{ ...s.input, width: '100%', margin: 0 }}
          autoFocus
          value={nameText}
          onChange={(e) => setNameText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <span style={s.folderName} title={p.folder.name}>{p.folder.name}</span>
          {p.folder.kind === 'custom' && (
            <span style={s.folderActions}>
              <button
                style={s.iconBtnSm}
                title="重命名"
                onClick={(e) => {
                  e.stopPropagation()
                  setEditing(true)
                }}
              >
                {'✎'}
              </button>
              <button
                style={s.iconBtnSm}
                title="删除"
                onClick={(e) => {
                  e.stopPropagation()
                  p.onDelete()
                }}
              >
                {'✕'}
              </button>
            </span>
          )}
        </>
      )}
      <span style={s.folderCount}>{p.folder.count}</span>
    </div>
  )
}

interface CardProps {
  plugin: Plugin
  hover: boolean
  phase: '' | 'before' | 'after'
  onHoverChange(hovering: boolean): void
  onPhaseChange(phase: 'before' | 'after'): void
  onDragStart(): void
  onDragEnd(): void
  onDropBefore(phase: 'before' | 'after'): void
  onToggle(): void
  onSaveNote(note: string): void
  onRename(alias: string): void
  onPromote(): void
  onTempRemove(): void
  onUninstall(): void
}

function PluginCard(p: CardProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [noteText, setNoteText] = useState(p.plugin.note)
  const [renaming, setRenaming] = useState(false)
  const [aliasText, setAliasText] = useState(p.plugin.alias)
  const [showDeps, setShowDeps] = useState(false)

  const stop = (e: MouseEvent<HTMLElement>): void => e.stopPropagation()

  const commit = (): void => {
    setEditing(false)
    p.onSaveNote(noteText)
  }

  const commitAlias = (): void => {
    setRenaming(false)
    p.onRename(aliasText)
  }

  const scopeLabel = p.plugin.scope === 'official' ? '官方' : p.plugin.scope === 'shell' ? '壳' : '第三方'
  const badgeStyle =
    p.plugin.scope === 'official' ? s.badge : p.plugin.scope === 'shell' ? s.badgeShell : s.badgeThird
  const displayName = p.plugin.alias || p.plugin.name
  // 统一状态框：圆点 + 运行态文案 + 来源尾巴，颜色由运行态驱动；孤儿红色描边/尾巴隔离。
  const runtimeInfo = RUNTIME_INFO[p.plugin.runtime]
  const srcTail = SOURCE_TAIL[p.plugin.source]
  const boxStyle = p.plugin.toggleable ? s.statusBoxClick : s.statusBox
  const finalBoxStyle = p.plugin.source === 'orphan' ? { ...boxStyle, ...s.statusBoxOrphan } : boxStyle
  const dotColor = RUNTIME_COLOR[p.plugin.runtime]
  const textStyle = p.plugin.runtime === 'disabled' || p.plugin.runtime === 'none'
    ? s.statusTextNeutral : { color: dotColor }
  const srcStyle = (
    p.plugin.source === 'orphan' ? s.statusSrcOrphan
      : p.plugin.source === 'official' || p.plugin.source === 'shell' ? s.statusSrc
      : s.statusSrc)
  const clickTarget = p.plugin.toggleable
    ? (e: MouseEvent<HTMLElement>) => { stop(e); p.onToggle() }
    : undefined

  return (
    <div
      style={{ ...s.card, ...(p.hover ? s.cardOver : {}) }}
      draggable
      onDragStart={p.onDragStart}
      onDragEnd={p.onDragEnd}
      onDragEnter={(e) => {
        if (dragKind.current !== 'plugin') return
        e.preventDefault()
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const ph = e.clientX < r.left + r.width / 2 ? 'before' : 'after'
        dragPhase.current = ph
        p.onHoverChange(true)
      }}
      onDragLeave={() => {
        if (dragKind.current === 'plugin') p.onHoverChange(false)
      }}
      onDragOver={(e) => {
        if (dragKind.current !== 'plugin') return
        e.preventDefault()
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const ph = e.clientX < r.left + r.width / 2 ? 'before' : 'after'
        dragPhase.current = ph
        p.onPhaseChange(ph)
      }}
      onDrop={(e) => {
        if (dragKind.current !== 'plugin') return
        e.preventDefault()
        p.onDropBefore(dragPhase.current)
      }}
      onClick={() => setShowDeps((v) => !v)}
    >
      {p.hover && p.phase && (
        <div style={{ ...s.dropLine, ...(p.phase === 'after' ? { left: 'calc(100% - 2px)' } : { left: 0 }) }} />
      )}
      <div style={s.cardHead} onClick={stop}>
        <span style={badgeStyle}>{scopeLabel}</span>
        <span style={s.headRight}>
          {p.plugin.pendingRestart && (
            <span style={s.noteChip} title="已转正为持久安装，重启后由装配清单加载">{'转正·待重启'}</span>
          )}
          {p.plugin.toggleable ? (
            <button
              style={finalBoxStyle}
              title={p.plugin.source === 'temporary' ? '运行时临时插件（重启即消失）· 点击启停' : '点击启停'}
              onClick={clickTarget}
            >
              <span style={{ ...s.statusDot, background: dotColor }} />
              <span style={textStyle}>{runtimeInfo}</span>
              <span style={{ ...srcStyle, ...(p.plugin.source === 'orphan' ? s.statusSrcOrphan : {}) }}>
                {`· ${srcTail}`}
              </span>
            </button>
          ) : (
            <span style={finalBoxStyle}>
              <span style={{ ...s.statusDot, background: dotColor }} />
              <span style={textStyle}>{runtimeInfo}</span>
              <span style={{ ...srcStyle, ...(p.plugin.source === 'orphan' ? s.statusSrcOrphan : {}) }}>
                {`· ${srcTail}`}
              </span>
            </span>
          )}
          {p.plugin.promoteable && (
            <button style={s.promoteBtn} title="真注入：安装依赖并写入装配清单，重启后持久生效" onClick={p.onPromote}>{'转正'}</button>
          )}
          {p.plugin.tempRemoveable && (
            <button style={s.tempRemoveBtn} title="卸载临时插件（仅当前进程，不影响磁盘）" onClick={p.onTempRemove}>{'✕'}</button>
          )}
          {p.plugin.removable && (
            <button
              style={s.uninstallBtn}
              title={p.plugin.source === 'orphan' ? '清理孤儿残留（移出磁盘并注销装配）' : '真卸载：移出磁盘、注销装配并清理备注/分类'}
              onClick={(e) => {
                stop(e)
                p.onUninstall()
              }}
            >
              {p.plugin.source === 'orphan' ? '清理' : '卸载'}
            </button>
          )}
        </span>
      </div>

      {renaming ? (
        <input
          style={{ ...s.input, width: '100%' }}
          autoFocus
          value={aliasText}
          placeholder={p.plugin.name}
          onClick={stop}
          onChange={(e) => setAliasText(e.target.value)}
          onBlur={commitAlias}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitAlias()
            if (e.key === 'Escape') setRenaming(false)
          }}
        />
      ) : (
        <div style={s.cardTitleRow}>
          <div
            style={s.cardName}
            title="双击重命名"
            onDoubleClick={(e) => {
              stop(e)
              setAliasText(p.plugin.alias)
              setRenaming(true)
            }}
          >
            {displayName}
          </div>
          <span
            style={{ ...s.depsCount, color: showDeps ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-tertiary)' }}
            title={showDeps ? '收起依赖' : '点击展开查看依赖'}
            onClick={(e) => {
              stop(e)
              setShowDeps((v) => !v)
            }}
          >
            {p.plugin.dependencies.length > 0 ? `${showDeps ? '▾' : '▸'} 依赖 ${p.plugin.dependencies.length}` : '依赖 0'}
          </span>
          <button
            style={s.iconBtnSm}
            title="自定义显示名（也可双击插件名）"
            onClick={(e) => {
              stop(e)
              setAliasText(p.plugin.alias)
              setRenaming(true)
            }}
          >
            {'✎'}
          </button>
        </div>
      )}

      <div style={s.cardVersion}>{p.plugin.alias ? `${p.plugin.name} · v${p.plugin.version}` : `v${p.plugin.version}`}</div>

      <div style={s.cardMeta}>
        {p.plugin.description ? <div style={s.cardDesc}>{p.plugin.description}</div> : <div style={s.cardDescMuted}>{'（无描述）'}</div>}
      </div>

      {showDeps && (
        <div style={s.depsBox}>
          <div style={s.depsTitle}>{`声明的依赖（${p.plugin.dependencies.length}）`}</div>
          {p.plugin.dependencies.length === 0 ? (
            <div style={s.depsEmpty}>{'该插件未声明 dependencies / peerDependencies'}</div>
          ) : (
            <div style={s.depsList} onClick={(e) => e.stopPropagation()}>
              {p.plugin.dependencies.map((d) => (
                <code key={d} style={s.depsItem}>{d}</code>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={s.noteBox}>
        {editing ? (
          <textarea
            style={s.noteTextarea}
            autoFocus
            rows={2}
            value={noteText}
            placeholder="添加备注…"
            onClick={stop}
            onChange={(e) => setNoteText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              }
            }}
          />
        ) : (
          <button style={s.noteText} title="点击编辑备注" onClick={(e) => {
            stop(e)
            setEditing(true)
          }}>
            {p.plugin.note ? p.plugin.note : '＋ 添加备注'}
          </button>
        )}
      </div>
    </div>
  )
}

/** 运行态 → 文案。'none' 表示无活跃 fiber（如未装配/孤儿）。 */
const RUNTIME_INFO: Record<string, string> = {
  active: '运行中',
  disabled: '已停用',
  failed: '失败',
  pending: '待加载',
  loading: '加载中',
  disposed: '已卸载',
  unloading: '卸载中',
  none: '未装配',
}

/** 来源轴尾巴 → 文案（状态框右侧细字）。 */
const SOURCE_TAIL: Record<string, string> = {
  official: '官方内置',
  shell: '桌面壳',
  temporary: '临时',
  persistent: '持久',
  orphan: '孤儿',
}

/** 运行态 → 主色（驱动状态框圆点 + 文案；disabled/none 走中性）。 */
const RUNTIME_COLOR: Record<string, string> = {
  active: 'var(--dsw-alias-state-success-primary)',
  disabled: 'var(--dsw-alias-label-secondary)',
  failed: 'var(--dsw-alias-state-danger-primary)',
  pending: 'var(--dsw-alias-state-warning-primary)',
  loading: 'var(--dsw-alias-label-secondary)',
  disposed: 'var(--dsw-alias-label-secondary)',
  unloading: 'var(--dsw-alias-label-secondary)',
  none: 'var(--dsw-alias-label-tertiary)',
}

/** 统一徽标/状态胶囊的基础尺寸：状态框、scope 徽标、转正/✕/卸载/清理 全部对齐。 */
const pillBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 20,
  boxSizing: 'border-box',
  padding: '0 7px',
  borderRadius: 5,
  fontSize: 12,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  lineHeight: 1,
}

/** 日志级别 → 文本颜色（ok=成功 / warn=警告 / err=危险 / 其它中性）。 */
const LOG_COLOR: Record<string, string> = {
  ok: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warning-primary)',
  err: 'var(--dsw-alias-state-danger-primary)',
}

function logStyle(level: 'info' | 'ok' | 'warn' | 'err'): CSSProperties {
  return { ...s.logText, ...(LOG_COLOR[level] ? { color: LOG_COLOR[level] } : {}) }
}

const s: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, minHeight: 0 },
  center: { padding: 24, color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, },
  // 顶部三栏导航
  stickyTop: {
    position: 'sticky',
    top: 0,
    zIndex: 40,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    paddingBottom: 4,
    background: 'var(--dsw-alias-bg-layer-0)',
  },
  tabBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px',
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    boxShadow: 'var(--dsw-shadow-lv1)',
  },
  tabBtn: {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    borderRadius: 7,
    padding: '6px 16px',
    cursor: 'pointer',
    fontSize: 13, fontWeight: 500,
    transition: 'background 0.15s ease, color 0.15s ease',
  },
  tabBtnActive: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent)',
    color: 'var(--dsw-alias-state-business-primary)',
  },
  tabClear: {
    marginLeft: 'auto',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    borderRadius: 6,
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 11,
    flexShrink: 0,
  },
  // 热插拔面板
  hotswapPanel: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  hotswapHead: { display: 'flex', flexDirection: 'column', gap: 4 },
  hotswapTitle: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  hotswapHint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  // 日志区
  logBox: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flex: 1,
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    boxShadow: 'var(--dsw-shadow-lv1)',
    overflow: 'hidden',
  },
  logHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
  },
  logTitle: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  logCount: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
  logActions: { marginLeft: 'auto', display: 'flex', gap: 6 },
  ghostBtnSm: {
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    borderRadius: 6,
    height: 28,
    boxSizing: 'border-box',
    padding: '0 12px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    fontSize: 12,
    flexShrink: 0,
  },
  logView: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minHeight: 0,
    flex: 1,
    overflowY: 'auto',
    padding: '8px 12px',
    fontFamily: 'var(--ds-font-family-code)',
    fontSize: 12,
  },
  logRow: { display: 'flex', gap: 10, lineHeight: '19px' },
  logTime: { flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)' },
  logText: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  logEmpty: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '20px' },
  // 步骤骨架 + 实时跟踪
  stepBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '8px 12px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
  },
  stepHead: { display: 'flex', alignItems: 'center', gap: 8 },
  stepTitle: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  stepHint: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginLeft: 'auto' },
  stepList: { display: 'flex', flexDirection: 'column', gap: 4 },
  stepRow: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, lineHeight: '18px' },
  stepIcon: { display: 'inline-flex', width: 14, justifyContent: 'center', fontSize: 12, flexShrink: 0 },
  stepIconRunning: { animation: 'smStepPulse 1.2s ease-in-out infinite' },
  stepLabel: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
  stepRight: { marginLeft: 'auto', display: 'flex', gap: 8, flexShrink: 0 },
    stepMeta: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
    stepNote: { maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // 诊断占位
  diagnosePanel: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 240,
    padding: 24,
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    boxShadow: 'var(--dsw-shadow-lv1)',
    textAlign: 'center',
  },
  diagnoseTitle: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  diagnoseEmpty: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', maxWidth: 420 },
  diagFolderBar: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  diagFolderLabel: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', fontWeight: 500, marginRight: 2 },
  diagChip: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    borderRadius: 6,
    fontSize: 12,
    cursor: 'pointer',
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l1)',
    color: 'var(--dsw-alias-label-secondary)',
  },
  // 代码规范治理面板
  diagHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  diagHeadText: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  diagHint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', maxWidth: 560 },
  diagRunBtn: {
    padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    borderRadius: 6, whiteSpace: 'nowrap',
    color: '#fff',
    background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
    border: 'none',
  },
  diagSummaryBar: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12 },
  diagSummaryText: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
  diagSummaryEll: { display: 'flex', gap: 12 },
  diagList: { display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto', flex: 1, minHeight: 0 },
  diagCard: {
    display: 'flex', flexDirection: 'column', gap: 8, padding: 12,
    borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
  },
  diagCardHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  diagCardName: { fontSize: 13, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', fontFamily: 'monospace' },
  diagCardBadge: { fontSize: 11, fontWeight: 600 },
  diagCardMeta: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginLeft: 'auto' },
  diagRuleList: { display: 'flex', flexDirection: 'column', gap: 6 },
  diagRuleRow: { display: 'flex', gap: 8, alignItems: 'flex-start' },
  diagRuleMark: { fontSize: 13, fontWeight: 700, lineHeight: '18px', width: 14, flexShrink: 0 },
  diagRuleTitle: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  diagRuleDetail: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 },
  diagEvid: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', background: 'var(--dsw-alias-bg-layer-2)', padding: '3px 6px', borderRadius: 4, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  kernelBanner: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'nowrap',
    whiteSpace: 'nowrap',
    gap: 16,
    padding: '8px 14px',
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    boxShadow: 'var(--dsw-shadow-lv1)',
  },
  kernelCol: { display: 'flex', flexDirection: 'row', alignItems: 'baseline', gap: 6, minWidth: 0 },
  kernelDot: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 },
  kernelTitle: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' },
  kernelVersion: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' },
  kernelChannel: {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'var(--ds-font-family-code)',
    whiteSpace: 'nowrap',
  },
  body: { display: 'flex', gap: 14, minHeight: 0, flex: 1, alignItems: 'flex-start' },
  sidebar: {
    width: 196,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: 8,
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    boxShadow: 'var(--dsw-shadow-lv1)',
    // 文件夹栏跟随顶部固定：右侧插件区滚动时文件夹保持可见，便于继续把插件拖入文件夹。
    position: 'sticky',
    top: 0,
    maxHeight: 'min(52vh, 420px)',
    overflowY: 'auto',
    alignSelf: 'flex-start',
  },
  sidebarTitle: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 13, fontWeight: 500,
    padding: '4px 6px 6px',
  },
  iconBtn: {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 13, fontWeight: 500,
    cursor: 'pointer',
    width: 26,
    height: 26,
    borderRadius: 6,
  },
  iconBtnSm: {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
    padding: '0 3px',
    fontSize: 12,
  },
  createBox: { display: 'flex', gap: 6, margin: '0 2px 4px' },
  input: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: 'var(--dsw-alias-label-primary)',
    background: 'transparent',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 6,
    padding: '5px 8px',
    outline: 'none',
  },
  primaryBtn: {
    border: 'none',
    background: 'var(--dsw-alias-state-business-primary)',
    color: '#fff',
    borderRadius: 6,
    height: 28,
    boxSizing: 'border-box',
    padding: '0 14px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    fontSize: 12, fontWeight: 500,
    flexShrink: 0,
  },
  folder: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 9px',
    borderRadius: 7,
    cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 12, fontWeight: 500,
    transition: 'background 0.15s ease',
  },
  folderActive: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 13%, transparent)',
    color: 'var(--dsw-alias-state-business-primary)',
  },
  folderName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  folderActions: { display: 'flex', gap: 2 },
  folderCount: {
    fontSize: 12,
    color: 'var(--dsw-alias-label-secondary)',
    background: 'var(--dsw-alias-bg-module-platform)',
    borderRadius: 999,
    padding: '0 7px',
    flexShrink: 0,
  },
  cards: { flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, minHeight: 0 },
  cardsHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 2px',
    position: 'sticky',
    top: 0,
    zIndex: 5,
    background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent)',
    backdropFilter: 'blur(4px)',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  cardsTitle: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', margin: 0 },
  cardsCount: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
  // 改造2：拖拽悬停落点高亮（文件夹行）。
  folderOver: {
    outline: '2px solid var(--dsw-alias-state-business-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)',
  },
  // 改造3：插件搜索框（放行首宽自适应）。
  searchBox: {
    marginLeft: 'auto',
    width: 200,
    fontSize: 12,
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 6,
    padding: '4px 8px',
    outline: 'none',
  },
  tempBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    borderRadius: 9,
    background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary) 8%, transparent)',
    border: '1px dashed var(--dsw-alias-border-l2)',
  },
  tempHint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, marginLeft: 'auto', whiteSpace: 'nowrap' },
  tempRow: { display: 'flex', alignItems: 'center', gap: 8, width: '100%' },
  dirCrumbs: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 4,
    fontSize: 12,
    color: 'var(--dsw-alias-label-secondary)',
  },
  dirCrumb: {
    cursor: 'pointer',
    padding: '1px 3px',
    borderRadius: 4,
    color: 'var(--dsw-alias-state-business-primary)',
  },
  dirList: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 180, overflowY: 'auto' },
  dirRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '3px 6px',
    borderRadius: 5,
    cursor: 'pointer',
    fontSize: 13,
    border: '1px solid transparent',
  },
  dirName: { wordBreak: 'break-all' },
  ghostBtn: {
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    borderRadius: 6,
    height: 28,
    boxSizing: 'border-box',
    padding: '0 12px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    fontSize: 12,
    flexShrink: 0,
  },
  reloadClientBtn: {
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-muted)',
    color: 'var(--dsw-alias-label-primary)',
    borderRadius: 6,
    height: 28,
    boxSizing: 'border-box',
    padding: '0 12px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    fontSize: 12,
    flexShrink: 0,
  },
  preflightSwitch: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    height: 32,
    boxSizing: 'border-box',
    padding: '0 9px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-muted)',
    cursor: 'pointer',
    flexShrink: 0,
    userSelect: 'none',
  },
  preflightSwitchTrackOn: {
    position: 'relative',
    width: 26,
    height: 14,
    borderRadius: 7,
    boxSizing: 'border-box',
    flexShrink: 0,
    transition: 'background .15s ease',
    background: 'var(--dsw-alias-state-success-primary)',
  },
  preflightSwitchTrackOff: {
    position: 'relative',
    width: 26,
    height: 14,
    borderRadius: 7,
    boxSizing: 'border-box',
    flexShrink: 0,
    transition: 'background .15s ease',
    background: 'var(--dsw-alias-border-l2)',
  },
  preflightSwitchKnobOn: {
    position: 'absolute',
    top: 1,
    left: 13,
    width: 12,
    height: 12,
    borderRadius: 6,
    background: '#fff',
    boxShadow: '0 1px 2px rgba(0,0,0,.25)',
    transition: 'left .15s ease',
  },
  preflightSwitchKnobOff: {
    position: 'absolute',
    top: 1,
    left: 1,
    width: 12,
    height: 12,
    borderRadius: 6,
    background: '#fff',
    boxShadow: '0 1px 2px rgba(0,0,0,.25)',
    transition: 'left .15s ease',
  },
  preflightSwitchLabel: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    lineHeight: 1.1,
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 12,
    whiteSpace: 'nowrap',
  },
  preflightSwitchSub: {
    fontSize: 10,
    color: 'var(--dsw-alias-label-secondary)',
    whiteSpace: 'nowrap',
  },
  headRight: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  noteChip: {
    ...pillBase,
    fontFamily: 'var(--ds-font-family-code)',
    color: 'var(--dsw-alias-state-warning-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary) 14%, transparent)',
    border: '1px dashed var(--dsw-alias-state-warning-primary)',
  },
  statusBox: {
    ...pillBase,
    fontFamily: 'var(--ds-font-family-code)',
    gap: 6,
    background: 'var(--dsw-alias-bg-module-platform)',
    border: '1px solid transparent',
  },
  statusBoxClick: {
    ...pillBase,
    fontFamily: 'var(--ds-font-family-code)',
    gap: 6,
    background: 'var(--dsw-alias-bg-module-platform)',
    border: '1px solid var(--dsw-alias-border-l2)',
    cursor: 'pointer',
    transition: 'border-color 0.12s ease, box-shadow 0.12s ease',
  },
  statusBoxOrphan: {
    borderColor: 'var(--dsw-alias-state-danger-primary)',
  },
  statusDot: { width: 8, height: 8, borderRadius: 999, flexShrink: 0, display: 'inline-block' },
  statusTextNeutral: { color: 'var(--dsw-alias-label-secondary)' },
  statusSrc: { opacity: 0.6, whiteSpace: 'nowrap' },
  statusSrcOrphan: { color: 'var(--dsw-alias-state-danger-primary)', opacity: 1 },
  tempRemoveBtn: {
    ...pillBase,
    color: 'var(--dsw-alias-state-danger-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-danger-primary) 8%, transparent)',
    border: '1px solid color-mix(in srgb, var(--dsw-alias-state-danger-primary) 40%, transparent)',
    cursor: 'pointer',
  },
  promoteBtn: {
    ...pillBase,
    border: '1px solid var(--dsw-alias-state-warning-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary) 14%, transparent)',
    color: 'var(--dsw-alias-state-warning-primary)',
    cursor: 'pointer',
  },
  flash: {
    padding: '8px 12px',
    borderRadius: 7,
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)',
    color: 'var(--dsw-alias-state-success-primary)',
    fontSize: 12,
  },
  empty: { padding: 32, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(236px, 1fr))',
    gap: 12,
    minHeight: 0,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    padding: 12,
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    boxShadow: 'var(--dsw-shadow-lv1)',
    cursor: 'grab',
    position: 'relative',
  },
  // 拖拽排序插入指示条：悬停时在目标卡片左/右边缘显示 2px 竖线（改造：放宽精确落点）。
  dropLine: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    width: 2,
    zIndex: 3,
    borderRadius: 2,
    background: 'var(--dsw-alias-state-business-primary)',
  },
  // 改造2：拖拽悬停落点高亮（插件卡片）。
  cardOver: {
    outline: '2px solid var(--dsw-alias-state-business-primary)',
    boxShadow: 'var(--dsw-shadow-lv2)',
  },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  badge: {
    ...pillBase,
    fontFamily: 'var(--ds-font-family-code)',
    color: 'var(--dsw-alias-state-business-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent)',
  },
  badgeThird: {
    ...pillBase,
    fontFamily: 'var(--ds-font-family-code)',
    color: 'var(--dsw-alias-label-secondary)',
    background: 'var(--dsw-alias-bg-module-platform)',
  },
  badgeShell: {
    ...pillBase,
    fontFamily: 'var(--ds-font-family-code)',
    color: 'var(--dsw-alias-tertiary-color, var(--dsw-alias-state-warning-primary))',
    background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary) 12%, transparent)',
  },
  cardTitleRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  cardName: {
    flex: 1,
    minWidth: 0,
    fontSize: 13, fontWeight: 500,
    color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    lineHeight: '20px',
  },
  cardVersion: {
    font: 'var(--ds-font-family-code)',
    fontSize: 11,
    color: 'var(--dsw-alias-label-tertiary)',
  },
  cardMeta: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 2,
    paddingTop: 8,
    borderTop: '1px solid var(--dsw-alias-border-l2)',
  },
  depsCount: {
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    fontFamily: 'var(--ds-font-family-code)',
    userSelect: 'none',
  },
  depsBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    padding: '8px 10px',
    borderRadius: 7,
    background: 'var(--dsw-alias-bg-module-platform)',
    border: '1px solid var(--dsw-alias-border-l2)',
  },
  depsTitle: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
  depsEmpty: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', lineHeight: '15px' },
  depsList: { display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 300, overflowY: 'auto' },
  depsItem: {
    fontSize: 11,
    color: 'var(--dsw-alias-label-secondary)',
    fontFamily: 'var(--ds-font-family-code)',
    whiteSpace: 'normal',
    wordBreak: 'break-all',
    lineHeight: '15px',
  },
  uninstallBtn: {
    ...pillBase,
    border: '1px solid color-mix(in srgb, var(--dsw-alias-state-danger-primary) 45%, transparent)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-danger-primary) 14%, transparent)',
    color: 'var(--dsw-alias-state-danger-primary)',
    cursor: 'pointer',
  },
  cardDesc: {
    fontSize: 12,
    color: 'var(--dsw-alias-label-secondary)',
    minHeight: 34,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    lineHeight: '17px',
  },
  cardDescMuted: {
    fontSize: 12,
    color: 'var(--dsw-alias-label-tertiary)',
    minHeight: 34,
    lineHeight: '17px',
  },
  noteBox: { marginTop: 'auto', paddingTop: 7, borderTop: '1px solid var(--dsw-alias-border-l2)' },
  noteText: {
    width: '100%',
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 12,
    cursor: 'text',
    padding: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  noteTextarea: {
    width: '100%',
    resize: 'none',
    fontSize: 12,
    color: 'var(--dsw-alias-label-primary)',
    background: 'transparent',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 6,
    padding: '6px 8px',
    outline: 'none',
  },
  switchLabel: { display: 'inline-flex', alignItems: 'center', cursor: 'pointer' },
  checkboxHidden: { opacity: 0, position: 'absolute', width: 0, height: 0, margin: 0, pointerEvents: 'none' },
  switch: {
    width: 40,
    height: 20,
    borderRadius: 999,
    position: 'relative',
    display: 'inline-block',
    background: 'var(--dsw-alias-bg-layer-3)',
    boxShadow: 'inset 0 0 0 1px var(--dsw-alias-border-l1)',
    transition: 'background 0.2s ease',
  },
  knob: {
    position: 'absolute',
    top: 2,
    left: 2,
    width: 16,
    height: 16,
    borderRadius: 999,
    background: '#fff',
    boxShadow: 'var(--dsw-shadow-lv1)',
    transition: 'transform 0.2s ease',
  },
  // 改造1：目录选择独立弹窗。
  modalMask: {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    background: 'rgba(0,0,0,.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalPanel: {
    width: 520,
    maxWidth: '92vw',
    maxHeight: '80vh',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: 16,
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l1)',
    boxShadow: 'var(--dsw-shadow-lv2)',
  },
  modalHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  modalTitle: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  modalBody: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 },
  checkbox: { width: 14, height: 14, accentColor: 'var(--dsw-color-primary)', flexShrink: 0 },
  checkboxLabel: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.4 },
  dangerBtn: { background: 'var(--dsw-alias-state-danger-primary, #e74c3c)' },
}