// dsh-message-cite: HTTP routes for the browser half.
//
// The host plugin owns discovery; these routes are a thin JSON transport for the
// composer's `@` menu. They are registered on the harness web server and removed
// with the plugin fiber.

import { formatMessageReferenceMention } from './uri.js'
import { singleLine } from './search.js'

const API_PREFIX = '/dsh-message-cite/api/'
const GUARD_HEADER = 'x-dsh-message-cite'
const MAX_BODY_BYTES = 16 * 1024

function sendJson(response, status, payload) {
  if (response.writableEnded || response.destroyed) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

async function readBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Register every plugin route on the hosting web server.
 * @param {object} ctx - plugin context providing `webServer`.
 * @param {import('./indexer.js').MessageIndex} index - message index behind the menu.
 * @returns {() => void} disposer removing every route.
 */
export function registerRoutes(ctx, index) {
  const webServer = ctx.webServer
  const disposers = []
  /** Browser-half readiness, reported by client.js once it registered its source. */
  const state = { client: null }

  const route = (name, operation, method = 'POST') => {
    disposers.push(
      webServer.register({
        kind: 'exact',
        path: API_PREFIX + name,
        handler: async (request, response) => {
          try {
            if (request.method !== method) {
              sendJson(response, 405, { ok: false, error: { code: 'method-not-allowed', message: `${method} required` } })
              return
            }
            if (request.headers[GUARD_HEADER] !== '1') {
              sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'missing request marker header' } })
              return
            }
            let args = {}
            if (method === 'POST') {
              const body = await readBody(request)
              if (body.trim() !== '') {
                const parsed = JSON.parse(body)
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                  sendJson(response, 400, { ok: false, error: { code: 'bad-json', message: 'request body must be a JSON object' } })
                  return
                }
                args = parsed
              }
            }
            sendJson(response, 200, { ok: true, ...(await operation(args, request)) })
          } catch (error) {
            sendJson(response, 200, {
              ok: false,
              error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
            })
          }
        },
      }),
    )
  }

  route('search', async (args) => {
    // One bounded scan per request keeps a cold index useful without letting a
    // keystroke wait on many session logs.
    await index.scanSome({ count: 1, budgetMs: 250 }).catch(() => 0)

    const query = typeof args.query === 'string' ? args.query : ''
    const excludeSessionId = typeof args.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : undefined
    const limit = Number.isSafeInteger(args.limit) ? args.limit : 8

    const hits = await index.search({ query, excludeSessionId, limit })
    return { items: hits.map((hit) => present(hit)), indexed: index.size, indexedSessions: index.entries.size }
  })

  route('health', async () => ({
    plugin: 'dsh-message-cite',
    indexed: index.size,
    sessions: index.targetList === null ? null : index.targetList.length,
    scanning: index.scanning,
    client: state.client,
  }), 'GET')

  // The browser half reports here after it registers its `@` source, so a Host
  // side check can tell "not loaded yet" from "loaded and broken".
  route('client-ready', async (args) => {
    state.client = {
      at: new Date().toISOString(),
      version: typeof args.version === 'string' ? args.version : '',
      registered: typeof args.registered === 'number' ? args.registered : null,
    }
    return {}
  })

  // Diagnostics: force a full index build and report the cost. Never used by the UI.
  route('scan', async () => {
    const summary = await index.scanAll()
    return { ...summary, indexed: index.size }
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A route already removed by a reload must not block the rest.
      }
    }
  }
}

/** Project one hit into the candidate row the browser menu renders. */
function present(hit) {
  const label = buildLabel(hit)
  return {
    sessionId: hit.sessionId,
    seq: hit.seq,
    role: hit.role,
    time: hit.time,
    title: hit.title,
    snippet: hit.snippet,
    label,
    mention: formatMessageReferenceMention({ sessionId: hit.sessionId, seq: hit.seq, label }),
  }
}

/**
 * Build a short chip label: the session title plus a head of the message text.
 * @param {{title: string, snippet: string}} hit - one hit.
 * @returns {string} at most 36 characters.
 */
function buildLabel(hit) {
  const title = hit.title === '' ? '未命名对话' : hit.title
  const head = singleLine(hit.snippet, 14)
  const joined = head === '' ? title : `${title} · ${head}`
  const characters = Array.from(joined)
  return characters.length <= 36 ? joined : `${characters.slice(0, 35).join('')}…`
}
