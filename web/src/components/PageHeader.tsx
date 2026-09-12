import type { ReactNode } from 'react'

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="min-w-0 flex-1 basis-64">
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-zinc-600 dark:text-zinc-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
