import { act, renderHook } from '@testing-library/react'
import { DEFAULT_FX, FX_KEY, fmtMoney, fmtTokens, fmtUsd, fmtWhen, parseWhen, readFxRate, useFxRate, writeFxRate } from './format'

// 固定「現在」：2026-09-02（週三）10:00 本地時間
const now = new Date(2026, 8, 2, 10, 0, 0)
const at = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0)

describe('fmtWhen', () => {
  it('中文：剛剛 → N 分鐘前 → 今天 → 昨天 → 週幾 → 月/日 → 年/月/日', () => {
    expect(fmtWhen(new Date(now.getTime() - 20_000), now)).toBe('剛剛')
    expect(fmtWhen(new Date(now.getTime() - 5 * 60_000), now)).toBe('5 分鐘前')
    expect(fmtWhen(at(2026, 9, 2, 8, 30), now)).toBe('今天 08:30')
    expect(fmtWhen(at(2026, 9, 1, 14, 2), now)).toBe('昨天 14:02')
    expect(fmtWhen(at(2026, 8, 29, 8, 0), now)).toBe('週六 08:00')
    expect(fmtWhen(at(2026, 8, 20, 9, 0), now)).toBe('8/20')
    expect(fmtWhen(at(2025, 12, 3, 9, 0), now)).toBe('2025/12/03')
  })
  it('英文對照', () => {
    expect(fmtWhen(new Date(now.getTime() - 20_000), now, 'en')).toBe('just now')
    expect(fmtWhen(new Date(now.getTime() - 5 * 60_000), now, 'en')).toBe('5 min ago')
    expect(fmtWhen(at(2026, 9, 2, 8, 30), now, 'en')).toBe('Today 08:30')
    expect(fmtWhen(at(2026, 9, 1, 14, 2), now, 'en')).toBe('Yesterday 14:02')
    expect(fmtWhen(at(2026, 8, 29, 8, 0), now, 'en')).toBe('Sat 08:00')
    expect(fmtWhen(at(2026, 8, 20, 9, 0), now, 'en')).toBe('8/20')
    expect(fmtWhen(at(2025, 12, 3, 9, 0), now, 'en')).toBe('2025/12/03')
  })
  it('未來時間不講「後」：明天 08:00；一週內給週幾', () => {
    expect(fmtWhen(at(2026, 9, 3, 8, 0), now)).toBe('明天 08:00')
    expect(fmtWhen(at(2026, 9, 3, 8, 0), now, 'en')).toBe('Tomorrow 08:00')
    expect(fmtWhen(at(2026, 9, 5, 8, 0), now)).toBe('週六 08:00')
  })
  it('選項：relative=false 就固定講時刻；farTime 帶時刻；assumeUtc=false 當本地', () => {
    expect(fmtWhen(new Date(now.getTime() - 5 * 60_000), now, 'zh-TW', { relative: false })).toBe('今天 09:55')
    expect(fmtWhen(at(2026, 8, 20, 9, 5), now, 'zh-TW', { farTime: true })).toBe('8/20 09:05')
    // 沒時區的字串：預設當 UTC（+8 的機器會變 17:00）；assumeUtc=false 就照字面
    const local = fmtWhen('2026-09-02T09:00:00', now, 'zh-TW', { assumeUtc: false })
    expect(local).toBe('今天 09:00')
    const utc = parseWhen('2026-09-02T09:00:00')!
    expect(utc.getTime()).toBe(Date.UTC(2026, 8, 2, 9, 0, 0))
    expect(parseWhen('2026-09-02T09:00:00Z')!.getTime()).toBe(utc.getTime())
    expect(parseWhen('2026-09-02T09:00:00+00:00')!.getTime()).toBe(utc.getTime())
  })
  it('空值／壞字串回空字串', () => {
    expect(fmtWhen(null, now)).toBe('')
    expect(fmtWhen(undefined, now)).toBe('')
    expect(fmtWhen('', now)).toBe('')
    expect(fmtWhen('not-a-date', now)).toBe('')
    expect(parseWhen(NaN)).toBeNull()
  })
})

describe('fmtMoney / fmtUsd', () => {
  beforeEach(() => localStorage.removeItem(FX_KEY))
  it('預設匯率 32.5：0.62 美元 → NT$20；≥10 取整數，<10 留一位', () => {
    expect(fmtMoney(0.62)).toEqual({ local: 'NT$20', usd: '$0.62', rate: DEFAULT_FX, currency: 'NT$' })
    expect(fmtMoney(0.21).local).toBe('NT$6.8')
    expect(fmtMoney(0).local).toBe('NT$0')
    expect(fmtMoney(18.83).local).toBe('NT$612')
    expect(fmtMoney(1234).local).toBe('NT$40,105')
  })
  it('可指定匯率與幣別；localStorage 的匯率會被讀到', () => {
    expect(fmtMoney(1, { rate: 30 }).local).toBe('NT$30')
    expect(fmtMoney(1, { rate: 7.8, currency: 'HK$' }).local).toBe('HK$7.8')
    localStorage.setItem(FX_KEY, '31')
    expect(readFxRate()).toBe(31)
    expect(fmtMoney(1).local).toBe('NT$31')
    localStorage.setItem(FX_KEY, 'garbage')
    expect(readFxRate()).toBe(DEFAULT_FX)
  })
  it('美元字串：兩位小數；不到一分錢給四位；非數字當 0', () => {
    expect(fmtUsd(0.62)).toBe('$0.62')
    expect(fmtUsd(12)).toBe('$12.00')
    expect(fmtUsd(0.0031)).toBe('$0.0031')
    expect(fmtUsd(NaN)).toBe('$0.00')
    expect(fmtMoney(NaN).local).toBe('NT$0')
  })
  it('useFxRate：讀寫 localStorage，寫壞值就回預設', () => {
    const { result } = renderHook(() => useFxRate())
    expect(result.current[0]).toBe(DEFAULT_FX)
    act(() => result.current[1](31.2))
    expect(result.current[0]).toBe(31.2)
    expect(localStorage.getItem(FX_KEY)).toBe('31.2')
    act(() => writeFxRate(0))
    expect(result.current[0]).toBe(DEFAULT_FX)
    expect(localStorage.getItem(FX_KEY)).toBeNull()
  })
})

describe('fmtTokens', () => {
  it('中文：萬／億；一萬以下給千分位', () => {
    expect(fmtTokens(184_000)).toBe('18 萬 tokens')
    expect(fmtTokens(64_000)).toBe('6.4 萬 tokens')
    expect(fmtTokens(120_000_000)).toBe('1.2 億 tokens')
    expect(fmtTokens(6_400)).toBe('6,400 tokens')
    expect(fmtTokens(0)).toBe('0 tokens')
    expect(fmtTokens(NaN)).toBe('0 tokens')
  })
  it('英文：k／M', () => {
    expect(fmtTokens(184_000, 'en')).toBe('184k tokens')
    expect(fmtTokens(6_400, 'en')).toBe('6.4k tokens')
    expect(fmtTokens(1_400_000, 'en')).toBe('1.4M tokens')
    expect(fmtTokens(640, 'en')).toBe('640 tokens')
  })
})
