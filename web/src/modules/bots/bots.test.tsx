import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Member, Msg, Room } from './api'
import { parseAvatar } from './Avatar'
import { Composer } from './Composer'
import { MessageItem, type MsgCtx } from './MessageItem'
import { sortRooms } from './Sidebar'
import { dayLabel, listTime, needsDivider } from './util'

const mem = (id: string, name: string, kind: 'ai' | 'human' = 'ai'): Member => ({ id, room_id: 'r', kind, display_name: name, profile: name, agent_id: `ag_${id}` })

describe('util', () => {
  it('側欄時間：今天時刻、昨天、更早月/日', () => {
    const now = new Date('2026-09-11T10:00:00Z')
    expect(listTime('2026-09-11T09:00:00', now)).toMatch(/上午|下午/)
    expect(listTime('2026-09-10T09:00:00', now)).toBe('昨天')
    expect(listTime('2026-08-01T09:00:00', now)).toBe('8/1')
    expect(dayLabel('2026-09-11T09:00:00', now)).toMatch(/^今天 /)
  })
  it('超過 15 分鐘或跨日才插時間分隔', () => {
    expect(needsDivider(undefined, '2026-09-11T09:00:00')).toBe(true)
    expect(needsDivider('2026-09-11T09:00:00', '2026-09-11T09:05:00')).toBe(false)
    expect(needsDivider('2026-09-11T09:00:00', '2026-09-11T09:30:00')).toBe(true)
  })
  it('頭像：指定值照用，空值依名字穩定產生', () => {
    expect(parseAvatar('blob:2|#22c55e', 'x')).toEqual({ shape: 2, color: '#22c55e' })
    expect(parseAvatar('', '研究員')).toEqual(parseAvatar(undefined, '研究員'))
  })
  it('清單：釘選在前，其餘依最後訊息時間', () => {
    const r = (id: string, t: string, pinned = false) => ({ id, pinned, created_at: t, updated_at: t, last_message: { created_at: t } }) as unknown as Room
    expect(sortRooms([r('a', '2026-09-01'), r('b', '2026-09-03'), r('c', '2026-08-01', true)]).map((x) => x.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('Composer', () => {
  const members = [mem('1', '研究員'), mem('2', '文案'), mem('h', 'admin', 'human')]
  it('@ 跳出成員選單（含 everyone），Enter 插入名字', () => {
    const onSend = vi.fn()
    render(<Composer placeholder="傳訊息給 x" members={members} skills={[]} running={false} onSend={onSend} onStop={() => undefined} botAvatar={() => undefined} />)
    const ta = screen.getByLabelText('訊息') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '@文', selectionStart: 2 } })
    const menu = screen.getByTestId('mention-menu')
    expect(menu).toHaveTextContent('文案')
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(ta.value).toBe('@文案 ')
    fireEvent.change(ta, { target: { value: '@', selectionStart: 1 } })
    expect(screen.getByTestId('mention-menu')).toHaveTextContent('everyone')
  })
  it('開頭 / 跳技能選單；Enter 送出後清空', () => {
    const onSend = vi.fn()
    render(<Composer placeholder="x" members={members} skills={[{ name: 'web-research', enabled: true, description: '上網查資料', category: '' }]} running={false}
      onSend={onSend} onStop={() => undefined} botAvatar={() => undefined} />)
    const ta = screen.getByLabelText('訊息') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/web', selectionStart: 4 } })
    expect(screen.getByTestId('skill-menu')).toHaveTextContent('/web-research')
    fireEvent.keyDown(ta, { key: 'Tab' })
    expect(ta.value).toBe('/web-research ')
    fireEvent.change(ta, { target: { value: '/web-research 查競品', selectionStart: 17 } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('/web-research 查競品')
  })
  it('Bot 在跑且沒打字 → 停止鍵', () => {
    const onStop = vi.fn()
    render(<Composer placeholder="x" members={members} skills={[]} running onSend={() => undefined} onStop={onStop} botAvatar={() => undefined} />)
    fireEvent.click(screen.getByTestId('stop-btn'))
    expect(onStop).toHaveBeenCalled()
  })
})

describe('MessageItem', () => {
  const base: Msg = {
    id: 'm1', room_id: 'r', seq: 1, sender_id: 'rm_ai', sender_name: '研究員', sender_kind: 'ai', content: '做好了', depth: 1, status: 'done',
    created_at: '2026-09-11T09:00:00', reply_to_id: '', thread_root_id: '', doc_id: 'd1', attachments: [], reactions: [], reply_count: 0,
  }
  const ctx = (over: Partial<MsgCtx> = {}): MsgCtx => ({
    myRmIds: new Set(['rm_me']), isGroup: true, botAvatarByRm: () => undefined, botAvatarByAgent: () => undefined,
    onReply: vi.fn(), onThread: vi.fn(), onReact: vi.fn(), onOpenDoc: vi.fn(), onApprove: vi.fn(), ...over,
  })
  it('文件卡顯示標題、版本、誰改的；點了打開文件', () => {
    const c = ctx()
    render(<MessageItem showHeader ctx={c} m={{ ...base, attachments: [{ type: 'doc', doc_id: 'd1', title: '報價單', version: 2, summary: '數量改 200', action: 'updated', author: '文案', author_rm_id: 'rm_ai', diff_stat: { added: 2, removed: 1 } }] }} />)
    const card = screen.getByTestId('doc-card')
    expect(card).toHaveTextContent('報價單')
    expect(card).toHaveTextContent('v2')
    expect(card).toHaveTextContent('文案 修改')
    fireEvent.click(card)
    expect(c.onOpenDoc).toHaveBeenCalledWith('d1', 2)
  })
  it('核准卡三個按鈕；決定後顯示結果', () => {
    const c = ctx()
    const appr = { type: 'approval' as const, run_id: 'run', approval_id: 'a', command: 'rm -rf x', description: '', tool: 'terminal', choices: [], status: 'pending' as const }
    const { rerender } = render(<MessageItem showHeader ctx={c} m={{ ...base, content: '', attachments: [appr] }} />)
    fireEvent.click(screen.getByRole('button', { name: '一律允許' }))
    expect(c.onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'always')
    rerender(<MessageItem showHeader ctx={c} m={{ ...base, content: '', attachments: [{ ...appr, status: 'deny', decided_by: 'admin' }] }} />)
    expect(screen.getByTestId('approval-card')).toHaveTextContent('已拒絕')
  })
  it('自己的訊息靠右、有引用；反應可點', () => {
    const c = ctx()
    render(<MessageItem showHeader ctx={c} m={{ ...base, sender_id: 'rm_me', sender_kind: 'human', sender_name: 'admin', content: '好', doc_id: '',
      reply_to: { id: 'm0', sender_name: '研究員', content: '要不要改標題', has_doc: false }, reactions: [{ emoji: '👍', count: 1, mine: true, names: ['admin'] }] }} />)
    expect(screen.getByTestId('bubble-mine')).toBeInTheDocument()
    expect(screen.getByTestId('quote')).toHaveTextContent('要不要改標題')
    fireEvent.click(screen.getByRole('button', { name: /👍/ }))
    expect(c.onReact).toHaveBeenCalledWith(expect.anything(), '👍')
  })
})
