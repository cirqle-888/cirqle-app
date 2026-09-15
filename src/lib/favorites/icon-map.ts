/**
 * lucide icon name → component, so a favorited nav page or record (stored as
 * a plain string `icon_key` in `employee_favorites`) can be rendered without
 * shipping components through the database.
 *
 * REGISTER EVERY ICON navSections USES. A key that is not here falls back to
 * a Star, and a sidebar full of identical stars is exactly what happens when
 * this map drifts behind the nav — which it had, for 21 of the 46 nav icons.
 *
 * ─ On lucide's renames ───────────────────────────────────────────────────
 * lucide renamed a number of icons and kept the old names as aliases of the
 * SAME component: `CheckSquare`/`SquareCheckBig`, `Users2`/`UsersRound`,
 * `BarChart3`/`ChartColumn`. A component's `displayName` is the NEW name,
 * while this codebase imports the old one — so a key captured from
 * `displayName` could never be found by a map keyed on the import name.
 *
 * Rather than pick a side, resolution accepts both spellings (see ALIASES).
 * That also repairs favourites already stored under a displayName spelling,
 * with no data migration: the row keeps its key and simply resolves now.
 */
import {
  Activity, Award, BadgeCheck, BadgePercent, BarChart3, Blocks, BookOpen,
  Briefcase, Building2, Calculator, CalendarClock, CalendarRange, CheckSquare, CreditCard,
  ClipboardCheck, ClipboardList, FileText, Gauge, Handshake, HardHat, History,
  Images, Inbox, LayoutDashboard, LayoutGrid, MapPin, Megaphone, MessageSquare,
  NotebookPen, Package, PhoneCall, PieChart, Receipt, Repeat, Scale, Settings,
  Share2, Sheet, ShieldCheck, SlidersHorizontal, Sparkles, Star, Tags,
  TrendingUp, Upload, UserPlus, Users2, Wallet,
  // Not in navSections today, but held by favourites saved when it was —
  // dropping it would turn those rows into stars.
  CalendarDays,
  type LucideIcon,
} from 'lucide-react'

export const FAVORITE_ICON_MAP: Record<string, LucideIcon> = {
  Activity, Award, BadgeCheck, BadgePercent, BarChart3, Blocks, BookOpen,
  Briefcase, Building2, Calculator, CalendarClock, CalendarDays, CalendarRange, CheckSquare, CreditCard,
  ClipboardCheck, ClipboardList, FileText, Gauge, Handshake, HardHat, History,
  Images, Inbox, LayoutDashboard, LayoutGrid, MapPin, Megaphone, MessageSquare,
  NotebookPen, PhoneCall, PieChart, Receipt, Repeat, Scale, Settings,
  Share2, Sheet, ShieldCheck, SlidersHorizontal, Sparkles, Star, Tags,
  TrendingUp, Upload, UserPlus, Users2, Wallet,
  // navSections imports this as `PackageIcon`; register that spelling too so
  // a key taken from the import name resolves.
  Package, PackageIcon: Package,
}

/**
 * Every spelling a stored key might use → its component. Built from the map
 * above plus each icon's `displayName`, which is lucide's current name for it
 * and therefore what an older write path captured.
 *
 * Map entries win: an explicit registration is never shadowed by an alias.
 */
const ALIASES: Record<string, LucideIcon> = (() => {
  const out: Record<string, LucideIcon> = {}
  for (const Icon of Object.values(FAVORITE_ICON_MAP)) {
    const dn = (Icon as LucideIcon & { displayName?: string }).displayName
    if (dn && !(dn in FAVORITE_ICON_MAP)) out[dn] = Icon
  }
  return out
})()

export function resolveFavoriteIcon(iconKey: string): LucideIcon {
  return FAVORITE_ICON_MAP[iconKey] || ALIASES[iconKey] || Star
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
