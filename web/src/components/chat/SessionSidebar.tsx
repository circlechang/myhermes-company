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

/** 時間分桶的桶別。順序就是顯示順序。 */
export const TIME_BUCKETS = ['today', 'yesterday', 'week', 'older'] as const
export type TimeBucket = (typeof TIME_BUCKETS)[number]

export interface TimeSection {
  key: TimeBucket
  items: ChatSession[]
}

/** 以「本地日曆日」而不是「距今 24 小時」分桶——使用者說的今天是日曆上的今天。 */
export function bucketOf(when: number, now: number = Date.now()): TimeBucket {
  if (!when) return 'older'
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const day = 86_400_000
  if (when >= startOfToday.getTime()) return 'today'
  if (when >= startOfToday.getTime() - day) return 'yesterday'
  if (when >= startOfToday.getTime() - 6 * day) return 'week'
  return 'older'
}

/** 把已排序的清單切成時間區段；空的桶不產生標頭。進行中的對話一律留在最前面的桶。 */
export function sectionsOf(list: ChatSession[], now: number = Date.now()): TimeSection[] {
  const map = new Map<TimeBucket, ChatSession[]>()
  for (const s of list) {
    const b = s.running ? 'today' : bucketOf(ts(s), now)
    ;(map.get(b) ?? map.set(b, []).get(b)!).push(s)
  }
  return TIME_BUCKETS.filter((b) => map.has(b)).map((b) => ({ key: b, items: map.get(b)! }))
}

/** 側欄右側的時間戳：今天給時刻、一週內給星期、更早給日期。年份只在跨年時出現。 */
export function shortTime(when: number, locale: string, now: number = Date.now()): string {
  if (!when) return ''
  const d = new Date(when)
  const b = bucketOf(when, now)
  if (b === 'today') return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
  if (b === 'yesterday') return ''
  if (b === 'week') return d.toLocaleDateString(locale, { weekday: 'short' })
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(locale, sameYear ? { month: '2-digit', day: '2-digit' } : { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export const SOURCE_ICON: Record<string, string> = {
  workbench: '🖥', cli: '⌨️', telegram: '✈️', discord: '🎮', line: '💬', slack: '💼', whatsapp: '📱', workflow: '🔀', group: '👥', cron: '⏰', api_server: '🔌', tui: '⌨️',
}

/** 副標要顯示什麼：進行中 > 結果（失敗／文件／一般）> 開場白。一列只講一件事，老闆掃一眼就知道結局。 */
export function subtitleOf(s: ChatSession): { kind: 'running' | 'ok' | 'failed' | 'doc' | 'preview'; text: string } | null {
  if (s.running) return { kind: 'running', text: '' }
  if (s.result) {
    const k = s.result_kind || (s.run_status === 'failed' ? 'failed' : 'ok')
    return { kind: k === 'failed' || k === 'doc' ? k : 'ok', text: s.result }
  }
  if (s.preview) return { kind: 'preview', text: s.preview }
  return null
}

const RESULT_ICON: Record<'ok' | 'failed' | 'doc', string> = { ok: '✓', failed: '⚠', doc: '📄' }

/** 一列的狀態：進行中／完成／失敗；沒跑過的不標 */
export function statusOf(s: ChatSession): 'running' | 'done' | 'failed' | null {
  if (s.running) return 'running'
  if (s.run_status === 'failed' || s.result_kind === 'failed') return 'failed'
  if (s.run_status === 'completed' || s.result_kind === 'ok' || s.result_kind === 'doc' || !!s.result) return 'done'
  return null
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
  const { t, i18n } = useTranslation()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // 預設只展開「工作臺」。其他來源（工作流／Hermes 歷史動輒上千筆）先收起來，
  // 使用者點開才載入視野。undefined 代表「還沒動過」，才套預設值。
  const isCollapsed = (k: string) => collapsed[k] ?? k !== 'workbench'
  const [catFilter, setCatFilter] = useState<string>('')
  const [onlyRunning, setOnlyRunning] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const catById = useMemo(() => new Map(p.categories.map((c) => [c.id, c])), [p.categories])
  const runningCount = useMemo(() => p.sessions.filter((s) => s.running).length, [p.sessions])
  const filtered = p.sessions.filter((s) => (!catFilter || s.category_id === catFilter) && (!onlyRunning || s.running))
  const groups = useMemo(() => groupSessions(filtered, (k) => t(`chat.source.${k}`, { defaultValue: k })), [filtered, t])
  // 一定要從 isCollapsed 取現值再反轉：直接 !c[k] 會把「還沒動過」的 undefined 反成 true，
  // 讓預設收合的群組第一次點擊沒反應。
  const toggle = (k: string) => setCollapsed((c) => ({ ...c, [k]: !(c[k] ?? k !== 'workbench') }))

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="session-sidebar">
      <div className="flex items-center gap-1 px-2 pt-1">
        <div className="panel-title px-1">{t('workbench.sessions')}</div>
        {runningCount > 0 && (
          <button
            type="button"
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ${onlyRunning ? 'bg-indigo-600 text-white' : 'bg-indigo-100 text-indigo-800 hover:bg-indigo-200 dark:bg-indigo-900/50 dark:text-indigo-200'}`}
            aria-pressed={onlyRunning}
            title={t('workbench.onlyRunning')}
            onClick={() => setOnlyRunning((v) => !v)}
            data-testid="running-count"
          >
            <span className="chat-status-dot" data-status="running" aria-hidden />
            {t('workbench.runningCount', { n: runningCount })}
          </button>
        )}
        <button type="button" className="btn-ghost ml-auto text-xs" onClick={p.onOpenSearch} title="Ctrl+K" aria-label={t('chat.search.open')}>🔍</button>
        <button type="button" className="btn-ghost text-xs" onClick={p.onNew} disabled={p.newDisabled}>+ {t('workbench.newSession')}</button>
      </div>
      <div className="flex items-center gap-1 px-2 pb-1 text-xs">
        <select className="input h-6 min-w-0 flex-1 py-0 text-xs" value={catFilter} onChange={(e) => setCatFilter(e.target.value)} aria-label={t('chat.category.filter')}>
          <option value="">{t('chat.category.all')}</option>
          {p.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button type="button" className="btn-ghost px-1 text-xs" onClick={p.onManageCategories} title={t('chat.category.manage')}>⚙</button>
        <label className="flex cursor-pointer items-center gap-1 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={p.showArchived} onChange={p.onToggleArchived} /> {t('chat.archived')}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {groups.length === 0 && <div className="p-3 text-xs text-zinc-600 dark:text-zinc-400">{t('common.empty')}</div>}
        {groups.map((g) => (
          <div key={g.key} className="mb-1" data-testid={`group-${g.key}`}>
            <button type="button" className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/60" onClick={() => toggle(g.key)} aria-expanded={!isCollapsed(g.key)}>
              <span className="w-3 shrink-0 text-center">{isCollapsed(g.key) ? '▸' : '▾'}</span>
              <span className="shrink-0" aria-hidden>{SOURCE_ICON[g.key] ?? '•'}</span>
              <span className="min-w-0 truncate">{g.label}</span>
              {g.items.some((s) => s.running) && <span className="badge ml-auto bg-indigo-100 px-1 text-2xs font-normal text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200">{t('workbench.runningCount', { n: g.items.filter((s) => s.running).length })}</span>}
              <span className={`badge ${g.items.some((s) => s.running) ? '' : 'ml-auto'} bg-zinc-200 px-1 text-2xs font-normal dark:bg-zinc-700`}>{g.items.length}</span>
            </button>
            {!isCollapsed(g.key) && sectionsOf(g.items).map((sec) => (
              <div key={sec.key} data-testid={`time-${sec.key}`}>
                <div className="px-2 pb-0.5 pt-2 text-2xs font-medium text-zinc-500 dark:text-zinc-500">{t(`chat.when.${sec.key}`)}</div>
                {sec.items.map((s) => {
              const cat = s.category_id ? catById.get(s.category_id) : undefined
              const when = shortTime(ts(s), i18n.language)
              return (
                <div
                  key={s.id}
                  className={`group relative flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 ${s.id === p.activeId ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'} ${s.archived ? 'opacity-60' : ''} ${s.running ? 'border-l-2 border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/30' : ''}`}
                  onClick={() => p.onSelect(s.id)}
                  data-testid="session-row"
                  data-running={s.running ? 'true' : undefined}
                  data-status={statusOf(s) ?? undefined}
                >
                  <div className="flex w-full items-center gap-1 text-sm">
                  {(() => {
                    const st = statusOf(s)
                    if (st === 'running') return <span className="chat-spinner shrink-0 text-indigo-500" aria-label={t('workbench.statusRunning')} data-testid="running-spinner" />
                    if (st === 'done') return <span className="shrink-0 text-xs text-emerald-600 dark:text-emerald-400" title={t('workbench.statusDone')} data-testid="status-done">✓</span>
                    if (st === 'failed') return <span className="shrink-0 text-xs text-rose-600 dark:text-rose-400" title={t('workbench.statusFailed')} data-testid="status-failed">⚠</span>
                    return null
                  })()}
                  <span className="min-w-0 flex-1 truncate" title={s.title || undefined}>{s.title || t('workbench.untitled')}</span>
                  {cat && <span className="badge px-1 text-2xs" style={{ background: cat.color || '#e4e4e7', color: '#111' }}>{cat.name}</span>}
                  {s.archived && <span className="shrink-0 whitespace-nowrap text-2xs text-zinc-600 dark:text-zinc-400">{t('chat.archived')}</span>}
                  {when && <span className="shrink-0 whitespace-nowrap text-2xs tabular-nums text-zinc-500 group-hover:hidden dark:text-zinc-500" data-testid="session-time">{when}</span>}
                  <button
                    type="button"
                    className="hidden shrink-0 rounded px-1 text-xs text-zinc-600 hover:text-zinc-800 group-hover:block dark:text-zinc-400 dark:hover:text-zinc-100"
                    aria-label={t('chat.menu.open')}
                    onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === s.id ? null : s.id) }}
                  >⋯</button>
                  </div>
                  {(() => {
                    const sub = subtitleOf(s)
                    if (!sub) return null
                    const failed = sub.kind === 'failed'
                    return (
                      <div className={`flex min-w-0 items-center gap-1 text-2xs ${failed ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500 dark:text-zinc-500'}`} data-testid="session-preview" data-result-kind={sub.kind}>
                        {sub.kind === 'running' && <span className="chat-spinner shrink-0 text-indigo-500" aria-hidden />}
                        {sub.kind !== 'running' && sub.kind !== 'preview' && (
                          <span className="shrink-0" title={t(`workbench.result${sub.kind === 'ok' ? 'Ok' : sub.kind === 'doc' ? 'Doc' : 'Failed'}`)} aria-hidden>{RESULT_ICON[sub.kind]}</span>
                        )}
                        <span className="min-w-0 truncate">{sub.kind === 'running' ? t('workbench.running') : sub.text}</span>
                      </div>
                    )
                  })()}
                  {menuFor === s.id && (
                    <div className="card absolute right-1 top-7 z-20 min-w-[10rem] py-1 text-xs shadow-lg" role="menu" onClick={(e) => e.stopPropagation()}>
                      <MenuItem onClick={() => { setMenuFor(null); p.onRename(s) }}>{t('chat.menu.rename')}</MenuItem>
                      <MenuItem onClick={() => { setMenuFor(null); p.onArchive(s, !s.archived) }}>{s.archived ? t('chat.menu.unarchive') : t('chat.menu.archive')}</MenuItem>
                      <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
                      <div className="px-3 py-0.5 text-2xs text-zinc-600 dark:text-zinc-400">{t('chat.category.assign')}</div>
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
          </div>
        ))}

        {p.hermes && (
          <div className="mt-2 border-t border-zinc-200 pt-2 dark:border-zinc-800" data-testid="group-hermes">
            <button type="button" className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/60" onClick={() => toggle('__hermes')} aria-expanded={!isCollapsed('__hermes')}>
              <span className="w-3 shrink-0 text-center">{isCollapsed('__hermes') ? '▸' : '▾'}</span>
              <span className="shrink-0" aria-hidden>🗄</span>
              <span className="min-w-0 truncate">{t('chat.hermes.title')}</span>
              <span className="badge ml-auto bg-amber-100 px-1 text-2xs font-normal text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                {(p.hermes.sources ?? []).reduce((n, x) => n + x.total, 0)}
              </span>
            </button>
            {!isCollapsed('__hermes') && (
              <div className="pl-1">
                {(p.hermes.sources ?? []).map((src) => (
                  <div key={src.profile}>
                    <button
                      type="button"
                      className={`flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800/60 ${p.hermes!.openProfile === src.profile ? 'bg-zinc-100 dark:bg-zinc-800/60' : ''}`}
                      onClick={() => p.hermes!.onOpenGroup(src.profile)}
                    >
                      <code className="min-w-0 truncate font-mono" title={src.profile}>{src.profile}</code>
                      <span className="badge ml-auto bg-zinc-200 px-1 text-2xs dark:bg-zinc-700">{src.total}</span>
                    </button>
                    {p.hermes!.openProfile === src.profile && p.hermes!.children}
                  </div>
                ))}
                {(p.hermes.sources ?? []).length === 0 && <div className="px-2 py-1 text-xs text-zinc-600 dark:text-zinc-400">{t('chat.hermes.none')}</div>}
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
