// G. 模型管理：供應商發現／模型清單／自訂供應商／OAuth／預設模型／分組可見別名／STT-TTS 目錄
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../api/client'
import { PageHeader } from '../../components/PageHeader'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import type { StudioModule } from '../registry'
import { useProfiles } from '../profiles'

export interface Provider {
  id: string; name: string; kind: 'builtin' | 'custom'; auth_type: string; base_url: string; key_envs: string[]; key_env_set: string | null
  oauth_capable: boolean; oauth_logged_in: boolean; oauth_error?: string | null; credentials: { id: string; label: string; auth_type: string; source: string; last_status?: string }[]
  configured: boolean; is_active: boolean; is_current: boolean; group: string; hidden_models: string[]; aliases: Record<string, string>; enabled: boolean
  model?: string; models?: string[]; key_env?: string; format?: string
}
export interface ProvidersResp { providers: Provider[]; active_provider: string; current: { model: string; provider: string; base_url: string }; groups: string[] }
interface AuthSession { id: string; provider: string; status: string; url: string | null; code: string | null; output: string; error: string | null }
interface SpeechResp {
  tts: { provider: string; providers: { id: string; name: string; key_envs: string[]; key_set: boolean; current: boolean; config_keys: string[]; settings: Record<string, unknown> }[] }
  stt: { provider: string; enabled: boolean; providers: { id: string; name: string; key_envs: string[]; key_set: boolean; current: boolean; config_keys: string[]; settings: Record<string, unknown> }[] }
}

const json = (b: unknown) => JSON.stringify(b)
const pq = (profile?: string) => (profile && profile !== 'default' ? `?profile=${encodeURIComponent(profile)}` : '')
export const modelsApi = {
  providers: (profile?: string) => request<ProvidersResp>(`/models/providers${pq(profile)}`),
  catalog: (refresh = false) => request<{ providers: { slug: string; name: string; models: string[]; is_current: boolean }[]; model: string; provider: string }>(`/models/catalog${refresh ? '?refresh=1' : ''}`),
  models: (id: string, live = false, profile?: string) => request<{ models: string[]; source: string }>(`/models/providers/${id}/models?live=${live ? 1 : 0}${profile && profile !== 'default' ? `&profile=${profile}` : ''}`),
  detect: (b: { base_url: string; api_key?: string; provider_id?: string }) => request<{ base_url: string; models: string[]; detected: boolean }>('/models/providers/detect', { method: 'POST', body: json(b) }),
  createCustom: (b: Record<string, unknown>, profile?: string) => request<{ id: string; detected?: { error?: string } }>(`/models/providers${pq(profile)}`, { method: 'POST', body: json(b) }),
  updateCustom: (id: string, b: Record<string, unknown>, profile?: string) => request<unknown>(`/models/providers/${id}${pq(profile)}`, { method: 'PUT', body: json(b) }),
  deleteCustom: (id: string, profile?: string) => request<unknown>(`/models/providers/${id}${pq(profile)}`, { method: 'DELETE' }),
  setKey: (id: string, api_key: string, env_var?: string, profile?: string) => request<{ env_var: string }>(`/models/providers/${id}/key${pq(profile)}`, { method: 'PUT', body: json({ api_key, env_var }) }),
  clearKey: (id: string, profile?: string) => request<unknown>(`/models/providers/${id}/key${pq(profile)}`, { method: 'DELETE' }),
  authStart: (id: string) => request<AuthSession>(`/models/auth/${id}/start`, { method: 'POST' }),
  authPoll: (sid: string) => request<AuthSession>(`/models/auth/sessions/${sid}`),
  authSubmit: (sid: string, text: string) => request<AuthSession>(`/models/auth/sessions/${sid}/submit`, { method: 'POST', body: json({ text }) }),
  authCancel: (sid: string) => request<unknown>(`/models/auth/sessions/${sid}`, { method: 'DELETE' }),
  logout: (id: string) => request<unknown>(`/models/auth/${id}`, { method: 'DELETE' }),
  getDefault: (profile?: string) => request<{ model: string; provider: string; base_url: string }>(`/models/default${pq(profile)}`),
  setDefault: (b: { model: string; provider?: string; base_url?: string }, profile?: string) => request<unknown>(`/models/default${pq(profile)}`, { method: 'PUT', body: json(b) }),
  prefs: (id: string, b: { group?: string; hidden_models?: string[]; aliases?: Record<string, string>; enabled?: boolean }) => request<unknown>(`/models/providers/${id}/prefs`, { method: 'PUT', body: json(b) }),
  speech: (profile?: string) => request<SpeechResp>(`/models/speech${pq(profile)}`),
  setSpeech: (b: { tts?: Record<string, unknown>; stt?: Record<string, unknown>; env?: Record<string, string | null> }, profile?: string) => request<SpeechResp>(`/models/speech${pq(profile)}`, { method: 'PUT', body: json(b) }),
}

function OAuthFlow({ provider, onDone }: { provider: string; onDone: () => void }) {
  const { t } = useTranslation()
  const [sess, setSess] = useState<AuthSession | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [paste, setPaste] = useState('')
  useEffect(() => {
    let alive = true
    modelsApi.authStart(provider).then((s) => alive && setSess(s)).catch((e) => setErr(String(e.message ?? e)))
    return () => { alive = false }
  }, [provider])
  useEffect(() => {
    if (!sess || sess.status === 'done' || sess.status === 'failed' || sess.status === 'cancelled') { if (sess?.status === 'done') onDone(); return }
    const id = setInterval(() => modelsApi.authPoll(sess.id).then(setSess).catch(() => undefined), 2000)
    return () => clearInterval(id)
  }, [sess, onDone])
  return (
    <div className="mt-2 rounded-md border border-indigo-300 p-2 text-xs dark:border-indigo-800">
      <div className="font-medium">{t('models.oauthTitle', { p: provider })} <span className="text-zinc-600 dark:text-zinc-400">{sess?.status}</span></div>
      {err && <div className="text-rose-600 dark:text-rose-400">{err}</div>}
      {sess?.url && <div className="break-all">{t('models.oauthOpen')} <a className="underline" href={sess.url} target="_blank" rel="noreferrer">{sess.url}</a></div>}
      {sess?.code && <div>{t('models.oauthCode')} <code className="rounded bg-zinc-100 px-1 text-sm dark:bg-zinc-800" data-testid="oauth-code">{sess.code}</code></div>}
      {sess && sess.status === 'waiting' && (
        <div className="mt-1 flex flex-wrap gap-1">
          <input className="input flex-1 basis-40" placeholder={t('models.oauthPaste')} value={paste} onChange={(e) => setPaste(e.target.value)} />
          <button className="btn-outline" onClick={() => modelsApi.authSubmit(sess.id, paste).then(setSess)}>{t('models.oauthSubmit')}</button>
          <button className="btn-ghost" onClick={() => modelsApi.authCancel(sess.id).then(onDone)}>{t('common.cancel')}</button>
        </div>
      )}
      {sess?.status === 'done' && <div className="text-emerald-600 dark:text-emerald-400">{t('models.oauthDone')}</div>}
      {sess?.status === 'failed' && <div className="text-rose-600 dark:text-rose-400">{sess.error}</div>}
      {sess?.output && <pre className="mt-1 max-h-24 overflow-auto text-2xs text-zinc-600 dark:text-zinc-400">{sess.output}</pre>}
    </div>
  )
}

function ProviderCard({ p, profile, current, groups, onChanged }: { p: Provider; profile: string; current: { model: string; provider: string }; groups: string[]; onChanged: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [live, setLive] = useState(false)
  const models = useQuery({ queryKey: ['models', 'list', p.id, live, profile], queryFn: () => modelsApi.models(p.id, live, profile), enabled: open, retry: false })
  const [key, setKey] = useState('')
  const [oauth, setOauth] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const run = (fn: () => Promise<unknown>) => { setErr(null); return fn().then(onChanged).catch((e) => setErr(String(e.message ?? e))) }
  const hidden = new Set(p.hidden_models)
  return (
    <div className="card p-3" data-testid={`provider-${p.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`inline-block h-2 w-2 rounded-full ${p.configured ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
        <button className="min-w-0 truncate font-medium" onClick={() => setOpen(!open)} title={p.name}>{p.name}</button>
        <code className="id-text shrink text-zinc-600 dark:text-zinc-400" title={p.id}>{p.id}</code>
        {p.is_current && <span className="badge bg-indigo-100 text-2xs text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200">{t('models.current')}</span>}
        {p.kind === 'custom' && <span className="badge bg-amber-100 text-2xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">{t('models.custom')}</span>}
        <span className="ml-auto text-xs text-zinc-600 dark:text-zinc-400">{p.key_env_set ? `${t('models.keyVia')} ${p.key_env_set}` : p.oauth_logged_in ? t('models.oauthLoggedIn') : p.credentials.length ? t('models.credentials', { n: p.credentials.length }) : t('models.notConfigured')}</span>
      </div>
      {p.oauth_error && <div className="text-xs text-rose-600 dark:text-rose-400">{p.oauth_error}</div>}
      {open && (
        <div className="mt-2 space-y-2 text-xs">
          <div className="path-text text-zinc-600 dark:text-zinc-400" title={p.base_url}>{p.base_url || '—'}</div>
          {err && <div className="text-rose-600 dark:text-rose-400">{err}</div>}
          <div className="flex flex-wrap items-center gap-2">
            {p.key_envs.length > 0 && (
              <>
                <input className="input w-full sm:w-64" type="password" placeholder={`${t('models.apiKey')} → ${p.key_envs[0]}`} value={key} onChange={(e) => setKey(e.target.value)} aria-label={`${p.id} api key`} autoComplete="off" />
                <button className="btn-outline" disabled={!key} onClick={() => run(() => modelsApi.setKey(p.id, key, undefined, profile)).then(() => setKey(''))}>{t('models.saveKey')}</button>
                {p.key_env_set && <button className="btn-ghost text-rose-600 dark:text-rose-400" onClick={() => run(() => modelsApi.clearKey(p.id, profile))}>{t('models.clearKey')}</button>}
              </>
            )}
            {p.oauth_capable && !oauth && <button className="btn-outline" onClick={() => setOauth(true)}>{t('models.oauthLogin')}</button>}
            {p.oauth_capable && (p.oauth_logged_in || p.credentials.length > 0) && <button className="btn-ghost text-rose-600 dark:text-rose-400" onClick={() => run(() => modelsApi.logout(p.id))}>{t('models.logout')}</button>}
            {p.kind === 'custom' && <button className="btn-ghost text-rose-600 dark:text-rose-400" onClick={() => { if (confirm(t('models.confirmDelete', { name: p.name }))) run(() => modelsApi.deleteCustom(p.id, profile)) }}>{t('common.delete')}</button>}
            <label className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap">{t('models.group')}
              <select className="input w-auto" value={p.group} onChange={(e) => run(() => modelsApi.prefs(p.id, { group: e.target.value }))}>
                {[...new Set([...groups, p.group])].map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
            <label className="flex shrink-0 items-center gap-1 whitespace-nowrap"><input type="checkbox" checked={p.enabled} onChange={(e) => run(() => modelsApi.prefs(p.id, { enabled: e.target.checked }))} />{t('models.enabled')}</label>
          </div>
          {oauth && <OAuthFlow provider={p.id} onDone={() => { setOauth(false); onChanged() }} />}
          {p.credentials.length > 0 && (
            <ul className="flex flex-wrap gap-1">{p.credentials.map((c) => <li key={c.id} className="badge border dark:border-zinc-700">{c.label} · {c.auth_type} · {c.source}{c.last_status ? ` · ${c.last_status}` : ''}</li>)}</ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t('models.models')}</span>
            <label className="flex shrink-0 items-center gap-1 whitespace-nowrap"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />{t('models.live')}</label>
            <button className="btn-ghost" onClick={() => models.refetch()}>{t('models.refresh')}</button>
            {models.data && <span className="whitespace-nowrap text-zinc-600 dark:text-zinc-400">{models.data.models.length} · {models.data.source}</span>}
          </div>
          {models.isLoading && <Loading />}
          {models.error && <div className="text-rose-600 dark:text-rose-400">{String((models.error as Error).message)}</div>}
          {models.data && (
            <ul className="grid max-h-64 grid-cols-1 gap-1 overflow-auto md:grid-cols-2 lg:grid-cols-3">
              {models.data.models.map((m) => (
                <li key={m} className={`flex min-w-0 items-center gap-1 rounded border px-1.5 py-0.5 dark:border-zinc-700 ${hidden.has(m) ? 'opacity-40' : ''}`}>
                  <input type="checkbox" title={t('models.visible')} checked={!hidden.has(m)}
                    onChange={(e) => run(() => modelsApi.prefs(p.id, { hidden_models: e.target.checked ? p.hidden_models.filter((x) => x !== m) : [...p.hidden_models, m] }))} />
                  <code className="id-text" title={m}>{p.aliases[m] ? `${p.aliases[m]} (${m})` : m}</code>
                  {current.model === m && current.provider === p.id && <span className="shrink-0 text-indigo-600 dark:text-indigo-400">★</span>}
                  <span className="ml-auto flex shrink-0 gap-0.5">
                    <button className="btn-ghost px-1" title={t('models.alias')} onClick={() => { const a = prompt(t('models.aliasPrompt', { m }), p.aliases[m] ?? ''); if (a !== null) run(() => modelsApi.prefs(p.id, { aliases: { ...p.aliases, [m]: a } })) }}>✎</button>
                    <button className="btn-ghost px-1" title={t('models.setDefault')} onClick={() => run(() => modelsApi.setDefault({ model: m, provider: p.id }, profile))}>★</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function CustomProviderForm({ profile, onDone }: { profile: string; onDone: () => void }) {
  const { t } = useTranslation()
  const [f, setF] = useState({ name: '', base_url: '', api_key: '', model: '', api_mode: '' })
  const [det, setDet] = useState<{ base_url: string; models: string[]; detected: boolean } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const detect = useMutation({ mutationFn: () => modelsApi.detect({ base_url: f.base_url, api_key: f.api_key || undefined }), onSuccess: (d) => { setDet(d); setErr(null) }, onError: (e) => setErr(String((e as Error).message)) })
  const create = useMutation({
    mutationFn: () => modelsApi.createCustom({ name: f.name, base_url: det?.base_url ?? f.base_url, api_key: f.api_key || undefined, model: f.model || undefined, api_mode: f.api_mode || undefined, models: det?.models }, profile),
    onSuccess: (r) => { if (r.detected?.error) setErr(r.detected.error); onDone() }, onError: (e) => setErr(String((e as Error).message)),
  })
  return (
    <div className="card space-y-2 p-3">
      <h3 className="font-medium">{t('models.addCustom')}</h3>
      <div className="grid gap-2 md:grid-cols-2">
        <input className="input" placeholder={t('models.customName')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label={t('models.customName')} />
        <input className="input" placeholder="https://host/v1（可不填版本，自動偵測）" value={f.base_url} onChange={(e) => setF({ ...f, base_url: e.target.value })} aria-label="base_url" />
        <input className="input" type="password" placeholder={t('models.apiKey')} value={f.api_key} onChange={(e) => setF({ ...f, api_key: e.target.value })} aria-label={t('models.apiKey')} autoComplete="off" />
        <div className="flex flex-wrap gap-1">
          <input className="input flex-1 basis-40" placeholder={t('models.defaultModel')} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} list="detected-models" aria-label={t('models.defaultModel')} />
          <datalist id="detected-models">{det?.models.map((m) => <option key={m} value={m} />)}</datalist>
          <select className="input w-auto" value={f.api_mode} onChange={(e) => setF({ ...f, api_mode: e.target.value })} aria-label="api_mode">
            <option value="">chat_completions</option><option value="responses">responses</option><option value="anthropic_messages">anthropic_messages</option>
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button className="btn-outline" disabled={!f.base_url || detect.isPending} onClick={() => detect.mutate()}>{detect.isPending ? t('models.detecting') : t('models.detect')}</button>
        {det && <span className="text-emerald-600 dark:text-emerald-400">{t('models.detected', { url: det.base_url, n: det.models.length })}</span>}
        {err && <span className="text-rose-600 dark:text-rose-400">{err}</span>}
        <span className="ml-auto flex shrink-0 gap-2">
          <button className="btn-outline" onClick={onDone}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={!f.name || !f.base_url || create.isPending} onClick={() => create.mutate()}>{t('common.save')}</button>
        </span>
      </div>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('models.customHint')}</p>
    </div>
  )
}

function SpeechCard({ profile }: { profile: string }) {
  const { t } = useTranslation()
  const q = useQuery({ queryKey: ['models', 'speech', profile], queryFn: () => modelsApi.speech(profile) })
  const qc = useQueryClient()
  const set = useMutation({ mutationFn: (b: Parameters<typeof modelsApi.setSpeech>[0]) => modelsApi.setSpeech(b, profile), onSuccess: () => qc.invalidateQueries({ queryKey: ['models', 'speech'] }) })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorBox error={q.error} />
  const s = q.data!
  const Row = ({ kind, data }: { kind: 'tts' | 'stt'; data: SpeechResp['tts'] | SpeechResp['stt'] }) => (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-sm font-medium">{kind.toUpperCase()}
        <select className="input w-auto" value={data.provider} onChange={(e) => set.mutate({ [kind]: { provider: e.target.value } })} aria-label={`${kind} provider`}>
          <option value="">—</option>{data.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="table-wrap">
        <table className="w-full text-xs">
          <tbody>{data.providers.map((p) => (
            <tr key={p.id} className="border-t border-zinc-200 dark:border-zinc-800">
              <td className="nowrap-cell py-0.5 pr-2 align-top">{p.current ? '★ ' : ''}{p.name}</td>
              <td className="nowrap-cell pr-2 align-top">{p.key_envs.length ? <span className={p.key_set ? 'text-emerald-700 dark:text-emerald-400' : 'text-zinc-600 dark:text-zinc-400'}>{p.key_envs[0]} {p.key_set ? '✓' : '✗'}</span> : <span className="text-zinc-600 dark:text-zinc-400">{t('models.noKeyNeeded')}</span>}</td>
              <td className="min-w-[12rem] align-top text-zinc-600 dark:text-zinc-400">{Object.entries(p.settings).map(([k, v]) => `${k}=${String(v)}`).join(' · ')}</td>
            </tr>))}</tbody>
        </table>
      </div>
    </div>
  )
  return (
    <div className="card space-y-3 p-3">
      <h3 className="font-medium">{t('models.speech')}</h3>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('models.speechHint')}</p>
      <Row kind="tts" data={s.tts} />
      <Row kind="stt" data={s.stt} />
    </div>
  )
}

export function ModelsPage() {
  const { t } = useTranslation()
  const profiles = useProfiles()
  const [profile, setProfile] = useState('default')
  const [adding, setAdding] = useState(false)
  const [onlyConfigured, setOnlyConfigured] = useState(true)
  const q = useQuery({ queryKey: ['models', 'providers', profile], queryFn: () => modelsApi.providers(profile) })
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['models'] })
  const d = q.data
  const groups = d ? [...new Set(d.providers.map((p) => p.group))] : []
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <PageHeader title={t('models.title')} subtitle={t('models.subtitle')} actions={
        <>
          <select className="input w-auto" value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="profile">
            {(profiles.data?.profiles ?? [{ name: 'default' }]).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs"><input type="checkbox" checked={onlyConfigured} onChange={(e) => setOnlyConfigured(e.target.checked)} />{t('models.onlyConfigured')}</label>
          <button className="btn-outline" onClick={() => modelsApi.catalog(true).then(refresh)}>{t('models.refreshAll')}</button>
          <button className="btn-primary" onClick={() => setAdding(true)}>{t('models.addCustom')}</button>
        </>
      } />
      {d && (
        <div className="card p-3 text-sm" data-testid="current-model">
          {t('models.currentDefault')}: <code className="font-semibold">{d.current.model || '—'}</code> · {d.current.provider || '—'} <span className="text-xs text-zinc-600 dark:text-zinc-400">{d.current.base_url}</span>
          <span className="ml-2 text-xs text-zinc-600 dark:text-zinc-400">{t('models.activeAuth')}: {d.active_provider || '—'}</span>
        </div>
      )}
      {adding && <CustomProviderForm profile={profile} onDone={() => { setAdding(false); refresh() }} />}
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {d && groups.map((g) => {
        const list = d.providers.filter((p) => p.group === g && (!onlyConfigured || p.configured || p.kind === 'custom'))
        if (list.length === 0) return null
        return (
          <div key={g}>
            <div className="panel-title">{g}</div>
            <div className="space-y-2">{list.map((p) => <ProviderCard key={p.id} p={p} profile={profile} current={d.current} groups={d.groups} onChanged={refresh} />)}</div>
          </div>
        )
      })}
      {d && d.providers.filter((p) => !onlyConfigured || p.configured).length === 0 && <Empty text={t('models.noneConfigured')} />}
      <SpeechCard profile={profile} />
    </div>
  )
}

const zhTW = {
  nav: { models: '模型' },
  models: {
    title: '模型管理', subtitle: '供應商從 ~/.hermes/auth.json、.env、config.yaml 自動發現；金鑰只留在後端',
    current: '目前', custom: '自訂', keyVia: '金鑰來自', oauthLoggedIn: 'OAuth 已登入', credentials: '{{n}} 組憑證', notConfigured: '未設定', onlyConfigured: '只顯示已設定',
    refreshAll: '重新抓取模型清單', addCustom: '新增自訂供應商', currentDefault: '預設模型', activeAuth: 'auth.json 作用中供應商',
    apiKey: 'API key', saveKey: '存入 .env', clearKey: '清除金鑰', oauthLogin: 'OAuth 登入', logout: '登出', confirmDelete: '刪除供應商 {{name}}？（config.yaml 與 .env 的金鑰一併移除）',
    group: '分組', enabled: '啟用', models: '模型', live: '直接向供應商抓', refresh: '重新整理', visible: '可見', alias: '別名', aliasPrompt: '{{m}} 的別名（留空清除）', setDefault: '設為預設模型',
    oauthTitle: '{{p}} OAuth 登入', oauthOpen: '1. 打開網址：', oauthCode: '2. 輸入代碼：', oauthPaste: '若流程要求貼回 code，貼在這裡', oauthSubmit: '送出', oauthDone: '登入完成',
    customName: '名稱', defaultModel: '預設模型', detect: '偵測端點', detecting: '偵測中…', detected: '可用：{{url}}（{{n}} 個模型）',
    customHint: '寫入 config.yaml providers.<slug>（name/base_url/model/models/key_env）；金鑰存 .env 的 HERMES_CUSTOM_<SLUG>，與 Hermes 自己的寫法一致。',
    speech: 'STT／TTS 供應商目錄', speechHint: '這裡只切換供應商與檢查金鑰；語音功能本體在語音模組。', noKeyNeeded: '不需金鑰', noneConfigured: '沒有已設定的供應商，關掉「只顯示已設定」查看全部。',
  },
}
const en = {
  nav: { models: 'Models' },
  models: {
    title: 'Models', subtitle: 'Providers discovered from ~/.hermes/auth.json, .env, config.yaml; keys stay on the server',
    current: 'current', custom: 'custom', keyVia: 'key via', oauthLoggedIn: 'OAuth signed in', credentials: '{{n}} credentials', notConfigured: 'not configured', onlyConfigured: 'configured only',
    refreshAll: 'Refresh model lists', addCustom: 'Add custom provider', currentDefault: 'Default model', activeAuth: 'active provider',
    apiKey: 'API key', saveKey: 'Save to .env', clearKey: 'Clear key', oauthLogin: 'OAuth sign-in', logout: 'Sign out', confirmDelete: 'Delete provider {{name}}?',
    group: 'Group', enabled: 'Enabled', models: 'Models', live: 'fetch live', refresh: 'Refresh', visible: 'visible', alias: 'Alias', aliasPrompt: 'Alias for {{m}}', setDefault: 'Set as default',
    oauthTitle: '{{p}} OAuth', oauthOpen: '1. Open:', oauthCode: '2. Enter code:', oauthPaste: 'Paste callback code here if asked', oauthSubmit: 'Submit', oauthDone: 'Signed in',
    customName: 'Name', defaultModel: 'Default model', detect: 'Detect endpoint', detecting: 'Detecting…', detected: 'OK: {{url}} ({{n}} models)',
    customHint: 'Writes config.yaml providers.<slug>; key stored as HERMES_CUSTOM_<SLUG> in .env.',
    speech: 'STT / TTS providers', speechHint: 'Switch providers and check keys here; voice features live in the voice module.', noKeyNeeded: 'no key needed', noneConfigured: 'No configured providers.',
  },
}

const mod: StudioModule = {
  name: 'models',
  routes: [{ path: '/models', element: <ModelsPage /> }],
  nav: [{ to: '/models', key: 'models', order: 32, group: 'agents', icon: 'Sparkles' }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
