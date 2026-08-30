import { request } from '../../api/client'

export interface SetupStatus {
  completed: boolean
  hermes: { installed: boolean; bin: string; version: string; error: string; home: string; home_exists: boolean; install_cmd: string; docs_url: string }
  api: { key_configured: boolean; key_source: 'env_file' | 'env' | 'none'; studio_key_loaded: boolean; url: string; env_path: string; reachable: boolean; version: string; error: string; auth_failed?: boolean }
  gateway: { ok: boolean; running: boolean; pid: number | null; supervised: boolean; stale_service: boolean; profiles: { name: string; running: boolean }[]; raw_tail: string }
  profiles: { count: number; names: string[] }
  admin: { default_password: boolean; username: string }
  next_step: 'install' | 'api' | 'password' | 'agents' | 'done'
  dry_run: boolean
}

export interface SetupJobStep { name: 'write_key' | 'gateway' | 'health'; status: 'running' | 'ok' | 'failed' | 'skipped'; detail: string }
export interface SetupJob {
  id: string; dry_run: boolean; done: boolean; ok: boolean | null; phase: string; error: string; log_tail: string
  steps: SetupJobStep[]; elapsed: number; manual_cmd: string
}
export interface EnableApiResponse { status: 'configured' | 'written' | 'restarting'; changed: boolean; backup?: string | null; reachable: boolean; job: SetupJob | null }
export interface SetupState { completed: boolean; is_owner: boolean }

export const setupApi = {
  state: () => request<SetupState>('/setup/state'),
  status: () => request<SetupStatus>('/setup/status'),
  enableApi: (body: { dry_run?: boolean } = {}) => request<EnableApiResponse>('/setup/enable-api', { method: 'POST', body: JSON.stringify(body) }),
  progress: () => request<{ job: SetupJob | null }>('/setup/enable-api/progress'),
  adminPassword: (password: string) => request<{ ok: boolean; default_password: boolean }>('/setup/admin-password', { method: 'POST', body: JSON.stringify({ password }) }),
  complete: () => request<{ ok: boolean; completed: boolean }>('/setup/complete', { method: 'POST' }),
  reset: () => request<{ ok: boolean; completed: boolean }>('/setup/reset', { method: 'POST' }),
}

/** 本次瀏覽器工作階段先略過精靈（不寫 DB flag） */
export const SETUP_SKIP_KEY = 'mhc.setup.skip'
export function isSetupSkipped(): boolean {
  try { return sessionStorage.getItem(SETUP_SKIP_KEY) === '1' } catch { return false }
}
export function setSetupSkipped(v: boolean) {
  try { if (v) sessionStorage.setItem(SETUP_SKIP_KEY, '1'); else sessionStorage.removeItem(SETUP_SKIP_KEY) } catch { /* ignore */ }
}
