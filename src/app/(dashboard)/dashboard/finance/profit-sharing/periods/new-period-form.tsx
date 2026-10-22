'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createRun } from '../actions'
import { Button, Field, inputCls, useAction } from '../_components'

export default function NewPeriodForm({ fixedStart, defaultEnd }: { fixedStart: string | null; defaultEnd: string }) {
  const { run, busy, host } = useAction()
  const router = useRouter()
  const [start, setStart] = useState(fixedStart ?? '')
  const [end, setEnd] = useState(defaultEnd)
  return (
    <form className="grid gap-3 md:grid-cols-4" onSubmit={async e => {
      e.preventDefault()
      let id: string | undefined
      const ok = await run('new', async () => {
        const res = await createRun({ startMonth: start, endMonth: end })
        if (res.ok) id = res.data?.id
        return res
      }, 'Period created')
      if (ok && id) router.push(`/dashboard/finance/profit-sharing/periods/${id}`)
    }}>
      {host}
      <Field label="From month">
        <input type="month" className={inputCls} value={start} onChange={e => setStart(e.target.value)} disabled={!!fixedStart} required />
      </Field>
      <Field label="To month"><input type="month" className={inputCls} value={end} onChange={e => setEnd(e.target.value)} required /></Field>
      <div className="flex items-end"><Button type="submit" variant="primary" busy={busy === 'new'}>Create period</Button></div>
    </form>
  )
}
