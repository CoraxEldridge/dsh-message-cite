// dsh-message-cite: Host half.
//
// Owns the message index behind the browser's JSON routes and the
// `agent/pre-step` listener that turns a message citation into model context.
// The Web client half lives in client.js.

import { registerRoutes } from './host/routes.js'
import { registerMessageCiteContext } from './host/context.js'
import { MessageIndex } from './host/indexer.js'

export const name = 'dsh-message-cite'

/** Delay before the background index warms up, so boot stays quiet. */
const WARMUP_DELAY_MS = 3000

/** Mount every capability the host provides, each disposed with this plugin fiber. */
export function apply(ctx) {
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(String(message))
    } catch {
      // Logging must never break the plugin.
    }
  }

  ctx.inject(['webServer', 'sessionQuery'], (scope) => {
    const index = new MessageIndex(scope.sessionQuery)

    scope.effect(() => registerRoutes(scope, index), 'dsh-message-cite: routes')
    scope.effect(() => registerMessageCiteContext(scope), 'dsh-message-cite: context')

    // Warm the index in the background; the menu still works while it fills.
    const timer = setTimeout(() => {
      index.scanAll().then(
        (summary) => warn(`index ready: ${index.size} sessions (${summary.elapsedMs}ms)`),
        (error) => warn(`index warmup failed: ${error?.message ?? error}`),
      )
    }, WARMUP_DELAY_MS)
    scope.effect(() => () => clearTimeout(timer), 'dsh-message-cite: warmup')
  })
}
