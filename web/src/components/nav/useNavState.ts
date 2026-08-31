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

/** matchMedia 包裝；jsdom 沒有 matchMedia 時一律回 false（視為桌面／寬螢幕） */
export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false)
  const [hit, setHit] = useState(get)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const h = () => setHit(mq.matches)
    h()
    mq.addEventListener?.('change', h)
    return () => mq.removeEventListener?.('change', h)
  }, [query])
  return hit
}

/** 手機判定（<768px） */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY)
}

/** 視窗比 px 窄（用 max-width 問，jsdom 的測試 stub 也答得出來） */
export function useNarrowerThan(px: number): boolean {
  return useMediaQuery(`(max-width: ${px - 1}px)`)
}
