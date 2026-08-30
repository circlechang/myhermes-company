// 共用檔案預覽元件：一個元件涵蓋 md / docx / xlsx / csv / pptx / pdf / 圖片 / 程式碼 / HTML。
//
// 三種來源：
//   <FilePreview source={{ kind: 'path', path: '/abs/or/workspace/virtual' }} />
//   <FilePreview source={{ kind: 'inline', text, title, format }} />   // 工作流節點輸出等純文字
//   <FilePreview source={{ kind: 'url', url, title, format }} />       // 呼叫端自有的檔案端點
//
// 工具列固定提供：檔名／大小／修改時間、下載、新分頁開啟、複製內容、全螢幕、（文字類）搜尋。
// 額外動作用 `actions` 塞（例如聊天的「附回聊天」、檔案瀏覽器的「編輯」）。
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { fmtSize, fmtTime } from '../admin2/Tabs'
import { ErrorBox } from '../QueryState'
import { CodeView } from './CodeView'
import { DocxView, MarkdownView } from './DocView'
import { ImageView } from './ImageView'
import { PdfView } from './PdfView'
import { SheetView } from './SheetView'
import { SlidesView } from './SlidesView'
import { TableView } from './TableView'
import { downloadUrlFor, rawUrlFor, usePreviewSource } from './api'
import type { PreviewData, PreviewSource } from './types'
import { isTextKind } from './types'
import './preview.css'

export interface FilePreviewProps {
  source: PreviewSource
  /** 有給就顯示關閉鈕 */
  onClose?: () => void
  /** 工具列右側的額外動作 */
  actions?: ReactNode
  /** 點到內容裡的檔案路徑（Markdown 內文） */
  onOpenFile?: (path: string) => void
  /** 蓋掉標題（inline 來源常用） */
  title?: string
  className?: string
  /** 內嵌在窄面板時省略次要按鈕 */
  compact?: boolean
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-3 p-4" data-testid="preview-loading">
      <div className="h-4 w-2/5 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-3 w-full rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-3 w-11/12 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-3 w-4/5 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-28 w-full rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-3 w-3/5 rounded bg-zinc-200 dark:bg-zinc-800" />
    </div>
  )
}

function NoPreview({ data, downloadHref }: { data: PreviewData; downloadHref: string | null }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center" data-testid="preview-binary">
      <div className="text-4xl" aria-hidden>📄</div>
      <div className="max-w-full break-all text-sm font-medium">{data.title}</div>
      <div className="text-xs text-zinc-600 dark:text-zinc-400">
        {fmtSize(data.size)} · {data.mime || t('preview.unknownType')}
      </div>
      <p className="max-w-sm text-xs text-zinc-600 dark:text-zinc-400">
        {data.too_large ? t('preview.tooLarge') : data.error || t('preview.noPreview')}
      </p>
      {downloadHref && (
        <a className="btn-outline mt-1 text-xs" href={downloadHref} download={data.title}>
          {t('preview.download')}
        </a>
      )}
    </div>
  )
}

export function FilePreview({ source, onClose, actions, onOpenFile, title, className = '', compact = false }: FilePreviewProps) {
  const { t } = useTranslation()
  const q = usePreviewSource(source)
  const data = q.data
  const [full, setFull] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [htmlSource, setHtmlSource] = useState(false)
  const [copied, setCopied] = useState(false)

  const rawHref = rawUrlFor(source)
  const downloadHref = downloadUrlFor(source, data)
  const displayTitle = title ?? data?.title ?? (source.kind === 'path' ? source.path.split('/').pop() : t('preview.title'))
  const fullPath = source.kind === 'path' ? source.path : data?.path ?? ''

  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  const copyText = useMemo(() => {
    if (!data) return ''
    if (data.text) return data.text
    if (data.rows) return data.rows.map((r) => r.join('\t')).join('\n')
    if (data.sheets) return data.sheets.map((s) => `# ${s.name}\n` + s.rows.map((r) => r.join('\t')).join('\n')).join('\n\n')
    if (data.pages) return data.pages.map((p) => p.text ?? [p.title, ...(p.body ?? []), p.notes].filter(Boolean).join('\n')).join('\n\n---\n\n')
    if (data.html) return data.html.replace(/<[^>]+>/g, '')
    return ''
  }, [data])

  const doCopy = async () => {
    try {
      await navigator.clipboard?.writeText(copyText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* http 非 localhost 時 clipboard 不可用 */
    }
  }

  const searchable = !!data && (isTextKind(data.kind) || data.kind === 'pdf')

  const body = (() => {
    if (q.isLoading) return <Skeleton />
    if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />
    if (!data) return null
    if (data.too_large || data.kind === 'binary') return <NoPreview data={data} downloadHref={downloadHref} />
    switch (data.kind) {
      case 'markdown':
        return <MarkdownView text={data.text ?? ''} onOpenFile={onOpenFile} />
      case 'docx':
        return <DocxView html={data.html ?? ''} />
      case 'xlsx':
        return <SheetView sheets={data.sheets ?? []} />
      case 'csv':
        return (
          <TableView
            rows={data.rows ?? []}
            numericCols={data.meta.numeric_cols}
            note={data.meta.truncated ? t('preview.truncated') : undefined}
          />
        )
      case 'pptx':
        return <SlidesView pages={data.pages ?? []} />
      case 'pdf':
        return <PdfView url={rawHref} pages={data.pages ?? []} total={data.meta.pages ?? 0} search={search} />
      case 'image':
        return rawHref ? <ImageView url={rawHref} alt={data.title} meta={data.meta} /> : <NoPreview data={data} downloadHref={downloadHref} />
      case 'html':
        return htmlSource ? (
          <CodeView text={data.text ?? ''} language="xml" wrap={wrap} search={search} />
        ) : (
          <iframe title={data.title} sandbox="" srcDoc={data.text ?? ''} className="min-h-0 w-full flex-1 bg-white" data-testid="html-preview" />
        )
      case 'code':
      default:
        return <CodeView text={data.text ?? ''} language={data.meta.language ?? 'text'} wrap={wrap} search={search} />
    }
  })()

  const shell = (
    <div className={`flex min-h-0 flex-col ${full ? 'h-full' : 'h-full'} ${className}`} data-testid="file-preview">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        <span className="min-w-[6rem] flex-1 basis-40 truncate font-medium" title={fullPath || displayTitle} data-testid="preview-title">
          {displayTitle}
        </span>
        {data && (
          <span className="shrink-0 whitespace-nowrap text-zinc-600 dark:text-zinc-400" data-testid="preview-meta">
            {data.kind}
            {data.size ? ` · ${fmtSize(data.size)}` : ''}
            {data.mtime ? ` · ${fmtTime(data.mtime)}` : ''}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-0.5">
          {searchable && (
            <button
              type="button"
              className="btn-ghost !px-1.5 !py-0.5 text-xs"
              onClick={() => setShowSearch((v) => !v)}
              aria-label={t('preview.search')}
              data-testid="preview-search-toggle"
            >
              🔍
            </button>
          )}
          {data?.kind === 'html' && (
            <button type="button" className="btn-ghost !px-1.5 !py-0.5 text-xs" onClick={() => setHtmlSource((v) => !v)}>
              {htmlSource ? t('preview.rendered') : t('preview.source')}
            </button>
          )}
          {data && (data.kind === 'code' || data.kind === 'html') && !compact && (
            <button type="button" className="btn-ghost !px-1.5 !py-0.5 text-xs" onClick={() => setWrap((v) => !v)} data-testid="preview-wrap">
              {wrap ? t('preview.nowrap') : t('preview.wrap')}
            </button>
          )}
          {copyText && (
            <button type="button" className="btn-ghost !px-1.5 !py-0.5 text-xs" onClick={doCopy} data-testid="preview-copy">
              {copied ? t('preview.copied') : t('preview.copy')}
            </button>
          )}
          {downloadHref && (
            <a className="btn-ghost !px-1.5 !py-0.5 text-xs" href={downloadHref} download={data?.title ?? true} data-testid="preview-download">
              {t('preview.download')}
            </a>
          )}
          {rawHref && !compact && (
            <a className="btn-ghost !px-1.5 !py-0.5 text-xs" href={rawHref} target="_blank" rel="noreferrer" data-testid="preview-newtab">
              {t('preview.newTab')}
            </a>
          )}
          <button
            type="button"
            className="btn-ghost !px-1.5 !py-0.5 text-xs"
            onClick={() => setFull((v) => !v)}
            aria-label={full ? t('preview.exitFullscreen') : t('preview.fullscreen')}
            data-testid="preview-fullscreen"
          >
            {full ? '⤡' : '⤢'}
          </button>
          {actions}
          {onClose && (
            <button type="button" className="btn-ghost !px-1.5 !py-0.5 text-xs" onClick={onClose} aria-label={t('common.close')} data-testid="preview-close">
              ✕
            </button>
          )}
        </span>
      </div>
      {showSearch && searchable && (
        <div className="border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
          <input
            autoFocus
            className="input h-7 py-0.5 text-xs"
            placeholder={t('preview.searchPlaceholder')}
            aria-label={t('preview.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="preview-search-input"
          />
        </div>
      )}
      {data?.warnings?.length ? (
        <ul className="border-b border-amber-200 bg-amber-50 px-3 py-1 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200" data-testid="preview-warnings">
          {data.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
    </div>
  )

  if (!full) return shell
  return (
    <div className="fixed inset-0 z-50 bg-white dark:bg-zinc-900" role="dialog" aria-modal="true" data-testid="preview-fullscreen-layer">
      {shell}
    </div>
  )
}

export default FilePreview
