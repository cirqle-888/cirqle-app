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
  Blocks, Upload, Settings, Star, SlidersHorizontal, type LucideIcon,
} from 'lucide-react'

export const FAVORITE_ICON_MAP: Record<string, LucideIcon> = {
  LayoutDashboard, Inbox, CheckSquare, TrendingUp, BookOpen, FileText, PhoneCall,
  Wallet, Handshake, Users2, BarChart3, Sheet, Award, Activity, Megaphone,
  Blocks, Upload, Settings, Star, SlidersHorizontal,
}

export function resolveFavoriteIcon(iconKey: string): LucideIcon {
  return FAVORITE_ICON_MAP[iconKey] || Star
}
