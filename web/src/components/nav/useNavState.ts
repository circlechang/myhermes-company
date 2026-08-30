import { useCallback, useEffect, useState } from 'react'

export const SIDEBAR_KEY = 'mhc.sidebar'
export const MOBILE_QUERY = '(max-width: 767px)'

function readExpanded(): boolean {
  try {
    const v = window.localStorage.getItem(SIDEBAR_KEY)
    if (v === 'expanded') return true
    if (v === 'collapsed') return false
  } catch {
    /* ignore */
  }
  return true
}

/** 側欄展開／收合，記在 localStorage */
export function useSidebarExpanded(): [boolean, () => void] {
  const [expanded, setExpanded] = useState(readExpanded)
  const toggle = useCallback(() => {
    setExpanded((e) => {
      const next = !e
      try {
        window.localStorage.setItem(SIDEBAR_KEY, next ? 'expanded' : 'collapsed')
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])
  return [expanded, toggle]
}

/** 手機判定：matchMedia；jsdom 沒有 matchMedia 時視為桌面 */
export function useIsMobile(): boolean {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_QUERY).matches : false)
  const [mobile, setMobile] = useState(get)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(MOBILE_QUERY)
    const h = () => setMobile(mq.matches)
    h()
    mq.addEventListener?.('change', h)
    return () => mq.removeEventListener?.('change', h)
  }, [])
  return mobile
}
