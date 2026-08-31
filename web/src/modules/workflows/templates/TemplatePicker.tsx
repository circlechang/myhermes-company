// 建立工作流的第一步：選範本。選完直接進生產線視圖，不用先面對空白畫布。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WF_TEMPLATES, templateSummary } from './index'

export function TemplatePicker({
  onCreate,
  onCancel,
  busy = false,
  error,
}: {
  onCreate: (key: string, name: string) => void
  onCancel: () => void
  busy?: boolean
  error?: string | null
}) {
  const { t } = useTranslation()
  const [key, setKey] = useState(WF_TEMPLATES[0].key)
  const [name, setName] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onClick={onCancel} data-testid="template-picker">
      <div className="card flex max-h-[88vh] w-full max-w-3xl flex-col gap-3 overflow-auto p-4" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-base font-semibold">{t('wf.tpl.pick')}</h2>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('wf.tpl.pickHint')}</p>
        </div>
        <ul className="grid gap-2 sm:grid-cols-2">
          {WF_TEMPLATES.map((tpl) => {
            const s = templateSummary(tpl.key)
            const on = key === tpl.key
            return (
              <li key={tpl.key}>
                <button
                  type="button"
                  data-testid={`template-${tpl.key}`}
                  aria-pressed={on}
                  onClick={() => setKey(tpl.key)}
                  className={`flex h-full w-full flex-col gap-1.5 rounded-lg border p-3 text-left transition ${
                    on ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500 dark:bg-indigo-950/40' : 'border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-semibold">{s.name}</span>
                    <span className="badge bg-zinc-200 text-[11px] dark:bg-zinc-800">{t('wf.tpl.count', { n: s.steps.length })}</span>
                  </span>
                  <span className="text-xs text-zinc-600 dark:text-zinc-300">{s.desc}</span>
                  <span className="mt-auto flex flex-wrap items-center gap-1 pt-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                    {s.steps.map((st, i) => (
                      <span key={`${st}-${i}`} className="flex items-center gap-1">
                        {i > 0 && <span aria-hidden>→</span>}
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">{st}</span>
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <label className="block">
          <span className="mb-1 block text-xs text-zinc-600 dark:text-zinc-400">{t('wf.tpl.nameLabel')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={templateSummary(key).name} aria-label={t('wf.tpl.nameLabel')} />
        </label>
        {error && <div className="text-xs text-rose-600 dark:text-rose-400">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onCancel}>{t('wf.tpl.cancel')}</button>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => onCreate(key, name)} data-testid="template-create">{t('wf.tpl.create')}</button>
        </div>
      </div>
    </div>
  )
}
