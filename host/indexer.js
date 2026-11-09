// dsh-message-cite: the in-process message index behind the `@` menu.
//
// This deployment composes `session-query-sqlite` with `openAt: "never"`, so
// ranked full-text search is unavailable and `searchEvents` cannot be used.
// The index therefore reads each session once through the backend-independent
// exact reads (`filterEvents`), keeps only conversational text, and answers
// every keystroke from memory. Scanning is incremental and bounded so the menu
// never waits on a cold session.

import { projectEventText } from './search.js'

const DEFAULT_MAX_SESSIONS = 48
const DEFAULT_MAX_MESSAGES = 300
const DEFAULT_MAX_TEXT_CHARS = 2048
const SESSION_LIST_TTL_MS = 30_000
const LIVE_REFRESH_MS = 15_000

/**
 * Message search over a bounded, incrementally built in-memory index.
 */
export class MessageIndex {
  /**
   * @param {object} sessionQuery - trusted session-query service.
   * @param {{maxSessions?: number, maxMessages?: number, maxTextChars?: number}} [options] - index bounds.
   */
  constructor(sessionQuery, options = {}) {
    this.sessionQuery = sessionQuery
    this.maxSessions = positiveInteger(options.maxSessions, DEFAULT_MAX_SESSIONS)
    this.maxMessages = positiveInteger(options.maxMessages, DEFAULT_MAX_MESSAGES)
    this.maxTextChars = positiveInteger(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS)
    /** @type {Map<string, {createdAt: number, live: boolean, scannedAt: number, messages: Array<object>, error?: string}>} */
    this.entries = new Map()
    this.targetList = null
    this.targetsAt = 0
    this.scanning = false
    this.scanned = 0
  }

  /** Number of indexed sessions. */
  get size() {
    return this.entries.size
  }

  /**
   * List the sessions this index will hold, newest first.
   * @param {boolean} [force] - bypass the short listing cache.
   * @returns {Promise<Array<object>>} session records.
   */
  async targets(force = false) {
    const now = Date.now()
    if (!force && this.targetList !== null && now - this.targetsAt < SESSION_LIST_TTL_MS) return this.targetList
    const records = await this.sessionQuery.listSessions()
    // Child (subagent) sessions carry delegated work, not a conversation worth
    // citing from the composer; the requested parent is the citable one.
    this.targetList = (records ?? [])
      .filter((record) => record?.header?.id !== undefined && record.header.parentSession === undefined)
      .slice(0, this.maxSessions)
    this.targetsAt = now
    return this.targetList
  }

  /**
   * Read one session into the index.
   * @param {object} record - session-query session record.
   * @returns {Promise<number>} number of indexed messages.
   */
  async scanSession(record) {
    const sessionId = record.header.id
    let surface
    let error
    try {
      surface = await this.sessionQuery.readSurface(sessionId)
    } catch (failure) {
      surface = undefined
      error = failure instanceof Error ? failure.message : String(failure)
    }
    const messages = []
    for (const event of surface?.events ?? []) {
      // Only real user/assistant text: tool calls, reasoning, injected context
      // and developer messages are never citeable, and a citation must resolve
      // to exactly the text the menu promised.
      const projected = projectEventText(event)
      if (projected === undefined) continue
      const text = projected.text.slice(0, this.maxTextChars)
      if (text === '') continue
      messages.push({
        seq: event.seq,
        role: projected.role,
        time: event.time,
        text,
      })
    }
    const retained = messages.slice(-this.maxMessages)
    const firstUser = retained.find((message) => message.role === 'user')
    this.entries.set(sessionId, {
      createdAt: record.header.createdAt ?? 0,
      live: record.live === true,
      scannedAt: Date.now(),
      messages: retained,
      // Cold sessions sometimes have no folded title; their opening prompt is a
      // far better menu label than "untitled".
      firstUserText: firstUser === undefined ? '' : singleLineOf(firstUser.text, 40),
      ...(error === undefined ? {} : { error }),
    })
    this.scanned += 1
    return messages.length
  }

  /**
   * Scan at most `count` unindexed sessions, yielding between them.
   * @param {{count?: number, budgetMs?: number, signal?: AbortSignal}} [options] - scan bounds.
   * @returns {Promise<number>} sessions scanned.
   */
  async scanSome(options = {}) {
    const count = positiveInteger(options.count, 2)
    const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : 900
    const startedAt = Date.now()
    let scanned = 0
    let targets
    try {
      targets = await this.targets()
    } catch {
      return 0
    }
    for (const record of targets) {
      if (options.signal?.aborted === true) break
      if (scanned >= count || Date.now() - startedAt > budgetMs) break
      if (this.entries.has(record.header.id)) continue
      await this.scanSession(record)
      scanned += 1
      await yieldToEventLoop()
    }
    return scanned
  }

  /**
   * Scan every target session in the background.
   * @param {{signal?: AbortSignal, onProgress?: (done: number, total: number) => void}} [options] - scan controls.
   * @returns {Promise<{scanned: number, total: number, elapsedMs: number}>} summary.
   */
  async scanAll(options = {}) {
    if (this.scanning) return { scanned: 0, total: 0, elapsedMs: 0, skipped: true }
    this.scanning = true
    const startedAt = Date.now()
    let scanned = 0
    try {
      const targets = await this.targets(true)
      for (const record of targets) {
        if (options.signal?.aborted === true) break
        if (this.entries.has(record.header.id)) continue
        await this.scanSession(record)
        scanned += 1
        options.onProgress?.(scanned, targets.length)
        await yieldToEventLoop()
      }
      return { scanned, total: targets.length, elapsedMs: Date.now() - startedAt }
    } finally {
      this.scanning = false
    }
  }

  /**
   * Search indexed messages.
   * @param {{query: string, excludeSessionId?: string, limit?: number}} request - search request.
   * @returns {Promise<Array<object>>} ranked hits.
   */
  async search(request) {
    const query = String(request.query ?? '').trim()
    if (query === '') return this.recent(request)
    const limit = clampLimit(request.limit)

    await this.refreshLive(request.excludeSessionId)

    const tokens = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    const needle = query.toLocaleLowerCase()
    const rows = []
    for (const [sessionId, entry] of this.entries) {
      if (sessionId === request.excludeSessionId) continue
      for (const message of entry.messages) {
        const haystack = message.text.toLocaleLowerCase()
        let score = 0
        let matchedAll = true
        for (const token of tokens) {
          if (haystack.includes(token)) score += 2
          else {
            matchedAll = false
            break
          }
        }
        if (!matchedAll) continue
        if (haystack.includes(needle)) score += 3
        if (message.role === 'user') score += 1
        rows.push({
          sessionId,
          seq: message.seq,
          type: message.role === 'user' ? 'user/message' : 'assistant/message',
          role: message.role,
          time: message.time,
          snippet: snippetAround(message.text, query, 150),
          score,
        })
      }
    }
    rows.sort((a, b) => b.score - a.score || (b.time ?? 0) - (a.time ?? 0))
    return this.decorate(rows, limit)
  }

  /**
   * Newest messages across indexed sessions.
   * @param {{excludeSessionId?: string, limit?: number}} request - request.
   * @returns {Promise<Array<object>>} newest hits first.
   */
  async recent(request) {
    const limit = clampLimit(request.limit)
    await this.refreshLive(request.excludeSessionId)
    const rows = []
    for (const [sessionId, entry] of this.entries) {
      if (sessionId === request.excludeSessionId) continue
      for (const message of entry.messages.slice(-4)) {
        rows.push({
          sessionId,
          seq: message.seq,
          type: message.role === 'user' ? 'user/message' : 'assistant/message',
          role: message.role,
          time: message.time,
          snippet: singleLineOf(message.text, 150),
          score: 0,
        })
      }
    }
    rows.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    return this.decorate(rows, limit)
  }

  /**
   * Cap rows per session, bound the list, and attach session titles.
   * @param {Array<object>} rows - ranked rows.
   * @param {number} limit - maximum rows.
   * @returns {Promise<Array<object>>} rows with `title`.
   */
  async decorate(rows, limit) {
    const retained = []
    const perSession = new Map()
    for (const row of rows) {
      if (retained.length >= limit) break
      const count = perSession.get(row.sessionId) ?? 0
      // One conversation usually matches many times; a menu should span
      // conversations, not repeat the same one.
      if (count >= 2) continue
      perSession.set(row.sessionId, count + 1)
      retained.push(row)
    }
    const titles = await this.titles(retained.map((row) => row.sessionId))
    return retained.map((row) => ({
      ...row,
      title: titles.get(row.sessionId) || this.entries.get(row.sessionId)?.firstUserText || '',
    }))
  }

  /** Re-read attached sessions whose index entry is older than the refresh window. */
  async refreshLive(excludeSessionId) {
    const now = Date.now()
    for (const [sessionId, entry] of this.entries) {
      if (!entry.live || sessionId === excludeSessionId) continue
      if (now - entry.scannedAt < LIVE_REFRESH_MS) continue
      const record = this.targetList?.find((item) => item.header.id === sessionId)
      if (record === undefined) continue
      await this.scanSession(record)
    }
  }

  async titles(sessionIds) {
    const unique = [...new Set(sessionIds)]
    if (unique.length === 0) return new Map()
    let results
    try {
      results = await this.sessionQuery.readTitleSnapshots(unique)
    } catch {
      return new Map()
    }
    const titles = new Map()
    for (const entry of results ?? []) {
      const title = entry?.value?.title
      if (typeof title === 'string' && title !== '') titles.set(entry.sessionId, title)
    }
    return titles
  }
}

/** Keep a preview window around the first matched token. */
function snippetAround(text, query, max) {
  const flat = String(text).replace(/\s+/gu, ' ').trim()
  const characters = Array.from(flat)
  if (characters.length <= max) return flat
  const lower = flat.toLocaleLowerCase()
  const token = query.toLocaleLowerCase().split(/\s+/u).find((value) => value !== '') ?? ''
  const index = token === '' ? -1 : lower.indexOf(token)
  const matchIndex = index < 0 ? 0 : Array.from(flat.slice(0, index)).length
  const start = Math.max(0, Math.min(matchIndex - Math.floor(max / 3), characters.length - max))
  const prefix = start > 0 ? '…' : ''
  const suffix = start + max < characters.length ? '…' : ''
  return `${prefix}${characters.slice(start, start + max).join('')}${suffix}`
}

function singleLineOf(text, max) {
  const flat = String(text).replace(/\s+/gu, ' ').trim()
  const characters = Array.from(flat)
  return characters.length <= max ? flat : `${characters.slice(0, max - 1).join('')}…`
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function clampLimit(value) {
  return Math.min(positiveInteger(value, 8), 12)
}

/** Yield to the event loop so one long scan cannot stall the Host. */
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}
