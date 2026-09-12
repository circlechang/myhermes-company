// 小元件：彈窗、下拉選單、確認框、按鈕樣式（深色）
import { X } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export const btn = {
  primary: 'rounded-full bg-[var(--gb-accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--gb-accent-hover)] disabled:opacity-40',
  ghost: 'rounded-full px-3 py-1.5 text-sm text-[var(--gb-text)] hover:bg-[var(--gb-hover)] disabled:opacity-40',
  soft: 'rounded-full bg-[var(--gb-elev2)] px-4 py-1.5 text-sm text-[var(--gb-text)] hover:bg-[#2c2c2c] disabled:opacity-40',
  danger: 'rounded-full px-4 py-1.5 text-sm text-[var(--gb-red)] ring-1 ring-[#ef444455] hover:bg-[#ef44441a]',
  icon: 'inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--gb-sub)] hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)]',
}
export const field =
  'w-full rounded-xl border border-[var(--gb-line2)] bg-[var(--gb-bg)] px-3 py-2 text-sm text-[var(--gb-text)] placeholder:text-[var(--gb-mute)] outline-none focus:border-[#3a3a3a]'

export function Modal({ title, onClose, children, wide = false, testId }: { title?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; testId?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        data-testid={testId}
        className={`gb-arrive max-h-[84vh] w-full overflow-y-auto rounded-2xl border border-[var(--gb-line2)] bg-[var(--gb-elev)] shadow-2xl ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between px-5 pb-2 pt-4">
            <div className="text-base font-semibold">{title}</div>
            <button type="button" className={btn.icon} onClick={onClose} aria-label="關閉">
              <X size={18} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

export interface MenuItem {
  label: string
  icon?: ReactNode
  hint?: string
  danger?: boolean
  onSelect: () => void
  testId?: string
}

/** 按鈕＋彈出選單（點外面或 Esc 關閉） */
export function MenuButton({ trigger, items, align = 'right', label, className = '' }: { trigger: ReactNode; items: MenuItem[]; align?: 'left' | 'right'; label: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className={`relative ${className}`} ref={ref}>
      <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} className={btn.icon} onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}>
        {trigger}
      </button>
      {open && <MenuList items={items} align={align} onDone={() => setOpen(false)} />}
    </div>
  )
}

export function MenuList({ items, align = 'right', onDone, style }: { items: MenuItem[]; align?: 'left' | 'right'; onDone: () => void; style?: CSSProperties }) {
  return (
    <div
      role="menu"
      style={style}
      className={`gb-arrive absolute z-40 mt-1 min-w-[200px] overflow-hidden rounded-xl border border-[var(--gb-line2)] bg-[var(--gb-elev2)] py-1 shadow-xl ${align === 'right' ? 'right-0' : 'left-0'}`}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          data-testid={it.testId}
          className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-[#2c2c2c] ${it.danger ? 'text-[var(--gb-red)]' : 'text-[var(--gb-text)]'}`}
          onClick={(e) => {
            e.stopPropagation()
            onDone()
            it.onSelect()
          }}
        >
          {it.icon && <span className="text-[var(--gb-sub)]">{it.icon}</span>}
          <span className="flex-1">{it.label}</span>
          {it.hint && <span className="text-xs text-[var(--gb-mute)]">{it.hint}</span>}
        </button>
      ))}
    </div>
  )
}

export function Confirm({ title, body, confirm, danger = false, onCancel, onConfirm }: { title: string; body: ReactNode; confirm: string; danger?: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal title={title} onClose={onCancel} testId="gb-confirm">
      <div className="px-5 pb-5 text-sm text-[var(--gb-sub)]">{body}</div>
      <div className="flex justify-end gap-2 border-t border-[var(--gb-line)] px-5 py-3">
        <button type="button" className={btn.ghost} onClick={onCancel}>取消</button>
        <button type="button" className={danger ? btn.danger : btn.primary} onClick={onConfirm} autoFocus>{confirm}</button>
      </div>
    </Modal>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-[#e5e5e5]' : 'bg-[#3a3a3a]'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full transition-all ${checked ? 'left-[22px] bg-[#111]' : 'left-0.5 bg-[#bdbdbd]'}`} />
    </button>
  )
}
