import { describe, expect, it } from 'vitest'
import type { JobInfo } from '@/api/types'
import { newer } from './simulation'

const job = (status: JobInfo['status'], id = 'j1'): JobInfo => ({
  job_id: id,
  project_id: 'p',
  status,
  run_id: status === 'ok' ? 'r' : null,
  progress: '',
  error: null,
  issues: [],
})

describe('newer', () => {
  it('does not let a late "queued" response undo a finished job', () => {
    expect(newer(job('ok'), job('queued')).status).toBe('ok')
    expect(newer(job('queued'), job('running')).status).toBe('running')
    expect(newer(job('ok'), job('queued', 'j2')).status).toBe('queued') // a new job
  })
})
