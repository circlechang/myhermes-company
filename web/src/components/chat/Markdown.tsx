import { useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useTranslation } from 'react-i18next'
import './chat.css'

/** 絕對路徑（macOS/Linux）＋副檔名；不含空白。給「agent 產出的檔案可點擊」用。 */
export const FILE_PATH_RE = /(?<![\w:/])(~?\/(?:[\w.\-一-鿿@%+]+\/)*[\w.\-一-鿿@%+]+\.[A-Za-z0-9]{1,8})(?![\w/])/g

export function extractFilePaths(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(FILE_PATH_RE)) out.add(m[1])
  return [...out]
}

/** 把純文字裡的路徑改寫成 studio-file: 連結（跳過 code fence 與 inline code） */
function linkifyPaths(md: string): string {
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  return parts
    .map((p, i) => (i % 2 === 1 ? p : p.replace(FILE_PATH_RE, (_m, path: string) => `[${path}](studio-file:${encodeURIComponent(path)})`)))
    .join('')
}

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const { t } = useTranslation()
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={`rounded px-1.5 py-0.5 text-xs text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-700 dark:hover:text-zinc-100 ${className}`}
      onClick={async (e) => {
        e.stopPropagation()
        try {
          await navigator.clipboard?.writeText(text)
        } catch {
          /* clipboard 不可用（http 非 localhost）時忽略 */
        }
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
      aria-label={t('chat.copy')}
    >
      {done ? t('chat.copied') : t('chat.copy')}
    </button>
  )
}

function CodeBlock({ children, className, onOpenFile }: { children: ReactNode; className?: string; onOpenFile?: (p: string) => void }) {
  const lang = /language-([\w-]+)/.exec(className ?? '')?.[1]
  const raw = extractText(children)
  return (
    <div className="group/code relative my-2 overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 text-xs dark:border-zinc-700 dark:bg-zinc-950" data-testid="code-block">
      <div className="flex items-center justify-between border-b border-zinc-200 px-2 py-0.5 text-2xs text-zinc-600 dark:text-zinc-400 dark:border-zinc-800">
        <span>{lang ?? 'text'}</span>
        <CopyButton text={raw} />
      </div>
      <pre className="overflow-x-auto p-2">
        <code className={className}>{children}</code>
      </pre>
      {onOpenFile && extractFilePaths(raw).length > 0 && (
        <div className="flex flex-wrap gap-1 border-t border-zinc-200 px-2 py-1 dark:border-zinc-800">
          {extractFilePaths(raw).map((p) => (
            <FileChip key={p} path={p} onOpen={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  )
}

function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) return extractText((node as { props: { children?: ReactNode } }).props.children)
  return ''
}

export function FileChip({ path, onOpen }: { path: string; onOpen: (p: string) => void }) {
  const name = path.split('/').pop() ?? path
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 font-mono text-xs text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200"
      title={path}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(path)
      }}
      data-testid="file-chip"
    >
      <span aria-hidden>📎</span>
      <span className="truncate">{name}</span>
    </button>
  )
}

export function Markdown({ text, onOpenFile, className = '' }: { text: string; onOpenFile?: (p: string) => void; className?: string }) {
  const components: Components = useMemo(() => ({
    a: ({ href, children }) => {
      if (href?.startsWith('studio-file:')) {
        const p = decodeURIComponent(href.slice('studio-file:'.length))
        return onOpenFile ? <FileChip path={p} onOpen={onOpenFile} /> : <code>{p}</code>
      }
      return (
        <a href={href} target="_blank" rel="noreferrer" className="text-indigo-600 dark:text-indigo-400 underline dark:text-indigo-300">
          {children}
        </a>
      )
    },
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      const raw = extractText(children)
      const isBlock = /language-/.test(className ?? '') || raw.includes('\n')
      if (isBlock) return <CodeBlock className={className} onOpenFile={onOpenFile}>{children}</CodeBlock>
      if (onOpenFile && /^~?\/\S+\.[A-Za-z0-9]{1,8}$/.test(raw.trim())) return <FileChip path={raw.trim()} onOpen={onOpenFile} />
      return <code className="rounded bg-zinc-200/70 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-700/60">{children}</code>
    },
    table: ({ children }) => (
      <div className="my-2 overflow-x-auto">
        <table className="min-w-full border-collapse text-xs [&_td]:border [&_td]:border-zinc-300 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-zinc-300 [&_th]:bg-zinc-100 [&_th]:px-2 [&_th]:py-1 dark:[&_td]:border-zinc-700 dark:[&_th]:border-zinc-700 dark:[&_th]:bg-zinc-800">
          {children}
        </table>
      </div>
    ),
  }), [onOpenFile])
  return (
    <div className={`md-body ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={components} urlTransform={(u) => u}>
        {onOpenFile ? linkifyPaths(text) : text}
      </ReactMarkdown>
    </div>
  )
}
