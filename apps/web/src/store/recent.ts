/** Recently placed symbols (shown first in the library), kept in localStorage. */
import { create } from 'zustand'

const KEY = 'bpt.recentSymbols'
const LIMIT = 6

function load(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

export const useRecentSymbols = create<{ ids: string[]; use: (id: string) => void }>((set, get) => ({
  ids: load(),
  use: (id) => {
    const ids = [id, ...get().ids.filter((x) => x !== id)].slice(0, LIMIT)
    set({ ids })
    try {
      localStorage.setItem(KEY, JSON.stringify(ids))
    } catch {
      // not remembered in private mode
    }
  },
}))
