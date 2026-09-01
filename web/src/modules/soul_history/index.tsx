// SOUL.md 版本歷史：版本清單、diff、回滾、漂移偵測（獨立於 /agents 頁）。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { request } from '../../api/client'
import { PageHeader } from '../../components/PageHeader'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import type { StudioModule } from '../registry'

export interface SoulVersionMeta { id: string; profile: string; version: number; member_id: string; ts: string; note: string; chars: number; lines: number }
export interface SoulProfileRow { profile: string; versions: number; latest: SoulVersionMeta | null }
export interface SoulDiff { profile: string; from: number | null; to: number | null; diff: string; added: number; removed: number }

const json = (b: unknown) => JSON.stringify(b)
export const soulApi = {
  profiles: () => request<SoulProfileRow[]>('/soul-history'),
  versions: (p: string) => request<SoulVersionMeta[]>(`/soul-history/${encodeURIComponent(p)}`),
  version: (p: string, v: number) => request<SoulVersionMeta & { content: string }>(`/soul-history/${encodeURIComponent(p)}/${v}`),
  current: (p: string) => request<{ profile: string; content: string; latest_version: number | null; drift: boolean }>(`/soul-history/${encodeURIComponent(p)}/current`),
  diff: (p: string, a?: number, b?: number) => {
    const q = new URLSearchParams()
    if (a !== undefined) q.set('a', String(a))
    if (b !== undefined) q.set('b', String(b))
    return request<SoulDiff>(`/soul-history/${encodeURIComponent(p)}/diff${q.toString() ? `?${q}` : ''}`)
  },
  write: (p: string, content: string, note: string) => request<SoulVersionMeta & { same: boolean }>(`/soul-history/${encodeURIComponent(p)}`, { method: 'PUT', body: json({ content, note }) }),
  snapshot: (p: string) => request<SoulVersionMeta>(`/soul-history/${encodeURIComponent(p)}/snapshot`, { method: 'POST', body: json({ note: 'manual snapshot' }) }),
  rollback: (p: string, version: number) => request<SoulVersionMeta & { rolled_back_to: number }>(`/soul-history/${encodeURIComponent(p)}/rollback`, { method: 'POST', body: json({ version }) }),
}
const qk = ['soul-history'] as const

function fmtTime(s: string) {
  const d = new Date(s.endsWith('Z') || s.includes('+') ? s : s + 'Z')
  return isNaN(d.getTime()) ? s : d.toLocaleString()
}

function DiffView({ text }: { text: string }) {
  if (!text) return <div className="text-xs text-zinc-600 dark:text-zinc-400">（無差異）</div>
  return (
    <pre className="max-h-96 overflow-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-800" data-testid="diff">
      {text.split('\n').map((l, i) => (
        <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100' : l.startsWith('-') && !l.startsWith('---') ? 'bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-100' : l.startsWith('@@') ? 'text-sky-600 dark:text-sky-400' : ''}>{l || ' '}</div>
      ))}
    </pre>
  )
}

export function SoulHistoryPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const profiles = useQuery({ queryKey: [...qk, 'profiles'], queryFn: soulApi.profiles })
  const [params, setParams] = useSearchParams()
  const [profile, setProfileState] = useState(params.get('profile') ?? '')
  const setProfile = (p: string) => { setProfileState(p); setParams(p ? { profile: p } : {}, { replace: true }) }
  useEffect(() => { if (!profile && profiles.data?.length) setProfileState(profiles.data[0].profile) }, [profiles.data, profile])
  const versions = useQuery({ queryKey: [...qk, profile, 'versions'], queryFn: () => soulApi.versions(profile), enabled: !!profile })
  const current = useQuery({ queryKey: [...qk, profile, 'current'], queryFn: () => soulApi.current(profile), enabled: !!profile })
  const [sel, setSel] = useState<number | null>(null)
  const [cmp, setCmp] = useState<{ a?: number; b?: number } | null>(null)
  const detail = useQuery({ queryKey: [...qk, profile, 'v', sel], queryFn: () => soulApi.version(profile, sel!), enabled: !!profile && sel !== null })
  const diff = useQuery({ queryKey: [...qk, profile, 'diff', cmp], queryFn: () => soulApi.diff(profile, cmp?.a, cmp?.b), enabled: !!profile && cmp !== null })
  const refresh = () => { qc.invalidateQueries({ queryKey: qk }); qc.invalidateQueries({ queryKey: ['agents'] }) }
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const write = useMutation({ mutationFn: () => soulApi.write(profile, draft, note), onSuccess: () => { setEditing(false); setNote(''); refresh() } })
  const snap = useMutation({ mutationFn: () => soulApi.snapshot(profile), onSuccess: refresh })
  const rollback = useMutation({ mutationFn: (v: number) => soulApi.rollback(profile, v), onSuccess: refresh })
  useEffect(() => { setSel(null); setCmp(null); setEditing(false) }, [profile])

  return (
    <div className="p-4">
      <PageHeader title={t('soul.title')} subtitle={t('soul.subtitle')} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <select className="input w-56" aria-label={t('soul.profile')} value={profile} onChange={(e) => setProfile(e.target.value)}>
          {(profiles.data ?? []).map((p) => <option key={p.profile} value={p.profile}>{p.profile} · {t('soul.nVersions', { n: p.versions })}</option>)}
        </select>
        {current.data?.drift && (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200" data-testid="drift">
            {t('soul.drift')} <button className="underline" onClick={() => snap.mutate()}>{t('soul.snapshot')}</button>
            {' · '}<button className="underline" onClick={() => setCmp({ b: -1 })}>{t('soul.diffCurrent')}</button>
          </span>
        )}
        <button className="btn-outline" onClick={() => { setDraft(current.data?.content ?? ''); setEditing(!editing) }}>{editing ? t('common.cancel') : t('soul.edit')}</button>
      </div>
      {profiles.isLoading && <Loading />}
      {profiles.error && <ErrorBox error={profiles.error} onRetry={() => profiles.refetch()} />}
      {editing && (
        <div className="card mb-3 p-3">
          <textarea className="input h-64 font-mono text-xs" aria-label={t('soul.content')} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
            <input className="input w-64" placeholder={t('soul.notePh')} aria-label={t('soul.note')} value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn-primary" disabled={write.isPending} onClick={() => write.mutate()}>{t('soul.save')}</button>
            {write.error && <span className="text-rose-600 dark:text-rose-400">{(write.error as Error).message}</span>}
          </div>
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="card p-3">
          <h3 className="mb-2 text-sm font-medium">{t('soul.versions')}</h3>
          {versions.data && versions.data.length === 0 && <Empty text={t('soul.empty')} />}
          <ul className="space-y-1 text-xs">
            {(versions.data ?? []).map((v, i, arr) => (
              <li key={v.id} className={`rounded border border-zinc-200 p-2 dark:border-zinc-800 ${sel === v.version ? 'bg-zinc-100 dark:bg-zinc-800' : ''}`} data-testid={`ver-${v.version}`}>
                <div className="flex items-center justify-between">
                  <button className="font-medium" onClick={() => setSel(v.version)}>v{v.version}{i === 0 ? ` (${t('soul.latest')})` : ''}</button>
                  <span className="text-zinc-600 dark:text-zinc-400">{fmtTime(v.ts)}</span>
                </div>
                <div className="text-zinc-600 dark:text-zinc-400">{v.note || '—'} · {v.chars} chars · {v.lines} lines{v.member_id ? ` · ${v.member_id}` : ''}</div>
                <div className="mt-1 flex gap-1">
                  {i < arr.length - 1 && <button className="btn-ghost px-1 py-0" onClick={() => setCmp({ a: arr[i + 1].version, b: v.version })}>{t('soul.diffPrev')}</button>}
                  {i > 0 && <button className="btn-ghost px-1 py-0" onClick={() => setCmp({ a: v.version, b: arr[0].version })}>{t('soul.diffLatest')}</button>}
                  {i > 0 && <button className="btn-outline px-1 py-0" disabled={rollback.isPending} onClick={() => rollback.mutate(v.version)}>{t('soul.rollback')}</button>}
                </div>
              </li>
            ))}
          </ul>
          {rollback.error && <div className="mt-1 text-xs text-rose-600 dark:text-rose-400">{(rollback.error as Error).message}</div>}
        </div>
        <div className="card p-3 lg:col-span-2">
          {cmp !== null ? (
            <>
              <div className="mb-2 flex items-center justify-between text-sm font-medium">
                <span>{t('soul.diff')} {diff.data ? `v${diff.data.from ?? '∅'} → ${diff.data.to === null ? t('soul.currentFile') : `v${diff.data.to}`}` : ''}
                  {diff.data && <span className="ml-2 text-xs text-zinc-600 dark:text-zinc-400">+{diff.data.added} / −{diff.data.removed}</span>}</span>
                <button className="btn-ghost text-xs" onClick={() => setCmp(null)}>{t('common.close')}</button>
              </div>
              {diff.isLoading && <Loading />}
              {diff.data && <DiffView text={diff.data.diff} />}
            </>
          ) : sel !== null ? (
            <>
              <div className="mb-2 flex items-center justify-between text-sm font-medium"><span>v{sel} {detail.data?.note && `· ${detail.data.note}`}</span><button className="btn-ghost text-xs" onClick={() => setSel(null)}>{t('common.close')}</button></div>
              {detail.isLoading && <Loading />}
              {detail.data && <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-800" data-testid="version-content">{detail.data.content}</pre>}
            </>
          ) : (
            <>
              <div className="mb-2 text-sm font-medium">{t('soul.currentFile')} {current.data?.latest_version !== null && current.data ? `· v${current.data.latest_version}` : ''}</div>
              {current.isLoading && <Loading />}
              {current.data && <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-800" data-testid="current-content">{current.data.content || t('soul.emptyFile')}</pre>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const zhTW = {
  nav: { soulHistory: 'SOUL 版本' },
  soul: {
    title: 'SOUL.md 版本歷史', subtitle: '每次透過 Studio 寫入都存一版；可看 diff、回滾（回滾也是新版本，歷史不刪）',
    profile: 'Profile', nVersions: '{{n}} 版', drift: '檔案內容與最新版本不同（有人從別的路徑改過）', snapshot: '記成新版本', diffCurrent: '看差異',
    edit: '編輯 SOUL.md', content: '內容', note: '版本備註', notePh: '這版改了什麼（選填）', save: '寫入並記版本',
    versions: '版本', empty: '還沒有版本。', latest: '最新', diffPrev: '與上一版比', diffLatest: '與最新比', rollback: '回滾到此版',
    diff: '差異', currentFile: '檔案現況', emptyFile: '（空白）',
  },
}
const en = {
  nav: { soulHistory: 'SOUL history' },
  soul: {
    title: 'SOUL.md history', subtitle: 'Every write through Studio is versioned; diff and roll back (rollback creates a new version)',
    profile: 'Profile', nVersions: '{{n}} versions', drift: 'File differs from latest version', snapshot: 'Snapshot', diffCurrent: 'Diff',
    edit: 'Edit SOUL.md', content: 'Content', note: 'Note', notePh: 'What changed (optional)', save: 'Write & version',
    versions: 'Versions', empty: 'No versions yet.', latest: 'latest', diffPrev: 'Diff prev', diffLatest: 'Diff latest', rollback: 'Roll back',
    diff: 'Diff', currentFile: 'Current file', emptyFile: '(empty)',
  },
}

const mod: StudioModule = {
  name: 'soul_history',
  routes: [{ path: '/soul-history', element: <SoulHistoryPage /> }],
  nav: [{ to: '/soul-history', key: 'soulHistory', order: 47 }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
