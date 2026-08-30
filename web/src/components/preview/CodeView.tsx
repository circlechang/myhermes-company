// 程式碼／純文字檢視：行號、語言標籤、複製、自動換行切換、搜尋命中高亮
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import hljs from 'highlight.js/lib/common'
import './preview.css'

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function CodeView({
  text,
  language = 'text',
  wrap,
  search = '',
}: {
  text: string
  language?: string
  wrap: boolean
  search?: string
}) {
  const { t } = useTranslation()
  const preRef = useRef<HTMLPreElement>(null)
  const lines = useMemo(() => text.split('\n'), [text])

  const html = useMemo(() => {
    let out: string
    try {
      out = language && language !== 'text' && hljs.getLanguage(language)
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : escapeHtml(text)
    } catch {
      out = escapeHtml(text)
    }
    const q = search.trim()
    if (q) {
      // 只在標籤外的文字上做標記，避免破壞 hljs 產生的 span
      const re = new RegExp(`(${escapeRe(q)})(?![^<]*>)`, 'gi')
      out = out.replace(re, '<mark class="bg-amber-200 text-black dark:bg-amber-500/70 dark:text-black">$1</mark>')
    }
    return out
  }, [text, language, search])

  const hits = useMemo(() => {
    const q = search.trim()
    if (!q) return 0
    return lines.filter((l) => l.toLowerCase().includes(q.toLowerCase())).length
  }, [lines, search])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="code-preview">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-2 py-1 text-[11px] text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
        <span className="badge bg-zinc-200 dark:bg-zinc-800" data-testid="code-lang">{language || 'text'}</span>
        <span>{t('preview.lineCount', { n: lines.length })}</span>
        {search.trim() && <span data-testid="code-hits">{t('preview.searchHits', { n: hits })}</span>}
      </div>
      <div className="code-view min-h-0 flex-1 overflow-auto bg-zinc-50 dark:bg-zinc-950">
        <div className="flex min-h-full">
          {!wrap && (
            <div
              className="code-gutter sticky left-0 shrink-0 select-none border-r border-zinc-200 bg-zinc-100 px-2 py-2 font-mono text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900"
              aria-hidden
              data-testid="code-gutter"
            >
              {lines.map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
          )}
          <pre
            ref={preRef}
            className={`min-w-0 flex-1 p-2 font-mono ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}
          >
            <code className="hljs bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
        </div>
      </div>
    </div>
  )
}
