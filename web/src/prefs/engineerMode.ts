// 工程師模式：預設關。關的時候把 Session ID／Run ID／profile 名／SOUL.md／模型 id 這類系統詞藏起來，
// 老闆只看「員工、對話、任務」。開關存 localStorage（每台裝置各自），跨分頁同步靠 storage 事件。
import { useSyncExternalStore } from 'react'

export const ENGINEER_KEY = 'mhc.engineer'
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return localStorage.getItem(ENGINEER_KEY) === '1'
  } catch {
    return false
  }
}
function emit() {
  for (const l of listeners) l()
}
function subscribe(cb: () => void) {
  listeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key === ENGINEER_KEY) cb()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', onStorage)
  }
}

export function isEngineerMode(): boolean {
  return read()
}
export function setEngineerMode(on: boolean) {
  try {
    localStorage.setItem(ENGINEER_KEY, on ? '1' : '0')
  } catch {
    /* 私密視窗等情況：只影響本次 */
  }
  emit()
}
export function toggleEngineerMode() {
  setEngineerMode(!read())
}

/** 元件用：`const engineer = useEngineerMode()`；要藏的東西包 `{engineer && ...}` */
export function useEngineerMode(): boolean {
  return useSyncExternalStore(subscribe, read, () => false)
}
