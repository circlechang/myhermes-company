import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { StudioModule } from '../registry'
import { PageHeader } from '../../components/PageHeader'
import { CollapsiblePanel, PanelGroup, WorkArea } from '../../components/layout/index'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import { CodeEditor } from '../../components/admin2/CodeEditor'
import { fmtSize, fmtTime } from '../../components/admin2/Tabs'
import { getToken } from '../../api/client'
import { FilePreview } from '../../components/preview'
import { dispatchAttach, filesApi, type FileEntry } from './api'

const zhTW = {
  nav: { files: '檔案' },
  files: {
    title: '檔案瀏覽器',
    subtitle: '瀏覽 Hermes workspace、各 profile 目錄與上傳區（僅本機；Docker/SSH 不支援）',
    root: '根目錄',
    up: '上一層',
    upload: '上傳',
    mkdir: '新資料夾',
    mkdirPrompt: '資料夾名稱',
    rename: '重新命名',
    renamePrompt: '新名稱',
    copy: '複製到…',
    move: '移動到…',
    destPrompt: '目的地目錄（虛擬路徑，例如 workspace/sub）',
    delete: '刪除',
    deleteConfirm: '確定刪除「{{name}}」？此動作無法復原。',
    download: '下載',
    attach: '附回聊天',
    attached: '已附加：{{uri}}',
    save: '儲存',
    saved: '已儲存',
    binary: '二進位檔案，無法預覽（{{size}}）',
    truncated: '檔案過大，只顯示前 2MB（唯讀）',
    readonly: '此根目錄僅 owner/admin 可寫入',
    name: '名稱',
    size: '大小',
    mtime: '修改時間',
    selectFile: '選一個檔案預覽或編輯',
    modePreview: '預覽',
    modeEdit: '編輯',
    editUnavailable: '這個檔案不能在這裡編輯（二進位或過大）',
    empty: '空目錄',
    missingRoot: '（目錄不存在）',
  },
}
const en = { nav: { files: 'Files' }, files: { title: 'Files', subtitle: 'Browse local Hermes workspace / profiles / uploads', up: 'Up', upload: 'Upload', save: 'Save', attach: 'Attach to chat', modePreview: 'Preview', modeEdit: 'Edit', editUnavailable: 'This file cannot be edited here (binary or too large)' } }

export function FilesPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const rootsQ = useQuery({ queryKey: ['files', 'roots'], queryFn: filesApi.roots })
  const [dir, setDir] = useState<string>('')
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [notice, setNotice] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!dir && rootsQ.data?.length) setDir(rootsQ.data.find((r) => r.exists)?.id ?? rootsQ.data[0].id)
  }, [rootsQ.data, dir])

  useEffect(() => setMode('preview'), [selected])
  const listQ = useQuery({ queryKey: ['files', 'list', dir], queryFn: () => filesApi.list(dir), enabled: !!dir })
  const fileQ = useQuery({ queryKey: ['files', 'read', selected], queryFn: () => filesApi.read(selected!), enabled: !!selected })
  useEffect(() => {
    if (fileQ.data) setDraft(fileQ.data.content ?? '')
  }, [fileQ.data])

  const rootId = dir.split('/')[0]
  const root = rootsQ.data?.find((r) => r.id === rootId)
  const writable = root?.writable ?? false
  const refresh = () => qc.invalidateQueries({ queryKey: ['files', 'list'] })
  const flash = (msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(null), 2500)
  }
  const onErr = (e: unknown) => flash(e instanceof Error ? e.message : String(e))

  const save = useMutation({
    mutationFn: () => filesApi.write(selected!, draft),
    onSuccess: () => {
      flash(t('files.saved'))
      qc.invalidateQueries({ queryKey: ['files', 'read', selected] })
      refresh()
    },
    onError: onErr,
  })
  const act = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => refresh(),
    onError: onErr,
  })

  const doUpload = async (files: FileList | null) => {
    if (!files?.length) return
    for (const f of Array.from(files)) await filesApi.upload(dir, f).catch(onErr)
    refresh()
  }
  const download = async (e: FileEntry) => {
    const res = await fetch(filesApi.downloadUrl(e.path), { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = e.name
    a.click()
    URL.revokeObjectURL(url)
  }
  const attach = async (e: FileEntry) => {
    const r = await filesApi.attach(e.path)
    dispatchAttach({ path: e.path, uri: r.uri, name: r.name })
    flash(t('files.attached', { uri: r.uri }))
  }

  const dirty = fileQ.data ? draft !== (fileQ.data.content ?? '') : false

  return (
    <PanelGroup>
      <CollapsiblePanel id="files.tree" side="left" title={t('panels.fileTree')} icon="Folder" defaultWidth={380} min={240} max={560} bodyClassName="flex min-h-0 flex-col overflow-hidden">
        <div className="p-4 pb-2">
          <PageHeader title={t('files.title')} subtitle={t('files.subtitle')} />
          <label className="flex min-w-0 items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
            <span className="shrink-0 whitespace-nowrap">{t('files.root')}</span>
            <select aria-label={t('files.root')} className="input" value={rootId} onChange={(e) => { setDir(e.target.value); setSelected(null) }}>
              {rootsQ.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label} {r.exists ? '' : t('files.missingRoot')}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
            <code className="max-w-full truncate rounded bg-zinc-100 px-1 py-0.5 font-mono dark:bg-zinc-800" title={dir}>{dir}</code>
            <button className="btn-ghost" disabled={!listQ.data?.parent} onClick={() => listQ.data?.parent && setDir(listQ.data.parent)}>↑ {t('files.up')}</button>
            <button className="btn-ghost" disabled={!writable} onClick={() => fileInput.current?.click()}>{t('files.upload')}</button>
            <input ref={fileInput} type="file" multiple hidden aria-label={t('files.upload')} onChange={(e) => doUpload(e.target.files)} />
            <button className="btn-ghost" disabled={!writable} onClick={() => { const n = prompt(t('files.mkdirPrompt')); if (n) act.mutate(() => filesApi.mkdir(`${dir}/${n}`)) }}>{t('files.mkdir')}</button>
          </div>
          {!writable && root && <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">{t('files.readonly')}</div>}
          {notice && <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-300" role="status">{notice}</div>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (writable) doUpload(e.dataTransfer.files) }}>
          {listQ.isLoading && <Loading />}
          {listQ.error && <ErrorBox error={listQ.error} onRetry={() => listQ.refetch()} />}
          {listQ.data?.entries.length === 0 && <Empty text={t('files.empty')} />}
          <ul className="text-sm">
            {listQ.data?.entries.map((e) => (
              <li key={e.path} className={`group flex items-center gap-2 rounded-md px-2 py-1 ${selected === e.path ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'}`}>
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => (e.kind === 'dir' ? (setDir(e.path), setSelected(null)) : setSelected(e.path))}>
                  <span aria-hidden>{e.kind === 'dir' ? '📁' : '📄'}</span>
                  <span className="truncate">{e.name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-zinc-600 dark:text-zinc-400">{e.kind === 'file' ? fmtSize(e.size) : ''}</span>
                </button>
                <details className="relative">
                  <summary className="cursor-pointer list-none px-1 text-zinc-600 dark:text-zinc-400" aria-label={`${e.name} 操作`}>⋯</summary>
                  <div className="absolute right-0 z-10 mt-1 flex w-40 flex-col rounded-md border border-zinc-200 bg-white p-1 text-xs shadow dark:border-zinc-700 dark:bg-zinc-900">
                    {e.kind === 'file' && <button className="btn-ghost justify-start" onClick={() => download(e)}>{t('files.download')}</button>}
                    <button className="btn-ghost justify-start" onClick={() => attach(e)}>{t('files.attach')}</button>
                    <button className="btn-ghost justify-start" disabled={!writable} onClick={() => { const n = prompt(t('files.renamePrompt'), e.name); if (n && n !== e.name) act.mutate(() => filesApi.rename(e.path, n)) }}>{t('files.rename')}</button>
                    <button className="btn-ghost justify-start" onClick={() => { const d = prompt(t('files.destPrompt'), dir); if (d) act.mutate(() => filesApi.copy(e.path, d)) }}>{t('files.copy')}</button>
                    <button className="btn-ghost justify-start" disabled={!writable} onClick={() => { const d = prompt(t('files.destPrompt'), dir); if (d) act.mutate(() => filesApi.move(e.path, d)) }}>{t('files.move')}</button>
                    <button className="btn-ghost justify-start text-rose-600 dark:text-rose-400" disabled={!writable} onClick={() => { if (confirm(t('files.deleteConfirm', { name: e.name }))) { act.mutate(() => filesApi.remove(e.path)); if (selected === e.path) setSelected(null) } }}>{t('files.delete')}</button>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </div>
      </CollapsiblePanel>
      <WorkArea>
        {!selected ? (
          <Empty text={t('files.selectFile')} />
        ) : fileQ.isLoading ? (
          <Loading />
        ) : fileQ.error ? (
          <ErrorBox error={fileQ.error} />
        ) : fileQ.data ? (
          (() => {
            const f = fileQ.data
            const editable = !f.binary && !f.truncated
            const modeButtons = (
              <>
                <button
                  type="button"
                  className={`btn-ghost !px-1.5 !py-0.5 text-xs ${mode === 'preview' ? 'bg-zinc-200 dark:bg-zinc-800' : ''}`}
                  onClick={() => setMode('preview')}
                  data-testid="files-mode-preview"
                >
                  {t('files.modePreview')}
                </button>
                <button
                  type="button"
                  className={`btn-ghost !px-1.5 !py-0.5 text-xs ${mode === 'edit' ? 'bg-zinc-200 dark:bg-zinc-800' : ''}`}
                  disabled={!editable}
                  title={editable ? undefined : t('files.editUnavailable')}
                  onClick={() => setMode('edit')}
                  data-testid="files-mode-edit"
                >
                  {t('files.modeEdit')}
                </button>
                <button
                  type="button"
                  className="btn-ghost !px-1.5 !py-0.5 text-xs"
                  onClick={() => attach({ name: f.name, path: f.path, kind: 'file', size: 0, mtime: 0 })}
                >
                  {t('files.attach')}
                </button>
              </>
            )
            if (mode === 'preview')
              return <FilePreview source={{ kind: 'path', path: f.path }} actions={modeButtons} />
            return (
              <div className="flex min-h-0 flex-1 flex-col p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 truncate font-medium" title={f.path}>{f.name}</span>
                  <span className="shrink-0 text-xs text-zinc-600 dark:text-zinc-400">{fmtSize(f.size)} · {fmtTime(f.mtime)} · {f.mime}</span>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    {modeButtons}
                    <button className="btn-primary !py-0.5 text-xs" disabled={!dirty || !writable || save.isPending} onClick={() => save.mutate()}>{t('files.save')}</button>
                  </div>
                </div>
                <div className="min-h-0 flex-1">
                  {f.truncated && <div className="mb-1 text-xs text-amber-700">{t('files.truncated')}</div>}
                  <CodeEditor value={draft} onChange={setDraft} filename={f.name} readOnly={!writable || f.truncated} ariaLabel="editor" />
                </div>
              </div>
            )
          })()
        ) : null}
      </WorkArea>
    </PanelGroup>
  )
}

const mod: StudioModule = {
  name: 'files',
  routes: [{ path: '/files', element: <FilesPage /> }],
  nav: [{ to: '/files', key: 'files', order: 45, group: 'connect', icon: 'FileText' }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
