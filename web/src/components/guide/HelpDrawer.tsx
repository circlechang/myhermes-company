// 每頁「？」說明抽屜：內容依當前路由（src/help/pages.*.ts）
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router-dom'
import { helpFor } from '../../help'
import '../../guide/i18n'
import { iconFor } from '../nav/icons'
import { startTour } from './Tour'

const CloseIcon = iconFor('X')

export function HelpDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const loc = useLocation()
  const page = helpFor(loc.pathname, i18n.language)
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[90] flex justify-end" data-testid="help-drawer" data-path={page?.path ?? ''}>
      <button type="button" className="absolute inset-0 bg-black/30" aria-label={t('guide.help.close')} onClick={onClose} data-testid="help-backdrop" />
      <aside className="relative flex h-full w-[380px] max-w-[92vw] flex-col overflow-y-auto border-l border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{t('guide.help.open')}</div>
            <h2 id="help-title" className="text-lg font-semibold" data-testid="help-title">{page?.title ?? t('guide.help.fallbackTitle')}</h2>
          </div>
          <button type="button" className="btn-ghost px-2" onClick={onClose} aria-label={t('guide.help.close')} data-testid="help-close"><CloseIcon className="h-4 w-4" aria-hidden /></button>
        </div>
        {page ? (
          <div className="mt-4 space-y-5 text-sm">
            <section>
              <h3 className="mb-1 font-medium">{t('guide.help.what')}</h3>
              {page.what.map((s, k) => <p key={k} className="text-zinc-600 dark:text-zinc-300">{s}</p>)}
            </section>
            <section>
              <h3 className="mb-1 font-medium">{t('guide.help.how')}</h3>
              <ol className="list-decimal space-y-1 pl-5 text-zinc-600 dark:text-zinc-300">{page.how.map((s, k) => <li key={k}>{s}</li>)}</ol>
            </section>
            <section>
              <h3 className="mb-1 font-medium">{t('guide.help.faq')}</h3>
              <dl className="space-y-2">
                {page.faq.map((f, k) => (
                  <div key={k}>
                    <dt className="font-medium text-zinc-700 dark:text-zinc-200">{f.q}</dt>
                    <dd className="text-zinc-600 dark:text-zinc-300">{f.a}</dd>
                  </div>
                ))}
              </dl>
            </section>
            {page.related.length > 0 && (
              <section>
                <h3 className="mb-1 font-medium">{t('guide.help.related')}</h3>
                <div className="flex flex-wrap gap-1">
                  {page.related.map((r) => <Link key={r.to} to={r.to} onClick={onClose} className="btn-outline !py-0.5 text-xs">{r.label}</Link>)}
                </div>
              </section>
            )}
          </div>
        ) : (
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">{t('common.empty')}</p>
        )}
        <div className="mt-auto pt-6">
          <button type="button" className="btn-outline w-full text-xs" onClick={() => { onClose(); startTour() }} data-testid="help-replay-tour">{t('guide.help.replayTour')}</button>
        </div>
      </aside>
    </div>
  )
}
