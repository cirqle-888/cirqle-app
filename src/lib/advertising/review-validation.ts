export const ANNOTATION_KINDS = ['creative', 'targeting', 'budget', 'note'] as const
export function validBudgetRequest(amount: unknown, currency: unknown, reason: unknown): string | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 1e12 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.0001) return 'Enter a positive amount with at most two decimal places.'
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return 'Use a three-letter currency code.'
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) return 'Add a reason (up to 2,000 characters).'
  return null
}
