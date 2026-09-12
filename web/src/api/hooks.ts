import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type NotifyPrefs } from './client'
import type { Agent, Workflow } from './types'

export const qk = {
  me: ['me'] as const,
  company: ['company'] as const,
  agents: ['agents'] as const,
  soul: (id: string) => ['agents', id, 'soul'] as const,
  skills: (id: string) => ['agents', id, 'skills'] as const,
  runtimes: ['agents', 'runtimes'] as const,
  dossier: (id: string, days: number) => ['agents', id, 'dossier', days] as const,
  sessions: (agentId?: string) => ['sessions', agentId ?? 'all'] as const,
  messages: (id: string) => ['sessions', id, 'messages'] as const,
  kanban: ['kanban'] as const,
  workflows: ['workflows'] as const,
  hermes: ['hermes', 'status'] as const,
}

export const useAgents = () => useQuery({ queryKey: qk.agents, queryFn: api.agents.list })
export const useRuntimes = (enabled = true) =>
  useQuery({ queryKey: qk.runtimes, queryFn: api.agents.runtimes, enabled })
export const useSoul = (id?: string) =>
  useQuery({ queryKey: qk.soul(id ?? ''), queryFn: () => api.agents.soul(id!), enabled: !!id })
export const useSkills = (id?: string) =>
  useQuery({ queryKey: qk.skills(id ?? ''), queryFn: () => api.agents.skills(id!), enabled: !!id, retry: false })
export const useSessions = (agentId?: string) =>
  useQuery({ queryKey: qk.sessions(agentId), queryFn: () => api.sessions.list(agentId), enabled: !!agentId })
export const useMessages = (id?: string) =>
  useQuery({ queryKey: qk.messages(id ?? ''), queryFn: () => api.sessions.messages(id!), enabled: !!id })
export const useKanban = () => useQuery({ queryKey: qk.kanban, queryFn: () => api.kanban.list() })
export const useWorkflows = () => useQuery({ queryKey: qk.workflows, queryFn: api.workflows.list })
export const useHermesStatus = () => useQuery({ queryKey: qk.hermes, queryFn: api.hermes.status, refetchInterval: 30_000 })
export const useCompany = () => useQuery({ queryKey: qk.company, queryFn: api.company.current })

export function useSaveSoul(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (content: string) => api.agents.saveSoul(id, content),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.soul(id) })
      qc.invalidateQueries({ queryKey: qk.agents })
    },
  })
}
export function useCreateAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.agents.create(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.agents }),
  })
}
export function useDeleteAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.agents.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.agents }),
  })
}
export function useUpdateAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Agent> }) => api.agents.update(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.agents }),
  })
}
export function useCreateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ agentId, title }: { agentId: string; title?: string }) => api.sessions.create(agentId, title),
    onSuccess: (_s, v) => qc.invalidateQueries({ queryKey: qk.sessions(v.agentId) }),
  })
}
export function useDeleteSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string; agentId: string }) => api.sessions.remove(id),
    onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: qk.sessions(v.agentId) }),
  })
}
export function useCreateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.kanban.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.kanban }),
  })
}
export function useSetTaskStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.kanban.setStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.kanban }),
  })
}
export function useCreateWorkflow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<Workflow>) => api.workflows.create(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.workflows }),
  })
}
export function useDeleteWorkflow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.workflows.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.workflows }),
  })
}

/** 人事檔案：選到員工才抓；派工／對話後 30 秒內自動更新 */
export const useAgentDossier = (id?: string, days = 7) =>
  useQuery({ queryKey: qk.dossier(id ?? '', days), queryFn: () => api.agents.dossier(id!, days), enabled: !!id, staleTime: 30_000 })

/** 有事找我（LINE 通知）偏好：儲存成功直接把回傳塞進快取，不用再 GET 一次 */
export const qkNotify = { prefs: ['notify', 'prefs'] as const, status: ['notify', 'status'] as const }
export const useNotifyPrefs = () => useQuery({ queryKey: qkNotify.prefs, queryFn: api.notify.prefs })
export const useNotifyStatus = () => useQuery({ queryKey: qkNotify.status, queryFn: api.notify.status, staleTime: 60_000 })
export function useSaveNotifyPrefs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<NotifyPrefs>) => api.notify.save(body),
    onSuccess: (data) => qc.setQueryData(qkNotify.prefs, data),
  })
}
export function useNotifyTest() {
  return useMutation({ mutationFn: (line_to?: string) => api.notify.test(line_to) })
}
