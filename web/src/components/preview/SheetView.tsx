// XLSX 檢視：工作表分頁 + 共用 TableView
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TableView } from './TableView'
import type { PreviewSheet } from './types'

export function SheetView({ sheets }: { sheets: PreviewSheet[] }) {
  const { t } = useTranslation()
  const [i, setI] = useState(0)
  const s = sheets[i]
  if (!sheets.length) return <div className="p-4 text-sm text-zinc-600 dark:text-zinc-400">{t('preview.emptyTable')}</div>
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="xlsx-preview">
      <div className="flex flex-wrap gap-1 border-b border-zinc-200 px-2 py-1 dark:border-zinc-800" role="tablist">
        {sheets.map((sh, idx) => (
          <button
            key={sh.name}
            role="tab"
            aria-selected={idx === i}
            className={`rounded px-2 py-0.5 text-xs ${idx === i ? 'bg-zinc-200 font-medium dark:bg-zinc-700' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
            onClick={() => setI(idx)}
            data-testid={`sheet-tab-${sh.name}`}
          >
            {sh.name}
            {sh.hidden ? ' (hidden)' : ''}
          </button>
        ))}
      </div>
      {s && (
        <TableView
          key={s.name}
          rows={s.rows}
          numericCols={s.numeric_cols}
          merges={s.merges}
          freeze={s.freeze}
          note={s.truncated ? t('preview.sheetTruncated', { rows: s.total_rows, cols: s.total_cols }) : undefined}
          testId="table-preview"
        />
      )}
    </div>
  )
}
