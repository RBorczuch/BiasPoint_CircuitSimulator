/** Which workspace is shown (panels shared by several workspaces adapt to it). */
import { create } from 'zustand'

export type Workspace = 'schematic' | 'simulate' | 'analysis'

export const useWorkspace = create<{ workspace: Workspace }>(() => ({ workspace: 'schematic' }))
