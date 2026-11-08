/** Pictures of parts of the UI (window, plot panel, graph canvas) for AI agents and the user. */
import { toPng } from 'html-to-image'

/** PNG data URL of `element`, scaled so its longer side is at most `maxPx`. */
export async function captureElement(element: HTMLElement, maxPx = 1600): Promise<string> {
  const rect = element.getBoundingClientRect()
  const ratio = Math.min(2, maxPx / Math.max(rect.width, rect.height, 1))
  return toPng(element, {
    pixelRatio: ratio,
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    // Floating UI (toasts, the "send to agent" dialog itself) is not part of the picture.
    filter: (node) => !(node instanceof HTMLElement && node.dataset.noCapture === 'true'),
  })
}

export const CAPTURE_TARGETS: Record<string, { selector: string; where: string }> = {
  window: { selector: '#root', where: 'the application window' },
  plot: { selector: '[data-capture="waveforms"]', where: 'the Waveforms panel (Simulate workspace)' },
  graph: { selector: '[data-testid="graph-canvas"]', where: 'the analysis graph (Analysis workspace)' },
}
