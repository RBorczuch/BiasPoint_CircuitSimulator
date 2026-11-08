/** File → Open example…: shipped example projects, opened as unsaved copies. */
import { useEffect, useState } from 'react'
import { apiGet } from '@/api/client'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDialogs } from '@/store/dialogs'
import { useProject } from '@/store/project'

interface ExampleInfo {
  name: string
  title: string
  description: string
}

export function ExamplesDialog() {
  const open = useDialogs((s) => s.examples)
  const [examples, setExamples] = useState<ExampleInfo[] | null>(null)

  useEffect(() => {
    if (open && examples === null) {
      apiGet<ExampleInfo[]>('/api/library/examples')
        .then(setExamples)
        .catch(() => setExamples([]))
    }
  }, [open, examples])

  const choose = (name: string) => {
    useDialogs.getState().setExamples(false)
    void useProject.getState().openExample(name)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => useDialogs.getState().setExamples(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Open example</DialogTitle>
          <DialogDescription>Opens a copy; save it wherever you like.</DialogDescription>
        </DialogHeader>
        <ul className="-mx-2">
          {(examples ?? []).map((e) => (
            <li key={e.name}>
              <button
                type="button"
                onClick={() => choose(e.name)}
                className="w-full rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                <p className="text-sm font-medium">{e.title}</p>
                <p className="text-xs text-muted-foreground">{e.description}</p>
              </button>
            </li>
          ))}
          {examples === null && <li className="px-2 py-2 text-sm text-muted-foreground">Loading…</li>}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
