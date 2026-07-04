import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import { fetchReportData } from './src/lib/reporting/data-engine'
import { buildKPIData } from './src/lib/reporting/kpi-engine'
import { computeDailyRows } from './src/lib/reporting/layouts/daily-report'

async function main() {
  const data = await fetchReportData({
    projectId: '83ebdf94-e6cb-4bd9-957a-f9ec6cd85280',
    clientId: '57ecb2bf-2565-4537-b08c-53b01fcc3040',
    dateFrom: '2026-06-24',
    dateTo: '2026-07-03'
  })
  
  const kpis = buildKPIData(data.metrics, data.comparisonMetrics, data.project)
  console.log('Project Tax Percent:', data.project.taxPercent)
  console.log('Daily Series [0]:', kpis.dailySeries[0])
  
  // mock for computeDailyRows
  const dailyRows = computeDailyRows({ project: data.project, kpi: kpis } as any)
  console.log('Daily Rows [0]:', dailyRows[0])
}
main()
