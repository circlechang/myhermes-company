import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useModelOptions, type ModelEntry } from '../../api/sessions'

const fmtTok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** 模型徽章 + token 用量（每 session） */
export function ModelBadge({ model, fallback, usage, onClick }: {
  model?: string
  fallback?: string
  usage?: { total_tokens: number; context_tokens: number; input_tokens?: number; output_tokens?: number }
  onClick?: () => void
}) {
  const { t } = useTranslation()
  const label = model || fallback || 'default'
  const short = label.includes('/') ? label.split('/').pop()! : label
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-2 rounded-full border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      onClick={onClick}
      title={`${label}${model ? '' : ` (${t('chat.model.default')})`}`}
      data-testid="model-badge"
    >
      <span className="truncate font-medium">{short}</span>
      {!model && <span className="text-zinc-600 dark:text-zinc-400">{t('chat.model.default')}</span>}
      {usage && (
        <span className="text-zinc-600 dark:text-zinc-400" title={`in ${usage.input_tokens ?? 0} / out ${usage.output_tokens ?? 0}`}>
          {t('chat.model.ctx')} {fmtTok(usage.context_tokens)} · Σ {fmtTok(usage.total_tokens)}
        </span>
      )}
    </button>
  )
}

/** 模型選擇器：呼叫 /chat/models?profile= 列可用模型；空字串＝回到 profile 預設 */
export function ModelPicker({ profile, value, onChange, onClose }: {
  profile?: string
  value: string
  onChange: (model: string, provider: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const q = useModelOptions(profile)
  const [filter, setFilter] = useState('')
  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (q.data?.providers ?? [])
      .map((p) => ({ ...p, models: p.models.filter((m) => !f || m.id.toLowerCase().includes(f)) }))
      .filter((p) => p.models.length > 0)
  }, [q.data, filter])
  const pick = (m?: ModelEntry) => {
    onChange(m?.id ?? '', m?.provider ?? '')
    onClose()
  }
  return (
    <div className="card absolute z-30 mt-1 w-[22rem] max-w-[90vw] p-2 shadow-lg" role="dialog" aria-label={t('chat.model.title')} data-testid="model-picker">
      <div className="mb-2 flex items-center gap-2">
        <input className="input" autoFocus placeholder={t('chat.model.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('chat.model.filter')} />
        <button type="button" className="btn-ghost text-xs" onClick={() => q.refetch()} title={t('common.retry')}>↻</button>
        <button type="button" className="btn-ghost text-xs" onClick={onClose} aria-label={t('common.close')}>✕</button>
      </div>
      <div className="max-h-72 overflow-auto text-sm">
        <button type="button" className={`flex w-full items-center rounded px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${!value ? 'bg-zinc-100 dark:bg-zinc-800' : ''}`} onClick={() => pick(undefined)}>
          <span>{t('chat.model.useDefault')}</span>
          {q.data?.current?.model && <span className="ml-auto text-xs text-zinc-600 dark:text-zinc-400">{q.data.current.model}</span>}
        </button>
        {q.isLoading && <div className="p-2 text-xs text-zinc-600 dark:text-zinc-400">{t('common.loading')}</div>}
        {q.data?.error && <div className="p-2 text-xs text-rose-600 dark:text-rose-400">{q.data.error}</div>}
        {q.data?.fallback && <div className="p-2 text-xs text-amber-700 dark:text-amber-400">{t('chat.model.fallback')}</div>}
        {groups.map((p) => (
          <div key={p.slug || p.name}>
            <div className="mt-1 px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
              {p.name} {p.is_current && <span className="ml-1 rounded bg-emerald-100 px-1 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200">{t('chat.model.current')}</span>}
              {p.authenticated === false && <span className="ml-1 text-amber-700 dark:text-amber-400">{t('chat.model.unauth')}</span>}
            </div>
            {p.models.map((m) => (
              <button
                key={`${p.slug}:${m.id}`}
                type="button"
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${value === m.id ? 'bg-indigo-50 dark:bg-indigo-950/40' : ''}`}
                onClick={() => pick(m)}
              >
                <span className="min-w-0 truncate font-mono text-xs">{m.id}</span>
                {m.pricing?.input && <span className="ml-auto shrink-0 text-2xs text-zinc-600 dark:text-zinc-400">{m.pricing.input} / {m.pricing.output}</span>}
                {m.pricing?.free && <span className="ml-auto shrink-0 text-2xs text-emerald-600 dark:text-emerald-400">free</span>}
              </button>
            ))}
          </div>
        ))}
        {!q.isLoading && groups.length === 0 && <div className="p-2 text-xs text-zinc-600 dark:text-zinc-400">{t('common.empty')}</div>}
      </div>
    </div>
  )
}
