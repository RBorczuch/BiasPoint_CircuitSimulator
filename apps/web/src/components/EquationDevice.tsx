/**
 * An equation-defined device (FR-MOD-9, Qucs' EDD): N branches between pins P1..PN and REF,
 * each with the current into its pin and its charge as expressions of V1..VN and parameters.
 * The device becomes a sheet of the project (placed as a block from the library's Sheets), after
 * ngspice has read it; what is wrong is listed instead.
 */
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { apiPost } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { own, useProject } from '@/store/project'

const useEquationDialog = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({
  open: false,
  set: (open) => set({ open }),
}))

export const openEquationDevice = (): void => useEquationDialog.getState().set(true)

interface Branch {
  current: string
  charge: string
}

/** "name = value" lines (or commas) to parameters. */
function parameters(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of text.split(/[\n,;]/)) {
    const [name, ...rest] = part.split('=')
    if (name.trim() && rest.length) out[name.trim()] = rest.join('=').trim()
  }
  return out
}

export function EquationDeviceDialog() {
  const open = useEquationDialog((s) => s.open)
  const setOpen = useEquationDialog((s) => s.set)
  const [name, setName] = useState('Equation device')
  const [branches, setBranches] = useState<Branch[]>([{ current: 'is*(exp(V1/vt)-1)', charge: 'cj*V1' }])
  const [params, setParams] = useState('is = 1e-14\nvt = 0.025852\ncj = 1n')
  const [problems, setProblems] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const setBranch = (k: number, patch: Partial<Branch>) =>
    setBranches(branches.map((b, i) => (i === k ? { ...b, ...patch } : b)))
  const create = async () => {
    const info = useProject.getState().info
    if (!info) return
    setBusy(true)
    try {
      const result = await own(() =>
        apiPost<{ problems: string[]; sheet: string }>('/api/components/equation-device', {
          project_id: info.id,
          name,
          branches,
          parameters: parameters(params),
        }),
      )
      setProblems(result.problems)
      if (result.problems.length) return
      await useProject.getState().refresh()
      useProject.getState().setSheet(result.sheet)
      setOpen(false)
      toast.success(`Device ${result.sheet} made`, {
        description: 'Place it as a block from the Library, under Sheets; its parameters are the block’s.',
      })
    } catch (error) {
      setProblems([error instanceof Error ? error.message : String(error)])
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl" data-testid="equation-device">
        <DialogHeader>
          <DialogTitle>Equation-defined device</DialogTitle>
          <DialogDescription>
            Each branch runs from its pin Pk to the common pin REF. Write the current into Pk and the charge
            of the branch with V1…V{branches.length} (the branch voltages), the parameters and functions such
            as exp, sqrt, tanh. A charge may use its own branch voltage only.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 text-sm">
          <span>Name</span>
          <Input
            className="h-8"
            aria-label="Device name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          {branches.map((b, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: branches are numbered by their place
            <div key={k} className="grid grid-cols-[2.5rem_1fr_1fr_1.75rem] items-center gap-1.5 text-xs">
              <span className="font-mono">P{k + 1}</span>
              <Input
                className="h-8 font-mono text-xs"
                aria-label={`Current of branch ${k + 1}`}
                placeholder={`I${k + 1}, e.g. V${k + 1}/r`}
                value={b.current}
                onChange={(e) => setBranch(k, { current: e.target.value })}
              />
              <Input
                className="h-8 font-mono text-xs"
                aria-label={`Charge of branch ${k + 1}`}
                placeholder={`Q${k + 1} (optional), e.g. c*V${k + 1}`}
                value={b.charge}
                onChange={(e) => setBranch(k, { charge: e.target.value })}
              />
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:text-destructive disabled:opacity-30"
                aria-label={`Remove branch ${k + 1}`}
                disabled={branches.length === 1}
                onClick={() => setBranches(branches.filter((_b, i) => i !== k))}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            disabled={branches.length >= 8}
            onClick={() => setBranches([...branches, { current: '', charge: '' }])}
          >
            <Plus className="size-3.5" /> Branch
          </Button>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <span>Parameters (name = value, one a line)</span>
          <Textarea
            aria-label="Device parameters"
            className="h-20 font-mono text-xs"
            value={params}
            onChange={(e) => setParams(e.target.value)}
          />
        </div>
        {problems.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-destructive" data-testid="equation-problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end">
          <Button disabled={busy} onClick={() => void create()}>
            {busy ? 'Checking…' : 'Make the device'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
