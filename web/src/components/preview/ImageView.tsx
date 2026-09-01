// 圖片檢視：滾輪縮放、拖曳平移、點擊在「符合視窗 ↔ 100%」之間切換；下方顯示尺寸與 EXIF 摘要
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PreviewMeta } from './types'
import './preview.css'

export function ImageView({ url, alt, meta }: { url: string; alt: string; meta: PreviewMeta }) {
  const { t } = useTranslation()
  const [zoom, setZoom] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  const reset = useCallback(() => {
    setZoom(1)
    setPos({ x: 0, y: 0 })
  }, [])
  const bump = (f: number) => setZoom((z) => Math.min(8, Math.max(0.1, Number((z * f).toFixed(3)))))

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 2) return
    e.preventDefault()
    bump(e.deltaY < 0 ? 1.12 : 1 / 1.12)
  }
  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, ox: pos.x, oy: pos.y }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    setPos({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) })
  }
  const onUp = () => {
    drag.current = null
  }

  const exif = meta.exif ?? {}
  const exifRows = Object.entries(exif)
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="image-preview">
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 px-2 py-1 text-xs dark:border-zinc-800">
        <button className="btn-ghost !px-1.5 !py-0" onClick={() => bump(1 / 1.25)} aria-label={t('preview.zoomOut')}>−</button>
        <span className="w-12 text-center tabular-nums" data-testid="image-zoom">{Math.round(zoom * 100)}%</span>
        <button className="btn-ghost !px-1.5 !py-0" onClick={() => bump(1.25)} aria-label={t('preview.zoomIn')}>＋</button>
        <button className="btn-ghost !px-1.5 !py-0" onClick={reset}>{t('preview.zoomReset')}</button>
        {meta.width ? (
          <span className="ml-auto text-zinc-600 dark:text-zinc-400">
            {meta.width}×{meta.height} · {meta.format}
            {meta.animated ? ` · ${t('preview.animated')}` : ''}
          </span>
        ) : null}
      </div>
      <div
        className="img-stage flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[repeating-conic-gradient(#00000008_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-2"
        onWheel={onWheel}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => (zoom === 1 ? setZoom(2) : reset())}
      >
        <img
          src={url}
          alt={alt}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain"
          style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${zoom})`, transformOrigin: 'center center' }}
        />
      </div>
      {exifRows.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-t border-zinc-200 p-2 text-xs dark:border-zinc-800" data-testid="image-exif">
          {exifRows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="whitespace-nowrap text-zinc-600 dark:text-zinc-400">{k}</dt>
              <dd className="min-w-0 truncate" title={v}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
