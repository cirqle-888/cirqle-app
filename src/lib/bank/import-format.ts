/**
 * The format a bank statement arrives in, and the prompt that produces it.
 *
 * THE PROBLEM. A bank sends a PDF. Sometimes a scan. Sometimes the only copy
 * anyone has is a screenshot on a phone. None of that imports, and retyping a
 * hundred lines is both slow and the single most likely place for a wrong
 * figure to enter the books.
 *
 * THE ROUTE. A person hands the PDF to whatever AI assistant they already
 * have, together with the prompt this file builds, and pastes back the CSV it
 * returns. The prompt is therefore part of the app's data contract and lives
 * in the codebase next to the parser that reads its output — not in a note
 * somewhere, where it would drift away from the columns it is describing.
 *
 * WHAT THE FORMAT IS FOR. Every rule below exists to remove a way the transfer
 * could go quietly wrong:
 *
 *   · YYYY-MM-DD, so 03/04 cannot land as 4 March in a day-first app;
 *   · money_in and money_out as SEPARATE columns, so no sign has to be
 *     inferred from a marker an assistant may not have understood;
 *   · the running balance carried across, so the import can check ITSELF —
 *     opening plus every movement must equal closing, and a dropped line is
 *     caught before anyone compares anything to the cash book;
 *   · the account named on every row, so two accounts extracted in one go
 *     cannot be imported into each other.
 */

/** The canonical header, in order. */
export const STATEMENT_COLUMNS = [
  'account',
  'date',
  'description',
  'reference',
  'money_in',
  'money_out',
  'balance',
] as const

export const STATEMENT_HEADER = STATEMENT_COLUMNS.join(',')

/** A blank template with two illustrative rows. */
export function buildStatementTemplate(accountName = 'HDFC Current'): string {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`
  return [
    STATEMENT_HEADER,
    [accountName, '2026-07-01', 'NEFT CR SEA STAR SUPERMARKET', 'N123456789', '25000.00', '', '125000.00'].map(q).join(','),
    [accountName, '2026-07-02', 'UPI/ZOHO CORP/PAYMENT', '', '', '1180.00', '123820.00'].map(q).join(','),
  ].join('\n')
}

export interface PromptOptions {
  /** Account names exactly as the app knows them — the assistant must echo one. */
  accountNames: string[]
  periodStart?: string | null
  periodEnd?: string | null
}

/**
 * The prompt a person copies and sends with their statement.
 *
 * Written AT the assistant, in the imperative, and deliberately repetitive
 * about the two things that ruin an import: inventing rows and dropping them.
 * It asks for the period's opening and closing balance separately because the
 * app needs those to check the import adds up, and they are printed as summary
 * figures rather than as transaction lines.
 */
export function buildExtractionPrompt(options: PromptOptions): string {
  const names = options.accountNames.filter(Boolean)
  const accountList = names.length
    ? names.map(n => `  - ${n}`).join('\n')
    : '  - (type your account names here, exactly as they appear in Cirqle)'

  const period = options.periodStart && options.periodEnd
    ? `\nOnly include transactions dated between ${options.periodStart} and ${options.periodEnd} (inclusive). Ignore anything outside that range.\n`
    : ''

  return `You are converting a bank statement into a CSV for import into an accounting app.
The statement is attached — it may be a PDF, a CSV, a spreadsheet, or a photo/screenshot.

Read EVERY transaction line in the attachment and output them as CSV.
${period}
## Output format

Return ONLY CSV inside a fenced \`\`\`csv block. No commentary before or after it.
The first line must be exactly this header:

${STATEMENT_HEADER}

One row per transaction, in the same order the statement lists them.

## Column rules

- **account** — the account this statement belongs to. Use EXACTLY one of these names:
${accountList}
  If the attachment covers more than one account, output a SEPARATE \`\`\`csv block
  for each account, each with its own header row. Never mix two accounts in one block.
- **date** — the transaction date as YYYY-MM-DD. Not DD/MM, not MM/DD. If the statement
  shows both a transaction date and a value date, use the TRANSACTION date.
- **description** — the narration/particulars text, copied verbatim. Keep the reference
  codes that are part of it. Replace any commas with spaces, or wrap the field in quotes.
- **reference** — cheque number, UTR or transaction ID if the statement has its own column
  for it. Leave empty otherwise.
- **money_in** — the amount if money ENTERED the account (deposit, credit, receipt).
- **money_out** — the amount if money LEFT the account (withdrawal, debit, payment).
  Fill exactly ONE of money_in / money_out on every row. Never both. Never neither.
  A "Cr" marker means money in; a "Dr" marker means money out.
- **balance** — the running balance printed after that line. Leave empty if the statement
  does not print one.
- All amounts: digits and at most one decimal point. No currency symbols, no commas,
  no brackets, no minus signs. 1,25,000.00 becomes 125000.00

## Rules that matter most

1. Do NOT invent, merge, split, round or reorder any transaction.
2. Do NOT skip any transaction, including bank charges, interest, taxes, reversals,
   auto-debits and internal transfers.
3. Do NOT output opening balance, closing balance, sub-totals, carried-forward rows,
   page headers, page footers or summary lines as transactions. Those are not transactions.
4. If a value is genuinely unreadable (a blurred scan), put UNREADABLE in that cell
   rather than guessing. Never guess a figure.

## After the CSV block

Add these four lines as plain text, filled in from the statement's own summary:

Account:          <account name>
Period:           <first date> to <last date>
Opening balance:  <the opening/brought-forward balance, digits only>
Closing balance:  <the closing balance, digits only>
Transaction rows: <how many rows you output>

Repeat that block once per account if there is more than one.`
}
