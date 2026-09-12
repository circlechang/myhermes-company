// 老闆模式（工程師模式關）文案檢查：主畫面文字不得出現這些系統詞。
// 各頁測試用 `expect(bossCopyViolations()).toEqual([])`；失敗時直接列出踩到哪個詞。
export const BOSS_FORBIDDEN = ['gateway', 'profile', 'session', '~/'] as const

export function bossCopyViolations(root: ParentNode = document.body): string[] {
  const text = (root.textContent ?? '').toLowerCase()
  return BOSS_FORBIDDEN.filter((w) => text.includes(w))
}
