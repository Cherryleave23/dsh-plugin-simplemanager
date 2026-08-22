/**
 * dsh-plugin-simplemanager — 插件管家（client 面板）。
 * 注册进「设置」作为独立板块（slot: settings.section，id: simplemanager，导航名「桌面管家」）。
 * 面板内三栏：插件管理 / 插件热插拔（含可复制操作日志）/ 插件诊断（占位）。
 * 布局：左侧文件夹列表（官方内置 / 第三方插件 / 自定义），右侧插件卡片网格；
 * 支持拖拽移动分类、内联编辑备注、一键启停、运行时热插拔 / 转正 / 真卸载，点击卡片展开查看依赖。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent } from 'react'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

export const name = 'dsh-plugin-simplemanager'
export const inject = ['slots']

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
  source: 'runtime' | 'profile' | 'temp'
  enabled: boolean
  toggleable: boolean
  folder: string
  note: string
  alias: string
  /** 运行时状态：active=已活跃 / failed=启动失败 / pending=待加载 / loading=加载中 / disposed=已卸载 / unloading=卸载中 / null=无 fiber。 */
  state: 'active' | 'failed' | 'pending' | 'loading' | 'disposed' | 'unloading' | null
  /** 插件自身声明的依赖（name@range）；临时插件为本次补装的闭包依赖。点击卡片展开可见。 */
  dependencies: string[]
  /** 热插拔生命周期档位：temporary = 本会话临时加载（重启即消失）；promoted = 已转正、重启后变持久；null = 非热插拔（持久安装/官方/壳）。 */
  hot: 'temporary' | 'promoted' | null
  /** 本会话刚卸载、列表仍显示其收敛中条目的残留标记：应标为「已卸载、不可启停」，重启后自然消失。 */
  residual?: boolean
}

interface Browse {
  ok: boolean
  folders: Folder[]
  plugins: Plugin[]
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

/** 拖拽某元素到列表中的落点：返回插入后的下标。居中判定 → 插入于目标之后。 */
function dropIndex(target: number, dragged: number): number {
  return target > dragged ? target : target + 1
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
        label: () => '桌面管家',
        inject: () => ({ hooks: {} }),
      },
      SimpleManagerTab,
    ),
  )
}

/** 模块级拖拽信号（纯命令式，不参与渲染）：来源 id 与类型，供子组件 FolderRow/PluginCard 判定落点行为。 */
const dragName = { current: '' as string }
const dragKind = { current: '' as 'plugin' | 'folder' | '' }

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
  /** 插件搜索关键词（改造3：匹配重命名名 alias / 原名 name）。 */
  const [query, setQuery] = useState('')
  /** 当前拖拽悬停的落点 key（"folder:<id>" / "plugin:<name>"），用于落点高亮显示（改造2）。 */
  const [hoverTarget, setHoverTarget] = useState('')

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
    if (logs.length === 0) {
      notify('暂无日志可复制')
      return
    }
    const text = logs.map((l) => `[${l.time}] ${l.text}`).join('\n')
    const done = (): void => notify(`已复制 ${logs.length} 行日志`)
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
    notify(r.enabled ? '已启用' + (r.hotApplied ? '' : '（重启后生效）') : '已停用' + (r.hotApplied ? '' : '（重启后生效）'))
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
          notify('已装配并运行期启用')
          pushLog('ok', '已在运行期启用（无需重启）')
          setTempInput('')
        } else {
          notify('已装配，重启后由该插件生效')
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

  /** 重载 CLIENT 层：重新执行渲染进程 boot 注入，让已热装进内核 graph 的插件 client 卡片出现。内核进程与热装状态不受影响。 */
  const reloadClient = (): void => {
    if (!window.confirm('重载界面（仅刷新渲染进程，不重启内核）？\n用于让热加载插件的 client 卡片立即出现在界面中。当前会话与内核热装状态都会保留。')) return
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
    if (!window.confirm(`真注入插件「${p.name}」？\n将安装其依赖闭包并写入 profile 装配清单，重启后持久生效（本次进程结束前仍为临时）。`)) {
      return
    }
    const { data: r, runId } = await withSteps<{ ok: boolean; error?: string; packageName?: string }>('promote', '转正插件', (rid) =>
      api(`${API}/promote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.name, runId: rid }) }),
    )
    if (r.ok) {
      notify(`已转正「${r.packageName ?? p.name}」，重启后生效`)
      pushLog('ok', `已转正插件「${r.packageName ?? p.name}」，重启后生效`)
      await refresh()
    } else {
      notify(r.error ?? '转正失败')
      // 错误详情已由步骤引擎的 run.lines 记录进日志，此处仅顶部 toast 一句话提示，不重复入日志。
    }
  }

  const tempRemove = async (p: Plugin): Promise<void> => {
    if (!window.confirm(`卸载临时插件「${p.name}」？仅当前进程移除，不影响磁盘。`)) return
    const { data: r, runId } = await withSteps<{ ok: boolean; error?: string }>('tempRemove', '卸载临时插件', (rid) =>
      api(`${API}/tempRemove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.name, runId: rid }) }),
    )
    if (r.ok) {
      notify('已卸载临时插件')
      pushLog('ok', `已卸载临时插件 ${p.name}`)
      await refresh()
    } else {
      notify(r.error ?? '卸载失败')
      // 错误详情已由步骤引擎的 run.lines 记录进日志，此处仅顶部 toast 一句话提示，不重复入日志。
    }
  }

  const uninstall = async (p: Plugin): Promise<void> => {
    if (
      !window.confirm(
        `真卸载插件「${p.name}」？\n将从磁盘移除包与依赖闭包、从装配清单注销并清理备注/分类——此操作不可通过面板撤销，重启后不再装配。\n确定继续吗？`,
      )
    )
      return
    const { data: r, runId } = await withSteps<{ ok: boolean; error?: string; packageName?: string }>('uninstall', '真卸载插件', (rid) =>
      api(`${API}/uninstall`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.name, runId: rid }) }),
    )
    if (r.ok) {
      notify(`已卸载「${r.packageName ?? p.name}」`)
      pushLog('ok', `已真卸载「${r.packageName ?? p.name}」`)
      await refresh()
    } else {
      notify(r.error ?? '卸载失败')
      // 错误详情已由步骤引擎的 run.lines 记录进日志，此处仅顶部 toast 一句话提示，不重复入日志。
    }
  }

  const move = (pluginName: string, folder: string): void => {
    if (pluginName) void call('move', { id: pluginName, folder })
  }

  const reorderPlugin = (p: Plugin, dir: 'up' | 'down'): void => {
    void call('reorder', { id: p.name, folder: active, dir })
  }

  /** 插件卡片拖拽重排：在 active 文件夹内把 dragged 移入 target 位置后整体提交。 */
  const reorderPluginDrop = (dragged: string, target: string): void => {
    const from = activePlugins.findIndex((p) => p.name === dragged)
    const to = activePlugins.findIndex((p) => p.name === target)
    if (from < 0 || to < 0 || from === to) return
    const effectiveTo = dropIndex(to, from)
    const ids = activePlugins
      .map((p) => p.name)
      .filter((n) => n !== dragged)
    ids.splice(effectiveTo, 0, dragged)
    void call('reorder', { folder: active, ids })
  }

  const moveFolder = (f: Folder, dir: 'up' | 'down'): void => {
    void call('folders', { action: dir, id: f.id })
  }

  /** 文件夹行拖拽重排：在自定义文件夹序列内移动并整体提交。 */
  const reorderFolderDrop = (dragged: string, target: string): void => {
    const custom = folders.filter((f) => f.kind === 'custom')
    const ids = custom.map((f) => f.id)
    const from = ids.indexOf(dragged)
    const to = ids.indexOf(target)
    if (from < 0 || to < 0 || from === to) return
    const effectiveTo = dropIndex(to, from)
    const next = ids.splice(from, 1)[0]
    const reordered = ids
    reordered.splice(effectiveTo, 0, next)
    void call('folders', { action: 'order', ids: reordered })
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
    if (window.confirm(`删除文件夹「${f.name}」？其中的插件将移回「第三方插件」。`)) {
      if (await call('folders', { action: 'delete', id: f.id })) setActive('third')
    }
  }

  const renamePlugin = async (p: Plugin, alias: string): Promise<void> => {
    await call('rename', { id: p.name, alias })
  }

  if (!ready) return <div style={s.center}>{'加载中…'}</div>

  return (
    <div style={s.root}>
      <div style={s.kernelBanner}>
        <div style={s.kernelCol}>
          <span style={s.kernelTitle}>{'当前内核版本'}</span>
          <code style={s.kernelVersion}>{kernel?.current ?? '未知'}</code>
        </div>
        <div style={s.kernelCol}>
          <span style={s.kernelTitle}>{'来源'}</span>
          <span style={s.kernelChannel}>{kernel?.source === 'resolve' ? 'profile 解析' : kernel?.source === 'runtime' ? '运行内置' : '未知'}</span>
        </div>
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
        <button style={s.tabClear} title="清空插件诊断/热插拔操作日志" onClick={() => {
          if (logs.length === 0) return notify('暂无日志')
          clearLogs()
          notify('已清空日志')
        }}>{'⧉ 清空日志'}</button>
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
                }}
                onDrop={() => {
                  const kind = dragKind.current
                  const id = dragName.current
                  dragName.current = ''
                  dragKind.current = ''
                  setHoverTarget('')
                  if (!id) return
                  if (kind === 'plugin') move(id, f.id)
                  else if (kind === 'folder' && f.kind === 'custom') reorderFolderDrop(id, f.id)
                }}
                onRename={(n) => void renameFolder(f, n)}
                onDelete={() => void deleteFolder(f)}
                onMove={(dir) => void moveFolder(f, dir)}
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
                    onHoverChange={(h) => setHoverTarget(h ? `plugin:${p.name}` : '')}
                    onDragStart={() => {
                      dragName.current = p.name
                      dragKind.current = 'plugin'
                    }}
                    onDragEnd={() => {
                      dragName.current = ''
                      dragKind.current = ''
                      setHoverTarget('')
                    }}
                    onDropBefore={() => {
                      const dragged = dragName.current
                      dragName.current = ''
                      dragKind.current = ''
                      setHoverTarget('')
                      if (!dragged) return
                      if (dragged !== p.name) reorderPluginDrop(dragged, p.name)
                    }}
                    onToggle={() => void toggle(p)}
                    onSaveNote={(n) => void saveNote(p, n)}
                    onRename={(alias) => void renamePlugin(p, alias)}
                    onMove={(dir) => void reorderPlugin(p, dir)}
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
                if (e.key === 'Escape') setTempWanted(false)
              }}
            />
            <button style={s.ghostBtn} onClick={() => void startTempBrowse()} title="应用内浏览目录选择">{'浏览目录…'}</button>
            <button style={s.primaryBtn} disabled={tempBusy} onClick={() => void tempLoad()}>
              {tempBusy ? '加载中…' : '临时加载'}
            </button>
            <button style={s.reloadClientBtn} title="只刷新渲染进程，让热加载插件的 client 卡片立即显示（不重启内核）" onClick={reloadClient}>{'↻ 重载界面'}</button>
          </div>

          <div style={s.logBox}>
            <div style={s.logHead}>
              <span style={s.logTitle}>{'操作日志'}</span>
              <span style={s.logCount}>{`${logs.length} 条`}</span>
              <span style={s.logActions}>
                <button style={s.ghostBtnSm} onClick={copyLogs} title="复制整段日志到剪贴板">{'⧉ 复制日志'}</button>
                <button style={s.ghostBtnSm} onClick={() => { if (logs.length) { clearLogs(); notify('已清空日志') } }} title="清空日志">{'清空'}</button>
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
          <div style={s.diagnoseTitle}>{'插件诊断'}</div>
          <div style={s.diagnoseEmpty}>{'诊断功能开发中，敬请期待。后续将在此提供插件依赖闭包、路由占用、热装残留等运行期诊断。'}</div>
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
    </div>
  )
}

function folderOf(folders: Folder[], id: string): Folder | undefined {
  return folders.find((f) => f.id === id)
}

interface RootProps {
  folder: Folder
  active: boolean
  hover: boolean
  onSelect(): void
  onDrop(): void
  onHoverChange(hovering: boolean): void
  onDragStart(): void
  onDragEnd(): void
  onRename(nameText: string): void
  onDelete(): void
  onMove(dir: 'up' | 'down'): void
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
        p.onHoverChange(true)
      }}
      onDragLeave={() => p.onHoverChange(false)}
      onDragOver={(e) => {
        if (dragKind.current) e.preventDefault()
      }}
      onDrop={(e) => {
        if (!dragKind.current) return
        e.preventDefault()
        p.onDrop()
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
                title="上移"
                onClick={(e) => {
                  e.stopPropagation()
                  p.onMove('up')
                }}
              >
                {'↑'}
              </button>
              <button
                style={s.iconBtnSm}
                title="下移"
                onClick={(e) => {
                  e.stopPropagation()
                  p.onMove('down')
                }}
              >
                {'↓'}
              </button>
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
  onHoverChange(hovering: boolean): void
  onDragStart(): void
  onDragEnd(): void
  onDropBefore(): void
  onToggle(): void
  onSaveNote(note: string): void
  onRename(alias: string): void
  onMove(dir: 'up' | 'down'): void
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
  const stateInfo = STATE_INFO[p.plugin.state ?? 'none']
  const stateStyle = STATE_STYLE[p.plugin.state ?? 'none']

  return (
    <div
      style={{ ...s.card, ...(p.hover ? s.cardOver : {}) }}
      draggable
      onDragStart={p.onDragStart}
      onDragEnd={p.onDragEnd}
      onDragEnter={(e) => {
        if (dragKind.current !== 'plugin') return
        e.preventDefault()
        p.onHoverChange(true)
      }}
      onDragLeave={() => {
        if (dragKind.current === 'plugin') p.onHoverChange(false)
      }}
      onDragOver={(e) => {
        if (dragKind.current === 'plugin') e.preventDefault()
      }}
      onDrop={(e) => {
        if (dragKind.current !== 'plugin') return
        e.preventDefault()
        p.onDropBefore()
      }}
      onClick={() => setShowDeps((v) => !v)}
    >
      <div style={s.cardHead} onClick={stop}>
        <span style={badgeStyle}>{scopeLabel}</span>
        <span style={s.headRight}>
          {p.plugin.hot === 'temporary' && (
            <span style={s.tempBadge} title="运行时临时加载，重启即消失">{'临时'}</span>
          )}
          {p.plugin.hot === 'promoted' && (
            <span style={s.promotedBadge} title="已转正为持久安装，重启后装配生效">{'待重启'}</span>
          )}
          {p.plugin.residual && (
            <span style={s.residualBadge} title="本会话已卸载，装配/物理层待重启收敛；不可再无谓启停">{'已卸载'}</span>
          )}
          <span style={stateStyle}>{stateInfo}</span>
          <label style={s.switchLabel} title={p.plugin.toggleable ? '点击启停' : '内置插件不可停用'}>
            <input style={s.checkboxHidden} type="checkbox" checked={p.plugin.enabled} disabled={!p.plugin.toggleable} onChange={p.onToggle} />
            <span style={{ ...s.switch, background: p.plugin.enabled ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-bg-layer-3)' }}>
              <span style={{ ...s.knob, transform: p.plugin.enabled ? 'translateX(16px)' : 'translateX(0)' }} />
            </span>
          </label>
          {p.plugin.hot === 'temporary' && (
            <>
              <button style={s.promoteBtn} title="真注入：安装依赖并写入装配清单，重启后持久生效" onClick={p.onPromote}>{'转正'}</button>
              <button style={s.tempRemoveBtn} title="卸载临时插件（仅当前进程，不影响磁盘）" onClick={p.onTempRemove}>{'✕'}</button>
            </>
          )}
          {p.plugin.hot === 'promoted' && (
            <span style={s.promotedHint} title="重启后由装配清单持久加载；当前进程内原临时 entry 仍运行至退出">{'重启后持久生效'}</span>
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
          <span style={s.moveBtns} onClick={stop}>
            <button style={s.moveBtn} title="上移" onClick={(e) => { stop(e); p.onMove('up') }}>{'↑'}</button>
            <button style={s.moveBtn} title="下移" onClick={(e) => { stop(e); p.onMove('down') }}>{'↓'}</button>
          </span>
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

      {p.plugin.hot !== 'temporary' && !p.plugin.residual && p.plugin.scope === 'third' && p.plugin.toggleable && (
        <div style={s.cardFooter}>
          <button style={s.uninstallBtn} title="真卸载：移出磁盘、注销装配并清理备注/分类" onClick={(e) => {
            stop(e)
            p.onUninstall()
          }}>
            {'卸载'}
          </button>
        </div>
      )}
    </div>
  )
}

/** 运行时状态 → 文案。'none' 表示无活跃 fiber（如仅停用、未加载）。 */
const STATE_INFO: Record<string, string> = {
  active: '运行中',
  failed: '失败',
  pending: '待加载',
  loading: '加载中',
  disposed: '已卸载',
  unloading: '卸载中',
  none: '未加载',
}

/** 运行时状态徽标的基础样式（模块级常量，先于 STATE_STYLE 定义）。 */
const statePillBase: CSSProperties = {
  padding: '1px 7px',
  borderRadius: 5,
  fontSize: 12,
  fontWeight: 500,
  fontFamily: 'var(--ds-font-family-code)',
  whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-bg-module-platform)',
}

/** 运行时状态 → 徽标样式（色彩语义：active=成功 / failed=危险 / 其它=中性）。 */
const STATE_STYLE: Record<string, CSSProperties> = {
  active: {
    ...statePillBase,
    color: 'var(--dsw-alias-state-success-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 13%, transparent)',
  },
  failed: {
    ...statePillBase,
    color: 'var(--dsw-alias-state-danger-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-danger-primary) 13%, transparent)',
  },
  pending: statePillBase,
  loading: statePillBase,
  disposed: statePillBase,
  unloading: statePillBase,
  none: { ...statePillBase, color: 'var(--dsw-alias-label-tertiary)', background: 'transparent' },
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
  kernelBanner: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '10px 18px',
    padding: '10px 14px',
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    boxShadow: 'var(--dsw-shadow-lv1)',
  },
  kernelCol: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  kernelTitle: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, fontWeight: 500, },
  kernelVersion: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  kernelChannel: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'var(--ds-font-family-code)',
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
  moveBtns: { display: 'inline-flex', alignItems: 'center', gap: 0, flexShrink: 0, opacity: 0.7 },
  moveBtn: {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
    padding: '0 2px',
    fontSize: 12,
    lineHeight: 1,
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
  cardsHeader: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 2px' },
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
  headRight: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  tempBadge: {
    padding: '1px 6px',
    borderRadius: 5,
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--dsw-alias-state-business-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent)',
    whiteSpace: 'nowrap',
  },
  promotedBadge: {
    padding: '1px 6px',
    borderRadius: 5,
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--dsw-alias-state-warning-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary) 14%, transparent)',
    border: '1px dashed var(--dsw-alias-state-warning-primary)',
    whiteSpace: 'nowrap',
  },
  residualBadge: {
    padding: '1px 6px',
    borderRadius: 5,
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--dsw-alias-label-tertiary)',
    background: 'color-mix(in srgb, var(--dsw-alias-label-tertiary) 12%, transparent)',
    border: '1px solid transparent',
    textDecoration: 'line-through',
    whiteSpace: 'nowrap',
  },
  promotedHint: {
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--dsw-alias-state-warning-primary)',
    opacity: 0.85,
    whiteSpace: 'nowrap',
  },
  tempRemoveBtn: {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
    padding: '0 3px',
    fontSize: 12,
    lineHeight: 1,
  },
  promoteBtn: {
    border: '1px solid var(--dsw-alias-state-warning-primary)',
    background: 'transparent',
    color: 'var(--dsw-alias-state-warning-primary)',
    borderRadius: 6,
    padding: '1px 8px',
    cursor: 'pointer',
    fontSize: 11, fontWeight: 600,
    whiteSpace: 'nowrap',
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
  },
  // 改造2：拖拽悬停落点高亮（插件卡片）。
  cardOver: {
    outline: '2px solid var(--dsw-alias-state-business-primary)',
    boxShadow: 'var(--dsw-shadow-lv2)',
  },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  badge: {
    padding: '1px 7px',
    borderRadius: 5,
    color: 'var(--dsw-alias-state-business-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent)',
    fontSize: 12, fontWeight: 500,
    fontFamily: 'var(--ds-font-family-code)',
  },
  badgeThird: {
    padding: '1px 7px',
    borderRadius: 5,
    color: 'var(--dsw-alias-label-secondary)',
    background: 'var(--dsw-alias-bg-module-platform)',
    fontSize: 12, fontWeight: 500,
    fontFamily: 'var(--ds-font-family-code)',
  },
  badgeShell: {
    padding: '1px 7px',
    borderRadius: 5,
    color: 'var(--dsw-alias-tertiary-color, var(--dsw-alias-state-warning-primary))',
    background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary) 12%, transparent)',
    fontSize: 12, fontWeight: 500,
    fontFamily: 'var(--ds-font-family-code)',
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
  cardFooter: {
    display: 'flex',
    justifyContent: 'flex-end',
    paddingTop: 6,
    borderTop: '1px solid var(--dsw-alias-border-l2)',
  },
  uninstallBtn: {
    border: '1px solid color-mix(in srgb, var(--dsw-alias-state-danger-primary) 45%, transparent)',
    background: 'transparent',
    color: 'var(--dsw-alias-state-danger-primary)',
    borderRadius: 6,
    padding: '2px 10px',
    cursor: 'pointer',
    fontSize: 11, fontWeight: 600,
    whiteSpace: 'nowrap',
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
    width: 34,
    height: 18,
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
    width: 14,
    height: 14,
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
}