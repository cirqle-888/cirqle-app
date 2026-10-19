'use server'

import { revalidatePath } from 'next/cache'

/**
 * Quotations are written from the browser (lib/quotations/save), which leaves
 * the client router cache (staleTimes.dynamic = 30s) holding the list as it
 * was. Called after every write so going back to the list shows the change.
 */
export async function revalidateQuotations() {
  revalidatePath('/dashboard/quotations', 'layout')
}
