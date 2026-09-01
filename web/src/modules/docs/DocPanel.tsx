// 文件面板：目前版本／有新版時看 diff（綠增紅刪）／接受或還原上一版／版本下拉看歷史／直接編輯。
// 工作臺的文件模式與 /docs/{id} 詳情頁共用這個元件。
// 渲染依 doc.format 分流：html 走沙箱 iframe（見 HtmlPreview），md 沿用 components/preview 的 MarkdownView。
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MarkdownView } from '../../components/preview'
import { ErrorBox, Loading } from '../../components/QueryState'
import { DiffStatBadge, DiffView } from './DiffView'
import { docsApi, useDoc, useDocDiff, useDocMutations, useDocVersions, type DiffStat } from './api'

export interface PendingUpdate {
  version: number
  summary?: string
  diff_stat?: DiffStat
}

export function DocPanel({
  docId,
  pending,
  onAccept,
  compact = false,
}: {
  docId: string
  /** WS 剛推來的 doc.updated：面板亮出「新版本」條，讓人確認或還原 */
  pending?: PendingUpdate
  onAccept?: () => void
  compact?: boolean
}) {
  const { t } = useTranslation()
  const doc = useDoc(docId)
  const versions = useDocVersions(docId)
  const m = useDocMutations(docId)
  const [tab, setTab] = useState<'doc' | 'diff'>('doc')
  const [showVersion, setShowVersion] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const latest = doc.data?.latest_version ?? null
  // 換一份文件 → 面板歸位（順序在下面那個 effect 之前，才不會把 pending 切到的 diff 蓋掉）
  useEffect(() => {
    setEditing(false)
    setShowVersion(null)
    setTab('doc')
  }, [docId])
  // 面板一有新版就切到 diff（使用者要「看到這一版改了什麼」）
  useEffect(() => {
    if (pending) setTab('diff')
  }, [pending?.version])

  const diffTo = pending?.version ?? latest ?? undefined
  const diff = useDocDiff(docId, undefined, diffTo, tab === 'diff' && !!diffTo)
  const [historyContent, setHistoryContent] = useState<string | null>(null)
  useEffect(() => {
    if (showVersion === null) {
      setHistoryContent(null)
      return
    }
    let alive = true
    docsApi.version(docId, showVersion).then((v) => alive && setHistoryContent(v.content)).catch(() => alive && setHistoryContent(''))
    return () => {
      alive = false
    }
  }, [docId, showVersion])

  const body = useMemo(() => (showVersion !== null ? (historyContent ?? '') : (doc.data?.content ?? '')), [showVersion, historyContent, doc.data])
  const isHtml = (doc.data?.format ?? 'html') !== 'md'

  if (doc.isLoading) return <Loading />
  if (doc.error) return <ErrorBox error={doc.error} onRetry={() => doc.refetch()} />
  if (!doc.data) return null

  const canRevert = (latest ?? 0) > 1
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="doc-panel">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        <span className="min-w-0 flex-1 truncate font-medium" title={doc.data.abs_path} data-testid="doc-title">
          {doc.data.title}
        </span>
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800" data-testid="doc-version">
          v{latest ?? 0}
        </span>
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">{t(`docs.status.${doc.data.status}`)}</span>
        <select
          className="input h-6 w-28 py-0 text-xs"
          aria-label={t('docs.panel.history')}
          value={showVersion === null ? '' : String(showVersion)}
          onChange={(e) => setShowVersion(e.target.value === '' ? null : Number(e.target.value))}
          data-testid="doc-version-select"
        >
          <option value="">{t('docs.panel.latest')}</option>
          {(versions.data ?? []).map((v) => (
            <option key={v.id} value={v.version}>
              v{v.version} · {v.summary ? v.summary.slice(0, 14) : t(`docs.author.${v.author_kind}`)}
            </option>
          ))}
        </select>
        <button type="button" className="btn-ghost !px-1.5 !py-0.5 text-xs" onClick={() => setTab(tab === 'diff' ? 'doc' : 'diff')} data-testid="doc-diff-toggle">
          {tab === 'diff' ? t('docs.panel.showDoc') : t('docs.panel.showDiff')}
        </button>
        {!compact && (
          <button
            type="button"
            className="btn-ghost !px-1.5 !py-0.5 text-xs"
            onClick={() => {
              setDraft(doc.data?.content ?? '')
              setEditing((v) => !v)
              setShowVersion(null)
            }}
            data-testid="doc-edit-toggle"
          >
            {editing ? t('common.cancel') : t('docs.panel.edit')}
          </button>
        )}
      </div>

      {doc.data.drift && (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200" data-testid="doc-drift">
          {t('docs.panel.drift')}{' '}
          <button type="button" className="underline" onClick={() => m.snapshot.mutate()} data-testid="doc-snapshot">
            {t('docs.panel.snapshot')}
          </button>
        </div>
      )}

      {pending && (
        <div className="flex flex-wrap items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100" data-testid="doc-pending">
          <span className="font-medium">{t('docs.panel.newVersion', { v: pending.version })}</span>
          {pending.diff_stat && <DiffStatBadge added={pending.diff_stat.added} removed={pending.diff_stat.removed} />}
          <span className="min-w-0 flex-1 truncate">{pending.summary}</span>
          <button type="button" className="btn-outline !px-1.5 !py-0.5 text-xs" onClick={() => onAccept?.()} data-testid="doc-accept">
            {t('docs.panel.accept')}
          </button>
          {canRevert && (
            <button
              type="button"
              className="btn-ghost !px-1.5 !py-0.5 text-xs"
              onClick={() => m.revert.mutate((latest ?? 2) - 1, { onSuccess: () => onAccept?.() })}
              data-testid="doc-revert"
            >
              {t('docs.panel.revert')}
            </button>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {editing ? (
          <div className="flex min-h-0 flex-1 flex-col p-2">
            <textarea
              className="input min-h-0 flex-1 font-mono text-xs"
              aria-label={t('docs.panel.edit')}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              data-testid="doc-editor"
            />
            <div className="mt-1 flex items-center gap-2 text-xs">
              <button
                type="button"
                className="btn-primary"
                disabled={m.save.isPending}
                onClick={() => m.save.mutate({ content: draft }, { onSuccess: () => setEditing(false) })}
                data-testid="doc-save"
              >
                {t('docs.panel.save')}
              </button>
              <span className="text-zinc-600 dark:text-zinc-400">{t('docs.panel.saveHint')}</span>
            </div>
          </div>
        ) : tab === 'diff' ? (
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {diff.isLoading && <Loading />}
            {diff.data && (
              <>
                <div className="mb-1 flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                  <span>
                    v{diff.data.from ?? 0} → v{diff.data.to ?? latest ?? 0}
                  </span>
                  <DiffStatBadge added={diff.data.added} removed={diff.data.removed} />
                </div>
                <DiffView text={diff.data.diff} />
              </>
            )}
          </div>
        ) : body ? (
          isHtml ? <HtmlPreview html={body} title={doc.data?.title ?? ''} /> : <MarkdownView text={body} />
        ) : (
          <div className="p-6 text-center text-xs text-zinc-600 dark:text-zinc-400" data-testid="doc-empty">
            {t('docs.panel.empty')}
          </div>
        )}
      </div>
    </div>
  )
}


/** HTML 文件預覽。
 *
 * 內容是模型產生的，等同不可信輸入，所以一律關進 `sandbox=""` 的 iframe：
 * 沒有 script、沒有 same-origin、沒有表單送出，拿不到頁面的 DOM 與登入 token。
 * 這也是 components/preview/FilePreview 對 HTML 附件用的同一套隔離。
 */
function HtmlPreview({ html, title }: { html: string; title: string }) {
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={html}
      className="h-full min-h-0 w-full flex-1 border-0 bg-white"
      data-testid="doc-html-preview"
    />
  )
}
