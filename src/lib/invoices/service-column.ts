/**
 * Should this invoice print a Service column?
 *
 * Two layers, because the question is really about the CLIENT and only
 * occasionally about one invoice:
 *
 *   • A client who buys several services wants to see which ones were done.
 *     A client on a single service already knows, and the column is noise.
 *     That is a standing fact about the client, so it lives on the client and
 *     does not have to be remembered every month — which is the failure mode
 *     of a per-invoice-only switch: the month someone forgets, the invoice
 *     goes out in the wrong shape.
 *
 *   • Any single invoice can still say otherwise. `show_service_column` is
 *     NULL by default, meaning "follow the client"; setting it true or false
 *     overrides for that invoice alone.
 *
 * Mirrors how expenses_mode already layers a per-invoice override over a
 * default, so there is one idea here, not two.
 */

export interface ServiceColumnInvoice {
  /** null / undefined = inherit from the client. */
  show_service_column?: boolean | null
}

export interface ServiceColumnClient {
  invoice_show_services?: boolean | null
}

/**
 * `false` unless something positively says otherwise — including before the
 * migration adds these columns, when both read as undefined and every invoice
 * keeps the exact shape it has today.
 */
export function showServiceColumn(
  inv: ServiceColumnInvoice | null | undefined,
  client: ServiceColumnClient | null | undefined,
): boolean {
  const override = inv?.show_service_column
  if (override === true || override === false) return override
  return client?.invoice_show_services === true
}

/** What the toggle in the UI should read, given where the value came from. */
export function serviceColumnSource(
  inv: ServiceColumnInvoice | null | undefined,
  client: ServiceColumnClient | null | undefined,
): 'invoice' | 'client' | 'default' {
  const override = inv?.show_service_column
  if (override === true || override === false) return 'invoice'
  if (client?.invoice_show_services === true) return 'client'
  return 'default'
}
