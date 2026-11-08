import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ACTIONS, type ActionId, runAction, useKeymap } from '@/keymap/keymap'

interface Props {
  action: ActionId
  icon: ReactNode
  active?: boolean
  disabled?: boolean
  side?: 'top' | 'bottom' | 'left' | 'right'
  label?: string
}

/** Icon button running an action; the tooltip shows its name and shortcut. */
export function ToolbarButton({ action, icon, active, disabled, side = 'bottom', label }: Props) {
  const key = useKeymap((s) => s.bindings)()[action]?.[0]
  const text = label ?? ACTIONS[action].label
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? 'secondary' : 'ghost'}
          size="icon"
          className={`size-8 ${active ? 'text-emerald-500 ring-1 ring-emerald-500/40' : ''}`}
          disabled={disabled}
          aria-label={text}
          aria-pressed={active}
          onClick={() => runAction(action)}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>
        {text}
        {key && <span className="ml-2 font-mono opacity-70">{key}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

export const ToolbarSeparator = ({ vertical = false }: { vertical?: boolean }) => (
  <div className={vertical ? 'my-1 h-px w-6 bg-border' : 'mx-1 h-5 w-px bg-border'} />
)
