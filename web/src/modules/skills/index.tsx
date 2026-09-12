import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { StudioModule } from '../registry'
import { PageHeader } from '../../components/PageHeader'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import { CollapsiblePanel, PanelGroup, WorkArea } from '../../components/layout/index'
import { CodeEditor } from '../../components/admin2/CodeEditor'
import { Tabs, fmtSize, fmtTime } from '../../components/admin2/Tabs'
import { useAuth } from '../../auth/AuthContext'
import { useEngineerMode } from '../../prefs/engineerMode'
import { JourneyView } from './Journey'
import { journeyApi, memoryApi, profilesApi, skillsApi, type SkillItem } from './api'
import { useStaffNames } from './staffNames'

export { useStaffNames } from './staffNames'

// 老闆看到的都是中文；系統詞（profile／Bundle／Journey／路徑）只在工程師模式出現
const zhTW = {
  nav: { skills: '技能' },
  skills: {
    title: '技能與記憶',
    subtitle: '每位員工會什麼、記得什麼',
    subtitleEngineer: '各 profile 的 skills、Skill Bundles、記憶檔與 Journey 關係圖',
    tabSkills: '技能',
    tabBundles: '組合',
    tabMemory: '記憶',
    tabJourney: '關係圖',
    profile: '員工',
    profileEngineer: 'Profile',
    search: '搜尋名稱／描述／標籤',
    allTopics: '全部用途',
    topicHint: '依「拿它來做什麼」分類，不是照資料夾',
    recentOnly: '最近用過',
    sortBy: '排序',
    sortRecent: '最近使用',
    sortUsage: '最常使用',
    sortName: '名稱',
    neverUsed: '還沒用過',
    usedAgo: '用過',
    allCategories: '全部分類',
    allSources: '全部來源',
    local: '本機',
    builtin: '內建',
    enabled: '啟用',
    disabled: '停用',
    toggleOn: '啟用',
    toggleOff: '停用',
    newSkill: '新增技能',
    newSkillName: '技能名稱（英數、- _ .）',
    newSkillCategory: '分類目錄（可空）',
    save: '儲存',
    saved: '已儲存',
    files: '附檔',
    preview: '預覽',
    note: '我的筆記（只有自己看得到）',
    saveNote: '儲存筆記',
    usage: '用量',
    usageHint: '從對話與工具呼叫紀錄裡數這個技能被用了幾次',
    usageHintEngineer: '從 Studio 對話與 Hermes state.db（唯讀）的工具呼叫中計數 skill 名稱',
    selectOne: '選一個技能看說明',
    noBundles: '還沒有組合',
    bundleName: '組合名稱',
    bundleSkills: '技能（逗號分隔）',
    bundleDesc: '描述',
    createBundle: '建立組合',
    deleteBundle: '移除',
    memoryFiles: '記憶檔',
    memoryStatus: '記憶狀態',
    memoryMissing: '（尚未建立）',
    saveMemory: '儲存',
    newMemoryFile: '新檔名（例如 NOTES.md）',
    addMemoryFile: '新增檔案',
    deleteMemoryFile: '刪除',
    newFile: '（新檔）',
    journeyAll: '全部分類',
    replay: '時間軸回放',
    play: '播放',
    pause: '暫停',
    nodes: '節點',
    edges: '邊',
    showEntries: '顯示記憶條目',
    adminOnly: '僅 owner/admin 可修改',
  },
}
const en = {
  nav: { skills: 'Skills' },
  skills: {
    title: 'Skills & Memory', subtitle: 'What each staff member can do and remembers', subtitleEngineer: 'Per-profile skills, bundles, memory files and the journey graph',
    tabSkills: 'Skills', tabBundles: 'Bundles', tabMemory: 'Memory', tabJourney: 'Graph', profile: 'Staff', profileEngineer: 'Profile',
    newSkill: 'New skill', selectOne: 'Pick a skill to read about it', save: 'Save', enabled: 'enabled', disabled: 'disabled',
    usageHint: 'Counted from chats and tool calls', usageHintEngineer: 'Counted from Studio chats and Hermes state.db (read-only)',
    memoryStatus: 'Memory status', memoryMissing: '(not created yet)', newFile: '(new)',
    allTopics: 'All uses', topicHint: 'Grouped by what you use it for, not by folder', recentOnly: 'Recently used',
    sortBy: 'Sort', sortRecent: 'Recently used', sortUsage: 'Most used', sortName: 'Name',
    neverUsed: 'not used yet', usedAgo: 'used',
  },
}

type Tab = 'skills' | 'bundles' | 'memory' | 'journey'

/** 「3 天前」這種相對時間；0 代表沒紀錄。 */
export function agoLabel(ts: number, now = Date.now()): string {
  if (!ts) return ''
  const sec = Math.max(0, now / 1000 - ts)
  const day = sec / 86400
  if (sec < 3600) return `${Math.max(1, Math.floor(sec / 60))} 分鐘前`
  if (day < 1) return `${Math.floor(sec / 3600)} 小時前`
  if (day < 30) return `${Math.floor(day)} 天前`
  if (day < 365) return `${Math.floor(day / 30)} 個月前`
  return `${Math.floor(day / 365)} 年前`
}

type SortKey = 'recent' | 'usage' | 'name'

export function useProfiles() {
  return useQuery({ queryKey: ['admin2', 'profiles'], queryFn: profilesApi.list, staleTime: 60_000 })
}

export function SkillsPage() {
  const { t } = useTranslation()
  const engineer = useEngineerMode()
  const staff = useStaffNames()
  const [tab, setTab] = useState<Tab>('skills')
  const [profile, setProfile] = useState('default')
  const profilesQ = useProfiles()
  const tabs = [
    { id: 'skills' as Tab, label: t('skills.tabSkills') },
    { id: 'bundles' as Tab, label: t('skills.tabBundles') },
    { id: 'memory' as Tab, label: t('skills.tabMemory') },
    { id: 'journey' as Tab, label: t('skills.tabJourney') },
  ]
  const profileLabel = engineer ? t('skills.profileEngineer') : t('skills.profile')
  return (
    <div className="flex h-full flex-col p-4" data-testid="skills-page">
      <PageHeader
        title={t('skills.title')}
        subtitle={engineer ? t('skills.subtitleEngineer') : t('skills.subtitle')}
        actions={
          <label className="flex items-center gap-2 text-sm">
            {profileLabel}
            <select aria-label={profileLabel} className="input w-auto" value={profile} onChange={(e) => setProfile(e.target.value)} data-testid="skills-profile">
              {(profilesQ.data ?? ['default']).map((p) => (
                <option key={p} value={p}>{staff.label(p)}</option>
              ))}
            </select>
          </label>
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="min-h-0 flex-1 pt-3">
        {tab === 'skills' && <SkillsTab profile={profile} />}
        {tab === 'bundles' && <BundlesTab profile={profile} />}
        {tab === 'memory' && <MemoryTab profile={profile} />}
        {tab === 'journey' && <JourneyTab profile={profile} />}
      </div>
    </div>
  )
}

function SkillsTab({ profile }: { profile: string }) {
  const { t } = useTranslation()
  const engineer = useEngineerMode()
  const { member } = useAuth()
  const isAdmin = member?.role === 'owner' || member?.role === 'admin'
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [source, setSource] = useState('')
  const [topic, setTopic] = useState('')
  const [recentOnly, setRecentOnly] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('recent')
  const [selected, setSelected] = useState<string | null>(null)
  const listQ = useQuery({ queryKey: ['skills', profile, q, category, source, topic], queryFn: () => skillsApi.list(profile, q, category, source, topic) })
  const usageQ = useQuery({ queryKey: ['skills', 'usage'], queryFn: skillsApi.usage, staleTime: 60_000 })
  const lastUsed = usageQ.data?.last_used ?? {}
  const counts = usageQ.data?.counts ?? {}
  // 排序在前端做：用量資料是跨 profile 的另一支 API，塞回列表端點只會讓兩邊都要等
  const items = useMemo(() => {
    const list = (listQ.data?.items ?? []).filter((s) => !recentOnly || lastUsed[s.name])
    const byName = (a: SkillItem, b: SkillItem) => a.name.localeCompare(b.name)
    if (sortKey === 'name') return [...list].sort(byName)
    const key = sortKey === 'recent' ? lastUsed : counts
    return [...list].sort((a, b) => ((key[b.name] ?? 0) - (key[a.name] ?? 0)) || byName(a, b))
  }, [listQ.data, sortKey, recentOnly, lastUsed, counts])
  const detailQ = useQuery({ queryKey: ['skills', profile, 'detail', selected], queryFn: () => skillsApi.detail(selected!, profile), enabled: !!selected })
  const noteQ = useQuery({ queryKey: ['skills', 'note', selected], queryFn: () => skillsApi.note(selected!), enabled: !!selected })
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [previewRel, setPreviewRel] = useState<string | null>(null)
  const previewQ = useQuery({ queryKey: ['skills', profile, selected, 'file', previewRel], queryFn: () => skillsApi.file(selected!, profile, previewRel!), enabled: !!selected && !!previewRel })
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { if (detailQ.data) setDraft(detailQ.data.content) }, [detailQ.data])
  useEffect(() => { if (noteQ.data) setNote(noteQ.data.content) }, [noteQ.data])
  useEffect(() => { setPreviewRel(null) }, [selected])
  const invalidate = () => qc.invalidateQueries({ queryKey: ['skills'] })
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 2500) }
  const onErr = (e: unknown) => flash(e instanceof Error ? e.message : String(e))
  const toggle = useMutation({ mutationFn: (s: SkillItem) => skillsApi.toggle(s.name, profile, !s.enabled), onSuccess: invalidate, onError: onErr })
  const save = useMutation({ mutationFn: () => skillsApi.write(selected!, profile, draft), onSuccess: () => { flash(t('skills.saved')); invalidate() }, onError: onErr })
  const saveNote = useMutation({ mutationFn: () => skillsApi.saveNote(selected!, note), onSuccess: () => { flash(t('skills.saved')); qc.invalidateQueries({ queryKey: ['skills', 'note'] }) }, onError: onErr })
  const create = useMutation({
    mutationFn: ({ name, cat }: { name: string; cat: string }) => skillsApi.write(name, profile, `---\nname: ${name}\ndescription: ""\n---\n\n# ${name}\n`, cat),
    onSuccess: (s) => { invalidate(); setSelected(s.name) },
    onError: onErr,
  })
  const detail = detailQ.data
  const dirty = detail ? draft !== detail.content : false
  return (
    <PanelGroup>
      <CollapsiblePanel id="skills.list" side="left" title={t('panels.skillList')} icon="Sparkles" defaultWidth={360} min={240} max={520}
                        bodyClassName="flex min-h-0 flex-col gap-2 overflow-hidden p-2">
        <input className="input" placeholder={t('skills.search')} aria-label={t('skills.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('skills.allTopics')} title={t('skills.topicHint')} data-testid="skill-topics">
          <button className={`badge px-2 text-2xs ${!topic && !recentOnly ? 'bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900' : 'bg-zinc-100 dark:bg-zinc-800'}`}
                  aria-pressed={!topic && !recentOnly} onClick={() => { setTopic(''); setRecentOnly(false) }}>
            {t('skills.allTopics')}
          </button>
          <button className={`badge px-2 text-2xs ${recentOnly ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200'}`}
                  aria-pressed={recentOnly} onClick={() => { setRecentOnly((v) => !v); setSortKey('recent') }}>
            {t('skills.recentOnly')}
          </button>
          {listQ.data?.topics?.map((tp) => (
            <button key={tp.name} title={tp.hint} aria-pressed={topic === tp.name}
                    className={`badge px-2 text-2xs ${topic === tp.name ? 'bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900' : 'bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700'}`}
                    onClick={() => setTopic(topic === tp.name ? '' : tp.name)}>
              {tp.name} <span className="opacity-60">{tp.count}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <select aria-label={t('skills.sortBy')} className="input min-w-0 flex-1 basis-28" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} data-testid="skill-sort">
            <option value="recent">{t('skills.sortRecent')}</option>
            <option value="usage">{t('skills.sortUsage')}</option>
            <option value="name">{t('skills.sortName')}</option>
          </select>
          {engineer && (
            <select aria-label={t('skills.allCategories')} className="input min-w-0 flex-1 basis-32" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t('skills.allCategories')}</option>
              {listQ.data?.categories.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
            </select>
          )}
          <select aria-label={t('skills.allSources')} className="input min-w-0 flex-1 basis-28" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">{t('skills.allSources')}</option>
            <option value="local">{t('skills.local')}</option>
            <option value="builtin">{t('skills.builtin')}</option>
          </select>
          {isAdmin && (
            <button className="btn-outline shrink-0" onClick={() => { const name = prompt(t('skills.newSkillName')); if (!name) return; const cat = prompt(t('skills.newSkillCategory')) ?? ''; create.mutate({ name, cat }) }}>
              {t('skills.newSkill')}
            </button>
          )}
        </div>
        {msg && <div role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{msg}</div>}
        <div className="min-h-0 flex-1 overflow-auto">
          {listQ.isLoading && <Loading />}
          {listQ.error && <ErrorBox error={listQ.error} onRetry={() => listQ.refetch()} />}
          {items.length === 0 && !listQ.isLoading && <Empty />}
          <ul className="space-y-1 text-sm">
            {items.map((s) => (
              <li key={s.source + s.name} className={`rounded-md px-2 py-1.5 ${selected === s.name ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'}`}>
                <div className="flex items-center gap-2">
                  <button className="min-w-0 flex-1 text-left" onClick={() => setSelected(s.name)}>
                    <span className="block truncate font-medium" title={s.name}>{s.name}</span>
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="truncate text-2xs text-zinc-600 dark:text-zinc-400">
                        {engineer ? s.category : s.topic} · {s.source === 'local' ? t('skills.local') : t('skills.builtin')}
                      </span>
                      {lastUsed[s.name]
                        ? <span className="badge whitespace-nowrap bg-indigo-100 px-1 text-2xs text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200">{t('skills.usedAgo')} {agoLabel(lastUsed[s.name])}</span>
                        : <span className="badge whitespace-nowrap bg-zinc-100 px-1 text-2xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{t('skills.neverUsed')}</span>}
                      {counts[s.name] ? <span className="text-2xs text-zinc-500 dark:text-zinc-400">×{counts[s.name]}</span> : null}
                    </span>
                  </button>
                  <button
                    aria-label={`${s.enabled ? t('skills.toggleOff') : t('skills.toggleOn')} ${s.name}`}
                    disabled={!isAdmin || toggle.isPending}
                    onClick={() => toggle.mutate(s)}
                    className={`badge px-1.5 text-2xs ${s.enabled ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'}`}
                  >
                    {s.enabled ? t('skills.enabled') : t('skills.disabled')}
                  </button>
                </div>
                <div className="truncate text-xs text-zinc-600 dark:text-zinc-400" title={s.description}>{s.description}</div>
              </li>
            ))}
          </ul>
        </div>
      </CollapsiblePanel>
      <WorkArea className="overflow-auto p-3">
        {!selected ? <Empty text={t('skills.selectOne')} /> : detailQ.isLoading ? <Loading /> : detailQ.error ? <ErrorBox error={detailQ.error} /> : detail ? (
          <div className="space-y-3">
            <div className="card p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="min-w-0 text-lg font-semibold">{detail.name}</h2>
                <span className="whitespace-nowrap text-xs text-zinc-600 dark:text-zinc-400">v{detail.version || '—'} · {engineer ? detail.category : detail.topic} · {fmtTime(detail.mtime)}</span>
                <div className="ml-auto flex flex-wrap gap-1">
                  {detail.tags.map((tg) => <span key={tg} className="badge bg-zinc-100 text-2xs dark:bg-zinc-800">#{tg}</span>)}
                </div>
              </div>
              <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{detail.description}</p>
              {/* 檔案路徑是系統詞，工程師模式才露出 */}
              {engineer && <code className="path-text block text-xs text-zinc-600 dark:text-zinc-400" title={detail.path}>{detail.path}</code>}
            </div>
            <div className="card p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">SKILL.md</span>
                {!isAdmin && <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('skills.adminOnly')}</span>}
                <button className="btn-primary ml-auto" disabled={!isAdmin || !dirty || save.isPending} onClick={() => save.mutate()}>{t('skills.save')}</button>
              </div>
              <div className="h-[360px]"><CodeEditor value={draft} onChange={setDraft} filename="SKILL.md" readOnly={!isAdmin} ariaLabel="SKILL.md" /></div>
            </div>
            <div className="card p-3">
              <div className="mb-2 text-sm font-medium">{t('skills.files')} ({detail.attachments.length})</div>
              <ul className="flex flex-wrap gap-1 text-xs">
                {detail.attachments.map((f) => (
                  <li key={f.rel}>
                    <button className={`rounded border px-2 py-0.5 ${previewRel === f.rel ? 'border-indigo-500' : 'border-zinc-300 dark:border-zinc-700'}`} onClick={() => setPreviewRel(f.rel)} title={f.rel}><span className="font-mono">{f.rel}</span> <span className="text-zinc-600 dark:text-zinc-400">{fmtSize(f.size)}</span></button>
                  </li>
                ))}
              </ul>
              {previewRel && previewQ.data && (
                <pre className="mt-2 max-h-72 overflow-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-800">{previewQ.data.binary ? `(binary ${fmtSize(previewQ.data.size)})` : previewQ.data.content}</pre>
              )}
            </div>
            <div className="card p-3">
              <div className="mb-2 flex items-center text-sm font-medium">{t('skills.note')}<button className="btn-outline ml-auto" onClick={() => saveNote.mutate()}>{t('skills.saveNote')}</button></div>
              <textarea aria-label={t('skills.note')} className="input h-24" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
        ) : null}
      </WorkArea>
    </PanelGroup>
  )
}

function BundlesTab({ profile }: { profile: string }) {
  const { t } = useTranslation()
  const engineer = useEngineerMode()
  const qc = useQueryClient()
  const bundlesQ = useQuery({ queryKey: ['skills', 'bundles'], queryFn: skillsApi.bundles })
  const usageQ = useQuery({ queryKey: ['skills', 'usage'], queryFn: skillsApi.usage, staleTime: 60_000 })
  const skillsQ = useQuery({ queryKey: ['skills', profile, '', '', ''], queryFn: () => skillsApi.list(profile) })
  const [name, setName] = useState('')
  const [skills, setSkills] = useState('')
  const [desc, setDesc] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () => skillsApi.createBundle({ name, skills: skills.split(/[,\s]+/).filter(Boolean), description: desc }),
    onSuccess: () => { setName(''); setSkills(''); qc.invalidateQueries({ queryKey: ['skills', 'bundles'] }) },
    onError: (e) => setErr(String((e as Error).message)),
  })
  const del = useMutation({ mutationFn: (n: string) => skillsApi.deleteBundle(n), onSuccess: () => qc.invalidateQueries({ queryKey: ['skills', 'bundles'] }), onError: (e) => setErr(String((e as Error).message)) })
  const usageOf = (b: { skills: string[] }) => b.skills.reduce((a, s) => a + (usageQ.data?.counts[s] ?? 0), 0)
  return (
    <PanelGroup className="gap-0">
      <WorkArea className="space-y-2 overflow-auto p-3">
        {bundlesQ.isLoading && <Loading />}
        {bundlesQ.data?.length === 0 && <Empty text={t('skills.noBundles')} />}
        {bundlesQ.data?.map((b) => (
          <div key={b.name} className="card p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 truncate font-medium" title={b.name}>/{b.name}</span>
              <span className="min-w-0 truncate text-xs text-zinc-600 dark:text-zinc-400" title={b.description}>{b.description}</span>
              <span className="badge ml-auto bg-indigo-100 px-1.5 text-2xs text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200">{t('skills.usage')} {usageOf(b)}</span>
              <button className="btn-ghost text-rose-600 dark:text-rose-400" onClick={() => del.mutate(b.name)}>{t('skills.deleteBundle')}</button>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {b.skills.map((s) => <span key={s} className="badge bg-zinc-100 dark:bg-zinc-800">{s} <span className="ml-1 text-zinc-600 dark:text-zinc-400">{usageQ.data?.counts[s] ?? 0}</span></span>)}
            </div>
          </div>
        ))}
        <div className="card p-3 text-xs text-zinc-600 dark:text-zinc-400">
          <div className="mb-1 font-medium">{t('skills.usage')}</div>
          <div>{engineer ? t('skills.usageHintEngineer') : t('skills.usageHint')}</div>
          <div className="mt-1 flex flex-wrap gap-1">{usageQ.data?.top.map(([n, c]) => <span key={n} className="badge border border-zinc-200 dark:border-zinc-700">{n} {c}</span>)}</div>
        </div>
      </WorkArea>
      <CollapsiblePanel id="skills.bundleForm" side="right" title={t('panels.bundleForm')} icon="Puzzle" defaultWidth={320} min={240} max={440} bodyClassName="overflow-auto p-3">
      <form className="space-y-2 text-sm" onSubmit={(e) => { e.preventDefault(); setErr(null); create.mutate() }}>
        <input className="input" placeholder={t('skills.bundleName')} aria-label={t('skills.bundleName')} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" placeholder={t('skills.bundleSkills')} aria-label={t('skills.bundleSkills')} value={skills} onChange={(e) => setSkills(e.target.value)} list="skill-names" />
        <datalist id="skill-names">{skillsQ.data?.items.map((s) => <option key={s.name} value={s.name} />)}</datalist>
        <input className="input" placeholder={t('skills.bundleDesc')} value={desc} onChange={(e) => setDesc(e.target.value)} />
        {err && <div className="text-xs text-rose-600 dark:text-rose-400">{err}</div>}
        <button className="btn-primary" disabled={!name || !skills || create.isPending}>{t('skills.createBundle')}</button>
      </form>
      </CollapsiblePanel>
    </PanelGroup>
  )
}

function MemoryTab({ profile }: { profile: string }) {
  const { t } = useTranslation()
  const engineer = useEngineerMode()
  const { member } = useAuth()
  const isAdmin = member?.role === 'owner' || member?.role === 'admin'
  const qc = useQueryClient()
  const filesQ = useQuery({ queryKey: ['memory', profile, 'files'], queryFn: () => memoryApi.files(profile) })
  // 記憶 provider 的原始輸出是給工程師看的，關著就不打這支 API
  const statusQ = useQuery({ queryKey: ['memory', profile, 'status'], queryFn: () => memoryApi.status(profile), staleTime: 60_000, enabled: engineer })
  const [name, setName] = useState<string>('MEMORY.md')
  const fileQ = useQuery({ queryKey: ['memory', profile, 'file', name], queryFn: () => memoryApi.read(profile, name), enabled: !!name })
  const [draft, setDraft] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { if (fileQ.data) setDraft(fileQ.data.content) }, [fileQ.data])
  const save = useMutation({
    mutationFn: () => memoryApi.write(profile, name, draft),
    onSuccess: () => { setMsg(t('skills.saved')); setTimeout(() => setMsg(null), 2500); qc.invalidateQueries({ queryKey: ['memory', profile] }) },
    onError: (e) => setMsg(String((e as Error).message)),
  })
  const del = useMutation({ mutationFn: (n: string) => memoryApi.remove(profile, n), onSuccess: () => { setName('MEMORY.md'); qc.invalidateQueries({ queryKey: ['memory', profile] }) }, onError: (e) => setMsg(String((e as Error).message)) })
  const dirty = fileQ.data ? draft !== fileQ.data.content : false
  return (
    <PanelGroup>
      <CollapsiblePanel id="skills.memoryFiles" side="left" title={t('panels.memoryFiles')} icon="FileText" defaultWidth={280} min={220} max={440}
                        bodyClassName="space-y-2 overflow-auto p-2">
        <div className="card p-2 text-sm">
          <div className="panel-title">{t('skills.memoryFiles')}</div>
          <ul>
            {(filesQ.data?.files ?? []).map((f) => (
              <li key={f.name}>
                <button className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left ${name === f.name ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'}`} onClick={() => setName(f.name)}>
                  <span className={`min-w-0 truncate ${f.primary ? 'font-medium' : ''}`} title={f.name}>{f.name}</span>
                  <span className="ml-auto shrink-0 whitespace-nowrap text-2xs text-zinc-600 dark:text-zinc-400">{fmtSize(f.size)}</span>
                </button>
              </li>
            ))}
            {!filesQ.data?.files.some((f) => f.name === 'MEMORY.md') && <li className="px-2 text-xs text-zinc-600 dark:text-zinc-400">MEMORY.md{t('skills.memoryMissing')}</li>}
          </ul>
          {isAdmin && (
            <button className="btn-ghost mt-1 w-full justify-start text-xs" onClick={() => { const n = prompt(t('skills.newMemoryFile')); if (n) { setName(n); setDraft('') } }}>+ {t('skills.addMemoryFile')}</button>
          )}
          {engineer && <div className="path-text px-2 text-2xs text-zinc-600 dark:text-zinc-400" title={filesQ.data?.dir}>{filesQ.data?.dir}</div>}
        </div>
        {engineer && (
          <div className="card p-2 text-xs">
            <div className="panel-title">{t('skills.memoryStatus')}</div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap px-2 text-xs text-zinc-600 dark:text-zinc-300">{statusQ.data?.output ?? '…'}</pre>
          </div>
        )}
      </CollapsiblePanel>
      <WorkArea className="overflow-auto p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 truncate font-medium" title={name}>{name}</span>
          {fileQ.data && <span className="whitespace-nowrap text-xs text-zinc-600 dark:text-zinc-400">{fileQ.data.exists ? fmtTime(fileQ.data.mtime) : t('skills.newFile')}</span>}
          {msg && <span role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{msg}</span>}
          <div className="ml-auto flex gap-2">
            {isAdmin && name !== 'MEMORY.md' && name !== 'USER.md' && fileQ.data?.exists && <button className="btn-ghost text-rose-600 dark:text-rose-400" onClick={() => confirm(`${t('skills.deleteMemoryFile')} ${name}?`) && del.mutate(name)}>{t('skills.deleteMemoryFile')}</button>}
            <button className="btn-primary" disabled={!isAdmin || (!dirty && fileQ.data?.exists) || save.isPending} onClick={() => save.mutate()}>{t('skills.saveMemory')}</button>
          </div>
        </div>
        <div className="h-[420px] min-h-0 md:h-auto md:flex-1"><CodeEditor value={draft} onChange={setDraft} filename={name} readOnly={!isAdmin} ariaLabel="memory-editor" /></div>
      </WorkArea>
    </PanelGroup>
  )
}

function JourneyTab({ profile }: { profile: string }) {
  const { t } = useTranslation()
  const g = useQuery({ queryKey: ['journey', profile], queryFn: () => journeyApi.graph(profile, true), staleTime: 30_000 })
  const labels = useMemo(() => ({ all: t('skills.journeyAll'), replay: t('skills.replay'), play: t('skills.play'), pause: t('skills.pause'), nodes: t('skills.nodes'), edges: t('skills.edges'), showEntries: t('skills.showEntries') }), [t])
  if (g.isLoading) return <Loading />
  if (g.error) return <ErrorBox error={g.error} onRetry={() => g.refetch()} />
  if (!g.data) return null
  return <JourneyView graph={g.data} labels={labels} />
}

const mod: StudioModule = {
  name: 'skills',
  routes: [{ path: '/skills', element: <SkillsPage /> }],
  nav: [{ to: '/skills', key: 'skills', order: 31, group: 'agents', icon: 'Puzzle' }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
