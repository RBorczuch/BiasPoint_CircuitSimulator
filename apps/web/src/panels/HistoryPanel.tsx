/** History of changes: every undo step with what it did and who did it; click to go there. */
import { Bot, Circle, CircleDot } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiGet } from '@/api/client'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useProject } from '@/store/project'

interface Step {
  label: string
  origin: 'user' | 'agent'
  time: number
}

interface History {
  done: Step[]
  undone: Step[]
}

const clock = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function HistoryPanel() {
  const info = useProject((s) => s.info)
  const revision = useProject((s) => s.revision)
  const goTo = useProject((s) => s.goTo)
  const [history, setHistory] = useState<History>({ done: [], undone: [] })

  // biome-ignore lint/correctness/useExhaustiveDependencies: every change moves the history
  useEffect(() => {
    if (!info) return
    apiGet<History>(`/api/projects/${info.id}/history`)
      .then(setHistory)
      .catch(() => setHistory({ done: [], undone: [] }))
  }, [info?.id, revision])

  const rows: { label: string; step?: Step; to: number; undone: boolean }[] = [
    { label: 'Opened', to: 0, undone: false },
    ...history.done.map((step, i) => ({ label: step.label, step, to: i + 1, undone: false })),
    ...history.undone.map((step, i) => ({
      label: step.label,
      step,
      to: history.done.length + i + 1,
      undone: true,
    })),
  ]
  const current = history.done.length
  return (
    <ScrollArea className="h-full" data-testid="history-panel">
      <ol className="p-1 text-sm" aria-label="History">
        {rows.map((row) => (
          <li key={row.to}>
            <button
              type="button"
              aria-current={row.to === current ? 'step' : undefined}
              title={
                row.to === current
                  ? 'The project is here now'
                  : row.undone
                    ? 'Redo up to this step'
                    : 'Go back to just after this step'
              }
              onClick={() => row.to !== current && void goTo(row.to)}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent',
                row.to === current && 'bg-muted font-medium',
                row.undone && 'text-muted-foreground italic',
              )}
            >
              {row.to === current ? (
                <CircleDot className="size-3 shrink-0 text-primary" />
              ) : (
                <Circle className="size-3 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {row.step?.origin === 'agent' && (
                <span title="Made by the AI agent">
                  <Bot className="size-3.5 text-muted-foreground" />
                </span>
              )}
              {row.step && (
                <span className="font-mono text-[10px] text-muted-foreground">{clock(row.step.time)}</span>
              )}
            </button>
          </li>
        ))}
      </ol>
      {rows.length === 1 && (
        <p className="px-3 text-xs text-muted-foreground">No changes yet. Each change becomes a step here.</p>
      )}
    </ScrollArea>
  )
}
