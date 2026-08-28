// FolderRow / PluginCard 展示组件 + 模块级拖拽信号（P2 拆分自 client.tsx）。
import { useState } from 'react'
import type { CSSProperties, MouseEvent } from 'react'
import type { Folder, Plugin } from './client'
import { s } from './client-styles'

/** 模块级拖拽信号（纯命令式，不参与渲染）：来源 id 与类型，供子组件 FolderRow/PluginCard 判定落点行为。 */
export const dragName = { current: '' as string }
export const dragKind = { current: '' as 'plugin' | 'folder' | '' }
/** 拖拽悬停目标上的落点相位：目标中点前半=插入到其前，后半=插入到其后。 */
export const dragPhase = { current: 'before' as 'before' | 'after' }

export function browserDragging(): boolean {
  return dragKind.current !== ''
}

export function folderOf(folders: Folder[] | undefined, id: string): Folder | undefined {
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

export function FolderRow(p: RootProps): JSX.Element {
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

export function PluginCard(p: CardProps): JSX.Element {
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


