export interface HelpLink { to: string; label: string }
export interface HelpPage {
  /** 路由前綴（最長匹配；'/' 只精確匹配） */
  path: string
  title: string
  /** 這頁做什麼（2 句） */
  what: string[]
  /** 怎麼用（3–6 步） */
  how: string[]
  /** 常見問題（2–4 題） */
  faq: { q: string; a: string }[]
  related: HelpLink[]
}
