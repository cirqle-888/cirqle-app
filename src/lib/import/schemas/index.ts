/**
 * Central schema registry.
 *
 * To add a new field to any mode:
 *   1. Find the mode's schema file (e.g. schemas/employees.ts)
 *   2. Add one FieldDef entry to the exported array
 *   Done — template header, column docs, parse, insert, and reference
 *   sections all derive automatically from the schema.
 *
 * To add a new import mode entirely:
 *   1. Create schemas/your_mode.ts with a FieldDef[]
 *   2. Add it to the FIELD_SCHEMA map below
 *   3. Add the mode to ImportMode union in import-client.tsx
 *   4. Add a case to runImport in import-client.tsx (for DB insert logic)
 */

import type { FieldDef } from '../types'
import type { ImportMode } from '@/app/(dashboard)/dashboard/import/import-client'

import { EMPLOYEE_FIELDS, EMPLOYEE_EXTRA_EXAMPLES } from './employees'
import { CLIENT_FIELDS,   CLIENT_EXTRA_EXAMPLES   } from './clients'
import { SERVICE_FIELDS,  SERVICE_EXTRA_EXAMPLES  } from './services'
import { JOB_FIELDS,      JOB_EXTRA_EXAMPLES      } from './jobs'
import {
  GROUP_FIELDS, PARAMETER_FIELDS, TOOL_FIELDS, PRICING_MATRIX_FIELDS,
} from './foundation'
import {
  CASHBOOK_FIELDS, INVOICE_FIELDS, INVOICE_STATUS_FIELDS, DISCOUNT_FIELDS,
} from './financial'
import {
  CONTRIB_SCORE_PCT_FIELDS, CONTRIB_EARNINGS_ONLY_FIELDS, CONTRIB_PARAM_DETAIL_BASE_FIELDS,
} from './contributions'

export {
  EMPLOYEE_FIELDS, EMPLOYEE_EXTRA_EXAMPLES,
  CLIENT_FIELDS,   CLIENT_EXTRA_EXAMPLES,
  SERVICE_EXTRA_EXAMPLES,
  JOB_EXTRA_EXAMPLES,
  GROUP_FIELDS, PARAMETER_FIELDS, TOOL_FIELDS, PRICING_MATRIX_FIELDS,
}

export const FIELD_SCHEMA: Record<ImportMode, FieldDef[]> = {
  employees:      EMPLOYEE_FIELDS,
  clients:        CLIENT_FIELDS,
  services:       SERVICE_FIELDS,
  groups:         GROUP_FIELDS,
  parameters:     PARAMETER_FIELDS,
  tools:          TOOL_FIELDS,
  pricing_matrix: PRICING_MATRIX_FIELDS,
  jobs:           JOB_FIELDS,
  cashbook_entries: CASHBOOK_FIELDS,
  // Contributions: schema selected at runtime based on sub-mode
  contributions:  CONTRIB_SCORE_PCT_FIELDS,
  invoices:       INVOICE_FIELDS,
  invoice_status: INVOICE_STATUS_FIELDS,
  discounts:      DISCOUNT_FIELDS,
}

/** Get fields for the active contribution sub-mode */
export function getContribFields(subMode: 'score_pct' | 'earnings_only' | 'param_detail'): FieldDef[] {
  if (subMode === 'earnings_only') return CONTRIB_EARNINGS_ONLY_FIELDS
  if (subMode === 'param_detail')  return CONTRIB_PARAM_DETAIL_BASE_FIELDS
  return CONTRIB_SCORE_PCT_FIELDS
}
