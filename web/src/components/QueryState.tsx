import { useTranslation } from 'react-i18next'

export function Loading() {
  const { t } = useTranslation()
  return <div className="p-4 text-sm text-zinc-600 dark:text-zinc-400">{t('common.loading')}</div>
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
