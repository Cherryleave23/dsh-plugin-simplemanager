/**
 * dsh-plugin-simplemanager — 插件管家（client 面板）。
 * 注册到「设置 → 插件」的独立标签页（slot: settings.plugins.tab）。
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
  /** true = 运行时临时加载，重启即消失。 */
  temporary: boolean
}

interface Browse {
  ok: boolean
  folders: Folder[]
  plugins: Plugin[]
}

const API = '/simplemanager'

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
  // 加载态：内核数据先占位，避免整栏闪跳
  ctx.slots.inject('settings.plugins.tab', () =>
    ctx.slots.register(
      {
        name: 'settings.plugins.tab',
        id: 'simplemanager',
        order: 50,
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

function browserDragging(): boolean {
  return dragKind.current !== ''
}

function SimpleManagerTab(): JSX.Element | null {
  const [ready, setReady] = useState(false)
  const [folders, setFolders] = useState<Folder[]>([])
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [active, setActive] = useState('third')
  const [kernel, setKernel] = useState<KernelInfo | null>(null)
  const [flash, setFlash] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [tempWanted, setTempWanted] = useState(false)
  const [tempInput, setTempInput] = useState('')
  const [tempBusy, setTempBusy] = useState(false)
  const tempInputRef = useRef<HTMLInputElement>(null)
  /** 运行时临时加载的目录浏览器状态：browsePath 当前层目录；dirLevel 该层列表。 */
  const [browsePath, setBrowsePath] = useState<string | undefined>(undefined)
  const [dirLevel, setDirLevel] = useState<DirLevel | null>(null)
  /** 目录选择弹窗是否打开（改造1：从内联改为独立弹层）。 */
  const [dirPickerOpen, setDirPickerOpen] = useState(false)
  /** 插件搜索关键词（改造3：匹配重命名名 alias / 原名 name）。 */
  const [query, setQuery] = useState('')
  /** 当前拖拽悬停的落点 key（"folder:<id>" / "plugin:<name>"），用于落点高亮显示（改造2）。 */
  const [hoverTarget, setHoverTarget] = useState('')

  // 临时加载输入框：渲染后显式聚焦（部分桌面壳 webview 对 autoFocus 不可靠）；点击亦重新聚焦。
  useEffect(() => {
    if (tempWanted) tempInputRef.current?.focus()
  }, [tempWanted])

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
    if (!r.ok) return notify(r.error ?? '启停失败')
    await refresh()
    notify(r.enabled ? '已启用' + (r.hotApplied ? '' : '（重启后生效）') : '已停用' + (r.hotApplied ? '' : '（重启后生效）'))
  }

  const tempLoad = async (): Promise<void> => {
    const name = tempInput.trim()
    if (!name) return
    setTempBusy(true)
    try {
      const r = await api<{ ok: boolean; error?: string; depsApplied?: boolean; hotApplied?: boolean; pnpmReason?: string }>(
        `${API}/tempLoad`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        },
      )
      if (r.ok) {
        if (r.depsApplied) notify('依赖已装齐')
        else notify(`依赖获取失败（${r.pnpmReason ?? '未知'}）`)
        if (r.hotApplied) {
          notify('已装配并运行期启用')
          setTempInput('')
          setTempWanted(false)
        } else {
          notify('已装配，重启后由该插件生效')
          setTempInput('')
          setTempWanted(false)
        }
        await refresh()
      } else {
        notify(r.error ?? '临时加载失败')
      }
    } finally {
      setTempBusy(false)
    }
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
    if (!browsePath || dirLevel?.roots) return
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
    const r = await api<{ ok: boolean; error?: string; packageName?: string }>(`${API}/promote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.name }),
    })
    if (r.ok) {
      notify(`已转正「${r.packageName ?? p.name}」，重启后生效`)
      await refresh()
    } else {
      notify(r.error ?? '转正失败')
    }
  }

  const tempRemove = async (p: Plugin): Promise<void> => {
    if (!window.confirm(`卸载临时插件「${p.name}」？仅当前进程移除，不影响磁盘。`)) return
    const r = await api<{ ok: boolean; error?: string }>(`${API}/tempRemove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.name }),
    })
    if (r.ok) {
      notify('已卸载临时插件')
      await refresh()
    } else {
      notify(r.error ?? '卸载失败')
    }
  }

  const uninstall = async (p: Plugin): Promise<void> => {
    if (
      !window.confirm(
        `真卸载插件「${p.name}」？\n将从磁盘移除包与依赖闭包、从装配清单注销并清理备注/分类——此操作不可通过面板撤销，重启后不再装配。\n确定继续吗？`,
      )
    )
      return
    const r = await api<{ ok: boolean; error?: string; packageName?: string }>(`${API}/uninstall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.name }),
    })
    if (r.ok) {
      notify(`已卸载「${r.packageName ?? p.name}」`)
      await refresh()
    } else {
      notify(r.error ?? '卸载失败')
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

          <div style={s.tempBar}>
            {tempWanted ? (
              <>
                <div style={s.tempRow}>
                  <input
                    ref={tempInputRef}
                    style={{ ...s.input, flex: 1 }}
                    value={tempInput}
                    placeholder="插件名（已安装未装配 / cordis: 内置，或本地目录路径）"
                    onChange={(e) => setTempInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void tempLoad()
                      if (e.key === 'Escape') setTempWanted(false)
                    }}
                  />
                  <button style={s.primaryBtn} disabled={tempBusy} onClick={() => void tempLoad()}>{'临时加载'}</button>
                  <button style={s.ghostBtn} onClick={() => setTempWanted(false)}>{'取消'}</button>
                </div>
              </>
            ) : (
              <>
                <button style={s.primaryBtn} onClick={() => void startTempBrowse()}>{'+ 运行时临时加载插件'}</button>
                <button style={s.ghostBtn} onClick={() => setTempWanted(true)}>{'手动输入…'}</button>
                <button style={s.reloadClientBtn} title="只刷新渲染进程，让热加载插件的 client 卡片立即显示（不重启内核）" onClick={reloadClient}>{'↻ 重载界面'}</button>
              </>
            )}
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
              disabled={tempBusy || !browsePath || !!dirLevel?.roots}
              onClick={loadFromBrowse}
            >
              {dirLevel?.roots ? '请先进入一个盘符' : `加载当前目录：${browsePath ?? '（尚未选择）'}`}
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
          {p.plugin.temporary && (
            <span style={s.tempBadge} title="运行时临时加载，重启即消失">{'临时'}</span>
          )}
          <span style={stateStyle}>{stateInfo}</span>
          <label style={s.switchLabel} title={p.plugin.toggleable ? '点击启停' : '内置插件不可停用'}>
            <input style={s.checkboxHidden} type="checkbox" checked={p.plugin.enabled} disabled={!p.plugin.toggleable} onChange={p.onToggle} />
            <span style={{ ...s.switch, background: p.plugin.enabled ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-bg-layer-3)' }}>
              <span style={{ ...s.knob, transform: p.plugin.enabled ? 'translateX(16px)' : 'translateX(0)' }} />
            </span>
          </label>
          {p.plugin.temporary && (
            <>
              <button style={s.promoteBtn} title="真注入：安装依赖并写入装配清单，重启后持久生效" onClick={p.onPromote}>{'转正'}</button>
              <button style={s.tempRemoveBtn} title="卸载临时插件（仅当前进程，不影响磁盘）" onClick={p.onTempRemove}>{'✕'}</button>
            </>
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

      {!p.plugin.temporary && p.plugin.scope === 'third' && p.plugin.toggleable && (
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

const s: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, minHeight: 0 },
  center: { padding: 24, color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, },
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
    padding: '0 10px',
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
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 12,
    flexShrink: 0,
  },
  reloadClientBtn: {
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-muted)',
    color: 'var(--dsw-alias-label-primary)',
    borderRadius: 6,
    padding: '4px 10px',
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
    color: 'var(--dsw-alias-state-warning-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary) 14%, transparent)',
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