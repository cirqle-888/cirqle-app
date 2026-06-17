/**
 * Editable WhatsApp message templates — lets Settings override the wording of
 * every client-facing WhatsApp text (invoice share, payment reminders)
 * without a code change. Stored as plain strings in `company_settings`,
 * keyed by TEMPLATE_KEYS below; empty/missing falls back to DEFAULT_TEMPLATES.
 *
 * Mini templating syntax (line-based, no nesting):
 *   {placeholder}        → substituted with the var's value (empty string if absent)
 *   {{if:var}}rest of line → the WHOLE line is dropped if `var` is falsy/empty,
 *                            otherwise the prefix is stripped and the rest renders normally
 */

export interface MessageTemplates {
  invoiceShare:   string
  reminderSingle: string
  reminderMulti:  string
  reminderItem:   string
}

export const TEMPLATE_KEYS: Record<keyof MessageTemplates, string> = {
  invoiceShare:   'wa_tpl_invoice_share',
  reminderSingle: 'wa_tpl_reminder_single',
  reminderMulti:  'wa_tpl_reminder_multi',
  reminderItem:   'wa_tpl_reminder_item',
}

export const DEFAULT_TEMPLATES: MessageTemplates = {
  invoiceShare:
`{{if:client_name}}Hi {client_name},
{{if:client_name}}
📄 Invoice *{invoice_number}* from {company_name}
{{if:amount}}Amount: *{amount}*
{{if:due_date}}Due: {due_date}
{{if:link}}
{{if:link}}View & download your invoice:
{{if:link}}{link}`,

  reminderSingle:
`Hi {client_name},

This is a gentle reminder from {company_name} regarding your pending payment:

*{invoice_number}*{amount_suffix}{issue_suffix}
{{if:link}}View & download: {link}

Kindly arrange the payment at your earliest convenience. Thank you!`,

  reminderMulti:
`Hi {client_name},

This is a gentle reminder from {company_name} regarding your pending payments:

{items_block}

Total invoices pending: *{count}*
{{if:total_amount}}Total outstanding: *{total_amount}*

Kindly arrange the payment at your earliest convenience. Thank you!`,

  reminderItem:
`• *{invoice_number}*{amount_suffix}{issue_suffix}
{{if:link}}   {link}`,
}

/** Documentation shown in the Settings UI — label, blurb, and which {placeholders} are available. */
export const TEMPLATE_DOCS: { key: keyof MessageTemplates; label: string; description: string; placeholders: string[] }[] = [
  {
    key: 'invoiceShare',
    label: 'Invoice Share Message',
    description: 'Sent when you click "Share invoice" or "Mark Sent & Share" — links the client to the hosted invoice page.',
    placeholders: ['client_name', 'invoice_number', 'company_name', 'amount', 'due_date', 'link'],
  },
  {
    key: 'reminderSingle',
    label: 'Payment Reminder — single invoice',
    description: 'Used in Follow-ups when a client has exactly one pending invoice.',
    placeholders: ['client_name', 'company_name', 'invoice_number', 'amount_suffix', 'issue_suffix', 'link'],
  },
  {
    key: 'reminderMulti',
    label: 'Payment Reminder — multiple invoices',
    description: 'Used in Follow-ups when a client has several pending invoices. {items_block} is the itemised list, built from the template below.',
    placeholders: ['client_name', 'company_name', 'items_block', 'count', 'total_amount'],
  },
  {
    key: 'reminderItem',
    label: 'Payment Reminder — invoice line item',
    description: 'One line per invoice inside the multi-invoice reminder above.',
    placeholders: ['invoice_number', 'amount_suffix', 'issue_suffix', 'link'],
  },
]

/** Renders {placeholder} substitution + {{if:var}} whole-line conditionals. */
export function renderTemplate(tpl: string, vars: Record<string, string | undefined | null>): string {
  const out: string[] = []
  for (const raw of tpl.split('\n')) {
    const m = raw.match(/^\{\{if:(\w+)\}\}/)
    let line = raw
    if (m) {
      if (!vars[m[1]]) continue
      line = raw.slice(m[0].length)
    }
    out.push(line.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : '')))
  }
  return out.join('\n')
}

/** Resolve the active templates from a company_settings key→value map, falling back to defaults. */
export function templatesFromSettings(settings: Record<string, string>): MessageTemplates {
  return {
    invoiceShare:   settings[TEMPLATE_KEYS.invoiceShare]   || DEFAULT_TEMPLATES.invoiceShare,
    reminderSingle: settings[TEMPLATE_KEYS.reminderSingle] || DEFAULT_TEMPLATES.reminderSingle,
    reminderMulti:  settings[TEMPLATE_KEYS.reminderMulti]  || DEFAULT_TEMPLATES.reminderMulti,
    reminderItem:   settings[TEMPLATE_KEYS.reminderItem]   || DEFAULT_TEMPLATES.reminderItem,
  }
}
