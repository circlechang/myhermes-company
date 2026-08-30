import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Category, ChatSession, HermesHistorySources } from '../../api/sessions'

export interface SessionGroup {
  key: string
  label: string
  items: ChatSession[]
}

const SOURCE_ORDER = ['workbench', 'studio', 'web', 'cli', 'telegram', 'discord', 'line', 'slack', 'whatsapp', 'workflow', 'group', 'cron', 'api_server']

const ts = (s: ChatSession) => Date.parse(s.last_message_at ?? s.updated_at ?? s.created_at ?? '') || 0

/** 進行中置頂 → 最後訊息時間新→舊 */
export function sortSessions(list: ChatSession[]): ChatSession[] {
  return [...list].sort((a, b) => (Number(!!b.running) - Number(!!a.running)) || ts(b) - ts(a))
}

/** 依來源分組（workbench/studio/web 合併成「工作臺」）；群組內已排序；群組依固定順序＋其餘字母序 */
export function groupSessions(list: ChatSession[], labelOf: (source: string) => string): SessionGroup[] {
  const map = new Map<string, ChatSession[]>()
  for (const s of list) {
    const src = (s.source || 'workbench').toLowerCase()
    const key = src === 'studio' || src === 'web' ? 'workbench' : src
    ;(map.get(key) ?? map.set(key, []).get(key)!).push(s)
  }
  const keys = [...map.keys()].sort((a, b) => {
    const ia = SOURCE_ORDER.indexOf(a), ib = SOURCE_ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
  })
  return keys.map((k) => ({ key: k, label: labelOf(k), items: sortSessions(map.get(k)!) }))
}

export const SOURCE_ICON: Record<string, string> = {
  workbench: '🖥', cli: '⌨️', telegram: '✈️', discord: '🎮', line: '💬', slack: '💼', whatsapp: '📱', workflow: '🔀', group: '👥', cron: '⏰', api_server: '🔌', tui: '⌨️',
}

export interface SidebarProps {
  sessions: ChatSession[]
  categories: Category[]
  activeId?: string
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (s: ChatSession) => void
  onDelete: (s: ChatSession) => void
  onArchive: (s: ChatSession, archived: boolean) => void
  onAssignCategory: (s: ChatSession, categoryId: string | null) => void
  showArchived: boolean
  onToggleArchived: () => void
  onManageCategories: () => void
  onOpenSearch: () => void
  hermes?: {
    sources?: HermesHistorySources[]
    active?: { profile: string; id: string }
    onOpenGroup: (profile: string) => void
    openProfile?: string
    children?: React.ReactNode
  }
  newDisabled?: boolean
}

export function SessionSidebar(p: SidebarProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [catFilter, setCatFilter] = useState<string>('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const catById = useMemo(() => new Map(p.categories.map((c) => [c.id, c])), [p.categories])
  const filtered = catFilter ? p.sessions.filter((s) => s.category_id === catFilter) : p.sessions
  const groups = useMemo(() => groupSessions(filtered, (k) => t(`chat.source.${k}`, { defaultValue: k })), [filtered, t])
  const toggle = (k: string) => setCollapsed((c) => ({ ...c, [k]: !c[k] }))

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="session-sidebar">
      <div className="flex items-center gap-1 px-2 pt-1">
        <div className="panel-title px-1">{t('workbench.sessions')}</div>
        <button type="button" className="btn-ghost ml-auto text-xs" onClick={p.onOpenSearch} title="Ctrl+K" aria-label={t('chat.search.open')}>🔍</button>
        <button type="button" className="btn-ghost text-xs" onClick={p.onNew} disabled={p.newDisabled}>+ {t('workbench.newSession')}</button>
      </div>
      <div className="flex items-center gap-1 px-2 pb-1 text-[11px]">
        <select className="input h-6 min-w-0 flex-1 py-0 text-[11px]" value={catFilter} onChange={(e) => setCatFilter(e.target.value)} aria-label={t('chat.category.filter')}>
          <option value="">{t('chat.category.all')}</option>
          {p.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button type="button" className="btn-ghost px-1 text-[11px]" onClick={p.onManageCategories} title={t('chat.category.manage')}>⚙</button>
        <label className="flex cursor-pointer items-center gap-1 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={p.showArchived} onChange={p.onToggleArchived} /> {t('chat.archived')}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {groups.length === 0 && <div className="p-3 text-xs text-zinc-600 dark:text-zinc-400">{t('common.empty')}</div>}
        {groups.map((g) => (
          <div key={g.key} className="mb-1" data-testid={`group-${g.key}`}>
            <button type="button" className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/60" onClick={() => toggle(g.key)} aria-expanded={!collapsed[g.key]}>
              <span className="w-3 shrink-0 text-center">{collapsed[g.key] ? '▸' : '▾'}</span>
              <span className="shrink-0" aria-hidden>{SOURCE_ICON[g.key] ?? '•'}</span>
              <span className="min-w-0 truncate">{g.label}</span>
              <span className="badge ml-auto bg-zinc-200 px-1 text-[10px] font-normal dark:bg-zinc-700">{g.items.length}</span>
            </button>
            {!collapsed[g.key] && g.items.map((s) => {
              const cat = s.category_id ? catById.get(s.category_id) : undefined
              return (
                <div
                  key={s.id}
                  className={`group relative flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-sm ${s.id === p.activeId ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'} ${s.archived ? 'opacity-60' : ''}`}
                  onClick={() => p.onSelect(s.id)}
                  data-testid="session-row"
                  data-running={s.running ? 'true' : undefined}
                >
                  {s.running && <span className="chat-spinner shrink-0 text-indigo-500" aria-label={t('workbench.running')} data-testid="running-spinner" />}
                  <span className="min-w-0 flex-1 truncate" title={s.title || undefined}>{s.title || t('workbench.untitled')}</span>
                  {cat && <span className="badge px-1 text-[10px]" style={{ background: cat.color || '#e4e4e7', color: '#111' }}>{cat.name}</span>}
                  {s.archived && <span className="shrink-0 whitespace-nowrap text-[10px] text-zinc-600 dark:text-zinc-400">{t('chat.archived')}</span>}
                  <button
                    type="button"
                    className="shrink-0 rounded px-1 text-xs text-zinc-600 dark:text-zinc-400 opacity-0 hover:text-zinc-800 group-hover:opacity-100 focus:opacity-100 dark:hover:text-zinc-100"
                    aria-label={t('chat.menu.open')}
                    onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === s.id ? null : s.id) }}
                  >⋯</button>
                  {menuFor === s.id && (
                    <div className="card absolute right-1 top-7 z-20 min-w-[10rem] py-1 text-xs shadow-lg" role="menu" onClick={(e) => e.stopPropagation()}>
                      <MenuItem onClick={() => { setMenuFor(null); p.onRename(s) }}>{t('chat.menu.rename')}</MenuItem>
                      <MenuItem onClick={() => { setMenuFor(null); p.onArchive(s, !s.archived) }}>{s.archived ? t('chat.menu.unarchive') : t('chat.menu.archive')}</MenuItem>
                      <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
                      <div className="px-3 py-0.5 text-[10px] text-zinc-600 dark:text-zinc-400">{t('chat.category.assign')}</div>
                      <MenuItem onClick={() => { setMenuFor(null); p.onAssignCategory(s, null) }}>{t('chat.category.none')}{!s.category_id && ' ✓'}</MenuItem>
                      {p.categories.map((c) => (
                        <MenuItem key={c.id} onClick={() => { setMenuFor(null); p.onAssignCategory(s, c.id) }}>{c.name}{s.category_id === c.id && ' ✓'}</MenuItem>
                      ))}
                      <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
                      <MenuItem danger onClick={() => { setMenuFor(null); p.onDelete(s) }}>{t('workbench.deleteSession')}</MenuItem>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}

        {p.hermes && (
          <div className="mt-2 border-t border-zinc-200 pt-2 dark:border-zinc-800" data-testid="group-hermes">
            <button type="button" className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/60" onClick={() => toggle('__hermes')} aria-expanded={!collapsed.__hermes}>
              <span className="w-3 shrink-0 text-center">{collapsed.__hermes ? '▸' : '▾'}</span>
              <span className="shrink-0" aria-hidden>🗄</span>
              <span className="min-w-0 truncate">{t('chat.hermes.title')}</span>
              <span className="badge ml-auto bg-amber-100 px-1 text-[10px] font-normal text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                {(p.hermes.sources ?? []).reduce((n, x) => n + x.total, 0)}
              </span>
            </button>
            {!collapsed.__hermes && (
              <div className="pl-1">
                {(p.hermes.sources ?? []).map((src) => (
                  <div key={src.profile}>
                    <button
                      type="button"
                      className={`flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800/60 ${p.hermes!.openProfile === src.profile ? 'bg-zinc-100 dark:bg-zinc-800/60' : ''}`}
                      onClick={() => p.hermes!.onOpenGroup(src.profile)}
                    >
                      <code className="min-w-0 truncate font-mono" title={src.profile}>{src.profile}</code>
                      <span className="badge ml-auto bg-zinc-200 px-1 text-[10px] dark:bg-zinc-700">{src.total}</span>
                    </button>
                    {p.hermes!.openProfile === src.profile && p.hermes!.children}
                  </div>
                ))}
                {(p.hermes.sources ?? []).length === 0 && <div className="px-2 py-1 text-[11px] text-zinc-600 dark:text-zinc-400">{t('chat.hermes.none')}</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" className={`block w-full px-3 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${danger ? 'text-rose-600 dark:text-rose-400' : ''}`} onClick={onClick}>
      {children}
    </button>
  )
}
