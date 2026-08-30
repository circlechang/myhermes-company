import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import type { Agent, Workflow } from './types'

export const qk = {
  me: ['me'] as const,
  company: ['company'] as const,
  agents: ['agents'] as const,
  soul: (id: string) => ['agents', id, 'soul'] as const,
  skills: (id: string) => ['agents', id, 'skills'] as const,
  sessions: (agentId?: string) => ['sessions', agentId ?? 'all'] as const,
  messages: (id: string) => ['sessions', id, 'messages'] as const,
  kanban: ['kanban'] as const,
  workflows: ['workflows'] as const,
  hermes: ['hermes', 'status'] as const,
}

export const useAgents = () => useQuery({ queryKey: qk.agents, queryFn: api.agents.list })
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
