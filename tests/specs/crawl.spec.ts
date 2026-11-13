// @ts-nocheck

// The spider in a real MV3 service worker: rex-core, rex-spider and this
// module bundled as the extension bundles them (tests/src/service-worker.ts),
// chatgpt.com answered by a route on the browser context (chatgpt-site.ts),
// every config served through rex-core and rex-spider's refresh, and each
// crawl started by the message the extension's alarm sends. Records are read
// back from a module registered with rex-core, as the data-upload module would
// get them, and the upload keys from rex-core's own store. Nothing uploads.
// Every id is made up, and every title and text carries MARK.
import crypto from 'node:crypto'

import { test, expect } from './fixtures'
import {
  MARK, ROUTE_NAME, Site, answerChatGPT, attachmentsChat, daysAgo, editedChat, mainItem, projectChat, reasoningChat, simpleDetail,
} from './chatgpt-site'
import { checkRecord } from './standard-check'

const chat = (n: number) => `6911f0a5-2222-8000-8000-${String(n).padStart(12, '0')}`
const PROJECT = 'g-p-0000000000000000000000000000aaaa'
const HOUR_MS = 60 * 60 * 1000
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex')
const uploadKey = (id: string, ms: number) => `rex-spider-chatgpt-conversation-upload-${id}-${ms}`

// rex-core answers store messages only once its database is open; a crawl
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

// A config served as the extension serves one: rex-core stores it and tells
// each module to read it again, and rex-spider merges the spider's block over
// {enabled: true} and hands it to the spider. Resolves once the spider has
// it. crawl_delay 10 keeps the list walk fast (a detail read still waits the
// 3 s settle wait), and sleep_delay -1 lets the next crawl start at once.
async function serve(serviceWorker, chatgpt = {}) {
  await serviceWorker.evaluate((block) => new Promise((resolve, reject) => {
    const spider = self.rexChatGPTPlugin
    // Shadowed on the instance until rex-spider hands the spider its block.
    spider.updateConfiguration = function (configuration) {
      delete spider.updateConfiguration
      try {
        spider.updateConfiguration(configuration)
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    self.rexCorePlugin.fetchConfiguration()
      .then((stored) => self.rexCorePlugin.updateConfiguration({ ...stored, spider: { spiders: { chatgpt: block } } }))
      .catch(reject)
  }), { enabled: true, crawl_delay: 10, sleep_delay: -1, ...chatgpt })
}

// One round of the extension's alarm, as rex-spider runs it: each registered,
// enabled spider crawls unless it is still crawling, and the answer gathers
// their issues. rex-spider clears its own crawling flag just after the round
// answers, and the next round waits for that.
async function crawl(serviceWorker) {
  const round = await serviceWorker.evaluate(() => {
    self.eventRecorder.events = []
    return new Promise((resolve) => {
      self.rexCorePlugin.handleMessage({ messageType: 'beginBackgroundCrawls' }, null, (result) => resolve({ result, events: self.eventRecorder.events }))
    })
  })
  await expect.poll(() => serviceWorker.evaluate(() => self.rexChatGPTPlugin.isCrawling())).toBe(false)
  // Nothing a round dispatches holds text from a chat, a summary sent in a
  // failed read's place included: every title and text of the site carries
  // MARK.
  expect(JSON.stringify(round.events)).not.toContain(MARK)
  return round
}

const records = (events) => events.filter((event) => event.name === 'rex-conversation')
const completions = (events) => events
  .filter((event) => event.event_name === 'rex-spider-chatgpt-complete')
  .map(({ event_details: details }) => [details.crawled_count, details.crawled_ids, details.reason])
const reason = (pattern: string) => expect.stringMatching(new RegExp(`^${pattern} ms=\\d+$`))

// The list walk of one crawl as the site writes it down: the home page, the
// main list to its first empty page, the archived and starred lists, the
// sidebar and each project it names. Every main list here holds a chat.
const listWalk = ({ archived = false, starred = false, projects = [] } = {}) => [
  'GET home', 'GET main 0', 'GET main 28',
  ...(archived ? ['GET archived 0', 'GET archived 28'] : ['GET archived 0']),
  ...(starred ? ['GET starred 0', 'GET starred 28'] : ['GET starred 0']),
  'GET sidebar', ...projects.map((id) => `GET project ${id} 0`),
]

// The upload keys in rex-core's store, read from its database.
async function uploadKeys(serviceWorker) {
  return serviceWorker.evaluate(() => new Promise((resolve, reject) => {
    const opened = indexedDB.open('rex_db')
    opened.onerror = () => reject(new Error('rex-core\'s database did not open'))
    opened.onsuccess = () => {
      const db = opened.result
      const read = db.transaction(['values'], 'readonly').objectStore('values').getAllKeys()
      read.onerror = () => {
        db.close()
        reject(new Error('the keys could not be read'))
      }
      read.onsuccess = () => {
        db.close()
        resolve(read.result.filter((key) => String(key).startsWith('rex-spider-chatgpt-conversation-upload-')).sort())
      }
    }
  }))
}

// What rex-core holds under a key, as it answers a fetchValue: null when
// nothing is stored.
async function storedValue(serviceWorker, key: string) {
  return serviceWorker.evaluate((key) => new Promise((resolve) => {
    self.rexCorePlugin.handleMessage({ messageType: 'fetchValue', key }, null, resolve)
  }), key)
}

async function storeValue(serviceWorker, key: string, value: unknown) {
  return serviceWorker.evaluate(({ key, value }) => new Promise((resolve) => {
    self.rexCorePlugin.handleMessage({ messageType: 'storeValue', key, value }, null, resolve)
  }), { key, value })
}

// The upload key rex-spider builds for an id and a list time, from its own
// fetchUploadKey (private in its types, a method at run time), the time read
// as the spider before this rewrite read it on each list path: the list's
// update_time as it is, or Date.parse(update_time) / 1000 on a project's.
async function rexSpiderKey(serviceWorker, id: string, updateTime: string, path: 'list' | 'project' = 'list') {
  return serviceWorker.evaluate(({ id, updateTime, path }) => {
    const time = new self.rexDateString(path === 'project' ? Date.parse(updateTime) / 1000 : updateTime)
    return self.rexChatGPTPlugin.fetchUploadKey(id, time)
  }, { id, updateTime, path })
}

// rex-core writes the install time once, when the extension is installed. A
// spec moves it back to stand for an install some time ago.
async function installedAt(serviceWorker, ms: number) {
  await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.storage.local.get('rexInstallTime')).rexInstallTime !== undefined)).toBe(true)
  await serviceWorker.evaluate((ms) => chrome.storage.local.set({ rexInstallTime: ms }), ms)
}

// Every request the worker made went to chatgpt.com and was answered by the
// route: the worker's own list of its requests, each with the route header
// its answer came back with (tests/src/service-worker.ts), is the route's
// list, and the catch-all for every other request (fixtures.ts) was never
// reached.
async function expectAllRouted(serviceWorker, site, unrouted) {
  const made = await serviceWorker.evaluate(() => self.workerRequests)
  expect(made.map((request) => request.url)).toEqual(site.urls)
  expect(made.filter((request) => request.routed !== ROUTE_NAME)).toEqual([])
  expect(unrouted).toEqual([])
}

test('served summarize, a crawl sends a summary per chat, newest first, keyed as rex-spider keys it on each list path, and the next crawl sends none', async ({ context, serviceWorker, unrouted }) => {
  const site = new Site()
  // The project chat's time comes out 1 ms early on the project path.
  site.main.push(mainItem(chat(1), Date.parse('2026-09-10T08:00:00.500Z')), mainItem(chat(2), Date.parse('2026-09-09T08:00:00.250Z')))
  site.projects.set(PROJECT, [projectChat(chat(3), Date.parse('2026-09-08T13:49:43.781Z'))])
  await answerChatGPT(context, site)
  await untilStoreOpen(serviceWorker)
  await serve(serviceWorker, { summarize: true })

  const first = await crawl(serviceWorker)
  expect(site.calls.splice(0)).toEqual(listWalk({ projects: [PROJECT] }))
  expect(first.result).toEqual({ sitesCrawled: ['chatgpt'], issues: [] })
  const sent = records(first.events)
  expect(sent.map((record) => [record.identifier, record.is_summary])).toEqual([[chat(1), true], [chat(2), true], [chat(3), true]])
  expect(sent.flatMap((record) => checkRecord(record, MARK))).toEqual([])
  expect(sent.map((record) => record.metadata.title_hash)).toEqual(Array(3).fill(sha256(`${MARK} list title`)))
  expect(sent.map((record) => record.metadata.gizmo_id_hash)).toEqual([null, null, sha256(`g-p-${MARK}gizmo`)])
  expect(completions(first.events)).toEqual([[3, [chat(1), chat(2), chat(3)], reason('ok seen=3 dispatched=3')]])

  // The keys as stored: the bare chat id, the list's time in ms, and on the
  // project path 1 ms early, each the key rex-spider builds for the chat.
  const keys = [
    `rex-spider-chatgpt-conversation-upload-${chat(1)}-1789027200500`,
    `rex-spider-chatgpt-conversation-upload-${chat(2)}-1788940800250`,
    `rex-spider-chatgpt-conversation-upload-${chat(3)}-1788875383780`,
  ]
  expect(await uploadKeys(serviceWorker)).toEqual([...keys].sort())
  expect([
    await rexSpiderKey(serviceWorker, chat(1), site.main[0].update_time),
    await rexSpiderKey(serviceWorker, chat(2), site.main[1].update_time),
    await rexSpiderKey(serviceWorker, chat(3), site.projects.get(PROJECT)[0].update_time, 'project'),
  ]).toEqual(keys)

  const second = await crawl(serviceWorker)
  expect(site.calls).toEqual(listWalk({ projects: [PROJECT] }))
  expect(records(second.events)).toEqual([])
  expect(completions(second.events)).toEqual([[0, [chat(1), chat(2), chat(3)], reason('ok seen=3 dispatched=0')]])
  await expectAllRouted(serviceWorker, site, unrouted)
})

// The study's configs serve summarize with the crawl window anchored at
// install: start -7776000000, 90 days before it. For an install a month ago
// the window starts 120 days back, where one anchored at the crawl would
// start 90 days back.
test('served the study\'s window anchored at install, a summary crawl sends the chats last used since 90 days before the install, and no older one', async ({ context, serviceWorker, unrouted }) => {
  const now = Date.now()
  const site = new Site()
  site.main.push(mainItem(chat(1), now - HOUR_MS), mainItem(chat(2), daysAgo(100, now)), mainItem(chat(3), daysAgo(125, now)))
  await answerChatGPT(context, site)
  await untilStoreOpen(serviceWorker)
  await installedAt(serviceWorker, daysAgo(30, now))
  await serve(serviceWorker, { summarize: true, time_anchor: 'install', start: -7_776_000_000 })

  const round = await crawl(serviceWorker)
  expect(site.calls).toEqual(listWalk())
  const sent = records(round.events)
  expect(sent.map((record) => [record.identifier, record.is_summary])).toEqual([[chat(1), true], [chat(2), true]])
  expect(sent.flatMap((record) => checkRecord(record, MARK))).toEqual([])
  expect(completions(round.events)).toEqual([[2, [chat(1), chat(2)], reason('ok seen=2 dispatched=2')]])
  await expectAllRouted(serviceWorker, site, unrouted)
})

// Detail reads are at least 3 s apart (the settle wait), so a spec that reads
// several gets more time.
test('served no summarize, a crawl reads each chat and sends detail records that meet the shared layout, keyed -detail at the list time, and the next crawl sends none', async ({ context, serviceWorker, unrouted }) => {
  test.setTimeout(60_000)
  const site = new Site()
  site.main.push(mainItem(chat(1), Date.parse('2026-09-10T08:00:00.500Z')), mainItem(chat(2), Date.parse('2026-09-09T08:00:00.250Z')), mainItem(chat(3), Date.parse('2026-09-08T13:49:43.781Z')))
  site.details.set(chat(1), reasoningChat(chat(1)))
  site.details.set(chat(2), editedChat(chat(2)))
  site.details.set(chat(3), attachmentsChat(chat(3)))
  await answerChatGPT(context, site)
  await untilStoreOpen(serviceWorker)
  await serve(serviceWorker)

  const first = await crawl(serviceWorker)
  expect(site.calls.splice(0)).toEqual([...listWalk(), `GET detail ${chat(1)}`, `GET detail ${chat(2)}`, `GET detail ${chat(3)}`])
  const sent = records(first.events)
  expect(sent.map((record) => [record.identifier, record.is_summary, record.turns_complete])).toEqual([[chat(1), false, true], [chat(2), false, true], [chat(3), false, true]])
  expect(sent.flatMap((record) => checkRecord(record, MARK))).toEqual([])
  // What the worker counted on each tree: the speaker, whether the turn is on
  // the current branch, characters, words, citations, search results and
  // attachments.
  const counted = (record) => record.turns.map((turn) => [turn.speaker, turn.on_current_branch, turn.text_chars, turn.text_words, turn.citation_count, turn.search_result_count, turn.attachments])
  // A reasoning reply is one turn: its two visible texts, two cited passages,
  // and the five results of its search.
  expect(counted(sent[0])).toEqual([['user', true, 20, 4, 0, 0, 0], ['assistant', true, 36, 7, 2, 5, 0]])
  // An edited first prompt: the old prompt and its reply are off the branch.
  expect(counted(sent[1]).map(([speaker, branch]) => [speaker, branch])).toEqual([['user', false], ['assistant', false], ['user', true], ['assistant', true]])
  // Two images are two attachments, and no text.
  expect(counted(sent[2])[0]).toEqual(['user', true, 20, 4, 0, 0, 2])
  expect(completions(first.events)).toEqual([[3, [chat(1), chat(2), chat(3)], reason('ok seen=3 dispatched=3')]])

  // The keys as stored: the chat id with -detail and the list's time, never
  // the record's ended, each the key rex-spider builds for it.
  const keys = [uploadKey(`${chat(1)}-detail`, 1789027200500), uploadKey(`${chat(2)}-detail`, 1788940800250), uploadKey(`${chat(3)}-detail`, 1788875383781)]
  expect(await uploadKeys(serviceWorker)).toEqual([...keys].sort())
  const built = []
  for (const item of site.main) built.push(await rexSpiderKey(serviceWorker, `${item.id}-detail`, item.update_time))
  expect(built).toEqual(keys)

  const second = await crawl(serviceWorker)
  expect(site.calls).toEqual(listWalk())
  expect(records(second.events)).toEqual([])
  expect(completions(second.events)).toEqual([[0, [chat(1), chat(2), chat(3)], reason('ok seen=3 dispatched=0')]])
  await expectAllRouted(serviceWorker, site, unrouted)
})

// The configs of a study that has ended serve enabled false. The pass reads
// the spider's flags as rex-spider last set them before each chat, so a
// refresh that lands between two detail reads stops it before the next one.
test('enabled false served through a configuration refresh between two detail reads ends the pass there, with no request after it', async ({ context, serviceWorker, unrouted }) => {
  test.setTimeout(60_000)
  const now = Date.now()
  const site = new Site()
  for (const n of [1, 2, 3]) {
    site.main.push(mainItem(chat(n), now - n * HOUR_MS))
    site.details.set(chat(n), simpleDetail(chat(n)))
  }
  // While the first detail read waits for its answer, a refresh brings a
  // config that switches the spider off.
  site.beforeDetail = async (id) => {
    if (id === chat(1)) await serve(serviceWorker, { enabled: false })
  }
  await answerChatGPT(context, site)
  await untilStoreOpen(serviceWorker)
  await serve(serviceWorker)

  const round = await crawl(serviceWorker)
  expect(site.calls).toEqual([...listWalk(), `GET detail ${chat(1)}`])
  expect(records(round.events).map((record) => [record.identifier, record.is_summary])).toEqual([[chat(1), false]])
  expect(completions(round.events)).toEqual([[1, [chat(1), chat(2), chat(3)], reason('ok seen=3 dispatched=1 left=2 stop=disabled')]])
  // The record that went out before the switch-off keeps its key.
  expect(await uploadKeys(serviceWorker)).toEqual([uploadKey(`${chat(1)}-detail`, Date.parse(site.main[0].update_time))])
  expect(await serviceWorker.evaluate(() => self.rexChatGPTPlugin.isEnabled())).toBe(false)
  await expectAllRouted(serviceWorker, site, unrouted)
})

// The switch rule: after summarize changes, the chats last used in the 90
// days before the switch go out once more in the new mode, and older ones
// keep the record they have. A chat with no key in either mode goes out in
// the served mode. The switch is dated by the first crawl in this browser
// that runs the new mode, kept in the mode record.
test('summarize served true, then false, then true: each switch re-sends, in the new mode, only the chats last used in the 90 days before it', async ({ context, serviceWorker, unrouted }) => {
  test.setTimeout(90_000)
  const now = Date.now()
  const site = new Site()
  site.main.push(mainItem(chat(1), now - HOUR_MS), mainItem(chat(2), daysAgo(100, now)))
  for (const n of [1, 2, 3, 4]) site.details.set(chat(n), simpleDetail(chat(n)))
  await answerChatGPT(context, site)
  await untilStoreOpen(serviceWorker)
  const sentIn = (round) => records(round.events).map((record) => [record.identifier, record.is_summary ? 'summary' : 'detail'])
  // The mode record after a crawl: its mode, and whether its start is that crawl's.
  const modeOf = async (from: number) => {
    const record = await storedValue(serviceWorker, 'rex-spider-chatgpt-mode')
    return [record.mode, record.since >= from && record.since <= Date.now()]
  }

  await serve(serviceWorker, { summarize: true })
  let from = Date.now()
  const first = await crawl(serviceWorker)
  expect(sentIn(first)).toEqual([[chat(1), 'summary'], [chat(2), 'summary']])
  expect(completions(first.events)).toEqual([[2, [chat(1), chat(2)], reason('ok seen=2 dispatched=2')]])
  expect(await modeOf(from)).toEqual(['summary', true])

  // Two chats that crawl never saw, used two hours and 120 days ago.
  site.main.push(mainItem(chat(3), now - 2 * HOUR_MS), mainItem(chat(4), daysAgo(120, now)))
  await serve(serviceWorker, { summarize: false })
  from = Date.now()
  site.calls.splice(0)
  const second = await crawl(serviceWorker)
  // Chat 1 goes out again in detail. Chat 2, last used 100 days before the
  // switch, keeps its summary. Chats 3 and 4 have no key, so they go out.
  expect(site.calls).toEqual([...listWalk(), `GET detail ${chat(1)}`, `GET detail ${chat(3)}`, `GET detail ${chat(4)}`])
  expect(sentIn(second)).toEqual([[chat(1), 'detail'], [chat(3), 'detail'], [chat(4), 'detail']])
  expect(completions(second.events)).toEqual([[3, [chat(1), chat(3), chat(2), chat(4)], reason('ok seen=4 dispatched=3')]])
  expect(await modeOf(from)).toEqual(['detail', true])

  await serve(serviceWorker, { summarize: true })
  from = Date.now()
  site.calls.splice(0)
  const third = await crawl(serviceWorker)
  // Back to summary: chat 3, sent only in detail two hours before the switch,
  // goes out as a summary. Chat 4, last used 120 days before it, keeps its
  // detail record, and chats 1 and 2 hold summary keys already.
  expect(site.calls).toEqual(listWalk())
  expect(sentIn(third)).toEqual([[chat(3), 'summary']])
  expect(completions(third.events)).toEqual([[1, [chat(1), chat(3), chat(2), chat(4)], reason('ok seen=4 dispatched=1')]])
  expect(await modeOf(from)).toEqual(['summary', true])

  // Each chat's keys as stored, one for each mode it went out in.
  const at = (n: number) => Date.parse(site.main.find((item) => item.id === chat(n)).update_time)
  expect(await uploadKeys(serviceWorker)).toEqual([
    uploadKey(chat(1), at(1)), uploadKey(`${chat(1)}-detail`, at(1)), uploadKey(chat(2), at(2)),
    uploadKey(chat(3), at(3)), uploadKey(`${chat(3)}-detail`, at(3)), uploadKey(`${chat(4)}-detail`, at(4)),
  ].sort())
  await expectAllRouted(serviceWorker, site, unrouted)
})

// The study's configs serve halt_on_error false. rex-spider's own flag, once
// false, never turns true again, so the spider keeps its own, and a config
// that leaves the key out brings back the default: the reads stop at the
// first that fails.
test('served halt_on_error false, a refused read sends its summary and the reads go on; served without it, they stop at the next failure', async ({ context, serviceWorker, unrouted }) => {
  test.setTimeout(60_000)
  const now = Date.now()
  const site = new Site()
  site.main.push(mainItem(chat(1), now - HOUR_MS), mainItem(chat(2), now - 2 * HOUR_MS))
  for (const n of [1, 2, 3, 4]) site.details.set(chat(n), simpleDetail(chat(n)))
  // A refusal of one chat's detail counts against that chat alone.
  const refused = { status: 403, body: JSON.stringify({ detail: 'Forbidden' }) }
  site.refusals.set(chat(1), [refused])
  site.refusals.set(chat(3), [refused])
  await answerChatGPT(context, site)
  await untilStoreOpen(serviceWorker)
  const sentIn = (round) => records(round.events).map((record) => [record.identifier, record.is_summary ? 'summary' : 'detail'])

  await serve(serviceWorker, { halt_on_error: false })
  const first = await crawl(serviceWorker)
  expect(site.calls.splice(0)).toEqual([...listWalk(), `GET detail ${chat(1)} 403`, `GET detail ${chat(2)}`])
  // The refused chat's summary goes out in its place, and a memo holds the
  // chat back for a week.
  expect(sentIn(first)).toEqual([[chat(1), 'summary'], [chat(2), 'detail']])
  expect(completions(first.events)).toEqual([[2, [chat(1), chat(2)], reason('ok seen=2 dispatched=2 failed=1')]])
  const memo = await storedValue(serviceWorker, `rex-spider-chatgpt-detail-memo-${chat(1)}`)
  expect([memo.ended, memo.retryMs, memo.failures]).toEqual([Date.parse(site.main[0].update_time), 7 * 24 * HOUR_MS, 1])

  // A new chat whose read is refused, and an older one after it.
  site.main.push(mainItem(chat(3), now - HOUR_MS / 2), mainItem(chat(4), now - 3 * HOUR_MS))
  await serve(serviceWorker)
  const second = await crawl(serviceWorker)
  expect(site.calls).toEqual([...listWalk(), `GET detail ${chat(3)} 403`])
  expect(sentIn(second)).toEqual([[chat(3), 'summary']])
  expect(completions(second.events)).toEqual([[1, [chat(3), chat(1), chat(2), chat(4)], reason('ok seen=4 dispatched=1 failed=1 left=2 stop=halt-on-error')]])
  await expectAllRouted(serviceWorker, site, unrouted)
})

// A 429 that names a wait. The pass stops, and the wait is stored in
// rex-core, so it outlives the worker: as long as the header asks, and never
// shorter than the 5 minutes the schedule starts at.
test('a 429 with Retry-After on a detail stops the pass and stores the wait; a crawl during it makes no request, and the one after it reads the chats left', async ({ context, serviceWorker, unrouted }) => {
  test.setTimeout(60_000)
  const now = Date.now()
  const site = new Site()
  for (const n of [1, 2, 3]) {
    site.main.push(mainItem(chat(n), now - n * HOUR_MS))
    site.details.set(chat(n), simpleDetail(chat(n)))
  }
  site.refusals.set(chat(2), [{ status: 429, headers: { 'retry-after': '900' }, body: JSON.stringify({ detail: 'Too many requests' }) }])
  await answerChatGPT(context, site)
  await untilStoreOpen(serviceWorker)
  await serve(serviceWorker)

  const before = Date.now()
  const first = await crawl(serviceWorker)
  const after = Date.now()
  expect(site.calls.splice(0)).toEqual([...listWalk(), `GET detail ${chat(1)}`, `GET detail ${chat(2)} 429`])
  // The refused chat gets nothing: no summary in its place and no memo.
  expect(records(first.events).map((record) => [record.identifier, record.is_summary])).toEqual([[chat(1), false]])
  expect(completions(first.events)).toEqual([[1, [chat(1), chat(2), chat(3)], reason('ok seen=3 dispatched=1 left=2 stop=rate-limited')]])
  expect(await storedValue(serviceWorker, `rex-spider-chatgpt-detail-memo-${chat(2)}`)).toBeNull()
  const backoff = await storedValue(serviceWorker, 'rex-spider-chatgpt-backoff')
  expect([backoff.code, backoff.failures]).toEqual(['rate-limited', 1])
  // 900 s from the refusal, which came between the two readings of the clock.
  expect(backoff.until).toBeGreaterThanOrEqual(before + 900_000)
  expect(backoff.until).toBeLessThanOrEqual(after + 900_000)

  const during = await crawl(serviceWorker)
  expect(site.calls).toEqual([])
  const skipped = `backoff until=${new Date(backoff.until).toISOString()} code=rate-limited`
  expect(records(during.events)).toEqual([])
  expect(completions(during.events)).toEqual([[-1, [], skipped]])
  expect(during.result).toEqual({ sitesCrawled: ['chatgpt'], issues: [{ url: 'https://chatgpt.com/', message: skipped }] })

  // The wait runs out.
  await storeValue(serviceWorker, 'rex-spider-chatgpt-backoff', { ...backoff, until: Date.now() - 1000 })
  const resumed = await crawl(serviceWorker)
  expect(site.calls).toEqual([...listWalk(), `GET detail ${chat(2)}`, `GET detail ${chat(3)}`])
  expect(records(resumed.events).map((record) => [record.identifier, record.is_summary])).toEqual([[chat(2), false], [chat(3), false]])
  expect(completions(resumed.events)).toEqual([[2, [chat(1), chat(2), chat(3)], reason('ok seen=3 dispatched=2')]])
  // A crawl that read the lists with no refusal clears it.
  expect(await storedValue(serviceWorker, 'rex-spider-chatgpt-backoff')).toBeNull()
  await expectAllRouted(serviceWorker, site, unrouted)
})

// An access token can expire during a long pass. The API then answers 401:
// the pass ends as signed out, with no back-off and no summary in place of
// the read, and the next crawl reads a new token from the home page.
test('a token that expires between two detail reads ends the pass as signed out, with no back-off, and the next crawl reads a new token and the chats left', async ({ context, serviceWorker, unrouted }) => {
  test.setTimeout(60_000)
  const now = Date.now()
  const site = new Site()
  for (const n of [1, 2, 3]) {
    site.main.push(mainItem(chat(n), now - n * HOUR_MS))
    site.details.set(chat(n), simpleDetail(chat(n)))
  }
  // The first token stops working just before the second detail read.
  site.beforeDetail = async (id) => {
    if (id === chat(2) && site.tokens.length === 1) site.expired.add(site.tokens[0])
  }
  await answerChatGPT(context, site)
  await untilStoreOpen(serviceWorker)
  await serve(serviceWorker)

  const first = await crawl(serviceWorker)
  expect(site.calls.splice(0)).toEqual([...listWalk(), `GET detail ${chat(1)}`, `GET detail ${chat(2)} 401`])
  expect(records(first.events).map((record) => [record.identifier, record.is_summary])).toEqual([[chat(1), false]])
  expect(completions(first.events)).toEqual([[1, [chat(1), chat(2), chat(3)], reason('ok seen=3 dispatched=1 left=2 stop=not-signed-in')]])
  expect(first.result.issues).toEqual([])
  expect(await storedValue(serviceWorker, 'rex-spider-chatgpt-backoff')).toBeNull()
  expect(await storedValue(serviceWorker, `rex-spider-chatgpt-detail-memo-${chat(2)}`)).toBeNull()

  // The first token no longer works, so every answer of this crawl was to
  // the second.
  const second = await crawl(serviceWorker)
  expect(site.tokens).toHaveLength(2)
  expect(site.calls).toEqual([...listWalk(), `GET detail ${chat(2)}`, `GET detail ${chat(3)}`])
  expect(records(second.events).map((record) => [record.identifier, record.is_summary])).toEqual([[chat(2), false], [chat(3), false]])
  expect(completions(second.events)).toEqual([[2, [chat(1), chat(2), chat(3)], reason('ok seen=3 dispatched=2')]])
  await expectAllRouted(serviceWorker, site, unrouted)
})

// Archived and starred chats are collected too. The spider's own list leaves
// both out, so two more lists reach them, and a chat two lists name
// (archived and starred, or starred and in a project) is one chat, taken
// from the list the spider may already have keyed it on: a project before
// the starred list.
test('archived and starred chats go out once each, a starred project chat under the project path\'s key, and the next crawl sends none', async ({ context, serviceWorker, unrouted }) => {
  const site = new Site()
  const archived = { is_archived: true }
  const starred = { is_starred: true, pinned_time: '2026-09-08T14:00:00.000000Z' }
  site.main.push(mainItem(chat(1), Date.parse('2026-09-12T09:30:00.900Z')))
  site.archived.push(mainItem(chat(2), Date.parse('2026-09-11T10:15:00.400Z'), archived), mainItem(chat(3), Date.parse('2026-09-10T11:45:00.600Z'), { ...archived, ...starred }))
  site.starred.push(mainItem(chat(3), Date.parse('2026-09-10T11:45:00.600Z'), { ...archived, ...starred }), mainItem(chat(4), Date.parse('2026-09-08T13:49:43.781Z'), starred))
  site.projects.set(PROJECT, [projectChat(chat(4), Date.parse('2026-09-08T13:49:43.781Z'), starred)])
  await answerChatGPT(context, site)
  await untilStoreOpen(serviceWorker)
  await serve(serviceWorker, { summarize: true })

  const first = await crawl(serviceWorker)
  expect(site.calls.splice(0)).toEqual(listWalk({ archived: true, starred: true, projects: [PROJECT] }))
  const sent = records(first.events)
  expect(sent.map((record) => record.identifier)).toEqual([chat(1), chat(2), chat(3), chat(4)])
  expect(sent.flatMap((record) => checkRecord(record, MARK))).toEqual([])
  // Each as its list gives it, the starred project chat as the project's
  // item: archived, starred, and whether a project id is hashed.
  expect(sent.map(({ metadata }) => [metadata.is_archived, metadata.is_starred, metadata.gizmo_id_hash !== null])).toEqual([
    [false, null, false], [true, null, false], [true, true, false], [false, true, true],
  ])
  expect(completions(first.events)).toEqual([[4, [chat(1), chat(2), chat(3), chat(4)], reason('ok seen=4 dispatched=4')]])
  // One key each; the starred project chat's 1 ms early, the project path's.
  const keys = [uploadKey(chat(1), 1789205400900), uploadKey(chat(2), 1789121700400), uploadKey(chat(3), 1789040700600), uploadKey(chat(4), 1788875383780)]
  expect(await uploadKeys(serviceWorker)).toEqual([...keys].sort())
  expect(await rexSpiderKey(serviceWorker, chat(4), site.projects.get(PROJECT)[0].update_time, 'project')).toEqual(keys[3])

  const second = await crawl(serviceWorker)
  expect(site.calls).toEqual(listWalk({ archived: true, starred: true, projects: [PROJECT] }))
  expect(records(second.events)).toEqual([])
  expect(completions(second.events)).toEqual([[0, [chat(1), chat(2), chat(3), chat(4)], reason('ok seen=4 dispatched=0')]])
  await expectAllRouted(serviceWorker, site, unrouted)
})
