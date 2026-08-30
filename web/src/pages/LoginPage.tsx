import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { LangSwitch } from '../components/LangSwitch'

export function LoginPage() {
  const { t } = useTranslation()
  const { login } = useAuth()
  const nav = useNavigate()
  const loc = useLocation() as { state?: { from?: string } }
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username, password)
      nav(loc.state?.from ?? '/', { replace: true })
    } catch (err) {
      setError(err instanceof Error && err.message ? `${t('login.failed')}（${err.message}）` : t('login.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="absolute right-4 top-4">
        <LangSwitch />
      </div>
      <form onSubmit={submit} className="card w-full max-w-sm p-6">
        <div className="mb-1">
          <img src="/wordmark.svg" alt={t('app.name')} className="h-9 w-auto dark:[filter:invert(1)_hue-rotate(180deg)]" />
        </div>
        <p className="mb-5 text-sm text-zinc-600 dark:text-zinc-400">{t('app.tagline')}</p>
        <h1 className="mb-3 text-base font-medium">{t('login.title')}</h1>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-zinc-600 dark:text-zinc-400">{t('login.username')}</span>
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-zinc-600 dark:text-zinc-400">{t('login.password')}</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && (
          <div role="alert" className="mb-3 rounded-md bg-rose-50 p-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        )}
        <button type="submit" className="btn-primary w-full justify-center" disabled={busy}>
          {busy ? t('login.submitting') : t('login.submit')}
        </button>
        <p className="mt-4 text-xs text-zinc-600 dark:text-zinc-400">{t('login.hint')}</p>
      </form>
    </div>
  )
}
