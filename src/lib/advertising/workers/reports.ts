import { DequeuedJob } from '@/lib/jobs/engine'

export async function generateReportWorker(job: DequeuedJob): Promise<any> {
  const { report_type, client_id } = job.payload
  if (!report_type) throw new Error('Missing report_type in job payload')

  // In a real app we'd aggregate data here based on report_type (daily, weekly, client, etc)
  
  return {
    generated: true,
    report_type
  }
}
