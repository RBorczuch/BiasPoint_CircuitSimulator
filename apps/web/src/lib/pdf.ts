/**
 * Datasheet pages for the chart digitizer: a PDF opened in the browser with pdf.js (loaded only
 * when a PDF is opened), each page rendered to a picture.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'

export type PdfDocument = PDFDocumentProxy

export async function openPdf(file: File): Promise<PdfDocument> {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
}

/** Page ``number`` (from 1) as a PNG data URL, at ``scale`` × 72 dpi (2: sharp enough to click). */
export async function renderPage(doc: PdfDocument, number: number, scale = 2): Promise<string> {
  const page = await doc.getPage(number)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  await page.render({ canvas, viewport }).promise
  return canvas.toDataURL('image/png')
}
