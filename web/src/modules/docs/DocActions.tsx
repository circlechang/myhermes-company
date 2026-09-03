// 文件的「封存／取消封存／刪除」按鈕組。文件模式左欄、/docs 清單、/docs/{id} 三處共用。
// 封存＝status 改 archived（可逆）；刪除＝刪 DB 列、版本與血緣，工作區檔案保留（後端只有 admin 可刪）。
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthContext'
import { useDocMutations, type Doc } from './api'

export function DocActions({
  doc,
  onDeleted,
  compact = false,
}: {
  doc: Pick<Doc, 'id' | 'title' | 'status'>
  onDeleted?: (id: string) => void
  compact?: boolean
}) {
  const { t } = useTranslation()
  const { member } = useAuth()
  const isAdmin = member?.role === 'owner' || member?.role === 'admin'
  const m = useDocMutations()
  const archived = doc.status === 'archived'
  const size = compact ? 'px-1 py-0 text-[11px]' : 'px-1.5 py-0.5 text-xs'

  return (
    <span className="flex shrink-0 items-center gap-0.5" data-testid={`doc-actions-${doc.id}`} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`btn-ghost ${size}`}
        disabled={m.setStatus.isPending}
        title={archived ? t('docs.unarchive') : t('docs.archiveHint')}
        onClick={() => m.setStatus.mutate({ id: doc.id, status: archived ? 'draft' : 'archived' })}
        data-testid={`doc-archive-${doc.id}`}
      >
        {archived ? t('docs.unarchive') : t('docs.archive')}
      </button>
      {isAdmin && (
        <button
          type="button"
          className={`btn-ghost ${size} text-rose-600 dark:text-rose-400`}
          disabled={m.remove.isPending}
          title={t('docs.deleteHint')}
          onClick={() => {
            if (confirm(t('docs.confirmDelete', { title: doc.title }))) m.remove.mutate(doc.id, { onSuccess: () => onDeleted?.(doc.id) })
          }}
          data-testid={`doc-delete-${doc.id}`}
        >
          {t('common.delete')}
        </button>
      )}
    </span>
  )
}
