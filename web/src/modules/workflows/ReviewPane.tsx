// 「等你看」的閱讀欄：審核內容像文件一樣在右欄全文顯示（可拉寬、獨立捲動），
// 意見與「可以／退回」固定在底部，讀完不用再捲回卡片找按鈕。
// 「最近一次」與「怎麼跑」兩個分頁共用；有等你看的步時右欄自動切成這個。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FilePreview } from '../../components/preview'

export interface ReviewPaneProps {
  seq: number
  title: string
  /** 上一步的名字：讓人知道這份東西是誰交上來的 */
  fromTitle?: string
  approvalId: string
  payload: string
  busy?: boolean
  onApprove: (approvalId: string, comment: string) => void
  onReject: (approvalId: string, comment: string) => void
}

export function ReviewPane({ seq, title, fromTitle, approvalId, payload, busy, onApprove, onReject }: ReviewPaneProps) {
  const { t } = useTranslation()
  const [comment, setComment] = useState('')
  const heading = `${t('wf.station.reviewStep', { n: seq })}${title ? `：${title}` : ''}`
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="review-pane" data-approval-id={approvalId}>
      <div className="border-b border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-700 dark:bg-amber-950/30">
        <div className="text-sm font-semibold">{heading}</div>
        {fromTitle && <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('wf.station.reviewFrom', { name: fromTitle })}</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden" data-testid="review-body">
        {payload ? (
          <FilePreview source={{ kind: 'inline', text: payload, title: heading, format: 'markdown' }} title={heading} compact />
        ) : (
          <div className="p-3 text-xs text-zinc-600 dark:text-zinc-400">{t('wf.station.reviewEmpty')}</div>
        )}
      </div>
      <div className="shrink-0 space-y-2 border-t border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <textarea
          className="input min-h-[56px] w-full text-sm"
          placeholder={t('wf.station.comment')}
          aria-label={t('wf.station.comment')}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          data-testid="review-comment"
        />
        {/* 390px：提示句放不下就掉到下一行，按鈕不縮 */}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-primary" disabled={busy} data-testid="review-approve" onClick={() => onApprove(approvalId, comment)}>
            {t('wf.station.approve')}
          </button>
          <button type="button" className="btn-danger" disabled={busy} data-testid="review-reject" onClick={() => onReject(approvalId, comment)}>
            {t('wf.station.reject')}
          </button>
          <span className="text-xs text-zinc-500">{t('wf.station.reviewHint')}</span>
        </div>
      </div>
    </div>
  )
}
