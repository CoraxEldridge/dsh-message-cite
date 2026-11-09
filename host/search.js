// dsh-message-cite: reading one cited message through `ctx.sessionQuery`.
//
// Discovery lives in ./indexer.js; this module only resolves a concrete
// `{sessionId, seq}` into the text the model may be given.

/** Event types that carry conversational text. */
const CONVERSATION_TYPES = new Set(['user/message', 'assistant/message'])

/** Largest cited text kept per message, in UTF-8 bytes. */
const MAX_QUOTE_BYTES = 8 * 1024

/** Largest total cited text kept for one user message, in UTF-8 bytes. */
export const MAX_QUOTE_BUDGET = 24 * 1024

/**
 * Whether one event type can be cited as conversation text.
 * @param {string} type - session event type.
 * @returns {boolean} true for user and assistant messages.
 */
export function isConversationEvent(type) {
  return CONVERSATION_TYPES.has(type)
}

/**
 * Project one session event to its conversational text.
 * @param {object} event - current-surface or raw session event.
 * @returns {{role: 'user'|'assistant', text: string}|undefined} projected text, when the event is citable.
 */
export function projectEventText(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.type === 'user/message') {
    const data = event.data
    // Injected context and developer messages share the event type; only a
    // genuine user turn is citable.
    if (data?.source?.kind !== 'user') return undefined
    const text = textOf(data.content)
    return text === '' ? undefined : { role: 'user', text }
  }
  if (event.type === 'assistant/message') {
    const text = textOf(event.data?.message?.content)
    return text === '' ? undefined : { role: 'assistant', text }
  }
  return undefined
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) => (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')
}

/**
 * Read one cited message, preferring the current surface and falling back to the raw log.
 * @param {object} sessionQuery - trusted session-query service.
 * @param {{sessionId: string, seq: number, signal?: AbortSignal}} request - target identity.
 * @returns {Promise<{sessionId: string, seq: number, role: string, time: number, text: string, title: string, replaced: boolean}>} the cited message.
 * @throws {Error} when the target is missing or is not conversation text.
 */
export async function readCitedMessage(sessionQuery, request) {
  const surface = await sessionQuery.readSurface(request.sessionId)
  const title = await readOneTitle(sessionQuery, request.sessionId)
  const onSurface = (surface?.events ?? []).find((event) => event.seq === request.seq)
  if (onSurface !== undefined) {
    const projected = projectEventText(onSurface)
    if (projected === undefined) throw new Error(`消息 #${request.seq} 不是对话文本（类型：${onSurface.type}）`)
    return {
      sessionId: request.sessionId,
      seq: request.seq,
      role: projected.role,
      time: onSurface.time ?? 0,
      text: projected.text,
      title,
      replaced: false,
    }
  }

  // The message is no longer on the model surface (compacted or replaced);
  // the raw log still holds it.
  const read = await sessionQuery.readEvent({ sessionId: request.sessionId, seq: request.seq, before: 0, after: 0 }, request.signal)
  const target = read?.target
  if (target === undefined) throw new Error(`对话里找不到消息 #${request.seq}`)
  const projected = projectEventText(target)
  if (projected === undefined) throw new Error(`消息 #${request.seq} 不是对话文本（类型：${target.type}）`)
  return {
    sessionId: request.sessionId,
    seq: request.seq,
    role: projected.role,
    time: target.time ?? 0,
    text: projected.text,
    title,
    replaced: true,
  }
}

async function readOneTitle(sessionQuery, sessionId) {
  try {
    const results = await sessionQuery.readTitleSnapshots([sessionId])
    const title = results?.[0]?.value?.title
    return typeof title === 'string' ? title : ''
  } catch {
    return ''
  }
}

/** Collapse whitespace and bound one single-line preview. */
export function singleLine(text, max) {
  const collapsed = String(text).replace(/\s+/gu, ' ').trim()
  const characters = Array.from(collapsed)
  if (characters.length <= max) return collapsed
  return `${characters.slice(0, Math.max(1, max - 1)).join('')}…`
}

/**
 * Bound one cited text to the per-quote UTF-8 budget, keeping head and tail.
 * @param {string} text - original message text.
 * @param {number} [maxBytes] - byte budget.
 * @returns {{text: string, omittedBytes: number}} bounded text and the exact omitted byte count.
 */
export function boundQuoteText(text, maxBytes = MAX_QUOTE_BYTES) {
  const value = String(text)
  const total = Buffer.byteLength(value, 'utf8')
  if (total <= maxBytes) return { text: value, omittedBytes: 0 }

  const characters = Array.from(value)
  const markerReserve = 96
  const headTarget = Math.max(1, Math.floor((maxBytes - markerReserve) / 2))

  let head = ''
  let headBytes = 0
  for (const character of characters) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (headBytes + bytes > headTarget) break
    head += character
    headBytes += bytes
  }

  const tailTarget = Math.max(1, maxBytes - markerReserve - headBytes)
  let tail = ''
  let tailBytes = 0
  for (let index = characters.length - 1; index >= head.length; index -= 1) {
    const bytes = Buffer.byteLength(characters[index], 'utf8')
    if (tailBytes + bytes > tailTarget) break
    tail = characters[index] + tail
    tailBytes += bytes
  }

  const omittedBytes = Math.max(0, total - headBytes - tailBytes)
  return { text: `${head}\n[… 省略 ${omittedBytes} 字节 …]\n${tail}`, omittedBytes }
}
