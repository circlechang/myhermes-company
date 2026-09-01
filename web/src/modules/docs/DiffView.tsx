// unified diff 呈現（沿用 soul_history 的手法：綠增紅刪、@@ 藍）
export function DiffView({ text, testId = 'doc-diff' }: { text: string; testId?: string }) {
  if (!text) return <div className="text-xs text-zinc-600 dark:text-zinc-400" data-testid={`${testId}-empty`}>（無差異）</div>
  return (
    <pre className="max-h-[26rem] overflow-auto rounded bg-zinc-100 p-2 text-xs leading-5 dark:bg-zinc-800" data-testid={testId}>
      {text.split('\n').map((l, i) => (
        <div
          key={i}
          data-line={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : 'ctx'}
          className={
            l.startsWith('+') && !l.startsWith('+++')
              ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100'
              : l.startsWith('-') && !l.startsWith('---')
                ? 'bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-100'
                : l.startsWith('@@')
                  ? 'text-sky-600 dark:text-sky-400'
                  : ''
          }
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

export function DiffStatBadge({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="whitespace-nowrap text-xs" data-testid="diff-stat">
      <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
      {' / '}
      <span className="text-rose-600 dark:text-rose-400">−{removed}</span>
    </span>
  )
}
