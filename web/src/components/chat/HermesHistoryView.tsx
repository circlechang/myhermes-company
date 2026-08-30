import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHermesList, useHermesMessages, useImportHermes, type HermesHistorySession } from '../../api/sessions'
import { fromMessages } from '../../ws/chatState'
import { ErrorBox, Loading } from '../QueryState'
import { MessageList } from './MessageList'
import { SOURCE_ICON } from './SessionSidebar'

const fmt = (s?: string | null) => (s ? new Date(s.endsWith('Z') ? s : s + 'Z').toLocaleString() : '—')

/** 側欄裡某個 profile 的 Hermes 歷史清單（依 source 分組摺疊） */
export function HermesHistoryList({ profile, active, onOpen }: { profile: string; active?: { profile: string; id: string }; onOpen: (s: HermesHistorySession) => void }) {
  const { t } = useTranslation()
  const q = useHermesList(profile)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />
  const groups = new Map<string, HermesHistorySession[]>()
  for (const s of q.data ?? []) (groups.get(s.source) ?? groups.set(s.source, []).get(s.source)!).push(s)
  return (
    <div className="pl-2" data-testid={`hermes-list-${profile}`}>
      {[...groups.entries()].map(([src, items]) => (
        <div key={src}>
          <button type="button" className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[10px] uppercase text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/60" onClick={() => setCollapsed((c) => ({ ...c, [src]: !c[src] }))}>
            <span>{collapsed[src] ? '▸' : '▾'}</span>
            <span aria-hidden>{SOURCE_ICON[src] ?? '•'}</span>
            <span>{src}</span>
            <span className="ml-auto">{items.length}</span>
          </button>
          {!collapsed[src] && items.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800/60 ${active?.id === s.id && active.profile === profile ? 'bg-zinc-200 dark:bg-zinc-800' : ''}`}
              onClick={() => onOpen(s)}
              title={`${s.id} · ${fmt(s.started_at)}`}
            >
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{t('chat.hermes.badge')}</span>
            </button>
          ))}
        </div>
      ))}
      {(q.data ?? []).length === 0 && <div className="px-2 py-1 text-[11px] text-zinc-600 dark:text-zinc-400">{t('common.empty')}</div>}
    </div>
  )
}

/** 唯讀瀏覽 Hermes 歷史 session ＋「匯入」成 Studio session */
export function HermesHistoryView({ profile, id, onImported, onOpenFile }: { profile: string; id: string; onImported: (sessionId: string) => void; onOpenFile?: (p: string) => void }) {
  const { t } = useTranslation()
  const q = useHermesMessages(profile, id)
  const imp = useImportHermes()
  const s = q.data?.session
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="hermes-view">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{t('chat.hermes.readonly')}</span>
        <span className="min-w-0 truncate font-medium">{s?.title ?? id}</span>
        {s && <span className="shrink-0 text-zinc-600 dark:text-zinc-400">{s.source} · {s.model ?? '—'} · {s.message_count} {t('workbench.messages')} · {fmt(s.started_at)}</span>}
        <button
          type="button"
          className="btn-primary ml-auto shrink-0 text-xs"
          disabled={imp.isPending}
          onClick={async () => {
            const r = await imp.mutateAsync({ profile, id })
            onImported(r.id)
          }}
        >
          {imp.isPending ? t('common.loading') : t('chat.hermes.import')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {q.isLoading && <Loading />}
        {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
        {imp.error && <ErrorBox error={imp.error} />}
        {q.data && <MessageList items={fromMessages(q.data.messages).items} onDecide={() => undefined} actions={{ onOpenFile }} />}
      </div>
    </div>
  )
}
