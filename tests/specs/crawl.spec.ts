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
import { MARK, ROUTE_NAME, Site, answerChatGPT, daysAgo, mainItem, projectChat } from './chatgpt-site'
import { checkRecord } from './standard-check'

const chat = (n: number) => `6911f0a5-2222-8000-8000-${String(n).padStart(12, '0')}`
const PROJECT = 'g-p-0000000000000000000000000000aaaa'
const HOUR_MS = 60 * 60 * 1000
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex')

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
