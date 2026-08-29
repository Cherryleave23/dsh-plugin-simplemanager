/**
 * dsh-plugin-simplemanager — 插件管家（client 面板）。
 * 注册进「设置」作为独立板块（slot: settings.section，id: simplemanager，导航名「桌面管家」）。
 * 面板内三栏：插件管理 / 插件热插拔（含可复制操作日志）/ 工具管理。
 * 布局：左侧文件夹列表（官方内置 / 第三方插件 / 自定义），右侧插件卡片网格；
 * 支持拖拽移动分类、内联编辑备注、一键启停、运行时热插拔 / 转正 / 真卸载，点击卡片展开查看依赖。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent } from 'react'
import { s, logStyle } from './client-styles'
import { FolderRow, PluginCard, folderOf, dragName, dragKind, dragPhase, browserDragging } from './client-rows'

export const name = 'dsh-plugin-simplemanager'
export const inject = ['slots']

/**
 * 本插件消费的 slots 服务最小类型面。官方真实类型是 `dsh-client-ui-renderer` 的 `SlotRegistry`，
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

export interface Folder {
  id: string
  name: string
  kind: 'official' | 'third' | 'custom'
  count: number
  /** 作用域：shared=插件管理+工具管理双边可见；tool=仅工具管理可见。 */
  scope?: 'shared' | 'tool'
}

export interface Plugin {
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

// —— 工具管理（第3栏）工具元数据：name + 启用态 + 描述 + 参数 schema（详情展开查看）——
interface ToolMeta {
  name: string
  enabled: boolean
  description: string
  /** dsh-tools JSON Schema 子集（object-root），UI 只读展示字段名/类型/必填。 */
  parameters?: { type?: string; properties?: Record<string, { type?: string; description?: string; required?: unknown }> }
}

/** 统一卡片抽象：kind='plugin' 复用插件管理插件卡；kind='toolcat' 为资源管理特有的自定义工具组卡。
 * 每张卡承载 tools，标题别名/备注由宿主同步。 */
interface ToolCatCard {
  kind: 'plugin' | 'toolcat'
  key: string
  tools: ToolMeta[]
}

/** 工具管理统一视图快照（后端 listTools / scanToolGroups 返回结构）。 */
interface ToolView {
  toolCats: Array<{ id: string; name: string; folder?: string }>
  cards: ToolCatCard[]
  unassigned: ToolMeta[]
}

/** 工具管理：本地乐观迁移——把工具从当前归属挪到目标卡/未分组，返回新视图快照（纯函数，不触发网络）。
 * 目标卡不在当前快照（罕见：本地落后）则维持原样，由后端按真实卡兜底处理。 */
function relocateTool(tv: ToolView, tool: string, toKey: string): ToolView {
  let meta: ToolMeta | undefined
  for (const c of tv.cards) {
    const f = c.tools.find((t) => t.name === tool)
    if (f) { meta = f; break }
  }
  if (!meta) meta = tv.unassigned.find((t) => t.name === tool)
  if (!meta) return tv
  const byName = (a: ToolMeta, b: ToolMeta) => a.name.localeCompare(b.name)
  const cards = tv.cards.map((c) => (c.tools.some((t) => t.name === tool) ? { ...c, tools: c.tools.filter((t) => t.name !== tool) } : c))
  const unassigned = tv.unassigned.filter((t) => t.name !== tool)
  if (!toKey) return { ...tv, cards, unassigned: [...unassigned, meta].sort(byName) }
  const target = cards.find((c) => c.key === toKey)
  if (!target) return tv
  return {
    ...tv,
    cards: cards.map((c) => (c.key === toKey ? { ...c, tools: [...c.tools, meta!].sort(byName) } : c)),
    unassigned,
  }
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
/** 当前活跃的步骤轮询 interval（单活：新操作顶掉旧的，防僵尸轮询叠加）。 */
let pollTimer: number | undefined

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  return (await res.json()) as T
}

/** 消费后端刷新信号：渲染进程存活即轮询，命中立即重载（随页面 reload 自动重建，无面板可见性依赖）。 */
function startReloadPoller(): void {
  window.setInterval(() => {
    void api<{ ok: boolean; pending: boolean }>(`${API}/reloadSignal`)
      .then((r) => {
        if (r.ok && r.pending) window.location.reload()
      })
      .catch(() => { /* 单轮失败忽略，下一轮重试 */ })
  }, 1200)
}

async function browse(): Promise<Browse> {
  return await api<Browse>(`${API}/browse`)
}

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

/** 原生目录选择（官方 directoryPicker.pick → 宿主 OS 目录对话框，直接返回选中路径）。 */
async function pickdir(): Promise<{ ok: boolean; path?: string | null; kind?: string; error?: string }> {
  return await api(`${API}/pickdir`, { method: 'POST' })
}

export function apply(ctx: AppClientContext): void {
  // 作为设置里的独立板块呈现（设置 → 桌面管家）：
  // 用官方 settings.section slot（list scope=root），在设置导航列生成独立入口，
  // 而非嵌进官方「插件」section 的 plugins.tab。id/order/label 决定导航位。
  // 模块级常驻轮询：渲染进程存活即消费后端刷新信号（不再受「插件管家面板是否打开/可见」影响）。
  // 这样 pm_reloadClient 无论何时触发、用户是否在面板上，都能在 ≤1.2s 内被消费并刷新渲染进程，
  // 让已热装的新前端代码对用户可见——这就是要的「效果」，不必依赖用户此刻正停在面板上。
  startReloadPoller()

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
  /** 顶部导航：manage=插件管理 / hotswap=插件热插拔 / toolmanage=工具管理。 */
  const [tab, setTab] = useState<'manage' | 'hotswap' | 'toolmanage'>('manage')
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
  /** 插件搜索关键词（改造3：匹配重命名名 alias / 原名 name）。 */
  const [query, setQuery] = useState('')
  /** 当前拖拽悬停的落点 key（"folder:<id>" / "plugin:<name>"），用于落点高亮显示（改造2）。 */
  const [hoverTarget, setHoverTarget] = useState('')
  /** 当前拖拽悬停的落点相位（目标中点前/后），用于插入指示条（改造：拖拽排序放宽）。 */
  const [dropPhase, setDropPhase] = useState<'before' | 'after' | ''>('')
  /** 工具管理（第3栏）：扫描分组结果 + 开关态 + 展开的插件卡牌/工具详情。 */
  // 工具管理统一视图：默认 listTools（未分组大聚合）与增强 scanToolGroups（归到插件/工具组卡）同为该结构。
  const [toolView, setToolView] = useState<ToolView | null>(null)
  const [toolScanned, setToolScanned] = useState(false)
  const [toolScanBusy, setToolScanBusy] = useState(false)
  /** 工具管理：当前展开的卡片 key（插件包名 / 工具组卡 id / '__unassigned'）。 */
  const [expandedToolCard, setExpandedToolCard] = useState('')
  /** 工具管理：工具搜索关键词（多态模糊匹配 名/描述/插件名/别名/备注）。 */
  const [toolQuery, setToolQuery] = useState('')
  /** 工具管理：当前展开详情查看的工具名（显示 description + schema）。 */
  const [expandedToolDetail, setExpandedToolDetail] = useState('')
  /** 工具管理：拖拽中的工具名。 */
  const [draggedTool, setDraggedTool] = useState('')
  /** 工具管理：拖拽 hover 落点（卡片 key）。 */
  const [toolHoverKey, setToolHoverKey] = useState('')
  /** 工具管理：正在内联改名的插件包名（空=未编辑）。与插件管理页共用 aliases，双边同步。 */
  const [toolAliasEdit, setToolAliasEdit] = useState('')
  /** 工具管理：正在内联改名的自定义工具组卡 id（空=未编辑）。 */
  const [toolCatEdit, setToolCatEdit] = useState('')
  /** 工具管理：新建自定义工具组卡输入框内容。 */
  const [toolCatDraft, setToolCatDraft] = useState('')
  /** 工具管理：新建自定义工具组卡归属的工具管理文件夹 id（空=不归入任何文件夹）。 */
  const [toolCatFolder, setToolCatFolder] = useState('')
  /** 工具管理：新建「工具管理文件夹」（scope='tool'，仅工具管理可见）输入框内容。 */
  const [toolFolderDraft, setToolFolderDraft] = useState('')
  /** 工具管理：左侧分组栏当前选中的条目 id（'__unassigned'=未分组卡；'__freecats'=独立工具组卡片；否则=文件夹 id）。
   * 选中「未分组」由 loadToolView(false) 的平铺视图承载；镜像插件管理页的左侧文件夹导航形态。 */
  const [toolActive, setToolActive] = useState('__unassigned')
  /** 工具管理：左侧分组栏是否展开「新建文件夹」输入（scope='tool'）。 */
  const [toolFolderCreating, setToolFolderCreating] = useState(false)
  /** 工具管理：扫描分组选卡面板是否打开（需求3：先勾选插件卡→再点确定→只扫这些插件）。 */
  const [scanPickOpen, setScanPickOpen] = useState(false)
  /** 工具管理：扫描选卡面板中已勾选的插件包名集合。 */
  const [scanPickSel, setScanPickSel] = useState<Set<string>>(new Set())
  /** 工具管理：拖拽中的工具卡 {key,kind}，用于「拖卡进左侧文件夹」；与插件管理拖拽同一 dragName/dragKind 语义。 */
  const draggingCardRef = useRef<{ key: string; kind: 'plugin' | 'toolcat' } | null>(null)
  /** 工具管理：拖拽工具卡悬停在左侧文件夹行时的落点高亮 id（空=无）。 */
  const [toolSideHover, setToolSideHover] = useState('')
  /** 统一确认弹窗（dsh 客户端风格卡片）：替代浏览器原生 confirm，支持可选「同时清除缓存」开关。 */
  const [ask, setAsk] = useState<AskReq | null>(null)
  const [askClearData, setAskClearData] = useState(false)

  const refresh = useCallback(async () => {
    const view = await browse()
    const kb = await api<KernelInfo>(`${API}/kernel`)
    // 摄取点形态归一化：服务端异常响应（半写状态/降级/字段缺失）不得带崩整面板（B2 类防御，
    // data-render 用异常数据形态压测的就是这里）。Array.isArray 而非 ?? —— 非数组成员同样要拦。
    setFolders(Array.isArray(view?.folders) ? view.folders : [])
    setPlugins(Array.isArray(view?.plugins) ? view.plugins : [])
    setKernel(kb)
    setReady(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

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

  const clearLogs = (): void => {
    logStore.length = 0
    try { window.sessionStorage.removeItem(LOG_STORE_KEY) } catch { /* 忽略 */ }
    stepView = null
    logSubscribe?.()
    setLogs([])
    setSteps(null)
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

  /** 工具管理：加载工具视图。scan=false 走 listTools（默认平铺，未手动归属的全进未分组卡）；
   * scan=true 走 scanToolGroups（增强：额外源码归组到插件卡）。拖动改归属后按当前模式重载以反映新归属。 */
  const loadToolView = async (scan: boolean, opts?: { silent?: boolean; plugins?: string[] }): Promise<void> => {
    setToolScanBusy(true)
    const endpoint = scan ? 'scanToolGroups' : 'listTools'
    const body = { plugins: opts?.plugins }
    try {
      const r = await api<{ ok: boolean; error?: string; toolCats: Array<{ id: string; name: string; folder?: string }>; cards: ToolCatCard[]; unassigned: ToolMeta[] }>(
        `${API}/${endpoint}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      )
      if (!r.ok) {
        notify(r.error ?? (scan ? '扫描分组失败' : '加载工具失败'))
        return
      }
      setToolView({ toolCats: r.toolCats ?? [], cards: r.cards ?? [], unassigned: r.unassigned ?? [] })
      setToolScanned(scan)
      if (!opts?.silent) {
        const pluginCards = (r.cards ?? []).filter((c) => c.kind === 'plugin').length
        pushLog(scan ? 'ok' : 'info', `工具管理：${scan ? `扫描分组完成（${pluginCards} 个插件卡）` : `已列出全部工具（${((r.cards ?? []).reduce((n, c) => n + c.tools.length, 0)) + (r.unassigned ?? []).length} 个）`}`)
      }
    } catch {
      notify(scan ? '扫描分组异常' : '加载工具异常')
    } finally {
      setToolScanBusy(false)
    }
  }

  /** 工具管理：点「扫描分组」进入就地选卡模式——下方已有的插件卡可直接点选（不再额外生成一排选卡面板）。
   * 默认预勾选全部第三方插件卡；点击卡片切换；全不勾选 = 扫描全部第三方插件。 */
  const doScan = (): void => {
    setScanPickSel(new Set(plugins.filter((p) => p.scope === 'third').map((p) => p.name)))
    setScanPickOpen(true)
    // 就地选卡要盯着「第三方插件」下的插件卡点选，镜像形态下默认停在未分组页看不到卡，先切过去。
    setToolActive('third')
  }

  /** 工具管理（就地选卡）：切换某插件卡的勾选态。 */
  const toggleScanPick = (name: string): void => {
    setScanPickSel((prev) => {
      if (prev.has(name)) {
        const next = new Set(prev)
        next.delete(name)
        return next
      }
      return new Set(prev).add(name)
    })
  }

  /** 工具管理（就地选卡）：确认扫描选中插件（仅选中集合；全不勾选=空数组=扫全部第三方）。 */
  const confirmScan = async (): Promise<void> => {
    const selected = [...scanPickSel]
    setScanPickOpen(false)
    await loadToolView(true, { plugins: selected })
  }

  /** 工具管理（就地选卡）：取消退出选卡模式，不改动任何归属。 */
  const cancelScan = (): void => {
    setScanPickOpen(false)
    setScanPickSel(new Set())
  }

  /** 新建「工具管理文件夹」（scope='tool'）：仅工具管理可见；用它与插件管理共享文件夹区分作用域。 */
  const createToolFolder = async (): Promise<void> => {
    const n = toolFolderDraft.trim()
    if (!n) return
    const r = await api<{ ok: boolean; error?: string }>(
      `${API}/folders`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', name: n, scope: 'tool' }) },
    )
    if (!r.ok) { notify(r.error ?? '新建工具管理文件夹失败'); return }
    setToolFolderDraft('')
    pushLog('ok', `已新建工具管理文件夹「${n}」（仅工具管理可见）`)
    await refresh() // folders 列表更新，工具栏按 scope 重新分组
    setToolView(null)
  }

  /** 工具管理：进 tab 默认自动平铺全部工具（不分组），无需手动点按钮。 */
  const autoLoadTools = useCallback(() => { void loadToolView(false) }, [])

  /** 工具管理：运行态 —— 进入 tab 时自动加载一次（保持最新可见工具）。 */
  useEffect(() => { if (tab === 'toolmanage') autoLoadTools() }, [tab])

  /** 工具管理：切换单个工具启用态（写 overlay 持久 + 尝试真禁注入）。 */
  const toggleTool = async (name: string, enabled: boolean): Promise<void> => {
    const r = await api<{ ok: boolean; error?: string; enabled?: boolean; applied?: boolean }>(
      `${API}/setToolEnabled`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, enabled }) },
    )
    if (!r.ok) {
      notify(r.error ?? '工具开关失败')
      return
    }
    // 本地镜像更新（单工具）。
    setToolView((prev) => (prev
      ? {
          ...prev,
          cards: prev.cards.map((c) => ({ ...c, tools: c.tools.map((t) => (t.name === name ? { ...t, enabled } : t)) })),
          unassigned: prev.unassigned.map((t) => (t.name === name ? { ...t, enabled } : t)),
        }
      : prev))
    pushLog(r.enabled ? 'ok' : 'warn', `工具 ${name} ${r.enabled ? '已启用' : '已禁用'}${r.applied ? '（已对 agent 生效）' : ''}`)
  }

  /** 工具管理：整卡片总开关（names 批量统一态）——替代「全部禁用/全部启用」按钮。 */
  const toggleCardAll = async (names: string[], enabled: boolean): Promise<void> => {
    const r = await api<{ ok: boolean; error?: string; enabled?: boolean; applied?: boolean; names?: string[] }>(
      `${API}/setToolEnabled`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names, enabled }) },
    )
    if (!r.ok) {
      notify(r.error ?? '整卡片开关失败')
      return
    }
    const set = r.names ? new Set(r.names) : new Set(names)
    setToolView((prev) => (prev
      ? {
          ...prev,
          cards: prev.cards.map((c) => ({ ...c, tools: c.tools.map((t) => (set.has(t.name) ? { ...t, enabled } : t)) })),
          unassigned: prev.unassigned.map((t) => (set.has(t.name) ? { ...t, enabled } : t)),
        }
      : prev))
    pushLog(enabled ? 'ok' : 'warn', `已统一${enabled ? '启用' : '禁用'} ${set.size} 个工具${r.applied ? '（已对 agent 生效）' : ''}`)
  }

  /** 工具管理：拖拽工具改归属（持久化 toolGroupOverrides；key 空=回未分组）。
   * 本地乐观迁移：先把工具就地在视图里挪到目标卡/未分组，再静默落库；失败回滚到真实态。 */
  const setToolGroup = (tool: string, key: string): void => {
    setToolView((prev) => (prev ? relocateTool(prev, tool, key) : prev))
    pushLog('info', `工具 ${tool} → ${key ? `卡片「${toolCardTitle(key)}」` : '未分组'}`)
    void (async () => {
      const r = await api<{ ok: boolean; error?: string }>(
        `${API}/setToolGroup`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, owner: key }) },
      )
      if (!r.ok) { notify(r.error ?? '修改归属失败'); void loadToolView(toolScanned, { silent: true }) }
    })()
  }

  /** 工具管理：新建自定义工具组卡（资源管理特有容器）。等后端返回真实 id 后本地插入新卡，免全量重拉。 */
  const addToolCat = async (name: string, folder: string): Promise<void> => {
    const n = name.trim()
    if (!n) return
    const r = await api<{ ok: boolean; error?: string; id?: string }>(
      `${API}/addToolCat`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: n, folder }) },
    )
    if (!r.ok) { notify(r.error ?? '新建工具组卡失败'); return }
    setToolCatDraft('')
    setToolCatFolder('')
    pushLog('ok', `已新建工具组卡「${n}」`)
    if (r.id) {
      setToolView((prev) => (prev
        ? {
            toolCats: [...prev.toolCats, { id: r.id!, name: n, folder: folder || undefined }],
            cards: [...prev.cards, { kind: 'toolcat', key: r.id!, tools: [] }],
            unassigned: prev.unassigned,
          }
        : prev))
    } else {
      void loadToolView(toolScanned, { silent: true })
    }
  }

  /** 工具管理：重命名自定义工具组卡。本地乐观改卡名，失败回滚。 */
  const renameToolCat = async (id: string, name: string): Promise<void> => {
    const n = name.trim()
    setToolCatEdit('')
    if (!n) return
    setToolView((prev) => (prev ? { ...prev, toolCats: prev.toolCats.map((c) => (c.id === id ? { ...c, name: n } : c)) } : prev))
    const r = await api<{ ok: boolean; error?: string }>(
      `${API}/renameToolCat`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, name: n }) },
    )
    if (!r.ok) { notify(r.error ?? '重命名失败'); void loadToolView(toolScanned, { silent: true }) }
  }

  /** 工具管理：删除自定义工具组卡（其下工具回未分组）。本地乐观迁移，失败回滚。 */
  const removeToolCat = async (id: string): Promise<void> => {
    setToolView((prev) => {
      if (!prev) return prev
      const orphan = prev.cards.find((c) => c.key === id)?.tools ?? []
      const byName = (a: ToolMeta, b: ToolMeta) => a.name.localeCompare(b.name)
      return {
        toolCats: prev.toolCats.filter((c) => c.id !== id),
        cards: prev.cards.filter((c) => c.key !== id),
        unassigned: [...prev.unassigned, ...orphan].sort(byName),
      }
    })
    const r = await api<{ ok: boolean; error?: string }>(
      `${API}/removeToolCat`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) },
    )
    if (!r.ok) { notify(r.error ?? '删除失败'); void loadToolView(toolScanned, { silent: true }) }
  }

  /** 工具管理：插件显示名（共享别名 alias || 原名）。buildView 的 plugins 已含 alias，与插件管理页同源——单边改名另一边自动同步。 */
  const displayAliasPl = (plugin: string): string => {
    const p = plugins.find((x) => x.name === plugin)
    return (p?.alias?.trim() || plugin)
  }

  /** 工具管理：卡片标题。plugin 卡用共享别名；toolcat 卡用自定义名称；关键兜底。 */
  const toolCardTitle = (key: string): string => {
    if (key === '__unassigned') return '未分组 / 未知工具'
    const cat = toolView?.toolCats.find((c) => c.id === key)
    if (cat) return cat.name
    return displayAliasPl(key)
  }

  /** 工具管理：插件卡的备注（用于搜索匹配 + 展示）。 */
  const pluginObjOf = (key: string): Plugin | undefined => plugins.find((p) => p.name === key)

  /** 工具管理：内联改名提交（复用插件管理页同源 rename 接口，双边同步 + alias 空值清除）。 */
  const saveToolAlias = async (plugin: string, alias: string): Promise<void> => {
    setToolAliasEdit('')
    const p = plugins.find((x) => x.name === plugin)
    if (!p) return
    if (alias.trim() === (p.alias ?? '').trim()) return
    await renamePlugin(p, alias.trim())
  }

  /** 工具管理搜索：多态模糊匹配 工具名 / 工具描述 / 插件原名 / 插件别名 / 插件备注 / 工具组卡名。空查询不过滤。 */
  const toolQueryMatch = (t: { name: string; description?: string }, cardKey?: string, cardKind?: string): boolean => {
    const q = toolQuery.trim().toLowerCase()
    if (!q) return true
    const cntx = cardKey ? (cardKind === 'toolcat' ? toolCardTitle(cardKey) : [
      cardKey,
      pluginObjOf(cardKey)?.alias ?? '',
      pluginObjOf(cardKey)?.note ?? '',
    ].join(' ')) : ''
    return [
      t.name,
      t.description ?? '',
      cardKey ?? '',
      cntx,
    ].some((s) => (s || '').toLowerCase().includes(q))
  }

  /** 工具管理：面板内唯一工具行渲染（拖拽/开关/详情展开），三类卡片共用。 */
  const renderToolRows = (tools: ToolMeta[], cardKey: string, cardKind: string) => {
    const shown = tools.filter((t) => toolQueryMatch(t, cardKey, cardKind))
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
        {shown.map((t) => (
          <div key={t.name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} draggable onDragStart={(e) => { e.stopPropagation(); setDraggedTool(t.name) }} onDragEnd={(e) => { e.stopPropagation(); setDraggedTool('') }}>
              <button
                role="switch"
                aria-checked={t.enabled}
                onClick={(e) => { e.stopPropagation(); void toggleTool(t.name, !t.enabled) }}
                style={t.enabled ? s.toolSwitchTrackOn : s.toolSwitchTrackOff}
              >
                <span style={t.enabled ? s.toolSwitchKnobOn : s.toolSwitchKnobOff} />
              </button>
              <span
                style={{ fontSize: 12, fontFamily: 'var(--ds-font-family-code)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', userSelect: 'none' }}
                title={t.description || t.name}
                onClick={(e) => { e.stopPropagation(); setExpandedToolDetail(expandedToolDetail === t.name ? '' : t.name) }}
              >
                {t.name}
              </span>
              <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>{'拖拽可移动归属'}</span>
            </div>
            {expandedToolDetail === t.name && (
              <div style={s.toolDetailBox}>
                {t.description ? <><b style={{ color: 'var(--dsw-alias-label-primary)' }}>{'描述'}</b>{'\n'}{t.description}</> : <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{'（无描述）'}</span>}
                {t.parameters?.properties && (
                  <>
                    {'\n\n'}<b style={{ color: 'var(--dsw-alias-label-primary)' }}>{'参数'}</b>
                    {Object.entries(t.parameters.properties).map(([k, v]) => (
                      <div key={k} style={s.toolSchemaRow}>
                        <span style={{ fontFamily: 'var(--ds-font-family-code)', color: 'var(--dsw-alias-label-primary)' }}>{k}</span>
                        <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{typeof (v as { type?: string }).type === 'string' ? (v as { type?: string }).type : ''}</span>
                        {typeof (v as { description?: string }).description === 'string' && <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{(v as { description?: string }).description}</span>}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        {shown.length === 0 && <div style={s.diagEmpty}>{'没有匹配搜索的工具'}</div>}
      </div>
    )
  }

  /** 工具管理：统一卡片（plugin / toolcat / unassigned）渲染。拖拽落点=卡片；整卡点击展开/收起。
   * scanSel 非空且 active 时进入「就地选卡」态：点击插件卡切换勾选而非展开，选中卡高亮变色。 */
  const renderToolCard = (
    cardKey: string,
    cardKind: 'plugin' | 'toolcat' | 'unassigned',
    tools: ToolMeta[],
    title: string,
    accent: 'plugin' | 'toolcat' | 'unassigned',
    opts: { saveTitle?: (t: string) => void; editing: boolean; enterEdit?: () => void; note?: string; removable?: boolean; scanSel?: { active: boolean; selected: boolean; onToggle: () => void } },
  ) => {
    const open = expandedToolCard === cardKey
    const scan = opts.scanSel
    const selected = !!(scan?.active && scan.selected)
    const disabledCount = tools.filter((t) => !t.enabled).length
    const allOn = disabledCount === 0
    const allOff = disabledCount === tools.length
    const masterNext = allOn ? false : true
    const accentColor = selected
      ? 'var(--dsw-alias-state-success-primary)'
      : accent === 'plugin'
        ? 'var(--dsw-alias-state-business-primary)'
        : accent === 'toolcat'
          ? 'var(--dsw-alias-state-warning-primary)'
          : 'var(--dsw-alias-border-l2)'
    return (
      <div
        key={cardKey}
        style={{
          ...s.diagCard,
          ...(selected ? s.toolCardSelected : {}),
          borderLeft: `3px solid ${accentColor}`,
          cursor: 'pointer',
          outline: selected
            ? `2px solid var(--dsw-alias-state-success-primary)`
            : (toolHoverKey === cardKey ? `2px solid ${accentColor}` : 'none'),
        }}
        onClick={() => { if (scan?.active) { scan.onToggle(); return } setExpandedToolCard(open ? '' : cardKey) }}
        draggable={cardKind !== 'unassigned' && !(scan?.active)}
        onDragStart={(e) => { if (cardKind !== 'unassigned' && !scan?.active) { e.stopPropagation(); draggingCardRef.current = { key: cardKey, kind: cardKind }; setToolSideHover('') } }}
        onDragEnd={() => { draggingCardRef.current = null; setToolSideHover('') }}
        onDragOver={(e) => { e.preventDefault(); if (draggedTool) setToolHoverKey(cardKey) }}
        onDragLeave={() => setToolHoverKey((h) => (h === cardKey ? '' : h))}
        onDrop={() => { if (draggedTool) { setToolHoverKey(''); void setToolGroup(draggedTool, cardKind === 'unassigned' ? '' : cardKey) } }}
      >
        <div style={s.diagCardHead}>
          {opts.editing ? (
            <input
              autoFocus
              defaultValue={title}
              style={s.toolAliasInput}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') opts.saveTitle?.((e.target as HTMLInputElement).value)
                else if (e.key === 'Escape') { opts.saveTitle?.((e.target as HTMLInputElement).value); opts.enterEdit?.() }
              }}
              onBlur={(e) => opts.saveTitle?.(e.target.value)}
            />
          ) : opts.enterEdit ? (
            <span
              style={{ ...s.diagCardName, cursor: 'text' }}
              title={opts.note ? `备注：${opts.note}\n点击改名` : '点击改名'}
              onClick={(e) => { e.stopPropagation(); opts.enterEdit?.() }}
            >
              {title}
            </span>
          ) : (
            <span style={s.diagCardName}>{title}</span>
          )}
          {selected && <span style={s.toolCardCheck}>{'✓ 已选'}</span>}
          <span style={s.diagCardBadge}>{`${tools.length} 个工具`}</span>
          {disabledCount > 0 && <span style={{ ...s.diagCardBadge, color: 'var(--dsw-alias-state-danger-primary)' }}>{`${disabledCount} 个已禁`}</span>}
          {opts.removable && (
            <button
              style={s.toolCatActionDanger}
              title="删除工具组卡（其下工具回未分组）"
              onClick={(e) => { e.stopPropagation(); void removeToolCat(cardKey) }}
            >
              {'删除'}
            </button>
          )}
          <span style={{ ...s.diagCardMeta, cursor: 'pointer', userSelect: 'none' }}>
            {open ? '▲ 收起' : '▼ 展开'}
          </span>
          <button
            role="switch"
            aria-checked={allOn}
            title={allOn ? '点击禁用全部' : '点击启用全部'}
            onClick={(e) => { e.stopPropagation(); void toggleCardAll(tools.map((t) => t.name), masterNext) }}
            style={allOn ? s.toolSwitchTrackOn : s.toolSwitchTrackOff}
          >
            <span style={allOn ? s.toolSwitchKnobOn : s.toolSwitchKnobOff} />
          </button>
        </div>
        <div style={s.diagCardMeta}>{'共 ' + tools.filter((t) => t.enabled).length + ' 个启用'}{opts.note ? ' · 备注：' + opts.note : ''}</div>
        {open && renderToolRows(tools, cardKey, cardKind)}
      </div>
    )
  }

  /** 工具管理：按插件管理的文件夹把插件卡分组（复用同一套文件夹结构，排布一致）。只在有卡时显示对应文件夹。 */
  const toolFolderOptions = folders.filter((f) => f.scope === 'tool')
  const pluginFolderBuckets = useMemo(() => {
    // 复用插件管理的文件夹结构：共享文件夹（official/third/shared，位移在插件管理中改、此处同步）在前，
    // 工具管理文件夹（scope='tool'，仅工具栏可见）在后。每个文件夹承载：插件卡（插件管理同源，按 effectiveFolder）
    // +（仅 tool 文件夹）归属于它的工具组卡。未归任何 tool 文件夹的工具组卡由「工具组卡片」区单独渲染。
    const pluginCards = toolView?.cards.filter((c) => c.kind === 'plugin') ?? []
    const pluginByFolder = new Map<string, ToolCatCard[]>()
    for (const c of pluginCards) {
      const fid = pluginObjOf(c.key)?.folder ?? 'third'
      if (!pluginByFolder.has(fid)) pluginByFolder.set(fid, [])
      pluginByFolder.get(fid)!.push(c)
    }
    const toolCats = toolView?.toolCats ?? []
    const catByFolder = (fid: string): Array<{ id: string; name: string; folder?: string }> => toolCats.filter((c) => c.folder === fid)
    const sharedOrder = folders.filter((f) => (f.scope ?? 'shared') !== 'tool').map((f) => f.id)
    const toolOrder = folders.filter((f) => f.scope === 'tool').map((f) => f.id)
    const extra = [...new Set<string>([
      ...pluginByFolder.keys(),
      ...toolCats.map((c) => c.folder ?? '').filter(Boolean),
    ])].filter((id) => !sharedOrder.includes(id) && !toolOrder.includes(id))
    const bucketIds = [...sharedOrder, ...toolOrder, ...extra]
    return bucketIds.map((fid) => {
      const f = folders.find((x) => x.id === fid)
      return {
        id: fid,
        name: f?.name ?? fid,
        scope: f?.scope ?? 'shared',
        pluginCards: pluginByFolder.get(fid) ?? [],
        toolCats: catByFolder(fid),
      }
    })
  }, [toolView, folders, plugins])

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
  /** 延后启动轮询（不与 withSteps 的同步路径耦合），每间隔拉一次快照增量更新 stepView。
   * 单活轮询：新操作顶掉旧轮询；runId 失配的旧轮询自杀清 interval——否则切换操作后旧 interval
   * 永远每 400ms 打一次 /steps 接口（僵尸轮询），多次快速操作还会叠加多个 interval。 */
  const pollSteps = (runId: string): void => {
    if (pollTimer !== undefined) window.clearInterval(pollTimer)
    const timer = window.setInterval(async () => {
      const snap = await fetchSteps(runId)
      if (!snap.ok) return
      if (snap.plan && (!stepView || stepView.runId !== runId)) {
        stepView = { runId, plan: snap.plan, states: {}, done: snap.done ?? false, title: stepView?.title ?? '操作' }
      }
      const cur = stepView
      if (!cur || cur.runId !== runId) {
        window.clearInterval(timer)
        if (pollTimer === timer) pollTimer = undefined
        return
      }
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
        if (pollTimer === timer) pollTimer = undefined
        snap.lines?.forEach((l) => pushLog(mapStepLevel(l.level), l.text))
        setSteps(cur)
      } else {
        logSubscribe?.()
        setSteps(cur)
      }
    }, 400)
    pollTimer = timer
  }

  /** 重载 CLIENT 层：仅刷新渲染进程，不重启内核，会话与热装状态保留。
   * 「插件能否干净启动」的统一判定已收敛为 pm_probe 真实探针（独立子进程实测），
   * 不再做进程内无头冒烟预检（VM 3阀门引擎已因内核破坏性改动删除，见 git 历史）。 */
  const reloadClient = async (): Promise<void> => {
    const { ok } = await askConfirm({
      title: '重载界面',
      message: '重载界面（仅刷新渲染进程，不重启内核）？\n当前会话与内核热装状态都会保留。',
      okText: '重载',
    })
    if (ok) window.location.reload()
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

  // 开启目录选择：优先应用内浏览（browse 后端，弹窗逐层走目录）；
  // 若宿主仅支持原生选择（native 后端，如本机 Windows alpha.1 → pick OS 目录对话框），
  // 自动回退到原生选择器，把选中的目录直接填进输入框。
  const startTempBrowse = async (): Promise<void> => {
    const browse = await listdir(undefined)
    if (browse.ok && browse.level) {
      setDirPickerOpen(true)
      setBrowsePath(browse.level.path)
      setDirLevel(browse.level)
      return
    }
    const picked = await pickdir()
    if (picked.ok && picked.path) {
      setTempInput(picked.path)
      notify(`已选择目录：${picked.path}`)
    } else {
      notify(picked.error ?? '当前环境不支持应用内目录浏览，且无可用的原生目录选择')
    }
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

  /** 工具管理：拖拽工具组卡进文件夹（folder=''=移出到「工具组卡片」区），重载当前视图。 */
  const moveToolCat = async (id: string, folder: string): Promise<void> => {
    const ok = await call('moveToolCat', { id, folder })
    if (ok) void loadToolView(toolScanned)
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

  // 工具管理（镜像插件管理页形态）：左侧分组栏选中条目对应的标题与计数。
  const toolActiveBucket = toolActive === '__unassigned' || toolActive === '__freecats'
    ? undefined
    : pluginFolderBuckets.find((fb) => fb.id === toolActive)
  const freeToolCats = toolView?.toolCats.filter((c) => !c.folder) ?? []
  const toolCatTools = (id: string): ToolMeta[] =>
    (toolView?.cards.find((x) => x.kind === 'toolcat' && x.key === id)?.tools) ?? []
  const activeToolTitle =
    toolActive === '__unassigned' ? '未分组 / 未知工具'
      : toolActive === '__freecats' ? '工具组卡片'
        : toolActiveBucket?.name ?? '工具分组'
  const activeToolCount =
    toolActive === '__unassigned' ? (toolView?.unassigned?.length ?? 0)
      : toolActive === '__freecats' ? freeToolCats.length
        : toolActiveBucket ? toolActiveBucket.pluginCards.length + toolActiveBucket.toolCats.length : 0

  /** 工具管理左侧分组栏的行（镜像插件管理页文件夹行）。dropId 非空=可接受卡牌拖入：
   * 插件卡 → 移动到该文件夹（move）；工具组卡 → moveToolCat 归入；'__freecats' 仅收工具组卡（移出到「工具组卡片」区）。 */
  const sideRow = (id: string, name: string, count: number, active: boolean, onClick: () => void, opts?: { deletable?: boolean; onDelete?: () => void; dropId?: string }): JSX.Element => {
    const di = opts?.dropId
    const dropHover = !!di && toolSideHover === di
    const rowStyle = active ? { ...s.folder, ...s.folderActive } : s.folder
    return (
      <div
        key={id}
        style={dropHover ? { ...rowStyle, ...s.folderDragOver } : rowStyle}
        onClick={onClick}
        onDragOver={(e) => { if (!di || !draggingCardRef.current) return; e.preventDefault(); setToolSideHover(di) }}
        onDragLeave={() => setToolSideHover((h) => (di && h === di ? '' : h))}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const c = draggingCardRef.current
          draggingCardRef.current = null
          setToolSideHover('')
          if (!c || !di) return
          if (di === '__freecats') { if (c.kind === 'toolcat') void moveToolCat(c.key, '') }
          else if (c.kind === 'toolcat') void moveToolCat(c.key, di)
          else if (c.kind === 'plugin') move(c.key, di)
        }}
      >
        <span style={s.folderName}>{name}</span>
        {opts?.deletable && opts?.onDelete && (
          <button
            style={{ ...s.toolCatActionDanger, height: 20, padding: '0 6px', border: 'none' }}
            title="删除文件夹"
            onClick={(e) => { e.stopPropagation(); opts.onDelete!() }}
          >{'⌫'}</button>
        )}
        <span style={s.folderCount}>{count}</span>
      </div>
    )
  }

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
              ['toolmanage', '工具管理'],
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
        <button style={s.tabClear} title="清空热插拔操作日志" onClick={() => { if (logs.length === 0) return; clearLogs() }}>{'⧉ 清空日志'}</button>
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

            {folders.filter((f) => (f.scope ?? 'shared') !== 'tool').map((f) => (
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
            <button style={s.reloadClientBtn} title="只刷新渲染进程，让热加载插件的 client 卡片立即显示（不重启内核）。重载前会做 client 无头冒烟预检（装配契约 + 真实 cordis 门禁）" onClick={reloadClient}>{'↻ 重载界面'}</button>
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

      {tab === 'toolmanage' && (
        <div style={s.body}>
          <aside style={s.sidebar}>
            <div style={s.sidebarTitle}>
              <span>{'工具分组'}</span>
              <button style={s.iconBtn} title="新建工具管理文件夹（仅本页可见）" onClick={() => { setToolFolderDraft(''); setToolFolderCreating((v) => !v) }}>{'+'}</button>
            </div>
            {toolFolderCreating && (
              <div style={s.createBox}>
                <input
                  style={s.input}
                  autoFocus
                  value={toolFolderDraft}
                  placeholder="文件夹名"
                  onChange={(e) => setToolFolderDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { setToolFolderCreating(false); void createToolFolder() } }}
                />
                <button style={s.primaryBtn} onClick={() => { setToolFolderCreating(false); void createToolFolder() }}>{'确定'}</button>
              </div>
            )}

            {/* 镜像插件管理页形态：左侧分组栏选中一组，右侧展示该组卡片集合 */}
            {/* __unassigned 只看聚合卡，不让卡片拖入 */}
            {sideRow('__unassigned', '未分组 / 未知工具', toolView?.unassigned?.length ?? 0, toolActive === '__unassigned', () => setToolActive('__unassigned'))}
            {pluginFolderBuckets.map((fb) => sideRow(
              fb.id,
              fb.name,
              fb.pluginCards.length + fb.toolCats.length,
              toolActive === fb.id,
              () => setToolActive(fb.id),
              { deletable: fb.scope === 'tool', onDelete: fb.scope === 'tool' ? () => { void deleteFolder({ id: fb.id, name: fb.name, kind: 'custom', scope: 'tool', count: 0 }); setToolActive('__freecats') } : undefined, dropId: fb.id },
            ))}
            {/* __freecats 接受工具组卡拖入=移出文件夹回到独立区 */}
            {sideRow('__freecats', '工具组卡片', freeToolCats.length, toolActive === '__freecats', () => setToolActive('__freecats'), { dropId: '__freecats' })}
          </aside>

          <section style={s.cards}>
            {/* 最上面一排：扫描工具单独一行，留白干净（不再混在标题/搜索里） */}
            <div style={s.scanStrip}>
              {scanPickOpen ? (
                <>
                  <span style={s.cardsCount}>{`已选 ${scanPickSel.size} 张插件卡 · 全不勾选即扫全部`}</span>
                  <span style={{ flex: 1 }} />
                  <button style={s.ghostBtnSm} onClick={cancelScan}>{'取消'}</button>
                  <button style={s.scanConfirmBtn} onClick={() => void confirmScan()} disabled={toolScanBusy}>
                    {toolScanBusy ? '扫描中…' : `确定扫描${scanPickSel.size ? ` (${scanPickSel.size})` : '全部'}`}
                  </button>
                </>
              ) : (
                <>
                  <button style={s.scanBtn} onClick={() => void (toolScanned ? (setToolActive('__unassigned'), loadToolView(false)) : doScan())} disabled={toolScanBusy}>
                    {toolScanBusy ? '加载中…' : (toolScanned ? '⛁ 回到未分组' : '⛁ 扫描分组')}
                  </button>
                  <span style={s.scanStripHint}>
                    {toolScanned
                      ? '已按插件归档：拖任意卡片到左侧文件夹可移动；拖工具行可在卡间调整归属'
                      : '扫描后按插件把内置工具归档到对应插件卡；也可直接拖卡片到左侧文件夹手动归类'}
                  </span>
                </>
              )}
            </div>

            {/* 卡片区：只留计数，文件夹名由左侧分组栏指示 */}
            <div style={s.cardsHeader}>
              <span style={s.cardsCount}>{`${activeToolCount} 张卡`}</span>
            </div>

            {toolView === null ? (
              <div style={s.empty}>{'加载工具列表…'}</div>
            ) : (
              <>
                {scanPickOpen && (
                  <div style={s.toolScanHint}>
                    <span>{'选择要扫描的插件卡：点击下方插件卡可勾选/取消，全不勾选即扫描全部第三方插件。'}</span>
                  </div>
                )}

                {toolActive === '__unassigned' && (
                  <div style={s.grid}>
                    {renderToolCard('__unassigned', 'unassigned', toolView.unassigned, '未分组 / 未知工具', 'unassigned', {
                      editing: false,
                      note: toolScanned ? '源码无法判定的工厂动态名 / 外壳打包来源不明工具' : '默认形态：未手动归属的工具都在此；点「扫描分组」按插件归档',
                    })}
                  </div>
                )}

                {toolActive === '__freecats' && (
                  <>
                    <div style={s.toolCatCreateRow}>
                      <input style={s.toolCatDraftInput} placeholder="新建工具组卡名称…" value={toolCatDraft} onChange={(e) => setToolCatDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addToolCat(toolCatDraft, '') }} />
                      <button style={s.diagRunBtn} onClick={() => void addToolCat(toolCatDraft, '')} disabled={!toolCatDraft.trim()}>{'+ 新建工具组卡'}</button>
                    </div>
                    {freeToolCats.length === 0 ? (
                      <div style={s.empty}>{'暂无独立工具组卡。上方输入框可新建；也可在左侧选中某工具文件夹后在其内新建并归入。'}</div>
                    ) : (
                      <div style={s.grid}>
                        {freeToolCats.map((c) => renderToolCard(c.id, 'toolcat', toolCatTools(c.id), toolCardTitle(c.id), 'toolcat', {
                          editing: toolCatEdit === c.id,
                          saveTitle: (t) => void renameToolCat(c.id, t),
                          enterEdit: () => setToolCatEdit(c.id),
                          removable: true,
                          note: '独立工具组卡：拖工具进来做快捷分组',
                        }))}
                      </div>
                    )}
                  </>
                )}

                {toolActiveBucket ? (
                  <>
                    {toolActiveBucket.scope === 'tool' && (
                      <div style={s.toolSectionHeader}>
                        <span style={s.toolSectionTitle}>{toolActiveBucket.name}</span>
                        <span style={s.toolSectionCount}>{'仅本页可见 · 可新建/改名/删除'}</span>
                        <span style={s.toolCatRowActions}>
                          <button style={s.toolCatAction} onClick={() => { const n = window.prompt('重命名文件夹', toolActiveBucket.name); if (n && n.trim()) void renameFolder({ id: toolActiveBucket.id, name: toolActiveBucket.name, kind: 'custom', scope: 'tool', count: 0 }, n.trim()) }}>{'改名'}</button>
                          <button style={s.toolCatActionDanger} onClick={() => { setToolActive('__freecats'); void deleteFolder({ id: toolActiveBucket.id, name: toolActiveBucket.name, kind: 'custom', scope: 'tool', count: 0 }) }}>{'删除'}</button>
                        </span>
                      </div>
                    )}
                    <div style={s.toolCatCreateRow}>
                      <input style={s.toolCatDraftInput} placeholder={`新建工具组卡（归入「${toolActiveBucket.name}」）…`} value={toolCatDraft} onChange={(e) => setToolCatDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addToolCat(toolCatDraft, toolActiveBucket.id) }} />
                      <button style={s.diagRunBtn} onClick={() => void addToolCat(toolCatDraft, toolActiveBucket.id)} disabled={!toolCatDraft.trim()}>{'+ 新建'}</button>
                    </div>
                    {toolActiveBucket.pluginCards.length === 0 && toolActiveBucket.toolCats.length === 0 ? (
                      <div style={s.empty}>
                        {toolActiveBucket.scope === 'tool'
                          ? '此工具管理文件夹暂空。上方输入框可新建工具组卡归入；或从「未分组」把工具卡拖进来。'
                          : `${toolActiveBucket.name} 暂无工具卡片。若插件在运行，可在上方点「扫描分组」把工具按插件归档到这里。`}
                      </div>
                    ) : (
                      <div style={s.grid}>
                        {toolActiveBucket.pluginCards.map((c) => {
                          const pl = pluginObjOf(c.key)
                          return renderToolCard(c.key, 'plugin', c.tools, displayAliasPl(c.key), 'plugin', {
                            editing: toolAliasEdit === c.key,
                            saveTitle: (t) => void saveToolAlias(c.key, t),
                            enterEdit: () => setToolAliasEdit(c.key),
                            note: pl?.note?.trim() || '',
                            scanSel: scanPickOpen ? { active: true, selected: scanPickSel.has(c.key), onToggle: () => toggleScanPick(c.key) } : undefined,
                          })
                        })}
                        {toolActiveBucket.toolCats.map((c) => renderToolCard(c.id, 'toolcat', toolCatTools(c.id), toolCardTitle(c.id), 'toolcat', {
                          editing: toolCatEdit === c.id,
                          saveTitle: (t) => void renameToolCat(c.id, t),
                          enterEdit: () => setToolCatEdit(c.id),
                          removable: true,
                          note: '工具组卡：拖工具进来做快捷分组',
                        }))}
                      </div>
                    )}
                  </>
                ) : null}
              </>
            )}
          </section>
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

