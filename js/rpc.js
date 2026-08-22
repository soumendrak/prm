// Main-thread client for the database worker.

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
const pending = new Map()
let nextId = 1

worker.onmessage = ({ data: { id, ok, result, error } }) => {
  const slot = pending.get(id)
  if (!slot) return
  pending.delete(id)
  ok ? slot.resolve(result) : slot.reject(new Error(error))
}

worker.onerror = (e) => {
  for (const { reject } of pending.values()) reject(new Error(e.message || 'database worker failed'))
  pending.clear()
}

export function call(op, ...args) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, op, args })
  })
}
