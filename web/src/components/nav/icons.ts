// registry nav.icon 字串 → lucide 元件。只列會用到的，避免整包進 bundle。
import {
  Activity, ArrowUpCircle, Bot, Cable, CalendarClock, ChevronLeft, ChevronRight, Circle, Code2, Compass, FileText, Filter, Folder, HelpCircle, Inbox,
  Info, LayoutDashboard, ListTree, LogOut, Maximize2, Menu, MessageSquare, Minimize2,
  Mic, Moon, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Palette, Puzzle, ScrollText, Search, Server, Settings, SlidersHorizontal, Sparkles, Sun,
  SunMoon, Users, Wallet, Workflow, KanbanSquare, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export const ICONS: Record<string, LucideIcon> = {
  Activity, ArrowUpCircle, Bot, Cable, CalendarClock, ChevronLeft, ChevronRight, Code2, Compass, FileText, Filter, Folder, HelpCircle, Inbox, Info,
  LayoutDashboard, ListTree, LogOut, Maximize2, Menu, MessageSquare, Minimize2, Mic, Moon,
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Palette, Puzzle, ScrollText, Search, Server, Settings, SlidersHorizontal, Sparkles, Sun, SunMoon, Users,
  Wallet, Workflow, KanbanSquare, X,
}
export function iconFor(name?: string): LucideIcon {
  return (name && ICONS[name]) || Circle
}
