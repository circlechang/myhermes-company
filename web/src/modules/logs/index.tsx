import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { StudioModule } from '../registry'
import { PageHeader } from '../../components/PageHeader'
import { CollapsiblePanel, PanelGroup, WorkArea } from '../../components/layout/index'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import { fmtSize, fmtTime } from '../../components/admin2/Tabs'
import { getToken, request } from '../../api/client'

export interface LogFile { id: string; group: string; name: string; size: number; mtime: number }
export interface LogEntry { raw: string; ts: string | null; level: string | null; component: string | null; msg: string; http: { method: string; path: string; status: number } | null }

const q = (o: Record<string, string>) => new URLSearchParams(o).toString()
export const logsApi = {
  files: () => request<LogFile[]>('/logs/files'),
  read: (file: string, lines: number, level: string, qs: string, httpOnly: boolean) =>
    request<{ file: string; size: number; entries: LogEntry[] }>(`/logs/read?${q({ file, lines: String(lines), level, q: qs, http_only: httpOnly ? '1' : '0' })}`),
  wsUrl: (file: string, level: string, qs: string) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/ws/logs?${q({ token: getToken() ?? '', file, level, q: qs })}`
  },
}

const zhTW = {
  nav: { logs: '日誌' },
  logs: {
    title: '日誌',
    subtitle: 'Hermes logs、各 profile logs 與 Studio 自己的 log；可依等級／關鍵字篩選並即時追蹤',
    file: '檔案',
    level: '等級',
    all: '全部',
    search: '關鍵字',
    lines: '行數',
    httpOnly: '只看 HTTP',
    follow: '即時追蹤',
    following: '追蹤中',
    refresh: '重新整理',
    empty: '沒有符合的行',
    rotated: '（檔案已輪替，重新讀取）',
  },
}
const en = { nav: { logs: 'Logs' }, logs: { title: 'Logs', file: 'File', level: 'Level', all: 'All', search: 'Search', follow: 'Follow' } }

const LEVEL_CLS: Record<string, string> = {
  DEBUG: 'text-zinc-600 dark:text-zinc-400',
  INFO: 'text-sky-700 dark:text-sky-300',
  WARNING: 'text-amber-700 dark:text-amber-300',
  ERROR: 'text-rose-700 dark:text-rose-300',
  CRITICAL: 'bg-rose-600 text-white',
}
function statusCls(s: number) {
  return s >= 500 ? 'bg-rose-600 text-white' : s >= 400 ? 'bg-amber-500 text-white' : s >= 300 ? 'bg-sky-500 text-white' : 'bg-emerald-600 text-white'
}

export function LogLine({ e }: { e: LogEntry }) {
  return (
    <div className="flex gap-2 whitespace-pre-wrap break-all border-b border-zinc-100 py-0.5 font-mono text-[12px] dark:border-zinc-800/60" data-testid="log-line">
      <span className="shrink-0 text-zinc-600 dark:text-zinc-400">{e.ts ?? ''}</span>
      {e.level && <span className={`shrink-0 rounded px-1 ${LEVEL_CLS[e.level] ?? ''}`}>{e.level}</span>}
      {e.component && <span className="min-w-0 max-w-[14rem] shrink truncate text-violet-700 dark:text-violet-300" title={e.component}>{e.component}</span>}
      {e.http ? (
        <span className="min-w-0">
          <span className="font-semibold">{e.http.method}</span> <span className="text-indigo-700 dark:text-indigo-300">{e.http.path}</span>{' '}
          <span className={`rounded px-1 ${statusCls(e.http.status)}`}>{e.http.status}</span>
          <span className="text-zinc-600 dark:text-zinc-400"> {e.msg.replace(/.*HTTP\/[\d.]+"\s*\d{3}\s*/, '')}</span>
        </span>
      ) : (
        <span className="min-w-0">{e.msg}</span>
      )}
    </div>
  )
}

// 測試可注入 WebSocket 實作
let WS: typeof WebSocket | undefined
export function setLogsWebSocketImpl(w: typeof WebSocket) {
  WS = w
}

export function LogsPage() {
  const { t } = useTranslation()
  const filesQ = useQuery({ queryKey: ['logs', 'files'], queryFn: logsApi.files, refetchInterval: 30_000 })
  const [file, setFile] = useState('')
  const [level, setLevel] = useState('')
  const [qs, setQs] = useState('')
  const [lines, setLines] = useState(200)
  const [httpOnly, setHttpOnly] = useState(false)
  const [follow, setFollow] = useState(false)
  const [tail, setTail] = useState<LogEntry[]>([])
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!file && filesQ.data?.length) setFile(filesQ.data.find((f) => f.id === 'hermes/gateway.log')?.id ?? filesQ.data[0].id)
  }, [filesQ.data, file])
  const readQ = useQuery({ queryKey: ['logs', 'read', file, lines, level, qs, httpOnly], queryFn: () => logsApi.read(file, lines, level, qs, httpOnly), enabled: !!file })
  useEffect(() => setTail([]), [file, level, qs, httpOnly])
  useEffect(() => {
    if (!follow || !file) return
    const Impl = WS ?? WebSocket
    const ws = new Impl(logsApi.wsUrl(file, level, qs))
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string)
      if (m.type === 'line') setTail((tl) => [...tl.slice(-2000), m.entry as LogEntry])
      if (m.type === 'rotated') setTail((tl) => [...tl, { raw: '', ts: null, level: null, component: null, msg: t('logs.rotated'), http: null }])
    }
    return () => ws.close()
  }, [follow, file, level, qs, t])
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [tail, follow])
  const groups = Array.from(new Set(filesQ.data?.map((f) => f.group) ?? []))
  return (
    <PanelGroup>
      <CollapsiblePanel id="logs.filters" side="left" title={t('panels.filters')} icon="Filter" defaultWidth={240} min={200} max={400}>
        <div className="panel-filters">
        <label className="min-w-0">{t('logs.file')}
          <select aria-label={t('logs.file')} className="input" value={file} onChange={(e) => setFile(e.target.value)}>
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {filesQ.data?.filter((f) => f.group === g).map((f) => <option key={f.id} value={f.id}>{f.name} ({fmtSize(f.size)})</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="min-w-0">{t('logs.level')}
          <select aria-label={t('logs.level')} className="input" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">{t('logs.all')}</option>
            {['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].map((l) => <option key={l}>{l}</option>)}
          </select>
        </label>
        <label className="min-w-0">{t('logs.search')}<input className="input" aria-label={t('logs.search')} value={qs} onChange={(e) => setQs(e.target.value)} /></label>
        <label className="min-w-0">{t('logs.lines')}
          <select className="input" value={lines} onChange={(e) => setLines(Number(e.target.value))}>{[100, 200, 500, 1000, 3000].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
        <label className="flex shrink-0 items-center gap-1 whitespace-nowrap"><input type="checkbox" checked={httpOnly} onChange={(e) => setHttpOnly(e.target.checked)} />{t('logs.httpOnly')}</label>
        <button className={follow ? 'btn-primary' : 'btn-outline'} onClick={() => setFollow((f) => !f)} aria-pressed={follow}>{follow ? t('logs.following') : t('logs.follow')}</button>
        <button className="btn-ghost" onClick={() => readQ.refetch()}>{t('logs.refresh')}</button>
        {readQ.data && <span className="whitespace-nowrap text-zinc-600 dark:text-zinc-400">{fmtSize(readQ.data.size)} · {fmtTime(filesQ.data?.find((f) => f.id === file)?.mtime ?? 0)}</span>}
        </div>
      </CollapsiblePanel>
      <WorkArea className="p-4">
      <PageHeader title={t('logs.title')} subtitle={t('logs.subtitle')} />
      <div ref={box} className="card min-h-0 flex-1 overflow-auto p-2">
        {readQ.isLoading && <Loading />}
        {readQ.error && <ErrorBox error={readQ.error} onRetry={() => readQ.refetch()} />}
        {readQ.data?.entries.length === 0 && tail.length === 0 && <Empty text={t('logs.empty')} />}
        {readQ.data?.entries.map((e, i) => <LogLine key={i} e={e} />)}
        {tail.map((e, i) => <LogLine key={`t${i}`} e={e} />)}
      </div>
      </WorkArea>
    </PanelGroup>
  )
}

const mod: StudioModule = {
  name: 'logs',
  routes: [{ path: '/logs', element: <LogsPage /> }],
  nav: [{ to: '/logs', key: 'logs', order: 81, group: 'system', icon: 'ScrollText' }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
