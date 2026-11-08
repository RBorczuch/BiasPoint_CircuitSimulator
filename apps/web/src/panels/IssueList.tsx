/** ERC issues with a short "how to fix" hint; clicking one shows the parts on the schematic. */
import { CircleAlert, TriangleAlert } from 'lucide-react'
import type { ErcIssue } from '@/api/types'
import { activeEditor } from '@/editor/controller'
import { useEditor } from '@/store/editor'
import { currentSheet, useProject } from '@/store/project'

/** What to do about each kind of problem (written for someone new to circuit simulation). */
export const ISSUE_HINTS: Record<string, string> = {
  'no-ground': 'Add a ground symbol (key P) and wire it to the reference point of the circuit.',
  'no-dc-path':
    'Every net needs a DC path to ground. A node between capacitors only needs e.g. 1G to ground.',
  'source-loop': 'Voltage sources or inductors in parallel short each other; add a small series resistor.',
  'unconnected-pin': 'Wire the pin, or delete the part if it is not needed.',
  'duplicate-ref': 'Give one of the parts another reference in Properties.',
  'missing-model': 'Choose a model in Properties, or add a .model card (SPICE directive).',
  'unknown-symbol': 'The symbol is not in the library; replace the part.',
  'bad-value': 'Use a number with an optional suffix (4k7, 100n, 1meg) or a parameter {name}.',
  'milli-not-mega': 'In SPICE "M" is milli. Write "meg" for mega, e.g. 1meg or 1 MHz with the unit.',
  'net-name-conflict': 'A net has two labels; remove one so it has a single name.',
  'empty-circuit': 'Add parts from the library (left) or type a SPICE line in the console.',
  'stress-over': 'Choose a part with a higher rating, or change the circuit so it is stressed less.',
  'stress-margin':
    'Within the rating but beyond the safety margin (project settings); a larger part lasts longer.',
  'script-ignored': 'Analyses are set in Simulate or in an analysis graph; ngspice scripts are not run.',
}

/** Select the parts of an issue and show them, switching to the schematic if needed. */
export function showOnSchematic(refs: string[]): void {
  if (refs.length === 0) return
  // The part may be on another sheet: show that sheet first.
  const { project, setSheet } = useProject.getState()
  const owner = project?.sheets.find((sh) => sh.instances.some((i) => refs.includes(i.ref)))
  if (owner) setSheet(owner.name)
  const sheet = currentSheet(useProject.getState())
  if (!sheet) return
  const ids = sheet.instances.filter((i) => refs.includes(i.ref)).map((i) => i.id)
  if (!ids.length) return
  useEditor.getState().select(ids)
  if (activeEditor) activeEditor.centerOn(new Set(ids))
  else {
    window.dispatchEvent(new CustomEvent('bpt:workspace', { detail: 'schematic' }))
    setTimeout(() => activeEditor?.centerOn(new Set(ids)), 400)
  }
}

export function IssueList({ issues, hints = false }: { issues: ErcIssue[]; hints?: boolean }) {
  return (
    <ul className="text-sm">
      {issues.map((issue) => (
        <li key={`${issue.code}-${issue.message}`}>
          <button
            type="button"
            onClick={() => showOnSchematic(issue.refs)}
            title={issue.refs.length ? 'Show on the schematic' : undefined}
            className="flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-accent"
          >
            {issue.severity === 'error' ? (
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : (
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
            )}
            <span className="min-w-0 flex-1">
              {issue.message}
              {hints && ISSUE_HINTS[issue.code] && (
                <span className="block text-xs text-muted-foreground">{ISSUE_HINTS[issue.code]}</span>
              )}
            </span>
            {!hints && <span className="ml-auto font-mono text-xs text-muted-foreground">{issue.code}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}
