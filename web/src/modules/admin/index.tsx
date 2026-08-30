import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { StudioModule } from '../registry'
import { PageHeader } from '../../components/PageHeader'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import { Tabs } from '../../components/admin2/Tabs'
import { getToken, request } from '../../api/client'
import { useAuth } from '../../auth/AuthContext'

export interface McpServer { name: string; transport: string; url?: string | null; command?: string | null; args: string[]; auth?: string | null; enabled: boolean; tools: unknown }
export interface Plugin { name: string; status: string; version?: string; description?: string; source?: string; enabled: boolean }
export interface StudioUpdateInfo {
  studio_latest: string | null
  studio_update_available: boolean | null
  studio_release: { tag: string; url: string } | null
  studio_repo: string
  studio_update_cmd: string
  studio_update_check_enabled: boolean
}
export interface VersionInfo extends StudioUpdateInfo { studio: { version: string }; hermes: { version: string; date?: string; upstream?: string; behind?: number | null; python?: string; error?: string }; latest: { tag: string; url: string } | null; update_check_enabled: boolean; update_available: boolean | null; repo: string }
export interface StudioVersionInfo extends StudioUpdateInfo { studio: { version: string } }

const json = (b: unknown) => JSON.stringify(b)
const q = (o: Record<string, string>) => new URLSearchParams(o).toString()
export const adminApi = {
  cwds: () => request<{ id: string; label: string; path: string }[]>('/terminal/cwds'),
  terminalUrl: (cwd: string, cols: number, rows: number) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/ws/terminal?${q({ token: getToken() ?? '', cwd, cols: String(cols), rows: String(rows) })}`
  },
  mcpList: (profile: string) => request<{ profile: string; servers: McpServer[] }>(`/mcp/servers?${q({ profile })}`),
  mcpAdd: (b: { name: string; profile: string; url?: string; command?: string; args?: string[]; auth?: string; env?: Record<string, string> }) =>
    request<{ ok: boolean; output: string }>('/mcp/servers', { method: 'POST', body: json(b) }),
  mcpRemove: (name: string, profile: string) => request<{ ok: boolean; output: string }>(`/mcp/servers/${encodeURIComponent(name)}?${q({ profile })}`, { method: 'DELETE' }),
  mcpTest: (name: string, profile: string) => request<{ ok: boolean; output: string }>(`/mcp/servers/${encodeURIComponent(name)}/test?${q({ profile })}`, { method: 'POST' }),
  plugins: () => request<Plugin[]>('/plugins'),
  pluginToggle: (name: string, action: 'enable' | 'disable') => request<{ ok: boolean; output: string }>(`/plugins/${encodeURIComponent(name)}/${action}`, { method: 'POST' }),
  version: (check: boolean) => request<VersionInfo>(`/version?check=${check ? 1 : 0}`),
  studioVersion: () => request<StudioVersionInfo>('/version/studio'),
  profiles: () => request<{ profiles: { name: string }[] }>('/hermes/status').then((r) => r.profiles.map((p) => p.name)),
}

const zhTW = {
  nav: { admin: '管理' },
  admin: {
    title: '管理與執行環境',
    subtitle: 'Web 終端、MCP 伺服器、Plugins 與版本（裝置／區網節點為桌面版功能，本產品不做）',
    tabTerminal: '終端',
    tabMcp: 'MCP',
    tabPlugins: 'Plugins',
    tabVersion: '版本',
    cwd: '工作目錄',
    connect: '連線',
    disconnect: '中斷',
    connected: '已連線',
    exited: '已結束',
    adminOnly: '終端僅 owner/admin 可用',
    profile: 'Profile',
    mcpName: '名稱',
    mcpTransport: '傳輸',
    mcpTarget: 'URL / 指令',
    mcpAuth: '認證',
    mcpTest: '測試',
    mcpRemove: '刪除',
    mcpAdd: '新增 MCP 伺服器',
    mcpUrl: 'HTTP/SSE URL',
    mcpCommand: 'stdio 指令（例如 npx）',
    mcpArgs: '參數（空白分隔）',
    mcpEnv: '環境變數（KEY=VALUE，每行一個）',
    mcpNone: '無',
    output: '輸出',
    pluginEnable: '啟用',
    pluginDisable: '停用',
    hermesVersion: 'Hermes 版本',
    studioVersion: 'Studio 版本',
    latest: 'GitHub 最新',
    checkUpdates: '檢查更新',
    updateAvailable: '有新版本可用',
    upToDate: '已是最新',
    checkDisabled: '更新檢查已關閉（STUDIO_UPDATE_CHECK=0）',
    behind: '落後 upstream {{n}} 個 commit',
    mhcLatest: 'MyHermesCompany 最新',
    mhcUpdateAvailable: '有新版 v{{v}}',
    mhcUpdateHow: '更新方式：在終端跑',
    mhcUpdateNote: '站內不做一鍵更新（會把正在服務的自己關掉）。',
    mhcCheckDisabled: '更新檢查已關閉（MHC_UPDATE_CHECK=0）',
  },
}
const en = { nav: { admin: 'Admin' }, admin: { title: 'Admin', tabTerminal: 'Terminal', tabMcp: 'MCP', tabPlugins: 'Plugins', tabVersion: 'Version', connect: 'Connect' } }

type Tab = 'terminal' | 'mcp' | 'plugins' | 'version'

export function AdminPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('version')
  const tabs = [
    { id: 'terminal' as Tab, label: t('admin.tabTerminal') },
    { id: 'mcp' as Tab, label: t('admin.tabMcp') },
    { id: 'plugins' as Tab, label: t('admin.tabPlugins') },
    { id: 'version' as Tab, label: t('admin.tabVersion') },
  ]
  return (
    <div className="flex h-full flex-col p-4">
      <PageHeader title={t('admin.title')} subtitle={t('admin.subtitle')} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="min-h-0 flex-1 pt-3">
        {tab === 'terminal' && <TerminalTab />}
        {tab === 'mcp' && <McpTab />}
        {tab === 'plugins' && <PluginsTab />}
        {tab === 'version' && <VersionTab />}
      </div>
    </div>
  )
}

let WS: typeof WebSocket | undefined
export function setAdminWebSocketImpl(w: typeof WebSocket) {
  WS = w
}

function TerminalTab() {
  const { t } = useTranslation()
  const { member } = useAuth()
  const isAdmin = member?.role === 'owner' || member?.role === 'admin'
  const cwdsQ = useQuery({ queryKey: ['terminal', 'cwds'], queryFn: adminApi.cwds, enabled: isAdmin })
  const [cwd, setCwd] = useState('workspace')
  const [status, setStatus] = useState<'idle' | 'connected' | 'exited'>('idle')
  const host = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const termRef = useRef<{ dispose: () => void } | null>(null)
  const disconnect = () => {
    wsRef.current?.close()
    wsRef.current = null
    termRef.current?.dispose()
    termRef.current = null
    setStatus('idle')
  }
  const connect = async () => {
    disconnect()
    const { Terminal } = await import('@xterm/xterm')
    const { FitAddon } = await import('@xterm/addon-fit')
    await import('@xterm/xterm/css/xterm.css')
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, Menlo, monospace', theme: { background: '#18181b' } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    if (host.current) {
      host.current.innerHTML = ''
      term.open(host.current)
      try { fit.fit() } catch { /* jsdom */ }
    }
    const Impl = WS ?? WebSocket
    const ws = new Impl(adminApi.terminalUrl(cwd, term.cols || 100, term.rows || 30))
    ws.onmessage = (ev) => {
      const data = ev.data as string
      if (data.startsWith('{')) {
        try {
          const m = JSON.parse(data)
          if (m.type === 'ready') { setStatus('connected'); return }
          if (m.type === 'exit') { setStatus('exited'); term.write('\r\n[exit]\r\n'); return }
          if (m.type === 'error') { term.write(`\r\n[error] ${m.message}\r\n`); setStatus('exited'); return }
        } catch { /* fallthrough: raw text */ }
      }
      term.write(data)
    }
    ws.onclose = () => setStatus((s) => (s === 'connected' ? 'exited' : s))
    term.onData((d) => ws.readyState === 1 && ws.send(d))
    term.onResize(({ cols, rows }) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'resize', cols, rows })))
    const onWin = () => { try { fit.fit() } catch { /* ignore */ } }
    window.addEventListener('resize', onWin)
    wsRef.current = ws
    termRef.current = { dispose: () => { window.removeEventListener('resize', onWin); term.dispose() } }
  }
  useEffect(() => () => disconnect(), [])
  if (!isAdmin) return <Empty text={t('admin.adminOnly')} />
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <label className="flex items-center gap-1 text-xs">{t('admin.cwd')}
          <select aria-label={t('admin.cwd')} className="input w-auto" value={cwd} onChange={(e) => setCwd(e.target.value)}>
            {(cwdsQ.data ?? [{ id: 'workspace', label: 'workspace', path: '' }]).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <button className="btn-primary" onClick={connect}>{t('admin.connect')}</button>
        <button className="btn-outline" onClick={disconnect} disabled={status === 'idle'}>{t('admin.disconnect')}</button>
        <span className="text-xs text-zinc-600 dark:text-zinc-400" data-testid="term-status">{status === 'connected' ? t('admin.connected') : status === 'exited' ? t('admin.exited') : ''}</span>
      </div>
      <div ref={host} className="min-h-[300px] flex-1 overflow-hidden rounded-md bg-zinc-900 p-1" data-testid="terminal-host" />
    </div>
  )
}

function McpTab() {
  const { t } = useTranslation()
  const { member } = useAuth()
  const isAdmin = member?.role === 'owner' || member?.role === 'admin'
  const qc = useQueryClient()
  const profilesQ = useQuery({ queryKey: ['admin2', 'profiles'], queryFn: adminApi.profiles, staleTime: 60_000 })
  const [profile, setProfile] = useState('default')
  const listQ = useQuery({ queryKey: ['mcp', profile], queryFn: () => adminApi.mcpList(profile) })
  const [out, setOut] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', url: '', command: '', args: '', auth: '', env: '' })
  const refresh = () => qc.invalidateQueries({ queryKey: ['mcp'] })
  const show = (r: { output: string }) => setOut(r.output)
  const onErr = (e: unknown) => setOut(String((e as Error).message))
  const add = useMutation({
    mutationFn: () => {
      const env: Record<string, string> = {}
      form.env.split('\n').forEach((l) => { const [k, ...v] = l.split('='); if (k.trim() && v.length) env[k.trim()] = v.join('=').trim() })
      return adminApi.mcpAdd({ name: form.name, profile, url: form.url || undefined, command: form.command || undefined, args: form.args.split(/\s+/).filter(Boolean), auth: form.auth || undefined, env })
    },
    onSuccess: (r) => { show(r); refresh(); setForm({ name: '', url: '', command: '', args: '', auth: '', env: '' }) },
    onError: onErr,
  })
  const remove = useMutation({ mutationFn: (n: string) => adminApi.mcpRemove(n, profile), onSuccess: (r) => { show(r); refresh() }, onError: onErr })
  const test = useMutation({ mutationFn: (n: string) => adminApi.mcpTest(n, profile), onSuccess: (r) => setOut(`${r.ok ? 'OK' : 'FAIL'}\n${r.output}`), onError: onErr })
  return (
    <div className="grid min-h-0 grid-cols-1 gap-3 overflow-auto lg:h-full lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">{t('admin.profile')}
          <select aria-label={t('admin.profile')} className="input w-auto" value={profile} onChange={(e) => setProfile(e.target.value)}>{(profilesQ.data ?? ['default']).map((p) => <option key={p}>{p}</option>)}</select>
        </label>
        {listQ.isLoading && <Loading />}
        {listQ.error && <ErrorBox error={listQ.error} />}
        {listQ.data?.servers.length === 0 && <Empty text={t('admin.mcpNone')} />}
        <div className="table-wrap">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-zinc-600 dark:text-zinc-400"><tr><th className="p-1">{t('admin.mcpName')}</th><th className="p-1">{t('admin.mcpTransport')}</th><th className="p-1">{t('admin.mcpTarget')}</th><th className="p-1">{t('admin.mcpAuth')}</th><th className="p-1"></th></tr></thead>
          <tbody>
            {listQ.data?.servers.map((s) => (
              <tr key={s.name} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className="nowrap-cell p-1 font-medium">{s.name}{!s.enabled && <span className="ml-1 text-[10px] text-zinc-600 dark:text-zinc-400">(disabled)</span>}</td>
                <td className="nowrap-cell p-1">{s.transport}</td>
                <td className="max-w-[320px] truncate p-1 text-xs" title={s.url ?? `${s.command} ${s.args.join(' ')}`}>{s.url ?? `${s.command ?? ''} ${s.args.join(' ')}`}</td>
                <td className="nowrap-cell p-1 text-xs">{s.auth ?? '—'}</td>
                <td className="nowrap-cell p-1 text-right">
                  <button className="btn-ghost text-xs" disabled={!isAdmin || test.isPending} onClick={() => test.mutate(s.name)}>{t('admin.mcpTest')}</button>
                  <button className="btn-ghost text-xs text-rose-600 dark:text-rose-400" disabled={!isAdmin} onClick={() => confirm(`${t('admin.mcpRemove')} ${s.name}?`) && remove.mutate(s.name)}>{t('admin.mcpRemove')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {out && <pre className="card max-h-64 overflow-auto p-2 text-xs" data-testid="mcp-output"><b>{t('admin.output')}</b>{'\n'}{out}</pre>}
      </div>
      <form className="card space-y-2 p-3 text-sm" onSubmit={(e) => { e.preventDefault(); add.mutate() }}>
        <div className="font-medium">{t('admin.mcpAdd')}</div>
        <input className="input" placeholder={t('admin.mcpName')} aria-label={t('admin.mcpName')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="input" placeholder={t('admin.mcpUrl')} aria-label={t('admin.mcpUrl')} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        <input className="input" placeholder={t('admin.mcpCommand')} value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
        <input className="input" placeholder={t('admin.mcpArgs')} value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
        <select className="input" value={form.auth} onChange={(e) => setForm({ ...form, auth: e.target.value })}><option value="">{t('admin.mcpAuth')}: —</option><option value="oauth">oauth</option><option value="header">header</option></select>
        <textarea className="input h-16" placeholder={t('admin.mcpEnv')} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
        <button className="btn-primary" disabled={!isAdmin || !form.name || (!form.url && !form.command) || add.isPending}>{t('admin.mcpAdd')}</button>
      </form>
    </div>
  )
}

function PluginsTab() {
  const { t } = useTranslation()
  const { member } = useAuth()
  const isAdmin = member?.role === 'owner' || member?.role === 'admin'
  const qc = useQueryClient()
  const q2 = useQuery({ queryKey: ['plugins'], queryFn: adminApi.plugins })
  const [out, setOut] = useState<string | null>(null)
  const toggle = useMutation({ mutationFn: (p: Plugin) => adminApi.pluginToggle(p.name, p.enabled ? 'disable' : 'enable'), onSuccess: (r) => { setOut(r.output); qc.invalidateQueries({ queryKey: ['plugins'] }) }, onError: (e) => setOut(String((e as Error).message)) })
  if (q2.isLoading) return <Loading />
  if (q2.error) return <ErrorBox error={q2.error} onRetry={() => q2.refetch()} />
  return (
    <div className="space-y-2 overflow-auto">
      <div className="table-wrap">
      <table className="w-full text-sm">
        <tbody>
          {q2.data?.map((p) => (
            <tr key={p.name} className="border-t border-zinc-200 dark:border-zinc-800">
              <td className="nowrap-cell p-1 font-medium">{p.name}<div className="text-[10px] text-zinc-600 dark:text-zinc-400">{p.version} · {p.source}</div></td>
              <td className="min-w-[10rem] max-w-[520px] p-1 text-xs text-zinc-600 dark:text-zinc-300"><span className="line-clamp-3" title={p.description}>{p.description}</span></td>
              <td className="nowrap-cell p-1 text-xs">{p.status}</td>
              <td className="nowrap-cell p-1 text-right">
                <button className={p.enabled ? 'btn-outline text-xs' : 'btn-primary text-xs'} disabled={!isAdmin || toggle.isPending} onClick={() => toggle.mutate(p)} aria-label={`${p.enabled ? t('admin.pluginDisable') : t('admin.pluginEnable')} ${p.name}`}>
                  {p.enabled ? t('admin.pluginDisable') : t('admin.pluginEnable')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {out && <pre className="card max-h-48 overflow-auto p-2 text-xs">{out}</pre>}
    </div>
  )
}

function VersionTab() {
  const { t } = useTranslation()
  const [check, setCheck] = useState(true)
  const v = useQuery({ queryKey: ['version', check], queryFn: () => adminApi.version(check), staleTime: 60_000 })
  if (v.isLoading) return <Loading />
  if (v.error) return <ErrorBox error={v.error} onRetry={() => v.refetch()} />
  const d = v.data!
  return (
    <div className="max-w-xl space-y-3">
      <div className="card p-4 text-sm">
        <dl className="grid grid-cols-1 gap-y-1 sm:grid-cols-[minmax(0,140px)_minmax(0,1fr)]">
          <dt className="text-zinc-600 dark:text-zinc-400">{t('admin.hermesVersion')}</dt><dd><b data-testid="hermes-version">{d.hermes.version || d.hermes.error || '—'}</b> {d.hermes.date && <span className="text-xs text-zinc-600 dark:text-zinc-400">({d.hermes.date}{d.hermes.upstream ? ` · ${d.hermes.upstream}` : ''})</span>}</dd>
          {d.hermes.behind != null && <><dt className="text-zinc-600 dark:text-zinc-400"></dt><dd className="text-xs text-amber-700 dark:text-amber-300">{t('admin.behind', { n: d.hermes.behind })}</dd></>}
          <dt className="text-zinc-600 dark:text-zinc-400">{t('admin.studioVersion')}</dt><dd>{d.studio.version}</dd>
          <dt className="text-zinc-600 dark:text-zinc-400">{t('admin.latest')}</dt>
          <dd>
            {!d.update_check_enabled ? <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('admin.checkDisabled')}</span> : d.latest ? (
              <a className="text-indigo-600 dark:text-indigo-400 underline dark:text-indigo-300" href={d.latest.url} target="_blank" rel="noreferrer">{d.latest.tag}</a>
            ) : '—'}
            {d.update_available === true && <span className="ml-2 rounded bg-amber-100 px-1.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{t('admin.updateAvailable')}</span>}
            {d.update_available === false && <span className="ml-2 rounded bg-emerald-100 px-1.5 text-xs text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">{t('admin.upToDate')}</span>}
          </dd>
        </dl>
        <label className="mt-3 flex items-center gap-1 text-xs"><input type="checkbox" checked={check} onChange={(e) => setCheck(e.target.checked)} />{t('admin.checkUpdates')} ({d.repo})</label>
      </div>
      <StudioUpdateCard d={d} />
    </div>
  )
}

/** MyHermesCompany 自己的新版：只告訴使用者跑哪個指令，不做站內一鍵更新（會把正在服務的自己關掉）。 */
export function StudioUpdateCard({ d }: { d: StudioUpdateInfo & { studio: { version: string } } }) {
  const { t } = useTranslation()
  return (
    <div className="card p-4 text-sm" data-testid="mhc-update-card">
      <dl className="grid grid-cols-1 gap-y-1 sm:grid-cols-[minmax(0,140px)_minmax(0,1fr)]">
        <dt className="text-zinc-600 dark:text-zinc-400">{t('admin.mhcLatest')}</dt>
        <dd>
          {!d.studio_update_check_enabled ? (
            <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('admin.mhcCheckDisabled')}</span>
          ) : d.studio_release ? (
            <a className="text-indigo-600 underline dark:text-indigo-300" href={d.studio_release.url} target="_blank" rel="noreferrer" data-testid="mhc-latest-tag">{d.studio_release.tag}</a>
          ) : d.studio_latest ? (
            <span data-testid="mhc-latest-tag">v{d.studio_latest}</span>
          ) : '—'}
          {d.studio_update_available === true && <span className="ml-2 rounded bg-amber-100 px-1.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200" data-testid="mhc-update-badge">{t('admin.mhcUpdateAvailable', { v: d.studio_latest })}</span>}
          {d.studio_update_available === false && <span className="ml-2 rounded bg-emerald-100 px-1.5 text-xs text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">{t('admin.upToDate')}</span>}
        </dd>
      </dl>
      {d.studio_update_available === true && (
        <p className="mt-2 break-words text-xs text-zinc-600 dark:text-zinc-400">
          {t('admin.mhcUpdateHow')} <code className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800" data-testid="mhc-update-cmd">{d.studio_update_cmd}</code>
          <br />{t('admin.mhcUpdateNote')}
        </p>
      )}
    </div>
  )
}

const mod: StudioModule = {
  name: 'admin',
  routes: [{ path: '/admin', element: <AdminPage /> }],
  nav: [{ to: '/admin', key: 'admin', order: 90, group: 'system', icon: 'Server' }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
