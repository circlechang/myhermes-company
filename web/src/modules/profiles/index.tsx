// H. 多 Profile：清單／建立／複製／重新命名／刪除／預設／匯出／匯入／config.yaml／帳號綁定
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthContext'
import { PageHeader } from '../../components/PageHeader'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import type { StudioModule } from '../registry'
import { profilesApi, type ProfileInfo } from './api'

export const profilesQk = ['profiles'] as const
export const useProfiles = () => useQuery({ queryKey: profilesQk, queryFn: profilesApi.list })

function useProfileMutations() {
  const qc = useQueryClient()
  const inv = () => {
    qc.invalidateQueries({ queryKey: profilesQk })
    qc.invalidateQueries({ queryKey: ['agents'] })
    qc.invalidateQueries({ queryKey: ['hermes'] })
  }
  return {
    create: useMutation({ mutationFn: profilesApi.create, onSuccess: inv }),
    clone: useMutation({ mutationFn: ({ name, newName }: { name: string; newName: string }) => profilesApi.clone(name, newName), onSuccess: inv }),
    rename: useMutation({ mutationFn: ({ name, newName }: { name: string; newName: string }) => profilesApi.rename(name, newName), onSuccess: inv }),
    remove: useMutation({ mutationFn: profilesApi.remove, onSuccess: inv }),
    use: useMutation({ mutationFn: profilesApi.use, onSuccess: inv }),
    importFile: useMutation({ mutationFn: ({ file, name }: { file: File; name?: string }) => profilesApi.import(file, name), onSuccess: inv }),
  }
}

/** 可嵌入 AgentsPage 的 profile 管理面板 */
export function ProfilesPanel({ onSelect, compact = false }: { onSelect?: (name: string) => void; compact?: boolean }) {
  const { t } = useTranslation()
  const { member } = useAuth()
  const isAdmin = member?.role === 'owner' || member?.role === 'admin'
  const q = useProfiles()
  const m = useProfileMutations()
  const [newName, setNewName] = useState('')
  const [cloneFrom, setCloneFrom] = useState('')
  const [desc, setDesc] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-3">
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {err && <ErrorBox error={err} />}
      {q.data && (
        <div className="table-wrap">
          <table className="w-full text-sm" data-testid="profiles-table">
            <thead className="text-left text-xs text-zinc-600 dark:text-zinc-400">
              <tr><th className="py-1">{t('profiles.name')}</th><th className="nowrap-cell">{t('profiles.model')}</th>{!compact && <th className="nowrap-cell">{t('profiles.gateway')}</th>}<th></th></tr>
            </thead>
            <tbody>
              {q.data.profiles.map((p) => (
                <ProfileRow key={p.name} p={p} compact={compact} isAdmin={isAdmin} onSelect={onSelect} run={run} m={m} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.data?.profiles.length === 0 && <Empty text={t('profiles.noneVisible')} />}
      {isAdmin && (
        <div className="card p-3">
          <h3 className="mb-2 text-sm font-medium">{t('profiles.create')}</h3>
          <div className={`grid min-w-0 gap-2 [&>*]:min-w-0 ${compact ? '' : 'md:grid-cols-4'}`}>
            <input className="input" placeholder={t('profiles.namePlaceholder')} value={newName} onChange={(e) => setNewName(e.target.value)} aria-label={t('profiles.name')} />
            <select className="input" value={cloneFrom} onChange={(e) => setCloneFrom(e.target.value)} aria-label={t('profiles.cloneFrom')}>
              <option value="">{t('profiles.fresh')}</option>
              {q.data?.profiles.map((p) => <option key={p.name} value={p.name}>{t('profiles.cloneFromX', { name: p.name })}</option>)}
            </select>
            <input className="input" placeholder={t('profiles.descPlaceholder')} value={desc} onChange={(e) => setDesc(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary" disabled={!newName.trim() || m.create.isPending}
                onClick={() => run(() => m.create.mutateAsync({ name: newName.trim(), clone_from: cloneFrom || undefined, description: desc || undefined }).then(() => { setNewName(''); setDesc('') }))}>
                {t('common.create')}
              </button>
              <button className="btn-outline" onClick={() => fileRef.current?.click()} disabled={m.importFile.isPending}>{t('profiles.import')}</button>
              <input ref={fileRef} type="file" accept=".tar.gz,.tgz,application/gzip" className="hidden" aria-label={t('profiles.import')}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) run(() => m.importFile.mutateAsync({ file: f, name: newName.trim() || undefined })); e.target.value = '' }} />
            </div>
          </div>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{t('profiles.createHint')}</p>
        </div>
      )}
    </div>
  )
}

function ProfileRow({ p, compact, isAdmin, onSelect, run, m }: {
  p: ProfileInfo; compact: boolean; isAdmin: boolean; onSelect?: (n: string) => void
  run: (fn: () => Promise<unknown>) => Promise<void>; m: ReturnType<typeof useProfileMutations>
}) {
  const { t } = useTranslation()
  return (
    <tr className="border-t border-zinc-200 dark:border-zinc-800">
      <td className="min-w-[10rem] max-w-xs py-1.5 align-top">
        <button className="max-w-full text-left" onClick={() => onSelect?.(p.name)}>
          <code className="font-mono text-xs" title={p.name}>{p.name}</code>
          {p.is_default && <span className="badge ml-2 bg-indigo-100 text-2xs text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200">{t('profiles.default')}</span>}
        </button>
        {p.description && <div className="line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400" title={p.description}>{p.description}</div>}
      </td>
      <td className="nowrap-cell align-top text-xs">{p.model || '—'}</td>
      {!compact && <td className="nowrap-cell align-top text-xs">{p.gateway || '—'}</td>}
      <td className="nowrap-cell text-right align-top text-xs">
        {isAdmin && (
          <div className="inline-flex flex-nowrap justify-end gap-1">
            {!p.is_default && <button className="btn-ghost" onClick={() => run(() => m.use.mutateAsync(p.name))}>{t('profiles.setDefault')}</button>}
            <button className="btn-ghost" onClick={() => { const n = prompt(t('profiles.clonePrompt', { name: p.name })); if (n) run(() => m.clone.mutateAsync({ name: p.name, newName: n })) }}>{t('profiles.clone')}</button>
            <button className="btn-ghost" onClick={() => { const n = prompt(t('profiles.renamePrompt'), p.name); if (n && n !== p.name) run(() => m.rename.mutateAsync({ name: p.name, newName: n })) }}>{t('profiles.rename')}</button>
            <button className="btn-ghost" onClick={() => run(() => profilesApi.download(p.name))}>{t('profiles.export')}</button>
            {p.name !== 'default' && (
              <button className="btn-ghost text-rose-600 dark:text-rose-400" onClick={() => { if (confirm(t('profiles.confirmDelete', { name: p.name }))) run(() => m.remove.mutateAsync(p.name)) }}>{t('common.delete')}</button>
            )}
          </div>
        )}
      </td>
    </tr>
  )
}

function ConfigEditor({ name }: { name: string }) {
  const { t } = useTranslation()
  const q = useQuery({ queryKey: ['profiles', name, 'config'], queryFn: () => profilesApi.configRaw(name) })
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [quick, setQuick] = useState({ key: 'model.default', value: '' })
  useEffect(() => { if (q.data) setText(q.data.text) }, [q.data])
  const save = useMutation({
    mutationFn: (body: Parameters<typeof profilesApi.saveConfig>[1]) => profilesApi.saveConfig(name, body),
    onSuccess: () => { setSavedAt(Date.now()); qc.invalidateQueries({ queryKey: ['profiles'] }); qc.invalidateQueries({ queryKey: ['agents'] }) },
  })
  const dirty = q.data ? text !== q.data.text : false
  return (
    <div className="card space-y-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="font-medium">config.yaml <code className="path-text inline text-zinc-600 dark:text-zinc-400" title={q.data?.path}>{q.data?.path}</code></h3>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('profiles.configHint')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          {savedAt && !dirty && <span className="text-emerald-600 dark:text-emerald-400">{t('common.saved')}</span>}
          <button className="btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate({ text })}>{t('common.save')}</button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <input className="input flex-1 basis-40" value={quick.key} onChange={(e) => setQuick({ ...quick, key: e.target.value })} aria-label={t('profiles.quickKey')} />
        <input className="input flex-1 basis-40" value={quick.value} placeholder={t('profiles.quickValue')} onChange={(e) => setQuick({ ...quick, value: e.target.value })} aria-label={t('profiles.quickValue')} />
        <button className="btn-outline" disabled={!quick.key || save.isPending}
          onClick={() => save.mutate({ set: { [quick.key]: coerce(quick.value) } })}>{t('profiles.quickSet')}</button>
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {save.error && <ErrorBox error={save.error} />}
      <textarea aria-label="config.yaml" className="input min-h-[420px] font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
    </div>
  )
}

function coerce(v: string): unknown {
  const s = v.trim()
  if (s === 'true') return true
  if (s === 'false') return false
  if (s !== '' && !Number.isNaN(Number(s))) return Number(s)
  return s
}

function Assignments() {
  const { t } = useTranslation()
  const q = useQuery({ queryKey: ['profiles', 'assignments'], queryFn: profilesApi.members })
  const profiles = useProfiles()
  const qc = useQueryClient()
  const assign = useMutation({
    mutationFn: ({ id, profiles }: { id: string; profiles: string[] }) => profilesApi.assign(id, profiles),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profiles', 'assignments'] }),
  })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorBox error={q.error} />
  return (
    <div className="card p-3">
      <h3 className="mb-1 font-medium">{t('profiles.assignments')}</h3>
      <p className="mb-2 text-xs text-zinc-600 dark:text-zinc-400">{t('profiles.assignHint')}</p>
      <div className="table-wrap">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-zinc-600 dark:text-zinc-400"><tr><th className="py-1 nowrap-cell">{t('profiles.member')}</th><th className="nowrap-cell">{t('profiles.role')}</th><th>{t('profiles.assigned')}</th></tr></thead>
        <tbody>
          {q.data?.map((mb) => (
            <tr key={mb.id} className="border-t border-zinc-200 dark:border-zinc-800">
              <td className="nowrap-cell py-1.5">{mb.username}</td>
              <td className="nowrap-cell text-xs">{mb.role}</td>
              <td>
                {mb.role === 'owner' ? <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('profiles.allVisible')}</span> : (
                  <div className="flex flex-wrap gap-2">
                    {profiles.data?.profiles.map((p) => (
                      <label key={p.name} className="flex items-center gap-1 text-xs">
                        <input type="checkbox" checked={mb.profiles.includes(p.name)} disabled={assign.isPending}
                          onChange={(e) => assign.mutate({ id: mb.id, profiles: e.target.checked ? [...mb.profiles, p.name] : mb.profiles.filter((x) => x !== p.name) })} />
                        <code className="font-mono text-xs">{p.name}</code>
                      </label>
                    ))}
                    {mb.role === 'admin' && mb.profiles.length === 0 && <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('profiles.adminUnassigned')}</span>}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}

export function ProfilesPage() {
  const { t } = useTranslation()
  const { member } = useAuth()
  const [selected, setSelected] = useState<string | null>(null)
  const isAdmin = member?.role === 'owner' || member?.role === 'admin'
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <PageHeader title={t('profiles.title')} subtitle={t('profiles.subtitle')} />
      <div className="card p-3"><ProfilesPanel onSelect={setSelected} /></div>
      {selected && isAdmin && <ConfigEditor key={selected} name={selected} />}
      {isAdmin && <Assignments />}
    </div>
  )
}

const zhTW = {
  nav: { profiles: 'Profile' },
  profiles: {
    title: 'Profile 管理', subtitle: '每個 profile 是一個獨立的 Hermes 工作身分（SOUL、設定、記憶、skills）',
    name: '名稱', model: '模型', gateway: 'Gateway', default: '預設', setDefault: '設為預設', clone: '複製', rename: '重新命名', export: '匯出 tar.gz', import: '匯入 tar.gz',
    create: '建立 profile', namePlaceholder: '名稱（小寫英數、-、_）', cloneFrom: '來源', fresh: '全新（不複製）', cloneFromX: '複製 {{name}}', descPlaceholder: '一句話描述（給看板分派用）',
    createHint: '建立走 `hermes profile create --no-alias`；匯入請先在名稱欄填新名稱（可留空用壓縮檔內的名稱）。',
    clonePrompt: '把 {{name}} 複製成新 profile，名稱：', renamePrompt: '新名稱（default 只改顯示名稱）：', confirmDelete: '刪除 profile {{name}}？目錄與記憶會一併刪除。',
    noneVisible: '你沒有被指派任何 profile，請聯絡管理員。',
    configHint: '直接編輯 config.yaml（保留註解）；下方快速設定可改單一 dotted key，例如 model.default。',
    quickKey: '設定鍵', quickValue: '值', quickSet: '套用',
    assignments: '帳號綁定', assignHint: 'owner 全部可見；admin 未指派＝全部可見；member 只看被勾選的 profile（AI 員工、對話、用量、排程都會跟著過濾）。',
    member: '成員', role: '角色', assigned: '可見 profile', allVisible: '全部（owner）', adminUnassigned: '（未指派＝全部）',
  },
}
const en = {
  nav: { profiles: 'Profiles' },
  profiles: {
    title: 'Profiles', subtitle: 'Each profile is an isolated Hermes identity (SOUL, config, memory, skills)',
    name: 'Name', model: 'Model', gateway: 'Gateway', default: 'default', setDefault: 'Set default', clone: 'Clone', rename: 'Rename', export: 'Export', import: 'Import',
    create: 'Create profile', namePlaceholder: 'name (lowercase, -, _)', cloneFrom: 'Source', fresh: 'Fresh', cloneFromX: 'Clone {{name}}', descPlaceholder: 'Description',
    createHint: 'Uses `hermes profile create --no-alias`; for import, optionally type a new name first.',
    clonePrompt: 'Clone {{name}} as:', renamePrompt: 'New name:', confirmDelete: 'Delete profile {{name}}?', noneVisible: 'No profiles assigned to you.',
    configHint: 'Edit config.yaml (comments preserved). Quick set changes one dotted key.', quickKey: 'Key', quickValue: 'Value', quickSet: 'Apply',
    assignments: 'Account binding', assignHint: 'owner sees all; admin without assignment sees all; member only sees checked profiles.',
    member: 'Member', role: 'Role', assigned: 'Visible profiles', allVisible: 'All (owner)', adminUnassigned: '(unassigned = all)',
  },
}

const mod: StudioModule = {
  name: 'profiles',
  routes: [{ path: '/profiles', element: <ProfilesPage /> }],
  nav: [{ to: '/profiles', key: 'profiles', order: 99.5, group: 'settings', icon: 'Users', hidden: true }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
