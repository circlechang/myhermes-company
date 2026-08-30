export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-zinc-200 text-sm dark:border-zinc-800">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          onClick={() => onChange(t.id)}
          className={`-mb-px border-b-2 px-3 py-2 ${t.id === value ? 'border-indigo-600 font-medium text-indigo-700 dark:text-indigo-300' : 'border-transparent text-zinc-600 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function fmtTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return d.toLocaleString('zh-TW', { hour12: false })
}
