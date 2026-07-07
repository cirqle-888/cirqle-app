/**
 * lucide icon name → component, so a favorited nav page or record (stored as
 * a plain string `icon_key` in `employee_favorites`) can be rendered without
 * shipping components through the database. Covers every icon currently used
 * by the sidebar's navSections plus one representative icon per pilot record
 * type (business_partner, campaign, employee). Extend this map — nothing
 * else — when a new module's icon needs to appear in Favorites.
 */
import {
  LayoutDashboard, Inbox, CheckSquare, TrendingUp, BookOpen, FileText, PhoneCall,
  Wallet, Handshake, Users2, BarChart3, Sheet, Award, Activity, Megaphone,
  Blocks, Upload, Settings, Star, SlidersHorizontal,
  MessageSquare, ClipboardCheck, NotebookPen, LayoutGrid,
  Briefcase, ClipboardList, CalendarClock, BadgeCheck, PieChart,
  type LucideIcon,
} from 'lucide-react'

export const FAVORITE_ICON_MAP: Record<string, LucideIcon> = {
  LayoutDashboard, Inbox, CheckSquare, TrendingUp, BookOpen, FileText, PhoneCall,
  Wallet, Handshake, Users2, BarChart3, Sheet, Award, Activity, Megaphone,
  Blocks, Upload, Settings, Star, SlidersHorizontal,
  MessageSquare, ClipboardCheck, NotebookPen, LayoutGrid,
  Briefcase, ClipboardList, CalendarClock, BadgeCheck, PieChart,
}

export function resolveFavoriteIcon(iconKey: string): LucideIcon {
  return FAVORITE_ICON_MAP[iconKey] || Star
}

// Reverse lookup (component reference → its string key) — built once. Lets a
// caller holding only the icon COMPONENT (e.g. NavItem.icon) find its stable
// string key without relying on the icon's (unofficial) displayName field.
const ICON_TO_KEY = new Map<LucideIcon, string>(
  Object.entries(FAVORITE_ICON_MAP).map(([key, Icon]) => [Icon, key]),
)

export function iconKeyFor(icon: LucideIcon): string {
  return ICON_TO_KEY.get(icon) ?? 'Star'
}
