/**
 * Managing libraries (docs/projekt-elementy.md §4.5): every library with its parts, templates and
 * symbols; create, rename, describe, export, remove a library; move, copy, recategorise or remove
 * several of its items at once (Ś12).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { apiDelete, apiGet, apiPatch, apiPost } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useCategories } from '@/lib/categories'
import { exportLibrary, importLibraryPackage, removeLibrary } from '@/lib/library'
import { reloadLibrary } from '@/store/project'

interface LibraryInfo {
  name: string
  description: string
  count: number
  standard: boolean
}

interface Item {
  id: string
  name: string
  type: 'component' | 'template' | 'symbol'
  category: string
}

const useManager = create<{ open: boolean; focus: string; show: (open: boolean) => void }>((set) => ({
  open: false,
  focus: '',
  show: (open) => set({ open }),
}))

/** Open the window, on `library` if given. */
export const manageLibraries = (library?: string) =>
  useManager.setState((s) => ({ open: true, focus: library ?? s.focus }))

const TYPE_LABEL: Record<Item['type'], string> = { component: 'part', template: 'model', symbol: 'symbol' }

export function LibraryManager() {
  const open = useManager((s) => s.open)
  const focus = useManager((s) => s.focus)
  const queries = useQueryClient()
  const categories = useCategories()
  const [selected, setSelected] = useState('')
  useEffect(() => {
    if (open && focus) setSelected(focus)
  }, [open, focus])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [newName, setNewName] = useState('')
  const [target, setTarget] = useState('')
  const [category, setCategory] = useState('')
  const [rename, setRename] = useState<{ name: string; description: string } | null>(null)
  const { data: libraries = [] } = useQuery({
    queryKey: ['libraries'],
    queryFn: () => apiGet<LibraryInfo[]>('/api/library/libraries'),
    enabled: open,
  })
  const { data: items = [] } = useQuery({
    queryKey: ['library-items', selected],
    queryFn: () => apiGet<Item[]>(`/api/library/libraries/${encodeURIComponent(selected)}/items`),
    enabled: open && Boolean(selected),
  })
  const library = libraries.find((l) => l.name === selected)
  const user = libraries.filter((l) => !l.standard)
  const refresh = async () => {
    await reloadLibrary()
    void queries.invalidateQueries({ queryKey: ['libraries'] })
    void queries.invalidateQueries({ queryKey: ['library-items'] })
    void queries.invalidateQueries({ queryKey: ['templates'] })
    setChecked(new Set())
  }
  const run = async (what: string, action: () => Promise<unknown>) => {
    try {
      await action()
      await refresh()
      toast.success(what)
    } catch (error) {
      toast.error(`${what.split(' ')[0]} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const ids = [...checked]
  const move = (mode: 'move' | 'copy') =>
    run(`${mode === 'move' ? 'Moved' : 'Copied'} ${ids.length} item(s) to “${target}”`, () =>
      apiPost('/api/library/items/move', { ids, to: target.trim(), mode }),
    )
  const removeChecked = () =>
    run(`Removed ${ids.length} item(s)`, async () => {
      for (const item of items.filter((i) => checked.has(i.id))) {
        if (item.type === 'component')
          await apiDelete(`/api/library/components?id=${encodeURIComponent(item.id)}`)
        else if (item.type === 'template')
          await apiDelete(`/api/library/templates?id=${encodeURIComponent(item.id)}`)
        else
          await apiDelete(
            `/api/library/symbols?library=${encodeURIComponent(selected)}&id=${encodeURIComponent(item.id)}`,
          )
      }
    })

  return (
    <Dialog open={open} onOpenChange={(o) => useManager.getState().show(o)}>
      <DialogContent className="max-h-[90vh] sm:max-w-4xl" data-testid="library-manager">
        <DialogHeader>
          <DialogTitle>Libraries</DialogTitle>
          <DialogDescription>
            Your libraries hold your parts, templates and symbols; the standard ones come with the program
            (read-only: copy from them).
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-cols-[14rem_1fr] gap-4">
          <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
            {libraries.map((l) => (
              <button
                key={l.name}
                type="button"
                aria-pressed={selected === l.name}
                className={`flex items-center justify-between rounded-md px-2 py-1 text-left text-sm ${selected === l.name ? 'bg-accent' : 'hover:bg-accent/60'}`}
                onClick={() => {
                  setSelected(l.name)
                  setChecked(new Set())
                  setRename(null)
                }}
              >
                <span className="truncate">{l.name}</span>
                {l.standard && (
                  <span className="rounded border px-1 text-[10px] text-muted-foreground">standard</span>
                )}
              </button>
            ))}
            <div className="mt-2 flex gap-1">
              <Input
                aria-label="New library name"
                className="h-7 text-xs"
                placeholder="New library"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <Button
                size="sm"
                className="h-7"
                disabled={!newName.trim()}
                onClick={() =>
                  void run(`Library “${newName.trim()}” created`, async () => {
                    await apiPost('/api/library/libraries', { name: newName.trim() })
                    setSelected(newName.trim())
                    setNewName('')
                  })
                }
              >
                Create
              </Button>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => void importLibraryPackage().then(refresh)}
            >
              Import a package…
            </Button>
          </div>
          <div className="flex min-h-0 flex-col gap-2">
            {!library ? (
              <p className="text-sm text-muted-foreground">Choose a library.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {rename ? (
                    <>
                      <Input
                        aria-label="Library name"
                        className="h-8 w-48"
                        value={rename.name}
                        onChange={(e) => setRename({ ...rename, name: e.target.value })}
                      />
                      <Input
                        aria-label="Library description"
                        className="h-8 flex-1"
                        placeholder="description"
                        value={rename.description}
                        onChange={(e) => setRename({ ...rename, description: e.target.value })}
                      />
                      <Button
                        size="sm"
                        onClick={() =>
                          void run(`Library saved as “${rename.name.trim()}”`, async () => {
                            await apiPatch(
                              `/api/library/libraries/${encodeURIComponent(library.name)}`,
                              rename,
                            )
                            setSelected(rename.name.trim() || library.name)
                            setRename(null)
                          })
                        }
                      >
                        Save
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="font-medium">{library.name}</span>
                      <span className="text-xs text-muted-foreground">{library.description}</span>
                      {!library.standard && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7"
                          onClick={() => setRename({ name: library.name, description: library.description })}
                        >
                          Rename…
                        </Button>
                      )}
                    </>
                  )}
                  <span className="ml-auto flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      onClick={() => void exportLibrary(library.name)}
                    >
                      Export…
                    </Button>
                    {!library.standard && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-destructive"
                        onClick={() => void removeLibrary(library.name).then(refresh)}
                      >
                        Remove library
                      </Button>
                    )}
                  </span>
                </div>
                <div className="min-h-40 overflow-y-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="w-8 px-2">
                          <input
                            type="checkbox"
                            aria-label="Select all"
                            checked={items.length > 0 && checked.size === items.length}
                            onChange={(e) =>
                              setChecked(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())
                            }
                          />
                        </th>
                        <th className="font-normal">Name</th>
                        <th className="font-normal">Type</th>
                        <th className="font-normal">Category</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.id} className="border-t">
                          <td className="px-2">
                            <input
                              type="checkbox"
                              aria-label={`Select ${item.name}`}
                              checked={checked.has(item.id)}
                              onChange={(e) => {
                                const next = new Set(checked)
                                if (e.target.checked) next.add(item.id)
                                else next.delete(item.id)
                                setChecked(next)
                              }}
                            />
                          </td>
                          <td>{item.name}</td>
                          <td className="text-xs text-muted-foreground">{TYPE_LABEL[item.type]}</td>
                          <td className="text-xs text-muted-foreground">{item.category || '—'}</td>
                        </tr>
                      ))}
                      {items.length === 0 && (
                        <tr>
                          <td colSpan={4} className="p-2 text-muted-foreground">
                            Empty.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{checked.size} selected:</span>
                  <Input
                    aria-label="Target library"
                    className="h-7 w-40 text-xs"
                    list="library-targets"
                    placeholder="to library…"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  />
                  <datalist id="library-targets">
                    {user.map((l) => (
                      <option key={l.name} value={l.name} />
                    ))}
                  </datalist>
                  {!library.standard && (
                    <Button
                      size="sm"
                      className="h-7"
                      disabled={!checked.size || !target.trim()}
                      onClick={() => void move('move')}
                    >
                      Move
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    disabled={!checked.size || !target.trim()}
                    onClick={() => void move('copy')}
                  >
                    Copy
                  </Button>
                  {!library.standard && (
                    <>
                      <select
                        aria-label="New category"
                        className="h-7 rounded-md border bg-background px-1 text-xs"
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                      >
                        <option value="">automatic category</option>
                        {categories.map((c) => (
                          <option key={c.path} value={c.path}>
                            {c.path.includes('/') ? ` ${c.path.split('/')[1]}` : c.path}
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        disabled={!checked.size}
                        onClick={() =>
                          void run(`Category of ${ids.length} item(s) set`, () =>
                            apiPost('/api/library/items/category', {
                              ids: ids.filter((i) => !i.startsWith('user:') && !i.startsWith('part:')),
                              category,
                            }),
                          )
                        }
                      >
                        Set category
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-destructive"
                        disabled={!checked.size}
                        onClick={() => void removeChecked()}
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
