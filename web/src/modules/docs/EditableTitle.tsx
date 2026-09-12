// 就地改文件名字：點一下變輸入框，Enter 存、Esc 取消、失焦也存。
// 後端改標題時會把工作區的檔名一起換掉（自訂過路徑的文件不動），所以這裡不用另外送 path。
import { Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function EditableTitle({
  title,
  onSave,
  disabled,
  className = '',
  testId = 'doc-title',
}: {
  title: string
  onSave: (next: string) => void
  disabled?: boolean
  className?: string
  testId?: string
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => setDraft(title), [title])
  useEffect(() => { if (editing) ref.current?.select() }, [editing])

  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (!next) { setDraft(title); return }      // 空字串不是改名，是誤刪
    if (next !== title) onSave(next)
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={`group flex min-w-0 max-w-full items-center gap-1 text-left ${className}`}
        title={disabled ? title : t('docs.renameHint')}
        disabled={disabled}
        onClick={() => setEditing(true)}
        data-testid={testId}
      >
        <span className="min-w-0 truncate group-hover:underline">{title}</span>
        {!disabled && <Pencil aria-hidden className="h-3.5 w-3.5 shrink-0 text-zinc-400 group-hover:text-zinc-700 dark:group-hover:text-zinc-200" />}
      </button>
    )
  }
  return (
    <input
      ref={ref}
      className={`input min-w-0 max-w-full ${className}`}
      aria-label={t('docs.rename')}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit() }
        if (e.key === 'Escape') { setDraft(title); setEditing(false) }
      }}
      data-testid={`${testId}-input`}
    />
  )
}
