// 員工顯示名：profile id → AI 員工名稱。老闆只看名字；工程師模式才附 profile id。
// 給技能／模型／看板／頻道共用（都要把 profile 下拉換成員工名）。
import { useMemo } from 'react'
import { useAgents } from '../../api/hooks'
import { useEngineerMode } from '../../prefs/engineerMode'

export interface StaffNames {
  engineer: boolean
  /** 下拉選單／卡片上用：關工程師模式＝員工名（對不到就退回 id）；開＝「員工名（id）」 */
  label: (profile: string) => string
  /** 只要員工名，沒對到回 undefined */
  nameOf: (profile: string) => string | undefined
  /** tooltip 用的完整說明：「員工名 · profile」 */
  full: (profile: string) => string
}

export function useStaffNames(): StaffNames {
  const agents = useAgents()
  const engineer = useEngineerMode()
  return useMemo(() => {
    const map = new Map<string, string>()
    for (const a of agents.data ?? []) if (a.profile && !map.has(a.profile)) map.set(a.profile, a.name)
    const nameOf = (p: string) => map.get(p)
    const label = (p: string) => {
      const n = map.get(p)
      if (engineer) return n ? `${n}（${p}）` : p
      return n ?? p
    }
    const full = (p: string) => {
      const n = map.get(p)
      return n ? `${n} · ${p}` : p
    }
    return { engineer, label, nameOf, full }
  }, [agents.data, engineer])
}
