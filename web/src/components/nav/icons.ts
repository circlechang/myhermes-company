// registry nav.icon 字串 → lucide 元件。只列會用到的，避免整包進 bundle。
import {
  Activity, Bot, Cable, CalendarClock, Circle, Code2, Compass, FileText, HelpCircle, Inbox, LayoutDashboard, LogOut, Menu, MessageSquare,
  Mic, Moon, PanelLeftClose, PanelLeftOpen, Palette, Puzzle, ScrollText, Search, Server, Settings, Sparkles, Sun,
  SunMoon, Users, Wallet, Workflow, KanbanSquare, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export const ICONS: Record<string, LucideIcon> = {
  Activity, Bot, Cable, CalendarClock, Code2, Compass, FileText, HelpCircle, Inbox, LayoutDashboard, LogOut, Menu, MessageSquare, Mic, Moon,
  PanelLeftClose, PanelLeftOpen, Palette, Puzzle, ScrollText, Search, Server, Settings, Sparkles, Sun, SunMoon, Users,
  Wallet, Workflow, KanbanSquare, X,
}
export function iconFor(name?: string): LucideIcon {
  return (name && ICONS[name]) || Circle
}
