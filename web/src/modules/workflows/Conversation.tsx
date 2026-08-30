// 節點對話檢視（從快照的 session_id 開啟）：讀 /sessions/{id}/messages
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'

export function ConversationModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['sessions', sessionId, 'messages'], queryFn: () => api.sessions.messages(sessionId) })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose} data-testid="conversation-modal">
      <div className="card max-h-[85vh] w-full max-w-3xl overflow-auto p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2">
          <span className="font-semibold">節點對話</span>
          <code className="text-xs text-zinc-600 dark:text-zinc-400">{sessionId}</code>
          <button className="btn-ghost ml-auto" onClick={onClose}>✕</button>
        </div>
        {q.isLoading && <div className="text-xs text-zinc-600 dark:text-zinc-400">載入中…</div>}
        {q.error && <div className="text-xs text-rose-600 dark:text-rose-400">{String(q.error)}</div>}
        <div className="space-y-2">
          {q.data?.map((m) => (
            <div key={m.id} className={`rounded-md p-2 text-sm ${m.role === 'user' ? 'bg-indigo-50 dark:bg-indigo-950/40' : m.role === 'tool' ? 'bg-zinc-100 text-xs dark:bg-zinc-800' : 'bg-zinc-50 dark:bg-zinc-900'}`}>
              <div className="mb-1 text-[10px] uppercase text-zinc-600 dark:text-zinc-400">{m.role}{m.tool_name ? ` · ${m.tool_name}` : ''}</div>
              <pre className="whitespace-pre-wrap font-sans">{m.content || (m.tool_result ? JSON.stringify(m.tool_result).slice(0, 800) : '')}</pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
