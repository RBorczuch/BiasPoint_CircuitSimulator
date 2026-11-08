/** Promise-based dialogs (text prompt, symbol picker) rendered once in the app shell. */
import { create } from 'zustand'

interface PromptRequest {
  title: string
  label?: string
  initial?: string
  placeholder?: string
  multiline?: boolean
  resolve: (value: string | null) => void
}

export interface Choice {
  label: string
  value: string
  variant?: 'default' | 'outline' | 'destructive'
}

interface ChoiceRequest {
  title: string
  description: string
  choices: Choice[] // the last one is the default (Enter)
  resolve: (value: string | null) => void
}

export interface FileRequest {
  // kicad / spice / bptlib: pick a file to import; saveLib: where to write a library package
  mode: 'open' | 'save' | 'kicad' | 'spice' | 'bptlib' | 'saveLib' | 'kicadSch'
  name?: string // save / saveLib: suggested name
  folder?: string // start folder
  resolve: (path: string | null) => void
}

interface DialogState {
  prompt: PromptRequest | null
  choice: ChoiceRequest | null
  file: FileRequest | null
  symbolPicker: ((symbolId: string | null) => void) | null
  shortcuts: boolean
  palette: boolean
  settings: boolean
  examples: boolean
  guide: boolean
  agentShot: string | null // picture for "Send to agent" (data URL)
  setShortcuts: (open: boolean) => void
  setPalette: (open: boolean) => void
  setSettings: (open: boolean) => void
  setExamples: (open: boolean) => void
  setGuide: (open: boolean) => void
  setAgentShot: (shot: string | null) => void
}

export const useDialogs = create<DialogState>((set) => ({
  prompt: null,
  choice: null,
  file: null,
  symbolPicker: null,
  shortcuts: false,
  palette: false,
  settings: false,
  examples: false,
  guide: false,
  agentShot: null,
  setShortcuts: (shortcuts) => set({ shortcuts }),
  setPalette: (palette) => set({ palette }),
  setSettings: (settings) => set({ settings }),
  setExamples: (examples) => set({ examples }),
  setGuide: (guide) => set({ guide }),
  setAgentShot: (agentShot) => set({ agentShot }),
}))

export function prompt(options: Omit<PromptRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.setState({
      prompt: {
        ...options,
        resolve: (value) => {
          useDialogs.setState({ prompt: null })
          resolve(value)
        },
      },
    })
  })
}

export function pickSymbol(): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.setState({
      symbolPicker: (id) => {
        useDialogs.setState({ symbolPicker: null })
        resolve(id)
      },
    })
  })
}

/** Open / Save dialog with folder browsing; resolves to a project path or null. */
export function pickProjectPath(options: Omit<FileRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.setState({
      file: {
        ...options,
        resolve: (path) => {
          useDialogs.setState({ file: null })
          resolve(path)
        },
      },
    })
  })
}

/** A question with a few buttons (e.g. Save / Don't save / Cancel); null when dismissed. */
export function choose(options: Omit<ChoiceRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.setState({
      choice: {
        ...options,
        resolve: (value) => {
          useDialogs.setState({ choice: null })
          resolve(value)
        },
      },
    })
  })
}
