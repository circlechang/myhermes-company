import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseUnifiedDiff, type DiffFile, type DiffPayload } from './state'

function FileBlock({ f }: { f: DiffFile }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="mb-2 rounded-md border border-zinc-200 dark:border-zinc-800">
      <button type="button" className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs font-medium" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '▾' : '▸'}</span>
        <code>{f.path}</code>
        <span className="ml-auto text-emerald-600 dark:text-emerald-400">+{f.lines.filter((l) => l.kind === 'add').length}</span>
        <span className="text-rose-600 dark:text-rose-400">-{f.lines.filter((l) => l.kind === 'del').length}</span>
      </button>
      {open && (
        <pre className="overflow-x-auto border-t border-zinc-200 text-[11px] leading-4 dark:border-zinc-800">
          {f.lines.map((l, i) => (
            <div
              key={i}
              className={
                l.kind === 'add'
                  ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
                  : l.kind === 'del'
                    ? 'bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200'
                    : l.kind === 'meta'
                      ? 'text-zinc-600 dark:text-zinc-400'
                      : ''
              }
            >
              <span className="inline-block w-4 select-none text-zinc-600 dark:text-zinc-400">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}</span>
              {l.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}

function Pane({ title, diff, emptyText }: { title: string; diff: string; emptyText: string }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])
  return (
    <div className="min-w-0 flex-1">
      <div className="panel-title">{title}</div>
      {files.length === 0 ? <div className="px-3 text-xs text-zinc-600 dark:text-zinc-400">{emptyText}</div> : files.map((f) => <FileBlock key={f.path} f={f} />)}
    </div>
  )
}

/** 執行前／執行後 `git diff HEAD` 並排 */
export function DiffView({ diff }: { diff?: DiffPayload }) {
  const { t } = useTranslation()
  if (!diff) return <div className="p-4 text-sm text-zinc-600 dark:text-zinc-400">{t('coding.diff.none')}</div>
  if (!diff.is_git) return <div className="p-4 text-sm text-zinc-600 dark:text-zinc-400">{t('coding.diff.notGit')}</div>
  return (
    <div className="p-2" data-testid="diff-view">
      {diff.files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1 text-[11px]">
          {diff.files.map((f) => (
            <span key={f.path} className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
              <b className="mr-1 text-zinc-600 dark:text-zinc-400">{f.status}</b>
              <code>{f.path}</code>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Pane title={t('coding.diff.before')} diff={diff.before} emptyText={t('coding.diff.clean')} />
        <Pane title={t('coding.diff.after')} diff={diff.after} emptyText={t('coding.diff.clean')} />
      </div>
    </div>
  )
}
