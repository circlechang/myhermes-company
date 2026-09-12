// 設定總覽的「有事找我」卡：閘門等你看／流程失敗／危險指令 → 推一則 LINE。
// 表單是本地副本（打開時從 GET /notify/prefs 灌進來），按「儲存」才 PUT；「傳一則測試」直接用欄位裡的對象，不必先存。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import type { NotifyPrefs as Prefs } from '../../api/client'
import { useNotifyPrefs, useNotifyStatus, useNotifyTest, useSaveNotifyPrefs } from '../../api/hooks'
import { useAuth } from '../../auth/AuthContext'

type Form = Pick<Prefs, 'enabled' | 'line_to' | 'public_url' | 'on_waiting' | 'on_failed' | 'on_chat_approval' | 'quiet_hours'>
const EMPTY: Form = { enabled: false, line_to: '', public_url: '', on_waiting: true, on_failed: true, on_chat_approval: true, quiet_hours: '' }

export function NotifyPrefs() {
  const { t } = useTranslation()
  const { member } = useAuth()
  const canEdit = member?.role === 'owner' || member?.role === 'admin'
  const prefs = useNotifyPrefs()
  const status = useNotifyStatus()
  const save = useSaveNotifyPrefs()
  const test = useNotifyTest()
  const [form, setForm] = useState<Form>(EMPTY)
  const [saved, setSaved] = useState(false)

  // 伺服器的值到了就蓋掉本地副本（只在資料變動時，避免打字被洗掉）
  useEffect(() => {
    if (prefs.data) {
      const d = prefs.data
      setForm({ enabled: d.enabled, line_to: d.line_to, public_url: d.public_url, on_waiting: d.on_waiting, on_failed: d.on_failed, on_chat_approval: d.on_chat_approval, quiet_hours: d.quiet_hours })
    }
  }, [prefs.data])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setSaved(false)
    setForm((f) => ({ ...f, [k]: v }))
  }
  const onSave = () => save.mutate(form, { onSuccess: () => setSaved(true) })
  const lineMissing = status.data && !status.data.line_configured

  const check = (k: 'on_waiting' | 'on_failed' | 'on_chat_approval', label: string) => (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={form[k]} disabled={!canEdit} onChange={(e) => set(k, e.target.checked)} data-testid={`notify-${k}`} />
      {label}
    </label>
  )

  return (
    <section className="card p-4" data-testid="notify-prefs">
      <h2 className="font-medium">{t('settings.notify.title')}</h2>
      <p className="mb-3 text-xs text-zinc-600 dark:text-zinc-400">{t('settings.notify.hint')}</p>

      {lineMissing && (
        <p className="mb-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" data-testid="notify-status">
          {t('settings.notify.lineMissing')}{' '}
          <Link to="/channels" className="underline">{t('settings.notify.lineMissingLink')}</Link>
        </p>
      )}
      {!canEdit && <p className="mb-3 text-xs text-zinc-600 dark:text-zinc-400">{t('settings.notify.readOnly')}</p>}

      <div className="space-y-3">
        <label className="flex cursor-pointer items-center gap-3 text-sm">
          <input type="checkbox" role="switch" checked={form.enabled} aria-checked={form.enabled} disabled={!canEdit} onChange={(e) => set('enabled', e.target.checked)} data-testid="notify-enabled" />
          <span className="font-medium">{t('settings.notify.enabled')}</span>
        </label>

        <div>
          <label className="block text-sm font-medium" htmlFor="notify-line-to">{t('settings.notify.lineTo')}</label>
          <input id="notify-line-to" className="input mt-1 w-full font-mono" value={form.line_to} disabled={!canEdit} placeholder="Uxxxxxxxx / Cxxxxxxxx"
            onChange={(e) => set('line_to', e.target.value)} data-testid="notify-line-to" />
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{t('settings.notify.lineToHint')}</p>
        </div>

        <div>
          <label className="block text-sm font-medium" htmlFor="notify-public-url">{t('settings.notify.publicUrl')}</label>
          <input id="notify-public-url" className="input mt-1 w-full font-mono" value={form.public_url} disabled={!canEdit} placeholder="https://studio.example.com"
            onChange={(e) => set('public_url', e.target.value)} data-testid="notify-public-url" />
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{t('settings.notify.publicUrlHint')}</p>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {check('on_waiting', t('settings.notify.onWaiting'))}
          {check('on_failed', t('settings.notify.onFailed'))}
          {check('on_chat_approval', t('settings.notify.onChat'))}
        </div>

        <div>
          <label className="block text-sm font-medium" htmlFor="notify-quiet-hours">{t('settings.notify.quietHours')}</label>
          <input id="notify-quiet-hours" className="input mt-1 w-32 font-mono" value={form.quiet_hours} disabled={!canEdit} placeholder="23-07"
            onChange={(e) => set('quiet_hours', e.target.value)} data-testid="notify-quiet-hours" />
          <span className="ml-2 text-xs text-zinc-600 dark:text-zinc-400">{t('settings.notify.quietHoursHint')}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button type="button" className="btn" onClick={onSave} disabled={!canEdit || save.isPending} data-testid="notify-save">{t('settings.notify.save')}</button>
          <button type="button" className="btn-outline" onClick={() => test.mutate(form.line_to)} disabled={!canEdit || test.isPending || !form.line_to.trim()} data-testid="notify-test">
            {t('settings.notify.test')}
          </button>
          {saved && <span className="text-emerald-700 dark:text-emerald-300" data-testid="notify-saved">{t('settings.notify.saved')}</span>}
          {save.error && <span className="text-rose-700 dark:text-rose-300" role="alert">{(save.error as Error).message}</span>}
          {test.data && (
            <span className={test.data.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'} data-testid="notify-test-result">
              {test.data.ok ? t('settings.notify.testSent') : t('settings.notify.testFailed', { error: test.data.error })}
            </span>
          )}
          {test.error && <span className="text-rose-700 dark:text-rose-300" role="alert">{(test.error as Error).message}</span>}
        </div>
      </div>
    </section>
  )
}
