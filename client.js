// dsh-message-cite: Web client half.
//
// Adds one `@` source that searches messages across sessions, inserts an atomic
// message-citation chip into the composer, and renders that mention as a chip
// in sent user text. The host half owns discovery and model-context injection.

window.__ModuleLoader__.load({
  id: 'dsh-message-cite',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'messageCite'
    const API = '/dsh-message-cite/api/'
    const GUARD_HEADER = 'x-dsh-message-cite'
    const SOURCE = 'message-citation'
    const RULE_ID = 'message-citation'
    const CANDIDATE_TIMEOUT_MS = 5000

    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }

    const zh = {
      section: '其他对话的消息',
      roleUser: '用户',
      roleAssistant: '助手',
      untitled: '未命名对话',
    }

    const en = {
      section: 'Messages in other conversations',
      roleUser: 'User',
      roleAssistant: 'Assistant',
      untitled: 'Untitled conversation',
    }

    /** Undo the mention label escaping used by the host. */
    function unescapeLabel(label) {
      return String(label).replace(/\\(.)/gu, '$1')
    }

    /**
     * Render one confirmed message citation as the existing Session chip.
     * @param props - the parsed text node and its original spelling.
     * @returns an inline non-interactive chip.
     */
    function MessageCitation({ node, raw }) {
      const label = node?.data?.label ?? ''
      const Chip = primitives?.ReferenceChip
      if (typeof Chip !== 'function') {
        return h('span', { title: raw }, `@${label}`)
      }
      return h(Chip, { appearance: 'session', label, title: raw })
    }

    /** Find the nearest `@[label](dsh-message:...)` mention in sent user text. */
    const messageCitationRule = {
      id: RULE_ID,
      order: 12,
      match(text, from) {
        const wire = /@\[((?:\\.|[^\\\]])*)\]\(dsh-message:[A-Za-z0-9_-]+\)/uy
        for (let start = text.indexOf('@[', from); start >= 0; start = text.indexOf('@[', start + 1)) {
          wire.lastIndex = start
          const explicit = wire.exec(text)
          if (explicit === null) continue
          return {
            id: RULE_ID,
            start,
            end: start + explicit[0].length,
            data: { label: unescapeLabel(explicit[1]) },
          }
        }
        return undefined
      },
    }

    /**
     * Register the `@` source and the transcript renderer.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-message-cite: locale')
      let t
      try {
        t = ctx.locale.bind(NS)
      } catch {
        t = (key) => key
      }

      const uiConversation = ctx.get('uiConversation')
      if (uiConversation?.userText !== undefined) {
        ctx.effect(
          () => uiConversation.userText.register(messageCitationRule),
          'dsh-message-cite: user text rule',
        )
      }

      ctx.slots.inject('conversation.user.text.node', () =>
        ctx.slots.register(
          { name: 'conversation.user.text.node', key: RULE_ID, priority: 100, locale: NS },
          MessageCitation,
        ),
      )

      const inputTriggers = ctx.get('inputTriggers')
      if (inputTriggers === undefined) return

      const source = {
        trigger: '@',
        name: SOURCE,
        order: 20,
        showGroupTitle: false,
        async candidates(session, { query, quoted, signal }) {
          // A quoted `@"..."` token keeps its spaces, which lets a message
          // search use several keywords; an unquoted token is one word.
          void quoted

          const controller = new AbortController()
          const forwardAbort = () => controller.abort()
          if (signal !== undefined) {
            if (signal.aborted) return []
            signal.addEventListener('abort', forwardAbort, { once: true })
          }
          const timer = setTimeout(() => controller.abort(), CANDIDATE_TIMEOUT_MS)

          try {
            const response = await fetch(`${API}search`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
              body: JSON.stringify({
                query: typeof query === 'string' ? query : '',
                sessionId: session?.sessionId,
                limit: 10,
              }),
              credentials: 'same-origin',
              signal: controller.signal,
            })
            if (!response.ok) return []
            const body = await response.json()
            if (body === null || body.ok !== true || !Array.isArray(body.items)) return []
            return body.items.map((item) => candidateRow(item, t))
          } catch {
            // A failed or superseded lookup drops its rows; the other `@`
            // sources still list.
            return []
          } finally {
            clearTimeout(timer)
            signal?.removeEventListener?.('abort', forwardAbort)
          }
        },
        onPick({ candidate }) {
          let value
          try {
            value = JSON.parse(candidate?.value ?? '')
          } catch {
            return undefined
          }
          if (value === null || typeof value !== 'object' || typeof value.mention !== 'string') return undefined
          return {
            insert: {
              source: SOURCE,
              ref: value.mention,
              label: typeof value.label === 'string' && value.label !== '' ? value.label : value.mention,
              appearance: 'session',
              clipboardText: value.mention,
            },
          }
        },
        openReference() {
          return false
        },
        codec: {
          clipboardText: (ref) => ref,
          serialize: (ref) => Promise.resolve(ref),
        },
      }

      ctx.effect(() => inputTriggers.registerSource(source), 'dsh-message-cite: @ source')

      // Tell the Host this half is live (the health route reports it), so a
      // failed bundle is distinguishable from a page that has not loaded yet.
      try {
        void fetch(`${API}client-ready`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
          body: JSON.stringify({ registered: 1 }),
          credentials: 'same-origin',
          keepalive: true,
        }).catch(() => {})
      } catch {
        // Diagnostics must never break the plugin.
      }
    }

    /**
     * Project one host hit into a menu row.
     * @param item - host candidate record.
     * @param t - the plugin dictionary.
     * @returns the menu row.
     */
    function candidateRow(item, t) {
      const title = typeof item.title === 'string' && item.title !== '' ? item.title : t('untitled')
      const role = item.role === 'assistant' ? t('roleAssistant') : t('roleUser')
      const snippet = typeof item.snippet === 'string' ? item.snippet : ''
      return {
        name: title,
        description: snippet === '' ? role : `${role} · ${snippet}`,
        icon: 'session',
        section: t('section'),
        value: JSON.stringify({ mention: item.mention, label: item.label }),
      }
    }

    return {
      inject: ['inputTriggers', 'locale', 'slots', 'uiConversation'],
      apply,
    }
  },
})
