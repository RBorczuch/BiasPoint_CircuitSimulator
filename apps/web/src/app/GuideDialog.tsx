/** "Getting started": the path from an empty sheet to a plot, for people new to simulation. */
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useDialogs } from '@/store/dialogs'

const STEPS: { title: string; text: string; keys?: string[] }[] = [
  {
    title: 'Place parts',
    text: 'Click a part in the Library (left), then click on the schematic. R rotates while placing, Esc stops.',
    keys: ['A'],
  },
  {
    title: 'Connect them',
    text: 'Draw wires from pin to pin: click to start, click to bend, click a pin or wire to finish. Red rings mark pins that are still open.',
    keys: ['W'],
  },
  {
    title: 'Add ground',
    text: 'Every circuit needs a ground (0 V reference). Connect it to the minus side of the source.',
    keys: ['P'],
  },
  {
    title: 'Name the nets you care about',
    text: 'A net label (e.g. "out") makes the node easy to find in plots and is plotted automatically.',
    keys: ['L'],
  },
  {
    title: 'Set values',
    text: 'Select a part and edit it in Properties (right): 4k7, 100n, 1meg or with units like "10 ms". Sources have a form for DC, AC and pulse/sine signals.',
    keys: ['E'],
  },
  {
    title: 'Simulate',
    text: 'Choose the analysis in the Simulate workspace (OP = DC voltages, TRAN = over time, AC = frequency response) and run it. Problems are listed with a hint how to fix them.',
    keys: ['F5'],
  },
  {
    title: 'Look at the results',
    text: 'Waveforms appear in Simulate; add more with + or probe a wire on the schematic. For calculations (power, averages, -3 dB) build an analysis graph in the Analysis workspace.',
    keys: ['Ctrl+P'],
  },
]

export function GuideDialog() {
  const open = useDialogs((s) => s.guide)
  const setOpen = useDialogs((s) => s.setGuide)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Getting started</DialogTitle>
          <DialogDescription>From an empty sheet to your first plot in seven steps.</DialogDescription>
        </DialogHeader>
        <ol className="flex flex-col gap-3 text-sm">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                {i + 1}
              </span>
              <div>
                <p className="font-medium">
                  {step.title}
                  {step.keys?.map((k) => (
                    <Kbd key={k} className="ml-2">
                      {k}
                    </Kbd>
                  ))}
                </p>
                <p className="text-muted-foreground">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">
          Experts: type SPICE lines in the console (:), use Ctrl+K for every command and Ctrl+/ to change
          shortcuts (KiCad, LTspice and Altium presets).
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false)
              useDialogs.getState().setExamples(true)
            }}
          >
            Open an example
          </Button>
          <Button onClick={() => setOpen(false)}>Start</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
