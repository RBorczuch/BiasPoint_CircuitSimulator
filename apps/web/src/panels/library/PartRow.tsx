/**
 * A part in the library list: symbol, name, its key data on a second line; click or drag to
 * place, hover for its card of key parameters, "⋯" (or right click) for what can be done with it.
 */
import {
  ChartLine,
  Copy,
  Ellipsis,
  FolderInput,
  MousePointerClick,
  Pencil,
  RotateCcw,
  Search,
  Share,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SymbolDef } from '@/api/types'
import { showComponentCard } from '@/components/ComponentCard'
import { openComponentWizard } from '@/components/ComponentWizard'
import { SymbolPreview } from '@/components/SymbolPreview'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { type DataField, keyParams, subtitle } from '@/lib/categories'
import { duplicateItem, exportItem, moveItem, removeLibraryItem, showWhereUsed } from '@/lib/library'
import { restoreDrawing } from '@/lib/looks'
import { useProject } from '@/store/project'
import { editSymbol } from '@/symbol-editor/SymbolEditor'

export type Origin = 'ideal' | 'standard' | 'user' | 'sheet'

export function originOf(symbol: SymbolDef): Origin {
  if (symbol.id.startsWith('bpt:')) return 'ideal'
  // A component of a library: the standard ones (parts, examples) come with the program.
  if (symbol.id.startsWith('cmp:')) return symbol.id.startsWith('cmp:Standard ') ? 'standard' : 'user'
  if (symbol.id.startsWith('sheet:')) return 'sheet'
  return symbol.id.startsWith('std:') ? 'standard' : 'user'
}

const ORIGIN_LABEL: Record<Origin, string> = {
  ideal: 'ideal',
  standard: 'standard library',
  user: 'my library',
  sheet: 'this project',
}

/** Reference a new part gets ("R1"; power symbols have none). */
export function refName(symbol: SymbolDef, n = 1): string {
  return symbol.ref_prefix.startsWith('#') ? symbol.ref_prefix.replace('#', '') : `${symbol.ref_prefix}${n}`
}

export function PartRow({
  symbol,
  fields,
  onPlace,
}: {
  symbol: SymbolDef
  fields: DataField[]
  onPlace: (s: SymbolDef) => void
}): ReactNode {
  const [menu, setMenu] = useState(false)
  const [card, setCard] = useState<DOMRect | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const row = useRef<HTMLDivElement>(null)
  const origin = originOf(symbol)
  const real = symbol.id.startsWith('cmp:')
  const line = subtitle(symbol, fields)
  const drawnHere = useProject((s) => Boolean(s.project?.default_looks?.[symbol.id]))
  const showCard = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCard(row.current?.getBoundingClientRect() ?? null), 450)
  }
  const hideCard = () => {
    clearTimeout(timer.current)
    setCard(null)
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover shows the card, right click the menu (both also by the ⋯ button)
    <div
      ref={row}
      className="group/row relative"
      data-testid={`part-${symbol.name}`}
      onMouseEnter={showCard}
      onMouseLeave={hideCard}
      onContextMenu={(e) => {
        e.preventDefault()
        hideCard()
        setMenu(true)
      }}
    >
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          hideCard()
          e.dataTransfer.setData('application/x-bpt-symbol', symbol.id)
        }}
        onClick={() => {
          hideCard()
          onPlace(symbol)
        }}
        title={`Click, then click on the schematic to place (or drag it there). Parts are named ${refName(symbol)}, ${refName(symbol, 2)}…`}
        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
      >
        <span className="flex min-w-0 items-center gap-2">
          <SymbolPreview symbol={symbol} size={22} />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="flex items-center gap-1 truncate">
              {symbol.name}
              {real && (
                <span
                  className="text-[9px] text-amber-600 dark:text-amber-400"
                  title="Real part: it has a card"
                >
                  ◆
                </span>
              )}
            </span>
            {line && <span className="truncate text-[10px] text-muted-foreground">{line}</span>}
          </span>
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/60 group-hover/row:invisible">
          {refName(symbol)}
        </span>
      </button>
      <DropdownMenu open={menu} onOpenChange={setMenu}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={`absolute top-1/2 right-1 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground ${menu ? 'block' : 'hidden group-hover/row:block'}`}
            aria-label={`Actions of ${symbol.name}`}
            onClick={hideCard}
          >
            <Ellipsis className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => onPlace(symbol)}>
            <MousePointerClick /> Place
          </DropdownMenuItem>
          {real && (
            <DropdownMenuItem onSelect={() => showComponentCard(symbol.id)}>
              <ChartLine /> Card
            </DropdownMenuItem>
          )}
          {real && (
            <DropdownMenuItem onSelect={() => openComponentWizard({ edit: symbol.id })}>
              <Pencil /> {origin === 'standard' ? 'Edit a copy' : 'Edit'}
            </DropdownMenuItem>
          )}
          {!real && origin !== 'sheet' && (
            <DropdownMenuItem onSelect={() => editSymbol(symbol)}>
              <Pencil /> {symbol.id.startsWith('user:') ? 'Edit symbol' : 'Edit the drawing…'}
            </DropdownMenuItem>
          )}
          {drawnHere && (
            <DropdownMenuItem onSelect={() => void restoreDrawing(symbol.id)}>
              <RotateCcw /> Restore the built-in drawing here
            </DropdownMenuItem>
          )}
          {(origin === 'user' || origin === 'standard') && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void duplicateItem(symbol.id, symbol.name)}>
                <Copy /> Duplicate…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void moveItem(symbol.id, symbol.name, origin === 'standard')}>
                <FolderInput /> {origin === 'standard' ? 'Copy to a library…' : 'Move to a library…'}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void showWhereUsed(symbol.id, symbol.name)}>
                <Search /> Where used
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportItem(symbol.id, symbol.name)}>
                <Share /> Export (.bptlib)…
              </DropdownMenuItem>
            </>
          )}
          {origin === 'user' && real && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => void removeLibraryItem('component', symbol.id, symbol.name)}
              >
                <Trash2 /> Remove from its library
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {card && <PartCard symbol={symbol} fields={fields} at={card} origin={origin} />}
    </div>
  )
}

/** The hover card: a big symbol, what the part is and its key parameters. */
function PartCard({
  symbol,
  fields,
  at,
  origin,
}: {
  symbol: SymbolDef
  fields: DataField[]
  at: DOMRect
  origin: Origin
}): ReactNode {
  const params = keyParams(symbol, fields)
  const top = Math.min(at.top, window.innerHeight - 260)
  return createPortal(
    <div
      role="tooltip"
      data-testid="part-card"
      className="pointer-events-none fixed z-50 w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
      style={{ left: at.right + 8, top: Math.max(8, top) }}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-md border bg-background p-1">
          <SymbolPreview symbol={symbol} size={56} />
        </div>
        <div className="min-w-0">
          <p className="font-medium">{symbol.name}</p>
          <p className="text-[11px] text-muted-foreground">
            {symbol.group ?? symbol.category} · {ORIGIN_LABEL[origin]}
          </p>
        </div>
      </div>
      {symbol.description && <p className="mt-2 text-xs text-muted-foreground">{symbol.description}</p>}
      {params.length > 0 && (
        <table className="mt-2 w-full text-xs">
          <tbody>
            {params.slice(0, 9).map(([label, value]) => (
              <tr key={label}>
                <td className="pr-2 text-muted-foreground">{label}</td>
                <td className="font-mono">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>,
    document.body,
  )
}
