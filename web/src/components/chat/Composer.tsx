import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { chatApi, type Attachment } from '../../api/sessions'
import type { TextItem } from '../../ws/chatState'

export interface ComposerProps {
  sessionId?: string
  disabled?: boolean
  running: boolean
  onSend: (text: string, attachments: Attachment[], replyTo?: string) => boolean
  onStop: () => void
  onSteer: (text: string) => boolean
  reply?: TextItem
  onCancelReply: () => void
  editing?: TextItem
  onCancelEdit: () => void
  onSubmitEdit: (text: string) => boolean
  compression?: { status: string; detail?: string }
  /** 從預覽面板「附回聊天」塞進來的既有檔案 */
  externalAttachments?: Attachment[]
  onConsumeExternal?: () => void
}

const fmtBytes = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)

export function Composer(p: ComposerProps) {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (p.editing) { setInput(p.editing.content); taRef.current?.focus() }
  }, [p.editing])
  useEffect(() => {
    if (p.externalAttachments?.length) {
      setFiles((f) => [...f, ...p.externalAttachments!.filter((a) => !f.some((x) => x.path === a.path))])
      p.onConsumeExternal?.()
    }
  }, [p.externalAttachments]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setFiles([]); setInput(''); setErr(null) }, [p.sessionId])

  const upload = async (list: File[]) => {
    if (!p.sessionId || list.length === 0) return
    setErr(null)
    setUploading((n) => n + list.length)
    try {
      const out = await chatApi.uploads.upload(p.sessionId, list)
      setFiles((f) => [...f, ...out])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading((n) => n - list.length)
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === 'file')
    if (items.length === 0) return
    e.preventDefault()
    const fs = items.map((i) => i.getAsFile()).filter((f): f is File => !!f)
      .map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `paste-${Date.now()}-${i}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })))
    upload(fs)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDrag(false)
    upload([...e.dataTransfer.files])
  }
  const submit = () => {
    const text = input.trim()
    if (p.editing) {
      if (!text) return
      if (p.onSubmitEdit(text)) setInput('')
      return
    }
    if (p.running) {
      // 進行中：輸入框變成「插話」
      if (text && p.onSteer(text)) setInput('')
      return
    }
    if (!text && files.length === 0) return
    if (p.onSend(text, files, p.reply?.message_id ?? p.reply?.id)) {
      setInput('')
      setFiles([])
    }
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
    if (e.key === 'Escape') { if (p.editing) p.onCancelEdit(); else if (p.reply) p.onCancelReply() }
  }
  const canSend = !p.disabled && !!p.sessionId && uploading === 0 && (input.trim().length > 0 || files.length > 0)

  return (
    <div
      className={`border-t border-zinc-200 p-3 dark:border-zinc-800 ${drag ? 'bg-indigo-50 dark:bg-indigo-950/30' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
      data-testid="composer"
    >
      {p.compression && (
        <div className="mb-1 text-[11px] text-amber-700 dark:text-amber-400" data-testid="compression">{t('chat.compressing')} {p.compression.status}{p.compression.detail ? ` · ${p.compression.detail}` : ''}</div>
      )}
      {p.reply && !p.editing && (
        <div className="mb-1 flex items-start gap-2 rounded border-l-2 border-indigo-400 bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-800" data-testid="reply-bar">
          <div className="min-w-0 flex-1">
            <div className="text-zinc-600 dark:text-zinc-400">{t('chat.replyingTo')} · {p.reply.role === 'user' ? t('chat.roleUser') : t('chat.roleAssistant')}</div>
            <div className="line-clamp-2 whitespace-pre-wrap">{p.reply.content}</div>
          </div>
          <button type="button" className="btn-ghost px-1 text-xs" onClick={p.onCancelReply} aria-label={t('common.cancel')}>✕</button>
        </div>
      )}
      {p.editing && (
        <div className="mb-1 flex items-center gap-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200" data-testid="edit-bar">
          <span>{t('chat.editingLast')}</span>
          <button type="button" className="btn-ghost ml-auto px-1 text-xs" onClick={() => { p.onCancelEdit(); setInput('') }}>{t('common.cancel')}</button>
        </div>
      )}
      {(files.length > 0 || uploading > 0) && (
        <div className="mb-1 flex flex-wrap gap-1" data-testid="pending-attachments">
          {files.map((a) => (
            <span key={a.path} className="inline-flex items-center gap-1 rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] dark:border-zinc-700" title={a.path}>
              <span aria-hidden>{a.mime?.startsWith('image/') ? '🖼' : '📄'}</span>
              <span className="max-w-[10rem] truncate">{a.name}</span>
              <span className="text-zinc-600 dark:text-zinc-400">{fmtBytes(a.size)}</span>
              <button type="button" className="text-zinc-600 dark:text-zinc-400 hover:text-rose-600" onClick={() => setFiles((f) => f.filter((x) => x.path !== a.path))} aria-label={`${t('common.delete')} ${a.name}`}>✕</button>
            </span>
          ))}
          {uploading > 0 && <span className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('chat.uploading', { n: uploading })}</span>}
        </div>
      )}
      {err && <div className="mb-1 text-xs text-rose-600 dark:text-rose-400">{err}</div>}
      <div className="flex items-end gap-2">
        <input ref={fileRef} type="file" multiple className="hidden" data-testid="file-input" onChange={(e) => { upload([...(e.target.files ?? [])]); e.target.value = '' }} />
        <button type="button" className="btn-ghost shrink-0 px-2" title={t('chat.attach')} aria-label={t('chat.attach')} onClick={() => fileRef.current?.click()} disabled={!p.sessionId || p.disabled}>📎</button>
        <textarea
          ref={taRef}
          aria-label={t('workbench.inputPlaceholder')}
          className="input min-h-[44px] max-h-40 resize-y"
          rows={2}
          placeholder={p.running ? t('chat.steerPlaceholder') : t('workbench.inputPlaceholder')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          disabled={p.disabled}
        />
        {p.running ? (
          <div className="flex shrink-0 flex-col gap-1">
            <button type="button" className="btn-outline" onClick={submit} disabled={!input.trim()} data-testid="steer-btn">{t('chat.steer')}</button>
            <button type="button" className="btn-danger" onClick={p.onStop}>{t('workbench.stop')}</button>
          </div>
        ) : (
          <button type="button" className="btn-primary shrink-0" onClick={submit} disabled={!canSend}>{p.editing ? t('chat.resend') : t('workbench.send')}</button>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-600 dark:text-zinc-400">
        {p.running && <span>{t('workbench.running')}</span>}
        <span className="ml-auto">{t('chat.dropHint')}</span>
      </div>
    </div>
  )
}
