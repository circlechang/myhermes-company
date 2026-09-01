// PDF 檢視：原檔用 <embed> 顯示（瀏覽器內建檢視器），另提供頁碼跳轉、縮放與抽出的文字面板
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PreviewPage } from './types'

export function PdfView({ url, pages, total, search = '' }: { url: string | null; pages: PreviewPage[]; total: number; search?: string }) {
  const { t } = useTranslation()
  const count = total || pages.length || 1
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(100)
  const [showText, setShowText] = useState(false)
  useEffect(() => {
    if (search.trim()) setShowText(true)
  }, [search])

  const go = (n: number) => setPage(Math.min(count, Math.max(1, n)))
  const cur = pages.find((p) => p.index === page)
  const hits = search.trim()
    ? pages.filter((p) => (p.text ?? '').toLowerCase().includes(search.trim().toLowerCase())).map((p) => p.index)
    : []

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pdf-preview">
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 px-2 py-1 text-xs dark:border-zinc-800">
        <button className="btn-ghost !px-1.5 !py-0" onClick={() => go(page - 1)} disabled={page <= 1} aria-label={t('preview.prevPage')}>‹</button>
        <label className="flex items-center gap-1">
          <input
            type="number"
            className="input h-6 w-14 px-1 py-0 text-center text-xs"
            value={page}
            min={1}
            max={count}
            aria-label={t('preview.page')}
            onChange={(e) => go(Number(e.target.value) || 1)}
            data-testid="pdf-page-input"
          />
          <span className="whitespace-nowrap text-zinc-600 dark:text-zinc-400">/ {count}</span>
        </label>
        <button className="btn-ghost !px-1.5 !py-0" onClick={() => go(page + 1)} disabled={page >= count} aria-label={t('preview.nextPage')}>›</button>
        <span className="mx-1 h-3 w-px bg-zinc-300 dark:bg-zinc-700" aria-hidden />
        <button className="btn-ghost !px-1.5 !py-0" onClick={() => setZoom((z) => Math.max(25, z - 25))} aria-label={t('preview.zoomOut')}>−</button>
        <span className="w-10 text-center tabular-nums">{zoom}%</span>
        <button className="btn-ghost !px-1.5 !py-0" onClick={() => setZoom((z) => Math.min(400, z + 25))} aria-label={t('preview.zoomIn')}>＋</button>
        {pages.length > 0 && (
          <button className="btn-ghost !px-1.5 !py-0 ml-auto" onClick={() => setShowText((v) => !v)} data-testid="pdf-toggle-text">
            {showText ? t('preview.hideText') : t('preview.showText')}
          </button>
        )}
      </div>
      {hits.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 px-2 py-1 text-xs dark:border-zinc-800" data-testid="pdf-hits">
          <span className="text-zinc-600 dark:text-zinc-400">{t('preview.searchHits', { n: hits.length })}</span>
          {hits.slice(0, 20).map((n) => (
            <button key={n} className="btn-ghost !px-1.5 !py-0" onClick={() => go(n)}>p.{n}</button>
          ))}
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-h-0 bg-zinc-100 dark:bg-zinc-950">
          {url ? (
            <object
              key={`${page}-${zoom}`}
              data={`${url}#page=${page}&zoom=${zoom}`}
              type="application/pdf"
              className="h-full w-full"
              aria-label={t('preview.pdfViewer')}
              data-testid="pdf-object"
            >
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
                <div className="text-3xl" aria-hidden>📕</div>
                <p className="max-w-sm">{t('preview.pdfFallback')}</p>
                <a className="btn-outline text-xs" href={url} target="_blank" rel="noreferrer">{t('preview.newTab')}</a>
                {pages.length > 0 && (
                  <button type="button" className="btn-ghost text-xs" onClick={() => setShowText(true)}>{t('preview.showText')}</button>
                )}
              </div>
            </object>
          ) : (
            <div className="p-4 text-sm text-zinc-600 dark:text-zinc-400">{t('preview.pdfFallback')}</div>
          )}
        </div>
        {showText && (
          <aside className="min-h-0 overflow-auto border-t border-zinc-200 p-3 text-xs md:w-80 md:border-l md:border-t-0 dark:border-zinc-800" data-testid="pdf-text">
            <div className="panel-title !px-0 !py-1">{t('preview.pageText', { n: page })}</div>
            <pre className="whitespace-pre-wrap break-words font-sans">{cur?.text ?? t('preview.noText')}</pre>
          </aside>
        )}
      </div>
    </div>
  )
}
