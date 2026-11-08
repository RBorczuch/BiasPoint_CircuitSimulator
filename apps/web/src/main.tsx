import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './app/AppShell'
import { Toaster } from './components/ui/sonner'
import { TooltipProvider } from './components/ui/tooltip'
import { installCaptureListener } from './editor/captureListener'
import { installKeyboard } from './keymap/keymap'
import { installGraphSync } from './store/graph'
import { useProject } from './store/project'
import { installSimulationSync } from './store/simulation'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root element missing')

installKeyboard()
installCaptureListener()
installSimulationSync()
installGraphSync()
void useProject.getState().init()

const queries = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } })

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queries}>
      <TooltipProvider>
        <AppShell />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)
