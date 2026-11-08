/** Sheet tabs over the schematic: switch with a click, rename with a double click, add with +. */
import { ArrowUp, Plus } from 'lucide-react'
import type { Sheet } from '@/api/types'
import { addSheet, renameSheet, viewSteps } from '@/lib/sheets'
import { cn } from '@/lib/utils'
import { useProject } from '@/store/project'

const NO_SHEETS: Sheet[] = [] // stable: a new [] per call would make the store re-render forever

export function SheetTabs() {
  const sheets = useProject((s) => s.project?.sheets ?? NO_SHEETS)
  const current = useProject((s) => s.sheetName)
  const setSheet = useProject((s) => s.setSheet)
  const viewPath = useProject((s) => s.viewPath)
  const path = viewSteps(sheets, current, viewPath)
  // Back to the sheet that holds the block, keeping the path above it.
  const up = (depth: number) =>
    setSheet(path[depth].sheet, depth > 0 ? path.slice(0, depth).map((p) => p.ref) : null)
  return (
    <div className="absolute top-2 left-2 z-[5] flex max-w-[70%] flex-col items-start gap-1">
      <div
        className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border bg-background/90 p-0.5 text-xs shadow-sm backdrop-blur"
        role="tablist"
        aria-label="Sheets"
      >
        {/* A placed component's sheets stay out of the tabs unless shown (entered from its part). */}
        {sheets
          .filter((sheet) => !sheet.owner || sheet.name === current)
          .map((sheet) => (
            <button
              type="button"
              role="tab"
              aria-selected={sheet.name === current}
              key={sheet.id}
              title="Click to show, double-click to rename"
              onClick={() => setSheet(sheet.name)}
              onDoubleClick={() => void renameSheet(sheet.name)}
              className={cn(
                'rounded px-2 py-0.5 whitespace-nowrap',
                sheet.name === current
                  ? 'bg-muted font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {sheet.name}
            </button>
          ))}
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          title="Add a sheet (global labels and power symbols connect sheets; ports make it a block)"
          aria-label="Add sheet"
          onClick={() => void addSheet()}
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {path.length > 0 && (
        // Inside a block: where it is used, and the way back up (Alt+Backspace).
        <nav
          aria-label="Hierarchy"
          className="flex items-center gap-1 rounded-md border bg-background/90 px-1.5 py-0.5 text-[11px] text-muted-foreground shadow-sm backdrop-blur"
        >
          <button
            type="button"
            className="rounded p-0.5 hover:text-foreground"
            title="Leave the block (Alt+Backspace)"
            aria-label="Leave block"
            onClick={() => up(path.length - 1)}
          >
            <ArrowUp className="size-3" />
          </button>
          {path.map((step, i) => (
            <span key={`${step.sheet}/${step.ref}`} className="flex items-center gap-1">
              {i > 0 && <span>›</span>}
              <button type="button" className="hover:text-foreground" onClick={() => up(i)}>
                {step.sheet}
              </button>
              <span>›</span>
              <span className="font-mono text-foreground">{step.ref}</span>
            </span>
          ))}
          <span className="ml-1" title="Signals inside are named with the block path, e.g. V(X1.mid)">
            ({path.map((p) => p.ref).join('.')}.<i>net</i>)
          </span>
        </nav>
      )}
    </div>
  )
}
