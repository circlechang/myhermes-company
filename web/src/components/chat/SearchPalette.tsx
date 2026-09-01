import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { chatApi, type SearchHit } from '../../api/sessions'

/** Ctrl+K 全文搜尋（標題＋訊息）；Esc 關閉、↑↓ 選、Enter 開 */
export function SearchPalette({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (hit: SearchHit) => void }) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState(0)
  const seq = useRef(0)
  useEffect(() => {
    if (!open) return
    setQ('')
    setHits([])
    setSel(0)
  }, [open])
  useEffect(() => {
    if (!open) return
    const term = q.trim()
    if (!term) { setHits([]); return }
    const my = ++seq.current
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const r = await chatApi.sessions.search(term)
        if (my === seq.current) { setHits(r); setSel(0) }
      } catch {
        if (my === seq.current) setHits([])
      } finally {
        if (my === seq.current) setLoading(false)
      }
    }, 150)
    return () => clearTimeout(timer)
  }, [q, open])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-[10vh]" onClick={onClose} data-testid="search-palette">
      <div className="card w-full max-w-xl overflow-hidden shadow-xl" role="dialog" aria-label={t('chat.search.title')} onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="w-full border-b border-zinc-200 bg-transparent px-4 py-3 text-sm outline-none dark:border-zinc-800"
          placeholder={t('chat.search.placeholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t('chat.search.title')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(hits.length - 1, s + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
            else if (e.key === 'Enter' && hits[sel]) { onPick(hits[sel]); onClose() }
          }}
        />
        <div className="max-h-80 overflow-auto text-sm">
          {loading && <div className="p-3 text-xs text-zinc-600 dark:text-zinc-400">{t('common.loading')}</div>}
          {!loading && q.trim() && hits.length === 0 && <div className="p-3 text-xs text-zinc-600 dark:text-zinc-400">{t('chat.search.none')}</div>}
          {hits.map((h, i) => (
            <button
              key={h.session.id}
              type="button"
              className={`flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left ${i === sel ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => { onPick(h); onClose() }}
            >
              <span className="flex w-full items-center gap-2">
                <span className="truncate font-medium">{h.session.title || t('workbench.untitled')}</span>
                <span className="ml-auto shrink-0 rounded bg-zinc-200 px-1 text-2xs dark:bg-zinc-700">{h.match === 'title' ? t('chat.search.inTitle') : t('chat.search.inMessage')}</span>
              </span>
              {h.match === 'message' && <span className="line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">{h.snippet}</span>}
            </button>
          ))}
        </div>
        <div className="border-t border-zinc-200 px-4 py-1.5 text-2xs text-zinc-600 dark:text-zinc-400 dark:border-zinc-800">{t('chat.search.hint')}</div>
      </div>
    </div>
  )
}
