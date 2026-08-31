// 右側屬性面板：依節點種類編輯欄位；邊：on / 回邊
import { useTranslation } from 'react-i18next'
import type { Agent } from '../../api/types'
import { CONDITION_OPS } from './graph'
import type { NodeKind, Rule, WfEdge, WfNode, WorkflowEnv } from './types'

interface Props {
  node?: WfNode
  edge?: WfEdge
  agents: Agent[]
  env?: WorkflowEnv
  readOnly?: boolean
  onNode: (id: string, patch: Partial<WfNode>) => void
  onEdge: (id: string, patch: { on?: WfEdge['on']; loop_back?: boolean }) => void
  onDuplicate: () => void
  onDelete: () => void
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-zinc-600 dark:text-zinc-400">{label}</span>
      {children}
    </label>
  )
}

function RuleEditor({ rule, onChange, t }: { rule: Rule; onChange: (r: Rule) => void; t: (k: string) => string }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <Field label={t('wf.node.op')}>
        <select className="input" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as Rule['op'] })} aria-label={t('wf.node.op')}>
          {CONDITION_OPS.map((op) => (
            <option key={op} value={op}>{op}</option>
          ))}
        </select>
      </Field>
      {rule.op === 'json_path' ? (
        <Field label={t('wf.node.path')}>
          <input className="input" value={rule.path ?? ''} onChange={(e) => onChange({ ...rule, path: e.target.value })} placeholder="$.items[0].ok" />
        </Field>
      ) : (
        <Field label={t('wf.node.value')}>
          <input className="input" value={rule.value ?? ''} onChange={(e) => onChange({ ...rule, value: e.target.value })} aria-label={t('wf.node.value')} />
        </Field>
      )}
      {rule.op === 'json_path' && (
        <Field label={t('wf.node.value')}>
          <input className="input" value={rule.value ?? ''} onChange={(e) => onChange({ ...rule, value: e.target.value })} placeholder="(留空＝存在即可)" />
        </Field>
      )}
    </div>
  )
}

export function NodePanel({ node, edge, agents, env, readOnly, onNode, onEdge, onDuplicate, onDelete }: Props) {
  const { t } = useTranslation()
  if (edge && !node) {
    const id = edge.id ?? `${edge.source}->${edge.target}:${edge.sourceHandle ?? 'output'}`
    return (
      <div className="space-y-3 p-3 text-sm">
        <div className="font-semibold">{edge.source} → {edge.target}</div>
        <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('wf.edge.handle')}: {edge.sourceHandle ?? 'output'}</div>
        <Field label={t('wf.edge.on')}>
          <select className="input" value={edge.on ?? 'always'} disabled={readOnly} onChange={(e) => onEdge(id, { on: e.target.value as WfEdge['on'] })} aria-label={t('wf.edge.on')}>
            {(['always', 'success', 'failure'] as const).map((o) => (
              <option key={o} value={o}>{t(`wf.edge.${o}`)}</option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!edge.loop_back} disabled={readOnly} onChange={(e) => onEdge(id, { loop_back: e.target.checked })} /> {t('wf.edge.loopBack')}
        </label>
        {!readOnly && <button className="btn-danger" onClick={onDelete}>{t('wf.delete')}</button>}
      </div>
    )
  }
  if (!node) return <div className="p-3 text-xs text-zinc-600 dark:text-zinc-400">點選節點或邊來編輯；雙擊節點可看對話（執行後）。Shift 多選、Delete 刪除。</div>
  const kind = (node.kind === 'agent' ? 'hermes' : node.kind) as NodeKind
  const set = (patch: Partial<WfNode>) => onNode(node.id, patch)
  const dis = readOnly
  return (
    <div className="space-y-3 p-3 text-sm" data-testid="node-panel">
      <div className="flex items-center gap-2">
        <span className="rounded bg-zinc-200 px-1.5 text-[10px] dark:bg-zinc-700">{t(`wf.kinds.${kind}`)}</span>
        <code className="text-[10px] text-zinc-600 dark:text-zinc-400">{node.id}</code>
        {!readOnly && (
          <span className="ml-auto flex gap-1">
            <button className="btn-outline !px-2 !py-0.5 text-xs" onClick={onDuplicate}>{t('wf.duplicate')}</button>
            <button className="btn-danger !px-2 !py-0.5 text-xs" onClick={onDelete}>{t('wf.delete')}</button>
          </span>
        )}
      </div>
      <Field label={t('wf.node.title')}>
        <input className="input" value={node.title} disabled={dis} onChange={(e) => set({ title: e.target.value })} aria-label={t('wf.node.title')} />
      </Field>
      {(kind === 'hermes' || (kind === 'condition' && node.mode === 'ai')) && (
        <>
          <Field label={t('wf.node.agent')}>
            <select className="input" value={node.agent_id ?? ''} disabled={dis} onChange={(e) => { const a = agents.find((x) => x.id === e.target.value); set({ agent_id: e.target.value || undefined, profile: a?.profile }) }} aria-label={t('wf.node.agent')}>
              <option value="">—</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}（{a.runtime && a.runtime !== 'hermes' ? (a.runtime_name ?? a.runtime) : a.profile}）</option>
              ))}
            </select>
          </Field>
          <Field label={t('wf.node.model')}>
            <input className="input" value={node.model ?? ''} disabled={dis} onChange={(e) => set({ model: e.target.value || undefined })} />
          </Field>
        </>
      )}
      {kind === 'hermes' && (
        <>
          <Field label={t('wf.node.skills')}>
            <input className="input" value={(node.skills ?? []).join(', ')} disabled={dis} onChange={(e) => set({ skills: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
          </Field>
          <Field label={t('wf.node.prompt')}>
            <textarea className="input min-h-[120px]" value={node.prompt ?? ''} disabled={dis} onChange={(e) => set({ prompt: e.target.value })} aria-label={t('wf.node.prompt')} />
          </Field>
          <Field label={t('wf.node.attachments')}>
            <textarea className="input min-h-[48px]" value={(node.attachments ?? []).join('\n')} disabled={dis} onChange={(e) => set({ attachments: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} placeholder="/path/to/file.pdf" />
          </Field>
          <Field label={t('wf.node.system')}>
            <textarea className="input min-h-[48px]" value={node.system ?? ''} disabled={dis} onChange={(e) => set({ system: e.target.value || undefined })} />
          </Field>
          <Field label={t('wf.node.toolApproval')}>
            <select className="input" value={node.tool_approval ?? 'deny'} disabled={dis} onChange={(e) => set({ tool_approval: e.target.value as 'deny' | 'allow' })}>
              <option value="deny">{t('wf.node.toolDeny')}</option>
              <option value="allow">{t('wf.node.toolAllow')}</option>
            </select>
          </Field>
          <div className="rounded border border-zinc-200 p-2 dark:border-zinc-700" data-testid="done-check">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={!!node.done_check} disabled={dis} onChange={(e) => set({ done_check: e.target.checked || undefined })} aria-label={t('wf.node.doneCheck')} /> {t('wf.node.doneCheck')}
            </label>
            <div className="mt-1 text-[10px] text-zinc-600 dark:text-zinc-400">{t('wf.node.doneCheckHint')}</div>
            {node.done_check && (
              <Field label={t('wf.node.doneCheckRounds')}>
                <input className="input" type="number" min={1} max={10} value={node.done_check_max_rounds ?? 3} disabled={dis} onChange={(e) => set({ done_check_max_rounds: Number(e.target.value) || 3 })} aria-label={t('wf.node.doneCheckRounds')} />
              </Field>
            )}
          </div>
        </>
      )}
      {kind === 'coding-agent' && (
        <>
          <Field label={t('wf.node.tool')}>
            <select className="input" value={node.tool ?? 'claude-code'} disabled={dis} onChange={(e) => set({ tool: e.target.value as WfNode['tool'] })} aria-label={t('wf.node.tool')}>
              {(['claude-code', 'codex', 'pi'] as const).map((tool) => (
                <option key={tool} value={tool}>{tool}{env && !env.coding_tools[tool]?.installed ? `（${t('wf.node.notInstalled')}）` : ''}</option>
              ))}
            </select>
          </Field>
          {env && node.tool && !env.coding_tools[node.tool]?.installed && <div className="rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{node.tool} {t('wf.node.notInstalled')}</div>}
          <Field label={t('wf.node.command')}>
            <textarea className="input min-h-[100px]" value={node.prompt ?? ''} disabled={dis} onChange={(e) => set({ prompt: e.target.value })} aria-label={t('wf.node.command')} />
          </Field>
          <Field label={t('wf.node.cwd')}>
            <input className="input" value={node.cwd ?? ''} disabled={dis} onChange={(e) => set({ cwd: e.target.value })} placeholder={env?.workspace} />
          </Field>
          <Field label={t('wf.node.timeout')}>
            <input className="input" type="number" value={node.timeout_seconds ?? 1800} disabled={dis} onChange={(e) => set({ timeout_seconds: Number(e.target.value) })} />
          </Field>
        </>
      )}
      {kind === 'gate' && <div className="rounded bg-rose-50 p-2 text-xs text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">{t('wf.node.gateHint')}</div>}
      {kind === 'condition' && (
        <>
          <Field label={t('wf.node.mode')}>
            <select className="input" value={node.mode ?? 'rule'} disabled={dis} onChange={(e) => set({ mode: e.target.value as 'rule' | 'ai' })} aria-label={t('wf.node.mode')}>
              <option value="rule">{t('wf.node.modeRule')}</option>
              <option value="ai">{t('wf.node.modeAi')}</option>
            </select>
          </Field>
          {node.mode === 'ai' ? (
            <Field label={t('wf.node.prompt')}>
              <textarea className="input min-h-[80px]" value={node.prompt ?? ''} disabled={dis} onChange={(e) => set({ prompt: e.target.value })} aria-label={t('wf.node.prompt')} />
            </Field>
          ) : (
            <RuleEditor rule={node.rule ?? { op: 'contains', value: '' }} onChange={(rule) => set({ rule })} t={t} />
          )}
        </>
      )}
      {kind === 'loop' && (
        <>
          <Field label={t('wf.node.maxIterations')}>
            <input className="input" type="number" min={1} max={100} value={node.max_iterations ?? 3} disabled={dis} onChange={(e) => set({ max_iterations: Number(e.target.value) })} aria-label={t('wf.node.maxIterations')} />
          </Field>
          <Field label={t('wf.node.until')}>
            <select className="input" value={node.until ? 'rule' : 'none'} disabled={dis} onChange={(e) => set({ until: e.target.value === 'none' ? null : { op: 'contains', value: '' } })}>
              <option value="none">{t('wf.node.untilNone')}</option>
              <option value="rule">{t('wf.node.modeRule')}</option>
            </select>
          </Field>
          {node.until && <RuleEditor rule={node.until} onChange={(until) => set({ until })} t={t} />}
        </>
      )}
      {kind === 'delivery' && (
        <>
          <Field label={t('wf.node.channel')}>
            <select className="input" value={node.channel ?? 'file'} disabled={dis} onChange={(e) => set({ channel: e.target.value as WfNode['channel'] })} aria-label={t('wf.node.channel')}>
              <option value="line">LINE push</option>
              <option value="webhook">Webhook</option>
              <option value="file">{t('wf.kinds.delivery')} → file</option>
            </select>
          </Field>
          {node.channel === 'line' && (
            <>
              {env && !env.line_configured && <div className="rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{t('wf.node.lineNotConfigured')}</div>}
              <Field label={t('wf.node.lineTo')}>
                <input className="input" value={node.to ?? ''} disabled={dis} onChange={(e) => set({ to: e.target.value })} aria-label={t('wf.node.lineTo')} />
              </Field>
            </>
          )}
          {node.channel === 'webhook' && (
            <Field label={t('wf.node.url')}>
              <input className="input" value={node.url ?? ''} disabled={dis} onChange={(e) => set({ url: e.target.value })} placeholder="https://" />
            </Field>
          )}
          {node.channel === 'file' && (
            <>
              <Field label={t('wf.node.path_')}>
                <input className="input" value={node.path ?? ''} disabled={dis} onChange={(e) => set({ path: e.target.value })} />
              </Field>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!node.append} disabled={dis} onChange={(e) => set({ append: e.target.checked })} /> {t('wf.node.append')}</label>
            </>
          )}
          <Field label={t('wf.node.template')}>
            <textarea className="input min-h-[48px]" value={node.template ?? ''} disabled={dis} onChange={(e) => set({ template: e.target.value || undefined })} />
          </Field>
        </>
      )}
    </div>
  )
}
