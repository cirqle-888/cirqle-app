/**
 * WhatsApp listener — two things worth telling the owner about at once. Pure rules.
 *
 *   A payment message   a client in a listed chat says they have paid, or
 *                       sends a payment screenshot.
 *   A new enquiry       someone who is not a client yet writes to the Cirqle
 *                       number asking about a service.
 *
 * Both only raise a notification inside Cirqle. Nothing is recorded as paid,
 * no lead is created, and nothing is sent to WhatsApp.
 */

// Words that only turn up when money has moved.
const PAID = /\b(paid|g\s?pay(ed)?|google\s?pay|phone\s?pe|paytm|upi|neft|imps|rtgs|utr|transaction\s?(id|no|number)|transferr?ed|credited|debited|payment\s+(done|sent|made|completed|successful|transferred))\b/i
// "payment / amount / cash" together with "sent / done" in English, Manglish or Malayalam.
const MONEY = /\b(payment|amount|cash|paisa|advance|balance)\b|പണം|പൈസ|പേയ്മെന്റ്/i
const SENT = /\b(done|sent|ayach\w*|cheyth\w*|ittu\w*|itt?itt?und\w*|kazhinj\w*)\b|അയച്ചു|ചെയ്തു|ഇട്ടു/i
// A price list is full of numbers and the odd "cash" brand name: never a payment message.
const MAX_LENGTH = 400

/** Does this message say a payment was made? */
export function isPaymentMessage(text: string): boolean {
  const t = String(text || '').trim()
  if (!t || t.length > MAX_LENGTH) return false
  return PAID.test(t) || (MONEY.test(t) && SENT.test(t))
}

/** The amount mentioned, as written ("₹5,000"), when there is one. */
export function paymentAmount(text: string): string | null {
  const m = String(text || '').match(/(?:₹|rs\.?|inr)\s*([\d,]{3,9}(?:\.\d{1,2})?)|\b([\d,]{3,9}(?:\.\d{1,2})?)\s*(?:\/-|rs\b|rupees|രൂപ)/i)
  const n = m ? (m[1] || m[2]) : null
  return n && /\d{3}/.test(n.replace(/,/g, '')) ? `₹${n}` : null
}

const SERVICE = /\b(logo|poster|flyer|brochure|banner|website|web\s?site|branding|packaging|label|menu\s?card|visiting\s?card|business\s?card|video|reel|ads?|advertis\w+|marketing|social\s?media|instagram|printing|design\w*)\b|ലോഗോ|പോസ്റ്റർ|ഡിസൈൻ|വെബ്സൈറ്റ്/i
const ASKING = /\b(rate|price|cost|charge|quot\w*|package|how\s?much|ethra|need|want|looking\s?for|require\w*|veno|venam|cheyy?\w*|details?|enquir\w*|inquir\w*)\b|എത്ര|വേണം|\?/i

/** Does this first message from an unknown number read like someone asking about Cirqle's services? */
export function looksLikeEnquiry(text: string): boolean {
  const t = String(text || '').trim()
  if (t.length < 8 || t.length > 600) return false
  return SERVICE.test(t) && ASKING.test(t)
}
