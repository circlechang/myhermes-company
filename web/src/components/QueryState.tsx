import { useTranslation } from 'react-i18next'

/** 載入中：三條灰色骨架（不是一行「載入中…」字），文字留給讀屏器與既有測試（sr-only） */
export function Loading({ rows = 3, className = '' }: { rows?: number; className?: string } = {}) {
  const { t } = useTranslation()
  const widths = ['w-3/4', 'w-1/2', 'w-2/3']
  return (
    <div className={`p-4 ${className}`} role="status" aria-label={t('common.loading')} aria-busy="true" data-testid="loading">
      <div className="animate-pulse space-y-2">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className={`h-3 rounded-full bg-zinc-200 dark:bg-zinc-700 ${widths[i % widths.length]}`} />
        ))}
      </div>
      <span className="sr-only">{t('common.loading')}</span>
    </div>
  )
}
export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation()
  const msg = error instanceof Error ? error.message : String(error)
  return (
    <div className="m-4 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
      <div className="font-medium">{t('common.error')}</div>
      <div className="mt-1 break-all">{msg}</div>
      {onRetry && (
        <button className="btn-outline mt-2" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  )
}
export function Empty({ text }: { text?: string }) {
  const { t } = useTranslation()
  return <div className="p-4 text-sm text-zinc-600 dark:text-zinc-400">{text ?? t('common.empty')}</div>
}
