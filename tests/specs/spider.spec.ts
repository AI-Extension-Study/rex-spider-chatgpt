// @ts-nocheck

// The spider as the extension loads it, in a real service worker: the module
// registers one ChatGPT spider with rex-spider, the spider's flags follow
// every configuration update both ways, and the keys the spider writes sit
// under rex-spider's namespace for it. A crawl against a mocked chatgpt.com
// is a later spec.
import { test, expect } from './fixtures'

test('the module registers one ChatGPT spider with rex-spider', async ({ serviceWorker }) => {
  const seen = await serviceWorker.evaluate(() => {
    const spider = self.rexChatGPTPlugin
    return {
      identifier: spider.identifier(),
      name: spider.name(),
      registered: self.rexSpiderPlugin.registeredSpiders.includes(spider),
      chatgpt: self.rexSpiderPlugin.registeredSpiders.filter((each) => each.identifier() === 'chatgpt').length,
      flags: [typeof spider.summarizes, typeof spider.haltsOnError],
    }
  })
  expect(seen).toEqual({ identifier: 'chatgpt', name: 'ChatGPT', registered: true, chatgpt: 1, flags: ['boolean', 'boolean'] })
})

test('summarize and halt_on_error take effect both ways on every configuration update', async ({ serviceWorker }) => {
  const seen = await serviceWorker.evaluate(() => {
    const spider = self.rexChatGPTPlugin
    const summarizes = []
    for (const configuration of [{ summarize: true }, { summarize: false }, {}]) {
      spider.updateConfiguration(configuration)
      summarizes.push(spider.justSummarize())
    }
    const continues = []
    for (const configuration of [{ halt_on_error: false }, {}]) {
      spider.updateConfiguration(configuration)
      continues.push(spider.continueAfterError())
    }
    return { summarizes, continues }
  })
  expect(seen).toEqual({ summarizes: [true, false, false], continues: [true, false] })
})

test('the same holds through rex-spider\'s own refresh, which merges the default block under the spider\'s', async ({ serviceWorker }) => {
  const seen = await serviceWorker.evaluate(() => {
    const spider = self.rexChatGPTPlugin
    const refresh = (chatgpt) => self.rexSpiderPlugin.updateConfiguration({ spiders: { default: { enabled: true, halt_on_error: false }, chatgpt } })
    const states = []
    for (const chatgpt of [{ enabled: true, summarize: true }, { enabled: true, summarize: false }, { enabled: true }, { enabled: true, halt_on_error: true }]) {
      refresh(chatgpt)
      states.push([spider.justSummarize(), spider.continueAfterError()])
    }
    return states
  })
  expect(seen).toEqual([[true, true], [false, true], [false, true], [false, false]])
})

test('the keys the spider writes sit under the namespace rex-spider gives its identifier', async ({ serviceWorker }) => {
  const seen = await serviceWorker.evaluate(() => ({ prefix: self.rexChatGPTKeyPrefix, identifier: self.rexChatGPTPlugin.identifier() }))
  expect(seen.prefix).toEqual(`rex-spider-${seen.identifier}-`)
})

test('a served enabled false and crawl_delay reach the spider, directly and through rex-spider\'s refresh', async ({ serviceWorker }) => {
  const seen = await serviceWorker.evaluate(() => {
    const spider = self.rexChatGPTPlugin
    const states = []
    spider.updateConfiguration({ enabled: true, crawl_delay: 1234 })
    states.push([spider.isEnabled(), spider.fetchCrawlDelay()])
    spider.updateConfiguration({ enabled: false })
    states.push([spider.isEnabled(), spider.fetchCrawlDelay()])
    self.rexSpiderPlugin.updateConfiguration({ spiders: { chatgpt: { enabled: true, crawl_delay: 4321 } } })
    states.push([spider.isEnabled(), spider.fetchCrawlDelay()])
    self.rexSpiderPlugin.updateConfiguration({ spiders: { chatgpt: { enabled: false } } })
    states.push([spider.isEnabled(), spider.fetchCrawlDelay()])
    return states
  })
  expect(seen).toEqual([[true, 1234], [false, 1234], [true, 4321], [false, 4321]])
})

// rex-core answers store messages only once its database is open; a pass
// started before then would end on its storage deadlines.
async function untilStoreOpen(serviceWorker) {
  await expect.poll(() => serviceWorker.evaluate(() => new Promise((resolve) => {
    try {
      const handled = self.rexCorePlugin.handleMessage({ messageType: 'fetchValue', key: 'rex-spider-chatgpt-probe' }, null, () => resolve(true))
      if (!handled) resolve(false)
    } catch {
      resolve(false)
    }
  })), { timeout: 15000 }).toBe(true)
}

// chatgpt.com for one pass, answered inside the worker: fetch is replaced for
// that host only, and so is the keep-alive read, so one log holds both in the
// order the worker made them. Each request is written down by what it asked
// for. The chat and its title are made up, and its text carries MARKER.
const CHAT = '6911f0a5-2222-8000-8000-0000000000aa'
const TITLE = 'MARKER title of the chat'
const T0 = 1794319205

async function onePass(serviceWorker, served) {
  await untilStoreOpen(serviceWorker)
  return serviceWorker.evaluate(async ({ chat, title, t0, served }) => {
    const message = (id, role, seconds, text, extra = {}) => ({
      id, author: { role, name: null, metadata: {} }, create_time: seconds, update_time: null, content: { content_type: 'text', parts: [text] },
      status: 'finished_successfully', end_turn: role === 'assistant' ? true : null, weight: 1, recipient: 'all', channel: role === 'assistant' ? 'final' : null, ...extra,
    })
    const detail = {
      title, create_time: t0, update_time: t0 + 2, conversation_id: chat, current_node: 'node-2', default_model_slug: 'gpt-5', is_archived: false, is_starred: null,
      pinned_time: null, is_temporary_chat: false, is_do_not_remember: false, memory_scope: 'global_enabled', is_study_mode: false, gizmo_id: null, gizmo_type: null,
      conversation_template_id: null,
      mapping: {
        'client-created-root': { id: 'client-created-root', message: null, parent: null, children: ['node-1'] },
        'node-1': { id: 'node-1', parent: 'client-created-root', children: ['node-2'], message: message('node-1', 'user', t0 + 1, 'MARKER prompt', { metadata: {} }) },
        'node-2': { id: 'node-2', parent: 'node-1', children: [], message: message('node-2', 'assistant', t0 + 2, 'MARKER answer', { metadata: { citations: [], content_references: [], search_result_groups: [], model_slug: 'gpt-5' } }) },
      },
    }
    const listed = { id: chat, title, create_time: '2026-11-10T14:00:05.000123Z', update_time: '2026-11-10T14:00:07.000123Z', is_archived: false, is_starred: null }
    const log = []
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    const realFetch = self.fetch
    self.fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.host !== 'chatgpt.com') return realFetch(input, init)
      if (url.pathname === '/') {
        log.push('GET home')
        return new Response('<html>\n<script>{"accessToken":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzcGVjIn0.c3BlYw"}</script>\n</html>', { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url.pathname === '/backend-api/conversations') {
        const list = url.searchParams.get('is_archived') === 'true' ? 'archived' : url.searchParams.get('is_starred') === 'true' ? 'starred' : 'main'
        log.push(`GET ${list} ${url.searchParams.get('offset')}`)
        return json({ items: list === 'main' && url.searchParams.get('offset') === '0' ? [listed] : [] })
      }
      if (url.pathname.endsWith('/sidebar')) {
        log.push('GET sidebar')
        return json({ items: [], cursor: null })
      }
      log.push(`GET ${url.pathname}`)
      return url.pathname === `/backend-api/conversation/${chat}` ? json(detail) : new Response('', { status: 404 })
    }
    const local = chrome.storage.local
    const realGet = local.get
    local.get = function (keys, ...rest) {
      if (keys === 'rex-spider-chatgpt-keep-alive') log.push('keep-alive')
      return realGet.call(this, keys, ...rest)
    }
    try {
      self.rexChatGPTPlugin.updateConfiguration({ enabled: true, crawl_delay: 10, ...served })
      await self.rexChatGPTPlugin.doBackgroundCrawl()
    } finally {
      self.fetch = realFetch
      local.get = realGet
    }
    const events = self.eventRecorder.events
    return {
      log,
      records: events.filter((event) => event.name === 'rex-conversation'),
      completions: events.filter((event) => event.event_name === 'rex-spider-chatgpt-complete').map((event) => event.event_details),
    }
  }, { chat: CHAT, title: TITLE, t0: T0, served })
}

// SHA-256 of TITLE in hex.
const TITLE_HASH = 'e9132382394b9cf16c5a932edf7227fe44d1d42639d3a41a63f1c91d293040fe'

test('a crawl is one pass: paced waits with a keep-alive call, rex-core\'s SHA-256, and whole records for rex-core\'s modules', async ({ serviceWorker }) => {
  const { log, records, completions } = await onePass(serviceWorker, { summarize: false })
  const requests = log.filter((entry) => entry.startsWith('GET'))
  expect(requests).toEqual(['GET home', 'GET main 0', 'GET main 28', 'GET archived 0', 'GET starred 0', 'GET sidebar', `GET /backend-api/conversation/${CHAT}`])
  // Between two list requests: the paced wait's keep-alive call and the request's own.
  for (const [from, to] of [['GET main 0', 'GET main 28'], ['GET main 28', 'GET archived 0'], ['GET starred 0', 'GET sidebar']]) {
    expect(log.slice(log.indexOf(from) + 1, log.indexOf(to))).toEqual(['keep-alive', 'keep-alive'])
  }
  expect(records).toHaveLength(1)
  const [record] = records
  expect(JSON.stringify(record)).not.toContain('MARKER')
  expect(Object.keys(record).sort()).toEqual(['date', 'ended', 'format_version', 'identifier', 'is_summary', 'metadata', 'name', 'platform', 'started', 'turns', 'turns_complete', 'user_agent'])
  expect(record).toMatchObject({ name: 'rex-conversation', platform: 'chatgpt', identifier: CHAT, format_version: 1, is_summary: false, turns_complete: true, user_agent: 'Browser' })
  expect(record.turns.map((turn) => turn.speaker)).toEqual(['user', 'assistant'])
  expect(record.metadata.title_hash).toEqual(TITLE_HASH)
  expect(Object.keys(record.metadata.mapping).sort()).toEqual(['client-created-root', 'node-1', 'node-2'])
  expect(completions.at(-1)).toMatchObject({ crawled_count: 1, crawled_ids: [CHAT] })
  expect(completions.at(-1).reason).toMatch(/^ok seen=1 dispatched=1 ms=\d+$/)
})

test('a crawl started while a pass runs starts no second pass, and the spider says it is crawling from the first moment', async ({ serviceWorker }) => {
  await untilStoreOpen(serviceWorker)
  const seen = await serviceWorker.evaluate(async () => {
    let homes = 0
    const realFetch = self.fetch
    self.fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.host !== 'chatgpt.com') return realFetch(input, init)
      if (url.pathname === '/') {
        homes += 1
        return new Response('<html>\n{"accessToken":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0d28ifQ.dHdv"}\n</html>', { status: 200 })
      }
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    try {
      const spider = self.rexChatGPTPlugin
      spider.updateConfiguration({ enabled: true, crawl_delay: 10, summarize: true })
      const first = spider.doBackgroundCrawl()
      const crawling = spider.isCrawling()
      const second = spider.doBackgroundCrawl()
      await Promise.all([first, second])
      const during = homes
      await spider.doBackgroundCrawl()
      return { crawling, during, after: homes }
    } finally {
      self.fetch = realFetch
    }
  })
  expect(seen).toEqual({ crawling: true, during: 1, after: 2 })
})
