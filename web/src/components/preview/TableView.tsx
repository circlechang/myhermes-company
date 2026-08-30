// 表格檢視（csv／xlsx 共用）：搜尋、排序、凍結首列／首欄、合併儲存格、數字右對齊
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SheetMerge } from './types'

export interface TableViewProps {
  rows: string[][]
  numericCols?: number[]
  merges?: SheetMerge[]
  freeze?: { rows: number; cols: number }
  note?: string
  testId?: string
}

type SortState = { col: number; dir: 'asc' | 'desc' } | null

const num = (s: string) => {
  const v = Number(String(s).replace(/[,\s%$]/g, '').replace(/^NT\$/, ''))
  return Number.isFinite(v) ? v : null
}

export function TableView({ rows, numericCols = [], merges = [], freeze, note, testId = 'table-preview' }: TableViewProps) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortState>(null)
  const header = rows[0] ?? []
  const body = useMemo(() => rows.slice(1).map((r, i) => ({ r, i: i + 1 })), [rows])
  const isNum = useMemo(() => new Set(numericCols), [numericCols])
  const needle = q.trim().toLowerCase()

  const view = useMemo(() => {
    let out = body
    if (needle) out = out.filter(({ r }) => r.some((c) => String(c).toLowerCase().includes(needle)))
    if (sort) {
      const { col, dir } = sort
      const sign = dir === 'asc' ? 1 : -1
      out = [...out].sort((a, b) => {
        const x = a.r[col] ?? ''
        const y = b.r[col] ?? ''
        const nx = num(x)
        const ny = num(y)
        if (nx !== null && ny !== null) return (nx - ny) * sign
        return String(x).localeCompare(String(y), 'zh-Hant') * sign
      })
    }
    return out
  }, [body, needle, sort])

  // 排序／搜尋後列的順序變了，合併儲存格就不再對得上 → 只在原始順序時套用
  const natural = !needle && !sort
  const { spans, covered } = useMemo(() => {
    const spans = new Map<string, { rowspan: number; colspan: number }>()
    const covered = new Set<string>()
    if (!natural) return { spans, covered }
    for (const m of merges) {
      if (m.rowspan <= 1 && m.colspan <= 1) continue
      spans.set(`${m.row}:${m.col}`, { rowspan: m.rowspan, colspan: m.colspan })
      for (let r = m.row; r < m.row + m.rowspan; r++)
        for (let c = m.col; c < m.col + m.colspan; c++) if (!(r === m.row && c === m.col)) covered.add(`${r}:${c}`)
    }
    return { spans, covered }
  }, [merges, natural])

  const stickyCol = (freeze?.cols ?? 0) > 0
  const onSort = (col: number) =>
    setSort((s) => (s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null))

  const cellCls = (c: number) =>
    `border border-zinc-300 px-2 py-1 align-top dark:border-zinc-700 ${isNum.has(c) ? 'text-right tabular-nums' : 'text-left'}`

  if (!rows.length) return <div className="p-4 text-sm text-zinc-600 dark:text-zinc-400">{t('preview.emptyTable')}</div>

  return (
    <div className="flex min-h-0 flex-col" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
        <input
          className="input h-7 max-w-[16rem] py-0.5 text-xs"
          placeholder={t('preview.searchTable')}
          aria-label={t('preview.searchTable')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="table-search"
        />
        <span className="shrink-0 text-[11px] text-zinc-600 dark:text-zinc-400" data-testid="table-count">
          {t('preview.rowCount', { shown: view.length, total: body.length })}
        </span>
        {sort && (
          <button className="btn-ghost !px-1.5 !py-0 text-[11px]" onClick={() => setSort(null)} data-testid="table-clear-sort">
            {t('preview.clearSort')}
          </button>
        )}
        {!natural && merges.length > 0 && (
          <span className="shrink-0 text-[11px] text-amber-700 dark:text-amber-300">{t('preview.mergesOff')}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10">
            <tr>
              {header.map((c, j) =>
                covered.has(`0:${j}`) ? null : (
                  <th
                    key={j}
                    colSpan={spans.get(`0:${j}`)?.colspan}
                    rowSpan={spans.get(`0:${j}`)?.rowspan}
                    className={`border border-zinc-300 bg-zinc-100 px-2 py-1 text-left font-semibold dark:border-zinc-700 dark:bg-zinc-800 ${
                      stickyCol && j === 0 ? 'sticky left-0 z-20' : ''
                    }`}
                  >
                    <button
                      type="button"
                      className="flex w-full min-w-0 items-center gap-1 text-left hover:text-indigo-700 dark:hover:text-indigo-300"
                      onClick={() => onSort(j)}
                      title={String(c)}
                    >
                      <span className="min-w-0 truncate">{String(c)}</span>
                      <span aria-hidden className="shrink-0 text-[9px] text-zinc-500">
                        {sort?.col === j ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
                      </span>
                    </button>
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {view.map(({ r, i }) => (
              <tr key={i} className="odd:bg-zinc-50/60 dark:odd:bg-zinc-800/30">
                {r.map((c, j) =>
                  covered.has(`${i}:${j}`) ? null : (
                    <td
                      key={j}
                      colSpan={spans.get(`${i}:${j}`)?.colspan}
                      rowSpan={spans.get(`${i}:${j}`)?.rowspan}
                      className={`${cellCls(j)} ${stickyCol && j === 0 ? 'sticky left-0 bg-white dark:bg-zinc-900' : ''}`}
                      title={String(c)}
                    >
                      <span className="block max-w-[26rem] truncate">{String(c)}</span>
                    </td>
                  ),
                )}
              </tr>
            ))}
            {view.length === 0 && (
              <tr>
                <td className="px-2 py-3 text-zinc-600 dark:text-zinc-400" colSpan={Math.max(1, header.length)}>
                  {t('preview.noMatch')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {note && <div className="border-t border-zinc-200 px-2 py-1 text-[11px] text-amber-700 dark:border-zinc-800 dark:text-amber-300">{note}</div>}
    </div>
  )
}
