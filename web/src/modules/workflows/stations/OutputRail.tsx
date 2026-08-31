// 右側常駐欄：這條線正在處理的文件／產出。
// 有文件（同事 A 的 docs 模組，node_states 帶 doc_ids）就顯示文件與版本；沒有就顯示最後一站的輸出。
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FilePreview } from '../../../components/preview'
import { docsApi } from '../../docs/api'
import type { LiveRun } from '../runState'
import type { Station } from './stationGraph'

const docIdsOf = (s?: { doc_ids?: unknown }): string[] => (Array.isArray(s?.doc_ids) ? (s!.doc_ids as string[]).filter((x) => typeof x === 'string') : [])

export function OutputRail({ stations, live }: { stations: Station[]; live?: LiveRun }) {
  const { t } = useTranslation()
  const pick = useMemo(() => {
    const rev = [...stations].reverse()
    for (const s of rev) {
      const st = live?.nodes[s.node.id] as ({ output?: string; doc_ids?: unknown } | undefined)
      const ids = docIdsOf(st)
      if (ids.length) return { station: s, docId: ids[ids.length - 1], text: st?.output }
    }
    for (const s of rev) {
      const st = live?.nodes[s.node.id]
      if (st?.output) return { station: s, docId: undefined, text: st.output }
    }
    return null
  }, [stations, live])

  const doc = useQuery({ queryKey: ['docs', 'one', pick?.docId], queryFn: () => docsApi.get(pick!.docId!), enabled: !!pick?.docId, retry: false })

  if (!pick) return <div className="p-3 text-xs text-zinc-600 dark:text-zinc-400" data-testid="output-rail-empty">{t('wf.station.railEmpty')}</div>

  const d = doc.data
  const title = d?.title ?? t('wf.station.outputTitle', { name: pick.station.node.title || pick.station.node.id })
  const body = d?.content ?? d?.file_content ?? pick.text ?? ''
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="output-rail">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <span className="min-w-0 truncate text-sm font-semibold" title={title}>{title}</span>
        {d?.latest_version != null && <span className="badge bg-zinc-200 text-[10px] dark:bg-zinc-800">{t('wf.station.railDoc', { n: d.latest_version })}</span>}
        <span className="w-full text-[11px] text-zinc-600 dark:text-zinc-400">{t('wf.station.railFrom', { name: pick.station.node.title || pick.station.node.id })}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <FilePreview source={{ kind: 'inline', text: body, title, format: 'markdown' }} title={title} compact />
      </div>
    </div>
  )
}
