/** Vertical drawing toolbar on the right edge of the schematic (KiCad layout). */
import { Code, Crosshair, MousePointer2, Rows3, SquareArrowRightEnter, Tag, Tags } from 'lucide-react'
import { ToolbarButton, ToolbarSeparator } from '@/app/ToolbarButton'
import {
  GroundIcon,
  JunctionIcon,
  NetHighlightIcon,
  PowerIcon,
  SymbolIcon,
  WireIcon,
} from '@/components/icons'
import { useEditor } from '@/store/editor'

export function DrawingToolbar() {
  const tool = useEditor((s) => s.tool)
  const placing = tool.kind === 'place' ? tool.symbolId : null
  return (
    <div className="absolute top-2 right-2 z-10 flex flex-col items-center gap-0.5 rounded-lg border bg-background/90 p-1 shadow-sm backdrop-blur">
      <ToolbarButton
        side="left"
        action="tool.select"
        icon={<MousePointer2 />}
        active={tool.kind === 'select'}
      />
      <ToolbarButton
        side="left"
        action="tool.highlightNet"
        icon={<NetHighlightIcon />}
        active={tool.kind === 'highlight'}
      />
      <ToolbarSeparator vertical />
      <ToolbarButton
        side="left"
        action="place.symbol"
        icon={<SymbolIcon />}
        active={placing !== null && placing !== 'bpt:gnd' && placing !== 'bpt:power'}
      />
      <ToolbarButton side="left" action="place.ground" icon={<GroundIcon />} active={placing === 'bpt:gnd'} />
      <ToolbarButton side="left" action="place.power" icon={<PowerIcon />} active={placing === 'bpt:power'} />
      <ToolbarButton
        side="left"
        action="tool.wire"
        icon={<WireIcon />}
        active={tool.kind === 'wire' && !tool.bus}
      />
      <ToolbarButton
        side="left"
        action="tool.bus"
        icon={<Rows3 className="text-sky-500" />}
        active={tool.kind === 'wire' && Boolean(tool.bus)}
      />
      <ToolbarButton
        side="left"
        action="place.junction"
        icon={<JunctionIcon />}
        active={tool.kind === 'junction'}
      />
      <ToolbarButton
        side="left"
        action="tool.label"
        icon={<Tag />}
        active={tool.kind === 'label' && tool.labelKind === 'local'}
      />
      <ToolbarButton
        side="left"
        action="tool.globalLabel"
        icon={<Tags />}
        active={tool.kind === 'label' && tool.labelKind === 'global'}
      />
      <ToolbarButton
        side="left"
        action="tool.portLabel"
        icon={<SquareArrowRightEnter />}
        active={tool.kind === 'label' && tool.labelKind === 'port'}
      />
      <ToolbarButton side="left" action="tool.directive" icon={<Code />} active={tool.kind === 'directive'} />
      <ToolbarSeparator vertical />
      <ToolbarButton side="left" action="sim.probe" icon={<Crosshair />} active={tool.kind === 'probe'} />
    </div>
  )
}
