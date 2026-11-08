/**
 * UUIDv7 ids, monotonic within the page like the backend (bpt/document/ids.py), so objects
 * created here keep their creation order when the backend sorts lists by id.
 */
let lastMs = 0
let counter = 0

export function newId(): string {
  let ms = Date.now()
  if (ms <= lastMs) {
    ms = lastMs
    counter++
    if (counter > 0xfff) {
      ms++
      counter = 0
    }
  } else {
    counter = 0
  }
  lastMs = ms
  const rand = crypto.getRandomValues(new Uint8Array(8))
  const hex = (n: number, width: number) => n.toString(16).padStart(width, '0')
  const timeHex = hex(ms, 12)
  const randB = [...rand].map((b) => hex(b, 2)).join('')
  const variant = (0x8 | (rand[0] & 0x3)).toString(16)
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8)}-7${hex(counter, 3)}-${variant}${randB.slice(1, 4)}-${randB.slice(4, 16)}`
}
