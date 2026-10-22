import 'server-only'
import { balanceOn } from '@/lib/profit-sharing/capital'
import type { CapitalMovement } from '@/lib/profit-sharing/types'

export * from '@/lib/profit-sharing/load'

export const todayIso = () => new Date().toISOString().slice(0, 10)

export const balanceOnToday = (capital: CapitalMovement[], memberId: string) => balanceOn(capital, memberId, todayIso())
