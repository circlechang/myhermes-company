// 空狀態卡：這是什麼＋下一步按哪裡。放在列表為空的位置，主要按鈕直接觸發建立動作
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export interface EmptyStateProps {
  title: string
  body?: string
  /** 主要動作：onClick 或 to（路由連結）擇一 */
  action?: { label: string; onClick?: () => void; to?: string; disabled?: boolean }
  /** 次要說明或第二個動作 */
  secondary?: ReactNode
  icon?: ReactNode
  /** compact：放在側欄等窄處 */
  compact?: boolean
  testId?: string
}

export function EmptyState({ title, body, action, secondary, icon, compact = false, testId = 'empty-state' }: EmptyStateProps) {
  const btn = 'btn-primary'
  return (
    <div data-testid={testId} className={`flex flex-col items-center justify-center text-center ${compact ? 'gap-2 p-3' : 'gap-3 p-8'}`}>
      {icon && <div className="text-zinc-600 dark:text-zinc-400" aria-hidden>{icon}</div>}
      <div className={`font-medium ${compact ? 'text-sm' : 'text-base'}`}>{title}</div>
      {body && <p className={`max-w-md text-zinc-600 dark:text-zinc-400 ${compact ? 'text-xs' : 'text-sm'}`}>{body}</p>}
      {action && (action.to ? (
        <Link to={action.to} className={btn} data-testid="empty-state-action">{action.label}</Link>
      ) : (
        <button type="button" className={btn} onClick={action.onClick} disabled={action.disabled} data-testid="empty-state-action">{action.label}</button>
      ))}
      {secondary && <div className="text-xs text-zinc-600 dark:text-zinc-400">{secondary}</div>}
    </div>
  )
}
