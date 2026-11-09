// Standalone checks for dsh-message-cite. Run with:
//   node test/run.mjs
// No harness services are required: every host/client service is a stub.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

import {
  decodeMessageReferenceUri,
  encodeMessageReferenceUri,
  formatMessageReferenceMention,
  parseMessageReferenceText,
} from '../host/uri.js'
import { boundQuoteText, readCitedMessage, singleLine } from '../host/search.js'
import { MessageIndex } from '../host/indexer.js'
import { createConversationTool } from '../host/tool.js'
import { registerMessageCiteContext } from '../host/context.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
let checks = 0
function check(name, body) {
  return Promise.resolve()
    .then(body)
    .then(() => {
      checks += 1
      console.log(`ok  ${name}`)
    })
    .catch((error) => {
      console.error(`FAIL ${name}`)
      throw error
    })
}

// ---------------------------------------------------------------- uri codec

await check('uri round-trips ids containing punctuation and spaces', () => {
  const reference = { sessionId: 'session-😀 a/b:c?d', seq: 42 }
  const uri = encodeMessageReferenceUri(reference)
  assert.deepEqual(decodeMessageReferenceUri(uri), reference)
  assert.match(uri, /^dsh-message:[A-Za-z0-9_-]+$/)
})

await check('non-canonical uri is rejected', () => {
  assert.throws(() => decodeMessageReferenceUri('dsh-message:!!!'))
  assert.throws(() => decodeMessageReferenceUri('dsh-session:abc'))
  const good = encodeMessageReferenceUri({ sessionId: 's', seq: 1 })
  assert.throws(() => decodeMessageReferenceUri(good + 'A'))
})

await check('mention formats and parses back with an escaped label', () => {
  const mention = formatMessageReferenceMention({ sessionId: 's1', seq: 7, label: 'a]b\\c' })
  assert.match(mention, /^@\[a\\\]b\\\\c\]\(dsh-message:/)
  const parsed = parseMessageReferenceText(`看 ${mention} 这条`)
  assert.equal(parsed.text, '看 @a]b\\c 这条')
  assert.deepEqual(parsed.references, [{ sessionId: 's1', seq: 7, label: 'a]b\\c' }])
  assert.equal(parsed.invalid, 0)
})

await check('malformed mention degrades to plain text', () => {
  const parsed = parseMessageReferenceText('x @[label](dsh-message:abc) y')
  assert.equal(parsed.references.length, 0)
  assert.equal(parsed.invalid, 1)
  assert.match(parsed.text, /dsh-message:abc/)
})

// ---------------------------------------------------------------- search

const cited = {
  sessionId: 's-target',
  seq: 3,
  time: 10,
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: '三体问题的结论是什么？' }] },
}

function fakeSessionQuery(overrides = {}) {
  return {
    async searchSessions() {
      return { items: [{ header: { id: 's-target' } }, { header: { id: 's-self' } }] }
    },
    async searchEvents({ sessionId }) {
      return {
        items: [
          { sessionId, seq: 3, type: 'user/message', time: 10, snippet: '三体问题的结论是什么？' },
          { sessionId, seq: 4, type: 'tool/result', time: 11, snippet: 'ignored' },
        ],
      }
    },
    async filterEvents(sessionId) {
      return [
        { sessionId, seq: 2, type: 'developer/message', time: 5, surface: 'current', text: 'ignored developer note' },
        { sessionId, seq: 3, type: 'user/message', time: 10, surface: 'current', text: '三体问题的结论是什么？' },
        { sessionId, seq: 4, type: 'assistant/message', time: 11, surface: 'current', text: '是三体文明的黑暗森林。' },
      ]
    },
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { title: `标题-${sessionId}` } }))
    },
    async listSessions() {
      return [{ header: { id: 's-live', createdAt: 2 }, live: true }, { header: { id: 's-cold', createdAt: 1 }, live: false }]
    },
    async readSurface(sessionId) {
      return {
        session: { id: sessionId },
        events: [
          {
            seq: 1,
            time: 4,
            type: 'developer/message',
            data: { source: { kind: 'developer' }, message: { content: [{ type: 'text', text: '开发者提示' }] } },
          },
          { ...cited, seq: 3 },
          {
            seq: 4,
            time: 11,
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: '是三体文明的黑暗森林。' }] } },
          },
          {
            seq: 5,
            time: 12,
            type: 'assistant/message',
            data: { message: { content: [{ type: 'tool-call', name: 'pwsh', arguments: '{"command":"ls"}' }] } },
          },
        ],
      }
    },
    async readEvent() {
      throw new Error('not found')
    },
    ...overrides,
  }
}

await check('index scans conversational text only and searches it', async () => {
  const index = new MessageIndex(fakeSessionQuery())
  await index.scanAll()
  const hits = await index.search({ query: '三体', excludeSessionId: 's-live', limit: 5 })
  assert.equal(hits.length, 2)
  assert.equal(hits[0].sessionId, 's-cold')
  assert.equal(hits[0].role, 'user')
  assert.equal(hits[0].title, '标题-s-cold')
  // Developer messages and tool-call-only assistant turns are never citeable.
  const seqs = hits.map((hit) => hit.seq).sort()
  assert.deepEqual(seqs, [3, 4])
})

await check('an empty query lists the newest indexed messages', async () => {
  const index = new MessageIndex(fakeSessionQuery())
  await index.scanAll()
  const hits = await index.search({ query: '   ', excludeSessionId: 's-live', limit: 5 })
  assert.equal(hits.length, 2)
  assert.equal(hits[0].seq, 4)
})

await check('readCitedMessage prefers the current surface', async () => {
  const message = await readCitedMessage(fakeSessionQuery(), { sessionId: 's-target', seq: 3 })
  assert.equal(message.text, '三体问题的结论是什么？')
  assert.equal(message.role, 'user')
  assert.equal(message.title, '标题-s-target')
  assert.equal(message.replaced, false)
})

await check('boundQuoteText keeps head and tail inside the budget', () => {
  const text = '甲'.repeat(5000)
  const bounded = boundQuoteText(text, 1000)
  assert.ok(Buffer.byteLength(bounded.text, 'utf8') <= 1000, 'bounded text exceeds budget')
  assert.ok(bounded.omittedBytes > 0)
  assert.ok(bounded.text.includes('省略'))
})

await check('singleLine collapses whitespace', () => {
  assert.equal(singleLine('a\n\n b\tc ', 40), 'a b c')
})

// ---------------------------------------------------------------- pre-step context

function userMessage(text) {
  return { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

function fakeCtx(sessionQuery) {
  const listeners = new Map()
  return {
    sessionQuery,
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    off(event) {
      listeners.delete(event)
    },
    get() {
      return undefined
    },
    listeners,
  }
}

function stepMessages(ctx, messages) {
  const dispose = registerMessageCiteContext(ctx)
  const handler = ctx.listeners.get('agent/pre-step')
  return { dispose, run: () => handler({ agent: {}, signal: undefined }, async () => ({ kind: 'continue', messages })) }
}

await check('pre-step appends one untrusted context message after the citing message', async () => {
  const ctx = fakeCtx(fakeSessionQuery())
  const mention = formatMessageReferenceMention({ sessionId: 's-target', seq: 3, label: '标题-目标 · 三体问题' })
  const { run, dispose } = stepMessages(ctx, [userMessage(`帮我看看 ${mention}`)])
  const decision = await run()

  assert.equal(decision.kind, 'continue')
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].role, 'user')
  assert.equal(decision.messages[0].content[0].text, '帮我看看 @标题-目标 · 三体问题')
  assert.equal(decision.messages[1].source.kind, 'message-citation')
  const payload = decision.messages[1].content[0].text
  assert.match(payload, /不可信/)
  assert.match(payload, /三体问题的结论是什么？/)
  assert.match(payload, /<quoted-messages>/)

  const json = JSON.parse(payload.split('<quoted-messages>')[1].split('</quoted-messages>')[0])
  assert.equal(json.quotes.length, 1)
  assert.equal(json.quotes[0].seq, 3)
  assert.equal(json.quotes[0].role, 'user')
  dispose()
  assert.equal(ctx.listeners.size, 0)
})

await check('pre-step leaves unrelated messages untouched', async () => {
  const ctx = fakeCtx(fakeSessionQuery())
  const messages = [userMessage('普通消息')]
  const { run } = stepMessages(ctx, messages)
  const decision = await run()
  assert.equal(decision.messages, messages)
})

await check('pre-step records an unreadable citation without failing the turn', async () => {
  const ctx = fakeCtx(
    fakeSessionQuery({
      async readSurface() {
        throw new Error('会话已被删除')
      },
    }),
  )
  const mention = formatMessageReferenceMention({ sessionId: 's-gone', seq: 9, label: '没了' })
  const { run } = stepMessages(ctx, [userMessage(mention)])
  const decision = await run()
  assert.equal(decision.messages.length, 2)
  assert.match(decision.messages[1].content[0].text, /unavailable/)
  assert.match(decision.messages[1].content[0].text, /会话已被删除/)
})

// ---------------------------------------------------------------- client bundle

function loadClient() {
  let registered = null
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    window: {
      __ModuleLoader__: {
        load(definition) {
          registered = definition
        },
      },
    },
  }
  sandbox.globalThis = sandbox
  return { sandbox, get: () => registered }
}

await check('client bundle registers an @ source, a rule, and a chip renderer', async () => {
  const source = await readFile(join(root, 'client.js'), 'utf8')
  const { sandbox, get } = loadClient()
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  const definition = get()
  assert.equal(definition.id, 'dsh-message-cite')

  const h = (type, props, ...children) => ({ type, props, children })
  const requireStub = (id) => {
    if (id === 'react') return { createElement: h }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { ReferenceChip: () => null }
    throw new Error(`unexpected require ${id}`)
  }
  const exports = definition.factory(requireStub)
  assert.equal([...exports.inject].join(','), 'inputTriggers,locale,slots,uiConversation')

  const registeredSources = []
  const rules = []
  let slotRegistration = null
  sandbox.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(url, '/dsh-message-cite/api/search')
    assert.equal(body.sessionId, 'me')
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          items: [
            {
              sessionId: 's-target',
              seq: 3,
              role: 'user',
              time: 1,
              title: '标题',
              snippet: '片段',
              label: '标题 · 片段',
              mention: '@[标题 · 片段](dsh-message:abc)',
            },
          ],
        }
      },
    }
  }

  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (_name, register) => register(),
      register: (options, component) => {
        slotRegistration = { options, component }
        return () => {}
      },
    },
    get(name) {
      if (name === 'inputTriggers') return { registerSource: (value) => (registeredSources.push(value), () => {}) }
      if (name === 'uiConversation') return { userText: { register: (rule) => (rules.push(rule), () => {}) } }
      return undefined
    },
    effect: (body) => body(),
  }

  exports.apply(ctx)
  assert.equal(rules.length, 1)
  assert.equal(rules[0].id, 'message-citation')
  assert.equal(slotRegistration.options.key, 'message-citation')
  assert.equal(registeredSources.length, 1)

  const sourceDefinition = registeredSources[0]
  assert.equal(sourceDefinition.trigger, '@')
  assert.equal(sourceDefinition.name, 'message-citation')

  const rows = await sourceDefinition.candidates({ sessionId: 'me' }, { query: '片段', quoted: false })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, '标题')
  assert.match(rows[0].description, /roleUser · 片段/)
  assert.equal(rows[0].icon, 'session')
  assert.equal(rows[0].section, 'section')

  const picked = sourceDefinition.onPick({ candidate: rows[0] })
  assert.equal(
    JSON.stringify(picked),
    JSON.stringify({
      insert: {
        source: 'message-citation',
        ref: '@[标题 · 片段](dsh-message:abc)',
        label: '标题 · 片段',
        appearance: 'session',
        clipboardText: '@[标题 · 片段](dsh-message:abc)',
      },
    }),
  )
  assert.equal(await sourceDefinition.codec.serialize(picked.insert.ref), picked.insert.ref)

  const parsed = rules[0].match('看 @[标题 · 片段](dsh-message:abc) 结尾', 0)
  assert.equal(
    JSON.stringify(parsed),
    JSON.stringify({ id: 'message-citation', start: 2, end: 29, data: { label: '标题 · 片段' } }),
  )
})

await check('client source passes quoted multi-word queries and drops failures', async () => {
  const source = await readFile(join(root, 'client.js'), 'utf8')
  const { sandbox, get } = loadClient()
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const exports = get().factory((id) => {
    if (id === 'react') return { createElement: () => null }
    return {}
  })
  const registeredSources = []
  exports.apply({
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: (_name, register) => register(), register: () => () => {} },
    get: (name) =>
      name === 'inputTriggers'
        ? { registerSource: (value) => (registeredSources.push(value), () => {}) }
        : { userText: { register: () => () => {} } },
    effect: (body) => body(),
  })

  const seen = []
  sandbox.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body).query)
    return { ok: true, async json() { return { ok: true, items: [] } } }
  }
  await registeredSources[0].candidates({ sessionId: 'me' }, { query: '多个 关键词', quoted: true })
  assert.equal(seen[0], '多个 关键词')

  sandbox.fetch = async () => {
    throw new Error('offline')
  }
  assert.equal((await registeredSources[0].candidates({ sessionId: 'me' }, { query: 'x', quoted: false })).length, 0)
})

// ---------------------------------------------------------------- model tool

const TOOL_SESSIONS = [
  { header: { id: 's-w1', cwd: 'W', createdAt: 4 }, live: false },
  { header: { id: 's-w2', cwd: 'W', createdAt: 3 }, live: false },
  { header: { id: 's-x', cwd: 'X', createdAt: 2 }, live: false },
  { header: { id: 's-caller', cwd: 'W', createdAt: 5 }, live: false },
]

function fakeToolSessionQuery() {
  return {
    async listSessions() {
      return TOOL_SESSIONS
    },
    async readSurface(id) {
      const cwd = TOOL_SESSIONS.find((record) => record.header.id === id)?.header.cwd
      return {
        session: { id, cwd },
        events: [
          {
            seq: 1,
            time: 100,
            type: 'user/message',
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: `开场白 ${id}` }] },
          },
          {
            seq: 2,
            time: 200,
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: `结论 ${id}：三体文明的黑暗森林` }] } },
          },
          {
            seq: 3,
            time: 300,
            type: 'user/message',
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: '补充一句' }] },
          },
        ],
      }
    },
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) => ({ sessionId, value: { title: `标题-${sessionId}` } }))
    },
    async readEvent({ sessionId, seq }) {
      return {
        session: { id: sessionId, cwd: 'W' },
        target: { seq },
        startSeq: Math.max(0, seq - 1),
        endSeq: seq + 1,
        events: [
          {
            seq: Math.max(0, seq - 1),
            time: 900,
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: '前一条' }] } },
          },
          {
            seq,
            time: 1000,
            type: 'user/message',
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: '目标消息原文' }] },
          },
          {
            seq: seq + 1,
            time: 1100,
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: '后一条' }] } },
          },
        ],
      }
    },
  }
}

function toolFixture() {
  const sessionQuery = fakeToolSessionQuery()
  const index = new MessageIndex(sessionQuery)
  const ctx = {
    sessionQuery,
    get(name) {
      if (name === 'workingDirectory') return { get: () => 'W' }
      return undefined
    },
  }
  const tool = createConversationTool(ctx, index)
  const exec = { agent: { id: 's-caller', session: { id: 's-caller', header: { cwd: 'W' } } } }
  return { tool, exec, index }
}

await check('tool list shows only this workspace and never the caller', async () => {
  const { tool, exec } = toolFixture()
  const result = await tool.execute({ action: 'list' }, exec)
  assert.match(result.summary, /s-w1/)
  assert.match(result.summary, /s-w2/)
  assert.doesNotMatch(result.summary, /s-x/)
  assert.doesNotMatch(result.summary, /s-caller/)
})

await check('tool search is scoped to the workspace and reports the seq to read', async () => {
  const { tool, exec } = toolFixture()
  const result = await tool.execute({ action: 'search', query: '三体' }, exec)
  assert.match(result.summary, /session=s-w1/)
  assert.match(result.summary, /seq=2/)
  assert.match(result.summary, /已索引/)
  assert.doesNotMatch(result.summary, /s-x/)
})

await check('tool read returns the message with its neighbours', async () => {
  const { tool, exec } = toolFixture()
  const result = await tool.execute({ action: 'read', session: 's-w1', seq: 2, before: 1, after: 1 }, exec)
  assert.match(result.summary, /结论 s-w1：三体文明的黑暗森林/)
  assert.match(result.summary, /→ 【助手】#2/)
  assert.match(result.summary, /开场白 s-w1/)
  assert.match(result.summary, /补充一句/)
})

await check('tool read accepts a unique session-id prefix and rejects an ambiguous one', async () => {
  const { tool, exec } = toolFixture()
  const result = await tool.execute({ action: 'read', session: 's-w1', seq: 2 }, exec)
  assert.match(result.summary, /session=s-w1/)
  await assert.rejects(() => tool.execute({ action: 'read', session: 's-w', seq: 2 }, exec), /匹配到 2 个会话/)
})

await check('tool search prints the full session id so read can reuse it', async () => {
  const { tool, exec } = toolFixture()
  const result = await tool.execute({ action: 'search', query: '三体' }, exec)
  assert.match(result.summary, /session=s-w1\b/)
  assert.match(result.summary, /seq=2\b/)
  assert.doesNotMatch(result.summary, /s-w1…/)
})

await check('tool read refuses another workspace and the caller itself', async () => {
  const { tool, exec } = toolFixture()
  await assert.rejects(() => tool.execute({ action: 'read', session: 's-x', seq: 1 }, exec), /不属于当前工作区/)
  await assert.rejects(() => tool.execute({ action: 'read', session: 's-caller', seq: 1 }, exec), /当前对话本身/)
  await assert.rejects(() => tool.execute({ action: 'read', session: 's-missing', seq: 1 }, exec), /找不到会话/)
})

await check('tool rejects a missing query and an unknown action', async () => {
  const { tool, exec } = toolFixture()
  await assert.rejects(() => tool.execute({ action: 'search' }, exec), /需要 "query"/)
  await assert.rejects(() => tool.execute({ action: 'nope' }, exec), /unknown action/)
})

console.log(`\n${checks} checks passed`)
