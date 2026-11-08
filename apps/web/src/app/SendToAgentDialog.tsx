/**
 * "Send to agent": a picture of the window with the user's marks and comment, put into the
 * project's capture inbox where an AI agent reads it (MCP capture_inbox / capture_get).
 */
import { Eraser, Send } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiPost } from '@/api/client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { describeView } from '@/editor/captureListener'
import { captureElement } from '@/lib/screenshot'
import { useDialogs } from '@/store/dialogs'
import { useProject } from '@/store/project'

type Box = { x: number; y: number; w: number; h: number } // fractions of the picture

/** Take the picture first (the dialog must not be in it), then open the dialog. */
export async function openSendToAgent(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#root')
  if (!root || !useProject.getState().info) return
  try {
    useDialogs.getState().setAgentShot(await captureElement(root, 1600))
  } catch (error) {
    toast.error(`Screenshot failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function SendToAgentDialog() {
  const shot = useDialogs((s) => s.agentShot)
  const setShot = useDialogs((s) => s.setAgentShot)
  const [comment, setComment] = useState('')
  const [boxes, setBoxes] = useState<Box[]>([])
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; box: Box } | null>(null)
  const area = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (shot) {
      setComment('')
      setBoxes([])
    }
  }, [shot])
  if (!shot) return null

  const point = (e: React.PointerEvent) => {
    const r = area.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }

  const send = async () => {
    const image = await compose(shot, boxes)
    const info = useProject.getState().info
    if (!info) return
    try {
      await apiPost('/api/captures', {
        project_id: info.id,
        image: image.split(',', 2)[1],
        mime: 'image/png',
        comment: comment.trim(),
        meta: { ...describeView('window'), marks: boxes.length },
      })
      toast.success('Sent to the agent', { description: 'It reads it with capture_inbox / capture_get.' })
      setShot(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && setShot(null)}>
      <DialogContent className="flex max-h-[92vh] flex-col sm:max-w-4xl" data-no-capture="true">
        <DialogHeader>
          <DialogTitle>Send to agent</DialogTitle>
          <DialogDescription>
            Drag on the picture to mark what you mean; say what you want in the comment.
          </DialogDescription>
        </DialogHeader>
        <div
          ref={area}
          className="relative min-h-0 cursor-crosshair touch-none overflow-hidden rounded border select-none"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            const p = point(e)
            setDrawing({ x0: p.x, y0: p.y, box: { x: p.x, y: p.y, w: 0, h: 0 } })
          }}
          onPointerMove={(e) => {
            if (!drawing) return
            const p = point(e)
            const box = {
              x: Math.min(drawing.x0, p.x),
              y: Math.min(drawing.y0, p.y),
              w: Math.abs(p.x - drawing.x0),
              h: Math.abs(p.y - drawing.y0),
            }
            setDrawing({ ...drawing, box })
          }}
          onPointerUp={() => {
            if (drawing && drawing.box.w > 0.005 && drawing.box.h > 0.005) setBoxes([...boxes, drawing.box])
            setDrawing(null)
          }}
          data-testid="agent-shot"
        >
          <img
            src={shot}
            alt="Screenshot to send"
            className="block max-h-[55vh] w-full object-contain"
            draggable={false}
          />
          {[...boxes, ...(drawing ? [drawing.box] : [])].map((b) => (
            <div
              key={`${b.x}-${b.y}-${b.w}-${b.h}`}
              className="pointer-events-none absolute border-2 border-red-500"
              style={{
                left: `${b.x * 100}%`,
                top: `${b.y * 100}%`,
                width: `${b.w * 100}%`,
                height: `${b.h * 100}%`,
              }}
            />
          ))}
        </div>
        <Textarea
          aria-label="Comment for the agent"
          placeholder="e.g. Why does V(out) oscillate here? / Make this filter cut off at 2 kHz."
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && void send()}
        />
        <DialogFooter className="items-center sm:justify-between">
          <Button variant="ghost" size="sm" disabled={!boxes.length} onClick={() => setBoxes([])}>
            <Eraser /> Clear marks
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShot(null)}>
              Cancel
            </Button>
            <Button onClick={() => void send()}>
              <Send /> Send <kbd className="ml-1 text-[10px] opacity-70">Ctrl+Enter</kbd>
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The picture with the marks drawn into it (the agent sees what the user circled). */
async function compose(src: string, boxes: Box[]): Promise<string> {
  if (!boxes.length) return src
  const image = new Image()
  image.src = src
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return src
  ctx.drawImage(image, 0, 0)
  ctx.strokeStyle = '#ef4444'
  ctx.lineWidth = Math.max(3, canvas.width / 400)
  for (const b of boxes)
    ctx.strokeRect(b.x * canvas.width, b.y * canvas.height, b.w * canvas.width, b.h * canvas.height)
  return canvas.toDataURL('image/png')
}
