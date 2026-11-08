import type { ErcIssue } from '@/api/types'
import { t } from '@/lib/i18n'
import { useProject } from '@/store/project'
import { useSimulation } from '@/store/simulation'
import { IssueList } from './IssueList'

export function ProblemsPanel() {
  const erc = useProject((s) => s.issues)
  const stress = useSimulation((s) => s.stress)
  // Ratings exceeded (error) or used beyond the project's margin (warning), from the last run.
  const stressed: ErcIssue[] = (stress?.items ?? [])
    .filter((i) => i.status !== 'ok')
    .map((i) => ({
      severity: i.status === 'over' ? 'error' : 'warning',
      code: i.status === 'over' ? 'stress-over' : 'stress-margin',
      message: i.message,
      refs: [i.ref],
    }))
  const issues = [...erc, ...stressed]
  if (issues.length === 0) return <p className="p-3 text-sm text-muted-foreground">{t('problems.none')}</p>
  return (
    <div className="h-full overflow-auto p-1">
      <IssueList issues={issues} hints />
    </div>
  )
}
