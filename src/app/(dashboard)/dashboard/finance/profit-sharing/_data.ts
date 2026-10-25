import 'server-only'
import { balanceOn } from '@/lib/profit-sharing/capital'
import type { CapitalMovement } from '@/lib/profit-sharing/types'
import { todayISO } from '@/lib/utils/local-date'

export * from '@/lib/profit-sharing/load'

export const todayIso = () => todayISO()

export const balanceOnToday = (capital: CapitalMovement[], memberId: string) => balanceOn(capital, memberId, todayIso())
