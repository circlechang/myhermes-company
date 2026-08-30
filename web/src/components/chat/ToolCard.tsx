import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToolItem } from '../../ws/chatState'
import { CopyButton, FileChip, extractFilePaths } from './Markdown'

const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '')
const LIMIT = 1200

/** 長內容先截斷、可展開；附複製鈕 */
export function TruncatedPre({ value, testId }: { value: unknown; testId?: string }) {
  const { t } = useTranslation()
  const [full, setFull] = useState(false)
  const text = pretty(value)
  const long = text.length > LIMIT
  const shown = full || !long ? text : text.slice(0, LIMIT)
  return (
    <div className="relative" data-testid={testId}>
      <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-950">
        {shown}
        {long && !full && '…'}
      </pre>
      <div className="mt-0.5 flex items-center gap-2">
        {long && (
          <button type="button" className="text-[11px] text-indigo-700 hover:underline dark:text-indigo-300" onClick={() => setFull((f) => !f)}>
            {full ? t('chat.tool.showLess') : t('chat.tool.showMore', { n: text.length })}
          </button>
        )}
        <CopyButton text={text} />
      </div>
    </div>
  )
}

export function ToolCard({ item, onOpenFile }: { item: ToolItem; onOpenFile?: (p: string) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const argPreview = typeof item.args === 'string' ? item.args : item.args ? JSON.stringify(item.args) : ''
  const paths = onOpenFile ? extractFilePaths(`${pretty(item.args)}\n${pretty(item.result)}`) : []
  return (
    <div className="card my-1 min-w-0 max-w-full text-sm sm:max-w-3xl" data-testid="tool-card">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${item.status === 'running' ? 'animate-pulse bg-amber-500' : 'bg-emerald-500'}`} />
        <span className="shrink-0 text-xs text-zinc-600 dark:text-zinc-400">{t('chat.tool.title')}</span>
        <code className="min-w-0 shrink truncate font-mono text-xs" title={item.name}>{item.name}</code>
        {argPreview && !open && <span className="min-w-0 truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{argPreview}</span>}
        <span className="ml-auto shrink-0 text-xs text-zinc-600 dark:text-zinc-400">
          {item.status === 'running' ? t('chat.tool.running') : t('chat.tool.done')} · {open ? t('chat.tool.collapse') : t('chat.tool.expand')}
        </span>
      </button>
      {open && (
        <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('chat.tool.args')}</div>
          <TruncatedPre value={item.args ?? {}} testId="tool-args" />
          {item.status === 'done' && (
            <>
              <div className="mt-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('chat.tool.result')}</div>
              <TruncatedPre value={item.result ?? ''} testId="tool-result" />
            </>
          )}
          {paths.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {paths.map((p) => (
                <FileChip key={p} path={p} onOpen={onOpenFile!} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
