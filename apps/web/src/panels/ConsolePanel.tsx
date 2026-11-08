/**
 * Command line (AutoCAD style): SPICE element lines are imported into the schematic,
 * words run editor actions. Output stays in a short scrollback.
 */
import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { ACTIONS, type ActionId, runAction } from '@/keymap/keymap'
import { t } from '@/lib/i18n'
import { decimalPoints } from '@/lib/units'
import { useProject } from '@/store/project'

const WORDS: Record<string, ActionId> = {
  undo: 'edit.undo',
  redo: 'edit.redo',
  fit: 'view.fit',
  wire: 'tool.wire',
  label: 'tool.label',
  save: 'file.save',
  delete: 'edit.delete',
}

export function ConsolePanel() {
  const [lines, setLines] = useState<string[]>(['Type a SPICE line, e.g. "R1 in out 10k", or "help".'])
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [cursor, setCursor] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const focus = () => input.current?.focus()
    window.addEventListener('bpt:focus-console', focus)
    return () => window.removeEventListener('bpt:focus-console', focus)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever output is added
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [lines])

  const run = async (text: string) => {
    const line = text.trim()
    if (!line) return
    setLines((l) => [...l, `> ${line}`])
    setHistory((h) => [line, ...h].slice(0, 100))
    const word = line.toLowerCase()
    if (word === 'help') {
      setLines((l) => [
        ...l,
        'SPICE lines (R C L V I E F G H B D Q M J S, .model, .param) are added to the schematic.',
        `Commands: ${Object.keys(WORDS).join(', ')}, clear.`,
      ])
    } else if (word === 'clear') {
      setLines([])
    } else if (word in WORDS) {
      runAction(WORDS[word])
      setLines((l) => [...l, ACTIONS[WORDS[word]].label])
    } else {
      await useProject.getState().importNetlist(decimalPoints(line).replaceAll(';', '\n'))
    }
  }

  return (
    <div className="flex h-full flex-col font-mono text-xs">
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2 text-muted-foreground">
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only log
          <div key={i}>{line}</div>
        ))}
        <div ref={end} />
      </div>
      <Input
        ref={input}
        value={value}
        placeholder={t('console.placeholder')}
        aria-label="SPICE command line"
        className="h-8 rounded-none border-x-0 border-b-0 font-mono text-xs"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            void run(value)
            setValue('')
            setCursor(-1)
          } else if (e.key === 'ArrowUp' && history.length) {
            const next = Math.min(cursor + 1, history.length - 1)
            setCursor(next)
            setValue(history[next])
          } else if (e.key === 'ArrowDown') {
            const next = Math.max(cursor - 1, -1)
            setCursor(next)
            setValue(next < 0 ? '' : history[next])
          } else if (e.key === 'Escape') {
            e.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}
