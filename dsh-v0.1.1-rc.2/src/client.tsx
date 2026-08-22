/**
 * dsh-plugin-simplemanager — 插件管家（client 面板）。
 * 注册到「设置 → 插件」的独立标签页（slot: settings.plugins.tab）。
 * 布局：左侧文件夹列表（官方内置 / 第三方插件 / 自定义），右侧插件卡片网格；
 * 支持拖拽移动分类、内联编辑备注、一键启停、内核更新检测。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
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
  /** 稳定线最新（npm latest dist-tag） */
  latest: string | null
  /** 官方预发布线（@next dist-tag） */
  next: string | null
  updatable: boolean
  updatableNext: boolean
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
  const dragName = useRef('')

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
      const r = await api<{ ok: boolean; error?: string; depsApplied?: boolean; pnpmReason?: string }>(`${API}/tempLoad`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (r.ok) {
        if (r.depsApplied) notify('已临时加载（依赖已装齐），重启后自动消失')
        else notify(`已临时加载，但依赖获取失败（${r.pnpmReason ?? '未知'}）`)
        setTempInput('')
        setTempWanted(false)
        await refresh()
      } else {
        notify(r.error ?? '临时加载失败')
      }
    } finally {
      setTempBusy(false)
    }
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

  const move = (pluginName: string, folder: string): void => {
    if (pluginName) void call('move', { id: pluginName, folder })
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
          <span style={s.kernelTitle}>{'当前内核'}</span>
          <code style={s.kernelVersion}>{kernel?.current ?? '未知'}</code>
        </div>
        <div style={s.kernelCol}>
          <span style={s.kernelTitle}>{'稳定线'}</span>
          <div style={s.kernelValue}>
            <span style={s.kernelChannel}>{kernel?.latest ?? '—'}</span>
            {kernel?.latest ? (
              kernel.updatable ? (
                <span style={s.chipUpdatable}>{'可更新'}</span>
              ) : (
                <span style={s.chipLatest}>{'已最新'}</span>
              )
            ) : (
              <span style={s.chipUnknown}>{'获取失败'}</span>
            )}
          </div>
        </div>
        <div style={s.kernelCol}>
          <span style={s.kernelTitle}>{'next 预发布'}</span>
          <div style={s.kernelValue}>
            <span style={s.kernelChannel}>{kernel?.next ?? '—'}</span>
            {kernel?.next ? (
              kernel.updatableNext ? (
                <span style={s.chipUpdatable}>{'可更新'}</span>
              ) : (
                <span style={s.chipLatest}>{'已最新'}</span>
              )
            ) : (
              <span style={s.chipUnknown}>{'获取失败'}</span>
            )}
          </div>
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
              onSelect={() => setActive(f.id)}
              onDrop={() => {
                const n = dragName.current
                dragName.current = ''
                if (n) move(n, f.id)
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
            <span style={s.cardsCount}>{`${activePlugins.length} 个插件`}</span>
          </div>

          <div style={s.tempBar}>
            {tempWanted ? (
              <>
                <input
                  style={{ ...s.input, flex: 1 }}
                  autoFocus
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
                <span style={s.tempHint}>{'仅当前进程生效，重启即消失'}</span>
              </>
            ) : (
              <button style={s.ghostBtn} onClick={() => setTempWanted(true)}>{'+ 运行时临时加载插件'}</button>
            )}
          </div>

          {activePlugins.length === 0 ? (
            <div style={s.empty}>{'此文件夹暂没有插件。拖拽左侧其它文件夹的插件卡片到这里，即可重新分类。'}</div>
          ) : (
            <div style={s.grid}>
              {activePlugins.map((p) => (
                <PluginCard
                  key={p.name}
                  plugin={p}
                  onDragStart={() => (dragName.current = p.name)}
                  onToggle={() => void toggle(p)}
                  onSaveNote={(n) => void saveNote(p, n)}
                  onRename={(alias) => void renamePlugin(p, alias)}
                  onPromote={() => void promote(p)}
                  onTempRemove={() => void tempRemove(p)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function folderOf(folders: Folder[], id: string): Folder | undefined {
  return folders.find((f) => f.id === id)
}

interface RootProps {
  folder: Folder
  active: boolean
  onSelect(): void
  onDrop(): void
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
      style={{ ...s.folder, ...(p.active ? s.folderActive : {}) }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
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
  onDragStart(): void
  onToggle(): void
  onSaveNote(note: string): void
  onRename(alias: string): void
  onPromote(): void
  onTempRemove(): void
}

function PluginCard(p: CardProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [noteText, setNoteText] = useState(p.plugin.note)
  const [renaming, setRenaming] = useState(false)
  const [aliasText, setAliasText] = useState(p.plugin.alias)

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
    <div style={s.card} draggable onDragStart={p.onDragStart}>
      <div style={s.cardHead}>
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
          onChange={(e) => setAliasText(e.target.value)}
          onBlur={commitAlias}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitAlias()
            if (e.key === 'Escape') setRenaming(false)
          }}
        />
      ) : (
        <div style={s.cardTitleRow}>
          <div style={s.cardName} title={p.plugin.name}>{displayName}</div>
          <button
            style={s.iconBtnSm}
            title="自定义显示名"
            onClick={() => {
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

      <div style={s.noteBox}>
        {editing ? (
          <textarea
            style={s.noteTextarea}
            autoFocus
            rows={2}
            value={noteText}
            placeholder="添加备注…"
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
          <button style={s.noteText} title="点击编辑备注" onClick={() => setEditing(true)}>
            {p.plugin.note ? p.plugin.note : '＋ 添加备注'}
          </button>
        )}
      </div>
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
  kernelValue: { display: 'flex', alignItems: 'center', gap: 8 },
  kernelTitle: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, fontWeight: 500, },
  kernelVersion: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  kernelChannel: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'var(--ds-font-family-code)',
  },
  chipUpdatable: {
    padding: '1px 8px',
    borderRadius: 6,
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)',
    color: 'var(--dsw-alias-state-success-primary)',
    fontSize: 12, fontWeight: 500,
    whiteSpace: 'nowrap',
  },
  chipLatest: {
    padding: '1px 8px',
    borderRadius: 6,
    background: 'color-mix(in srgb, var(--dsw-alias-label-tertiary) 13%, transparent)',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 12,
    whiteSpace: 'nowrap',
  },
  chipUnknown: {
    padding: '1px 8px',
    borderRadius: 6,
    background: 'var(--dsw-alias-bg-module-platform)',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 12,
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
}