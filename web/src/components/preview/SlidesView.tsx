// PPTX 檢視：左側投影片縮圖列（標題＋序號），右側大圖（標題／內文／圖片／表格／備註）
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PreviewPage } from './types'

export function SlidesView({ pages }: { pages: PreviewPage[] }) {
  const { t } = useTranslation()
  const [cur, setCur] = useState(0)
  const slide = pages[cur]
  if (!pages.length) return <div className="p-4 text-sm text-zinc-600 dark:text-zinc-400">{t('preview.noSlides')}</div>
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row" data-testid="pptx-preview">
      <ol className="flex shrink-0 gap-2 overflow-auto border-b border-zinc-200 p-2 md:w-48 md:flex-col md:border-b-0 md:border-r dark:border-zinc-800">
        {pages.map((p, i) => (
          <li key={p.index} className="shrink-0 md:w-full">
            <button
              className={`flex w-40 flex-col gap-0.5 rounded-md border p-2 text-left text-xs md:w-full ${
                i === cur
                  ? 'border-indigo-400 bg-indigo-50 dark:border-indigo-600 dark:bg-indigo-950/40'
                  : 'border-zinc-200 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800/60'
              }`}
              onClick={() => setCur(i)}
              data-testid={`slide-thumb-${p.index}`}
            >
              <span className="text-zinc-500">{p.index}</span>
              <span className="line-clamp-2 font-medium">{p.title || t('preview.untitledSlide')}</span>
              {p.images?.length ? <img src={p.images[0]} alt="" className="mt-1 max-h-16 w-full rounded object-cover" /> : null}
            </button>
          </li>
        ))}
      </ol>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {slide && (
          <article className="card mx-auto max-w-3xl p-5" data-testid="slide-body">
            <div className="text-xs text-zinc-500">{t('preview.slideN', { n: slide.index, total: pages.length })}</div>
            <h2 className="mt-1 text-lg font-semibold">{slide.title || t('preview.untitledSlide')}</h2>
            {slide.body?.length ? (
              <ul className="mt-3 space-y-1 text-sm">
                {slide.body.map((b, i) => (
                  <li key={i} className="flex gap-2">
                    <span aria-hidden className="text-zinc-400">•</span>
                    <span className="min-w-0 whitespace-pre-wrap">{b.trim()}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {slide.images?.map((src, i) => (
              <img key={i} src={src} alt="" className="mt-3 max-h-80 rounded border border-zinc-200 object-contain dark:border-zinc-800" />
            ))}
            {slide.tables?.map((tbl, i) => (
              <div className="table-wrap mt-3" key={i}>
                <table className="border-collapse text-xs">
                  <tbody>
                    {tbl.map((row, r) => (
                      <tr key={r}>
                        {row.map((c, j) => (
                          <td key={j} className="border border-zinc-300 px-2 py-1 dark:border-zinc-700">{c}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {slide.notes && (
              <div className="mt-4 rounded-md bg-zinc-100 p-2 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" data-testid="slide-notes">
                <div className="mb-1 font-semibold">{t('preview.notes')}</div>
                <div className="whitespace-pre-wrap">{slide.notes}</div>
              </div>
            )}
          </article>
        )}
      </div>
    </div>
  )
}
