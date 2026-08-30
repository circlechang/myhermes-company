import { useTranslation } from 'react-i18next'
import type { ApprovalDecision } from '../../api/types'
import type { ApprovalItem } from '../../ws/chatState'

export function ApprovalCard({ item, onDecide }: { item: ApprovalItem; onDecide: (d: ApprovalDecision) => void }) {
  const { t } = useTranslation()
  const decided = !!item.decision
  const btn = (d: ApprovalDecision, cls: string) => (
    <button key={d} type="button" className={cls} disabled={decided} onClick={() => onDecide(d)}>
      {t(`chat.approval.${d}`)}
    </button>
  )
  return (
    <div
      className="my-1 max-w-3xl rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/30"
      data-testid="approval-card"
      role="group"
      aria-label={t('chat.approval.title')}
    >
      <div className="font-medium text-amber-900 dark:text-amber-200">{t('chat.approval.title')}</div>
      <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">{t('chat.approval.command')}</div>
      <pre className="mt-1 overflow-auto rounded bg-white p-2 font-mono text-xs dark:bg-zinc-950">{item.command}</pre>
      {item.context && (
        <>
          <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">{t('chat.approval.context')}</div>
          <div className="mt-1 text-sm">{item.context}</div>
        </>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {btn('once', 'btn-primary')}
        {btn('session', 'btn-outline')}
        {btn('always', 'btn-outline')}
        {btn('deny', 'btn-danger')}
        <span className="ml-auto text-xs text-zinc-600 dark:text-zinc-400">
          {decided ? t('chat.approval.decided', { decision: t(`chat.approval.decisionLabel.${item.decision}`) }) : t('chat.approval.pending')}
        </span>
      </div>
    </div>
  )
}
