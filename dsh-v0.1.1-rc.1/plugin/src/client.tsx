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
  source: 'runtime' | 'profile'
  enabled: boolean
  toggleable: boolean
  folder: string
  note: string
  alias: string
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

  return (
    <div style={s.card} draggable onDragStart={p.onDragStart}>
      <div style={s.cardHead}>
        <span style={badgeStyle}>{scopeLabel}</span>
        <label style={s.switchLabel} title={p.plugin.toggleable ? '点击启停' : '内置插件不可停用'}>
          <input style={s.checkboxHidden} type="checkbox" checked={p.plugin.enabled} disabled={!p.plugin.toggleable} onChange={p.onToggle} />
          <span style={{ ...s.switch, background: p.plugin.enabled ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-bg-layer-3)' }}>
            <span style={{ ...s.knob, transform: p.plugin.enabled ? 'translateX(16px)' : 'translateX(0)' }} />
          </span>
        </label>
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