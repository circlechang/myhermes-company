// 文件類檢視（Markdown／DOCX）：內文 + 自動目錄側欄（h1–h3，可跳轉、捲動高亮）
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Markdown } from '../chat/Markdown'
import './preview.css'

interface TocItem {
  id: string
  text: string
  level: number
}

function collectHeadings(root: HTMLElement): TocItem[] {
  const out: TocItem[] = []
  root.querySelectorAll<HTMLHeadingElement>('h1, h2, h3').forEach((el, i) => {
    if (!el.id) el.id = `pv-h-${i}`
    const text = (el.textContent ?? '').trim()
    if (text) out.push({ id: el.id, text, level: Number(el.tagName[1]) })
  })
  return out
}

/** 內文 + 目錄的共用外殼。內文由 `children` 提供，目錄從實際渲染出來的 DOM 掃出來。 */
export function DocShell({
  children,
  contentKey,
  testId,
}: {
  children: React.ReactNode
  contentKey: string
  testId?: string
}) {
  const { t } = useTranslation()
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [toc, setToc] = useState<TocItem[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [open, setOpen] = useState(true)

  useLayoutEffect(() => {
    if (bodyRef.current) setToc(collectHeadings(bodyRef.current))
  }, [contentKey, children])

  // 目錄只在容器夠寬時出現：同一個元件會被塞進 300px 的聊天面板，
  // 用視窗斷點（md:）會把內文擠成一行一個字。0＝還沒量到（jsdom）→ 照常顯示。
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const upd = () => setWidth(el.clientWidth)
    upd()
    const ro = new ResizeObserver(upd)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = useCallback(() => {
    const sc = scrollRef.current
    const body = bodyRef.current
    if (!sc || !body || !toc.length) return
    let cur: string | null = toc[0]?.id ?? null
    for (const it of toc) {
      const el = body.querySelector<HTMLElement>(`#${CSS.escape(it.id)}`)
      if (el && el.offsetTop - sc.scrollTop <= 24) cur = it.id
    }
    setActive(cur)
  }, [toc])

  useEffect(() => {
    onScroll()
  }, [onScroll])

  const jump = (id: string) => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
    const sc = scrollRef.current
    if (el && sc) sc.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior: 'smooth' })
    setActive(id)
  }

  const showToc = toc.length >= 2 && (width === 0 || width >= 620)
  return (
    <div ref={rootRef} className="flex min-h-0 flex-1" data-testid={testId}>
      <div ref={scrollRef} onScroll={onScroll} className="min-w-0 flex-1 overflow-auto">
        <div ref={bodyRef} className="p-4 text-sm" data-preview-body>
          {children}
        </div>
      </div>
      {showToc && (
        <nav
          className={`flex shrink-0 flex-col border-l border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40 ${open ? 'w-56' : 'w-9'}`}
          data-testid="preview-toc"
          aria-label={t('preview.toc')}
        >
          <button
            className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            onClick={() => setOpen((v) => !v)}
            title={t('preview.toc')}
          >
            <span aria-hidden>{open ? '‹' : '›'}</span>
            {open && <span className="truncate">{t('preview.toc')}</span>}
          </button>
          {open && (
            <ol className="min-h-0 flex-1 overflow-auto px-1 pb-2 text-xs">
              {toc.map((it) => (
                <li key={it.id}>
                  <button
                    className={`block w-full truncate rounded px-1.5 py-0.5 text-left hover:bg-zinc-200 dark:hover:bg-zinc-800 ${
                      active === it.id ? 'bg-zinc-200 font-medium dark:bg-zinc-800' : 'text-zinc-600 dark:text-zinc-400'
                    }`}
                    style={{ paddingLeft: `${(it.level - 1) * 10 + 6}px` }}
                    title={it.text}
                    onClick={() => jump(it.id)}
                  >
                    {it.text}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </nav>
      )}
    </div>
  )
}

export function MarkdownView({ text, onOpenFile }: { text: string; onOpenFile?: (p: string) => void }) {
  return (
    <DocShell contentKey={text.slice(0, 64) + text.length} testId="markdown-preview">
      <Markdown text={text} onOpenFile={onOpenFile} />
    </DocShell>
  )
}

export function DocxView({ html }: { html: string }) {
  return (
    <DocShell contentKey={String(html.length)} testId="docx-preview">
      <div className="doc-rich" dangerouslySetInnerHTML={{ __html: html }} />
    </DocShell>
  )
}
