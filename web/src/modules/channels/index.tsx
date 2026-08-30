// B. 平台頻道：單頁設定 11 平台（LINE 優先）；憑證寫 .env、行為寫 config.yaml；gateway 狀態／重啟
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../api/client'
import { PageHeader } from '../../components/PageHeader'
import { EmptyState } from '../../components/EmptyState'
import '../../guide/i18n'
import { ErrorBox, Loading } from '../../components/QueryState'
import type { StudioModule } from '../registry'

export interface ChannelField { name: string; label: string; required: boolean; secret: boolean; kind: string; set: boolean; hint: string; default: string; value?: string }
export interface ChannelConfigKey { name: string; label: string; kind: string; default: unknown; hint: string }
export interface ChannelPlatform {
  id: string; label: string; description: string; docs_url: string; configured: boolean; fields: ChannelField[]
  config_section: string | null; config_keys: ChannelConfigKey[]; config: Record<string, unknown>; plugin: string
  webhook_url?: string; webhook_path?: string; webhook_hint?: string
}
export interface GatewayStatus { ok: boolean; running: boolean; pid: number | null; supervised: boolean; stale_service: boolean; profiles: { name: string; running: boolean; pid: number | null }[]; raw: string }

const json = (b: unknown) => JSON.stringify(b)
export const channelsApi = {
  list: (profile?: string) => request<{ platforms: ChannelPlatform[]; env_path: string; config_path: string }>(`/channels${profile ? `?profile=${encodeURIComponent(profile)}` : ''}`),
  save: (id: string, body: { env?: Record<string, string | null>; config?: Record<string, unknown>; restart?: boolean; profile?: string }) =>
    request<{ ok: boolean; platform: ChannelPlatform; restart: string | null }>(`/channels/${id}`, { method: 'PUT', body: json(body) }),
  clear: (id: string) => request<{ ok: boolean }>(`/channels/${id}`, { method: 'DELETE' }),
  gatewayStatus: () => request<GatewayStatus>('/channels/gateway/status'),
  gatewayRestart: () => request<{ ok: boolean; output: string }>('/channels/gateway/restart', { method: 'POST' }),
}

function PlatformForm({ p, onSaved }: { p: ChannelPlatform; onSaved: () => void }) {
  const { t } = useTranslation()
  const [env, setEnv] = useState<Record<string, string>>({})
  const [cfg, setCfg] = useState<Record<string, unknown>>(p.config)
  const [restart, setRestart] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    const init: Record<string, string> = {}
    for (const f of p.fields) if (!f.secret) init[f.name] = f.value ?? ''
    setEnv(init)
    setCfg(p.config)
  }, [p])
  const save = useMutation({
    mutationFn: () => {
      const envPatch: Record<string, string | null> = {}
      for (const f of p.fields) {
        const v = env[f.name]
        if (f.secret) { if (v !== undefined && v !== '') envPatch[f.name] = v }
        else if (v !== undefined && v !== (f.value ?? '')) envPatch[f.name] = v === '' ? null : v
      }
      const cfgPatch: Record<string, unknown> = {}
      for (const k of p.config_keys) if (cfg[k.name] !== p.config[k.name]) cfgPatch[k.name] = cfg[k.name]
      return channelsApi.save(p.id, { env: envPatch, config: p.config_section ? cfgPatch : undefined, restart })
    },
    onSuccess: (r) => { setMsg(restart ? t('channels.savedRestarted') : t('channels.saved')); onSaved(); if (r.restart) setMsg((m) => `${m} · ${r.restart}`) },
  })
  const clear = useMutation({ mutationFn: () => channelsApi.clear(p.id), onSuccess: onSaved })
  return (
    <div className="card p-4" data-testid={`platform-${p.id}`}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-medium">{p.label}
            <span className={`rounded px-1.5 text-[10px] ${p.configured ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300'}`}>
              {p.configured ? t('channels.configured') : t('channels.notConfigured')}
            </span>
          </h2>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">{p.description} {p.docs_url && <a className="underline" href={p.docs_url} target="_blank" rel="noreferrer">{t('channels.console')}</a>}</p>
        </div>
      </div>
      {p.webhook_url && (
        <div className="mb-3 rounded-md bg-amber-50 p-2 text-xs dark:bg-amber-900/20">
          <div>{t('channels.webhookUrl')}：<code data-testid="line-webhook">{p.webhook_url}</code></div>
          <div className="text-zinc-600 dark:text-zinc-400">{p.webhook_hint}</div>
        </div>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        {p.fields.map((f) => (
          <label key={f.name} className="text-xs">
            <span className="text-zinc-600 dark:text-zinc-400">{f.label}{f.required && ' *'} <code className="text-[10px]">{f.name}</code>
              {f.secret && f.set && <span className="ml-1 text-emerald-600 dark:text-emerald-400">{t('channels.keySet')}</span>}</span>
            {f.kind === 'bool' ? (
              <select className="input" value={env[f.name] ?? ''} onChange={(e) => setEnv({ ...env, [f.name]: e.target.value })}>
                <option value="">{t('channels.unset')}</option><option value="true">true</option><option value="false">false</option>
              </select>
            ) : (
              <input className="input" type={f.secret ? 'password' : 'text'} placeholder={f.secret ? (f.set ? t('channels.secretKeep') : '') : f.default || f.hint}
                value={env[f.name] ?? ''} onChange={(e) => setEnv({ ...env, [f.name]: e.target.value })} autoComplete="off" aria-label={f.label} />
            )}
            {f.hint && !f.secret && <span className="text-[10px] text-zinc-600 dark:text-zinc-400">{f.hint}</span>}
          </label>
        ))}
      </div>
      {p.config_keys.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('channels.behaviour')} <code>config.yaml › {p.config_section}</code></div>
          <div className="grid gap-2 md:grid-cols-3">
            {p.config_keys.map((k) => (
              <label key={k.name} className="text-xs">
                <span className="text-zinc-600 dark:text-zinc-400">{k.label}</span>
                {k.kind === 'bool' ? (
                  <select className="input" value={String(cfg[k.name] ?? k.default ?? false)} onChange={(e) => setCfg({ ...cfg, [k.name]: e.target.value === 'true' })}>
                    <option value="true">true</option><option value="false">false</option>
                  </select>
                ) : (
                  <input className="input" type={k.kind === 'int' ? 'number' : 'text'} value={String(cfg[k.name] ?? k.default ?? '')}
                    onChange={(e) => setCfg({ ...cfg, [k.name]: k.kind === 'int' ? Number(e.target.value) : e.target.value })} aria-label={k.label} />
                )}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="mt-3 flex items-center gap-3 text-xs">
        <button className="btn-primary" disabled={save.isPending} onClick={() => { setMsg(null); save.mutate() }}>{t('common.save')}</button>
        <label className="flex items-center gap-1"><input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />{t('channels.restartAfterSave')}</label>
        {p.configured && <button className="btn-ghost text-rose-600 dark:text-rose-400" onClick={() => { if (confirm(t('channels.confirmClear', { name: p.label }))) clear.mutate() }}>{t('channels.clear')}</button>}
        {msg && <span className="text-emerald-600 dark:text-emerald-400">{msg}</span>}
        {save.error && <span className="text-rose-600 dark:text-rose-400">{String((save.error as Error).message)}</span>}
      </div>
    </div>
  )
}

function GatewayCard() {
  const { t } = useTranslation()
  const q = useQuery({ queryKey: ['channels', 'gateway'], queryFn: channelsApi.gatewayStatus, refetchInterval: 30_000 })
  const qc = useQueryClient()
  const restart = useMutation({ mutationFn: channelsApi.gatewayRestart, onSuccess: () => qc.invalidateQueries({ queryKey: ['channels', 'gateway'] }) })
  const s = q.data
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">{t('channels.gateway')}</h2>
        <div className="flex gap-2">
          <button className="btn-outline" onClick={() => q.refetch()} disabled={q.isFetching}>{t('common.retry')}</button>
          <button className="btn-outline" onClick={() => restart.mutate()} disabled={restart.isPending}>{restart.isPending ? t('channels.restarting') : t('channels.restart')}</button>
        </div>
      </div>
      {q.isLoading && <Loading />}
      {s && (
        <div className="mt-2 text-sm">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${s.running ? 'bg-emerald-500' : 'bg-rose-500'}`} />
            {s.running ? t('channels.running', { pid: s.pid ?? '?' }) : t('channels.stopped')}
            {s.stale_service && <span className="text-xs text-amber-700 dark:text-amber-400">{t('channels.stale')}</span>}
          </div>
          {s.profiles.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-2 text-xs">
              {s.profiles.map((p) => <li key={p.name} className="rounded border px-1.5 dark:border-zinc-700">{p.running ? '✓' : '✗'} {p.name}</li>)}
            </ul>
          )}
          {restart.data?.output && <pre className="mt-2 max-h-24 overflow-auto text-[10px] text-zinc-600 dark:text-zinc-400">{restart.data.output}</pre>}
        </div>
      )}
    </div>
  )
}

export function ChannelsPage() {
  const { t } = useTranslation()
  const q = useQuery({ queryKey: ['channels'], queryFn: () => channelsApi.list() })
  const qc = useQueryClient()
  const [open, setOpen] = useState<string>('line')
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <PageHeader title={t('channels.title')} subtitle={t('channels.subtitle')} />
      <GatewayCard />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <>
          {q.data.platforms.length > 0 && q.data.platforms.every((p) => !p.configured) && (
            <div className="card"><EmptyState testId="empty-channels" title={t('guide.empty.channels.title')} body={t('guide.empty.channels.body')} action={{ label: t('guide.empty.channels.action'), onClick: () => { setOpen('line'); document.querySelector('[data-testid="platform-line"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } }} /></div>
          )}
          <div className="flex flex-wrap gap-1 text-sm">
            {q.data.platforms.map((p) => (
              <button key={p.id} onClick={() => setOpen(p.id)}
                className={`rounded-md px-3 py-1 ${open === p.id ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'}`}>
                <span className={`mr-1 inline-block h-2 w-2 rounded-full ${p.configured ? 'bg-emerald-500' : 'bg-zinc-400'}`} />{p.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('channels.paths', { env: q.data.env_path, cfg: q.data.config_path })}</p>
          {q.data.platforms.filter((p) => p.id === open).map((p) => (
            <PlatformForm key={p.id} p={p} onSaved={() => qc.invalidateQueries({ queryKey: ['channels'] })} />
          ))}
        </>
      )}
    </div>
  )
}

const zhTW = {
  nav: { channels: '頻道' },
  channels: {
    title: '平台頻道', subtitle: '把 Hermes 接到 LINE、Telegram、Discord、Slack…（憑證只寫進 ~/.hermes/.env，不會回傳到瀏覽器）',
    configured: '已設定', notConfigured: '未設定', console: '開發者主控台', webhookUrl: 'Webhook URL', keySet: '（已存）', secretKeep: '留空＝保留現有值', unset: '（未設）',
    behaviour: '行為設定', restartAfterSave: '儲存後重啟 gateway', saved: '已儲存', savedRestarted: '已儲存並重啟 gateway', clear: '移除此平台憑證',
    confirmClear: '移除 {{name}} 的所有 env 設定？', gateway: 'Gateway 狀態', restart: '重啟 gateway', restarting: '重啟中…', running: '執行中（PID {{pid}}）', stopped: '未執行',
    stale: '服務定義過期，建議 hermes gateway start', paths: '寫入：{{env}} ／ {{cfg}}',
  },
}
const en = {
  nav: { channels: 'Channels' },
  channels: {
    title: 'Channels', subtitle: 'Connect Hermes to LINE, Telegram, Discord, Slack… (secrets are written to ~/.hermes/.env and never returned)',
    configured: 'configured', notConfigured: 'not configured', console: 'developer console', webhookUrl: 'Webhook URL', keySet: '(stored)', secretKeep: 'leave blank to keep', unset: '(unset)',
    behaviour: 'Behaviour', restartAfterSave: 'restart gateway after save', saved: 'Saved', savedRestarted: 'Saved and gateway restarted', clear: 'Remove credentials',
    confirmClear: 'Remove all env settings of {{name}}?', gateway: 'Gateway', restart: 'Restart gateway', restarting: 'Restarting…', running: 'running (PID {{pid}})', stopped: 'stopped',
    stale: 'service definition stale', paths: 'Writes: {{env}} / {{cfg}}',
  },
}

const mod: StudioModule = {
  name: 'channels',
  routes: [{ path: '/channels', element: <ChannelsPage /> }],
  nav: [{ to: '/channels', key: 'channels', order: 42, group: 'connect', icon: 'Cable' }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
