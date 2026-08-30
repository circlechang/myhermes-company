import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fileUrl, usePreview } from '../../api/sessions'
import { ErrorBox, Loading } from '../QueryState'
import { Markdown } from './Markdown'

const fmtBytes = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)

/** 內嵌預覽面板：HTML(sandbox iframe)、PDF、圖片、Markdown、CSV、原始碼、DOCX/PPTX(後端轉 HTML)、XLSX(分頁表格) */
export function FilePreview({ path, onClose, onAttach }: { path: string; onClose: () => void; onAttach?: (path: string) => void }) {
  const { t } = useTranslation()
  const q = usePreview(path)
  const p = q.data
  const [sheet, setSheet] = useState(0)
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-preview">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        <span className="min-w-0 truncate font-medium" title={path}>{p?.name ?? path.split('/').pop()}</span>
        {p && <span className="shrink-0 text-zinc-600 dark:text-zinc-400">{p.kind} · {fmtBytes(p.size)}</span>}
        <a className="btn-ghost ml-auto shrink-0 text-xs" href={fileUrl(path, true)} download={p?.name}>{t('chat.preview.download')}</a>
        {onAttach && (
          <button type="button" className="btn-ghost shrink-0 text-xs" onClick={() => onAttach(path)}>{t('chat.preview.attach')}</button>
        )}
        <button type="button" className="btn-ghost shrink-0 text-xs" onClick={onClose} aria-label={t('common.close')}>✕</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {q.isLoading && <Loading />}
        {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
        {p && p.error && <div className="p-3 text-xs text-rose-600 dark:text-rose-400">{p.error}</div>}
        {p && p.kind === 'html' && (
          <iframe
            title={p.name}
            sandbox=""
            srcDoc={p.text}
            className="h-full w-full bg-white"
            data-testid="html-preview"
          />
        )}
        {p && p.kind === 'pdf' && <iframe title={p.name} src={fileUrl(path)} className="h-full w-full" data-testid="pdf-preview" />}
        {p && p.kind === 'image' && (
          <div className="flex items-center justify-center p-3">
            <img src={fileUrl(path)} alt={p.name} className="max-h-[80vh] max-w-full rounded" data-testid="image-preview" />
          </div>
        )}
        {p && p.kind === 'markdown' && <div className="p-3 text-sm"><Markdown text={p.text ?? ''} /></div>}
        {p && p.kind === 'code' && (
          <div className="p-3 text-sm">
            <Markdown text={'```' + (p.language ?? '') + '\n' + (p.text ?? '') + '\n```'} />
            {p.truncated && <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('chat.preview.truncated')}</div>}
          </div>
        )}
        {p && p.kind === 'csv' && <Table rows={p.rows ?? []} truncated={!!p.truncated} />}
        {p && (p.kind === 'docx' || p.kind === 'pptx') && (
          <div className="doc-preview p-3 text-sm" data-testid="doc-preview" dangerouslySetInnerHTML={{ __html: p.html ?? '' }} />
        )}
        {p && p.kind === 'xlsx' && p.sheets && (
          <div>
            <div className="flex flex-wrap gap-1 border-b border-zinc-200 px-2 py-1 dark:border-zinc-800">
              {p.sheets.map((s, i) => (
                <button key={s.name} type="button" className={`rounded px-2 py-0.5 text-xs ${i === sheet ? 'bg-zinc-200 dark:bg-zinc-700' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`} onClick={() => setSheet(i)}>
                  {s.name}
                </button>
              ))}
            </div>
            {p.sheets[sheet] && <Table rows={p.sheets[sheet].rows.map((r) => r.map((c) => String(c ?? '')))} truncated={p.sheets[sheet].truncated} />}
          </div>
        )}
        {p && p.kind === 'binary' && !p.error && <div className="p-3 text-xs text-zinc-600 dark:text-zinc-400">{t('chat.preview.noPreview')}</div>}
      </div>
    </div>
  )
}

function Table({ rows, truncated }: { rows: string[][]; truncated: boolean }) {
  const { t } = useTranslation()
  const [head, ...body] = rows
  return (
    <div className="overflow-auto p-2" data-testid="table-preview">
      <div className="table-wrap">
      <table className="min-w-full border-collapse text-xs">
        {head && (
          <thead>
            <tr>{head.map((c, i) => <th key={i} className="border border-zinc-300 bg-zinc-100 px-2 py-1 text-left dark:border-zinc-700 dark:bg-zinc-800">{c}</th>)}</tr>
          </thead>
        )}
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className="border border-zinc-300 px-2 py-1 dark:border-zinc-700">{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
      </div>
      {truncated && <div className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">{t('chat.preview.truncated')}</div>}
    </div>
  )
}
