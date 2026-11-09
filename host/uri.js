// dsh-message-cite: canonical message-reference URI and inline mention encoding.
//
// The scheme is deliberately NOT `dsh-session:`. The shipped session-reference
// service parses every `dsh-session:` mention at `agent/pre-step` and rejects a
// malformed one, which would terminate the turn. A distinct scheme keeps the two
// reference kinds independent: this plugin owns `dsh-message:` end to end.

/** URI scheme reserved for one cited message. */
export const MESSAGE_REFERENCE_SCHEME = 'dsh-message:'

/**
 * Encode one message identity as a canonical lossless URI.
 * @param {{sessionId: string, seq: number}} reference - target session and event seq.
 * @returns {string} canonical `dsh-message:` URI.
 */
export function encodeMessageReferenceUri(reference) {
  const payload = Buffer.from(JSON.stringify([reference.sessionId, reference.seq]), 'utf8').toString('base64url')
  return `${MESSAGE_REFERENCE_SCHEME}${payload}`
}

/**
 * Decode one canonical message URI.
 * @param {string} uri - complete URI.
 * @returns {{sessionId: string, seq: number}} decoded identity.
 * @throws {Error} when the URI is not a canonical message reference.
 */
export function decodeMessageReferenceUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith(MESSAGE_REFERENCE_SCHEME)) {
    throw invalidUri(uri)
  }
  const payload = uri.slice(MESSAGE_REFERENCE_SCHEME.length)
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw invalidUri(uri)
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw invalidUri(uri)
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw invalidUri(uri)
  const [sessionId, seq] = parsed
  if (typeof sessionId !== 'string' || sessionId === '') throw invalidUri(uri)
  if (!Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0)) throw invalidUri(uri)
  if (encodeMessageReferenceUri({ sessionId, seq }) !== uri) throw invalidUri(uri)
  return { sessionId, seq }
}

/**
 * Render the Markdown mention a host inserts into the prompt draft.
 * @param {{sessionId: string, seq: number, label: string}} reference - target and display label.
 * @returns {string} escaped `@[label](dsh-message:...)` mention.
 */
export function formatMessageReferenceMention(reference) {
  const label = escapeLabel(reference.label ?? reference.sessionId)
  return `@[${label}](${encodeMessageReferenceUri(reference)})`
}

const MENTION_PATTERN = /@\[((?:\\.|[^\\\]])*)\]\((dsh-message:[A-Za-z0-9_-]+)\)/gu

/**
 * Extract every well-formed message mention from one text value.
 *
 * A mention whose payload does not decode is left untouched and reported as
 * `invalid`, so a broken draft degrades to plain text instead of failing the
 * turn. Malformed text never throws.
 * @param {string} text - user message text.
 * @returns {{text: string, references: Array<{sessionId: string, seq: number, label: string}>, invalid: number}} readable text and structured references.
 */
export function parseMessageReferenceText(text) {
  const references = []
  let invalid = 0
  const rendered = text.replace(MENTION_PATTERN, (match, rawLabel, uri) => {
    let identity
    try {
      identity = decodeMessageReferenceUri(uri)
    } catch {
      invalid += 1
      return match
    }
    const label = unescapeLabel(rawLabel) || identity.sessionId
    references.push({ ...identity, label })
    return `@${label}`
  })
  return { text: rendered, references, invalid }
}

/** Escape a label for use inside the Markdown mention. */
export function escapeLabel(label) {
  return String(label).replace(/[\\\]]/gu, (match) => `\\${match}`)
}

/** Undo {@link escapeLabel}. */
export function unescapeLabel(label) {
  return String(label).replace(/\\(.)/gu, '$1')
}

function invalidUri(uri) {
  const shown = typeof uri === 'string' ? JSON.stringify(uri.length > 120 ? `${uri.slice(0, 117)}...` : uri) : String(uri)
  return new Error(`invalid message reference URI ${shown}`)
}
