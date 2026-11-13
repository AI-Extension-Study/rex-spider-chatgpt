// @ts-nocheck

// chatgpt.com for the worker specs, answered by a route on the browser
// context: the spider's requests leave the worker as they would in the
// extension, and this answers them in place of the site. It serves what a pass
// asks for (the home page with an access token, the three conversation lists,
// the project sidebar and each project's list, and a chat's detail), built
// from the unit tests' synthetic fixtures. Nothing here is a real chat: every
// title and text carries MARK, which no record may hold.
import {
  MARK, ROOT, T0, answer, attachment, detail, editedFirstPromptDetail, imagePart, listItem, nodeId, projectItem, prompt, reasoningDetail, tree,
} from '../unit/fixtures.mts'

export { MARK }

// Every answer made here carries this header. The test bundle writes down,
// for each request the worker makes, the value its answer came back with
// (tests/src/service-worker.ts), so a spec can tell that no answer came from
// anywhere else.
export const ROUTE_HEADER = 'x-spec-route'
export const ROUTE_NAME = 'chatgpt'

const PAGE = 28
const API = '/backend-api'

// The requests a pass makes, as the spider writes them, and how a call is
// written down. The main list's query is the one the spider has always sent;
// any other form is not a request the spider makes, and gets a 404.
const LISTS = [
  [/^\/backend-api\/conversations\?offset=(\d+)&limit=28&order=updated&is_archived=false&is_starred=false$/, 'main'],
  [/^\/backend-api\/conversations\?offset=(\d+)&limit=28&order=updated&is_archived=true$/, 'archived'],
  [/^\/backend-api\/conversations\?offset=(\d+)&limit=28&order=updated&is_starred=true$/, 'starred'],
]
const SIDEBAR = /^\/backend-api\/gizmos\/snorlax\/sidebar\?owned_only=true&conversations_per_gizmo=0&limit=28$/
const PROJECT = /^\/backend-api\/gizmos\/([^/?]+)\/conversations\?cursor=0$/
const DETAIL = /^\/backend-api\/conversation\/([^/?]+)$/

// A list time as the lists write it: an ISO instant with microseconds and Z.
export const listTime = (ms: number, micros = '123') => new Date(ms).toISOString().replace('Z', `${micros}Z`)

const DAY_MS = 24 * 60 * 60 * 1000
export const daysAgo = (days: number, now = Date.now()) => now - days * DAY_MS

// The account's chats and how the site answers. Each list is served newest
// first, as order=updated asks, from what it holds when the request comes, so
// a spec can change it between crawls.
export class Site {
  main = []
  archived = []
  starred = []
  // Project id to its list items.
  projects = new Map()
  // Chat id to its detail.
  details = new Map()
  // Chat id to the answers its next detail reads get in place of the detail,
  // one per read: { status, headers, body }.
  refusals = new Map()
  // Awaited before a detail read is answered, with the chat id.
  beforeDetail = async () => {}
  // The access tokens the home page has handed out, and those the site has
  // since stopped taking. A request with no token, or one not taken, is
  // answered 401, as the API answers an expired session.
  tokens = []
  expired = new Set()
  // Each request: its URL as the route saw it, and a line saying what it was,
  // with the status when it was not 200.
  urls = []
  calls = []

  // A token like the one on the page, a JWT; never sent anywhere but here.
  private nextToken() {
    const token = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzcGVjIn0.dG9rZW4t${this.tokens.length + 1}`
    this.tokens.push(token)
    return token
  }

  async answer(method, url, authorization) {
    const path = `${url.pathname}${url.search}`
    if (method === 'GET' && path === '/') {
      // The home page has always been fetched with no Authorization header.
      if (authorization !== null) return this.written('GET home with a token', { status: 400, body: '' })
      return this.written('GET home', {
        status: 200,
        type: 'text/html',
        body: `<html>\n<script>window.__oai = {"accessToken":"${this.nextToken()}","user":{"id":"user-spec"}}</script>\n</html>`,
      })
    }
    const call = method === 'GET' ? this.callOf(path) : null
    if (call === null) return this.written(`${method} ${path} (not a request the spider makes)`, { status: 404, body: '' })
    if (call.chat !== undefined) await this.beforeDetail(call.chat)
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null
    if (token === null || !this.tokens.includes(token) || this.expired.has(token)) {
      return this.written(call.line, { status: 401, body: JSON.stringify({ detail: 'Could not parse your authentication token. Please try signing in again.' }) })
    }
    if (call.chat !== undefined) {
      const refusal = this.refusals.get(call.chat)?.shift()
      if (refusal !== undefined) return this.written(call.line, refusal)
      const held = this.details.get(call.chat)
      return held === undefined ? this.written(call.line, { status: 404, body: JSON.stringify({ detail: 'Not found' }) }) : this.written(call.line, json(held))
    }
    return this.written(call.line, json(call.body()))
  }

  private written(line, answer) {
    this.calls.push(answer.status === 200 ? line : `${line} ${answer.status}`)
    return answer
  }

  private callOf(path) {
    for (const [pattern, name] of LISTS) {
      const match = path.match(pattern)
      if (match !== null) {
        const offset = Number(match[1])
        return { line: `GET ${name} ${offset}`, body: () => ({ items: newestFirst(this[name]).slice(offset, offset + PAGE), limit: PAGE, offset }) }
      }
    }
    if (SIDEBAR.test(path)) {
      return { line: 'GET sidebar', body: () => ({ items: [...this.projects.keys()].map((id) => ({ gizmo: { gizmo: { id } } })), cursor: null }) }
    }
    const project = path.match(PROJECT)
    if (project !== null) {
      const id = decodeURIComponent(project[1])
      return { line: `GET project ${id} 0`, body: () => ({ items: newestFirst(this.projects.get(id) ?? []), cursor: null }) }
    }
    const chat = path.match(DETAIL)
    if (chat !== null) {
      const id = decodeURIComponent(chat[1])
      return { line: `GET detail ${id}`, chat: id }
    }
    return null
  }
}

const newestFirst = (items) => [...items].sort((a, b) => Date.parse(b.update_time) - Date.parse(a.update_time))
const json = (body) => ({ status: 200, type: 'application/json', body: JSON.stringify(body) })

// Answers chatgpt.com from the site for the rest of the spec.
export async function answerChatGPT(context, site = new Site()) {
  await context.route('https://chatgpt.com/**', async (route) => {
    const request = route.request()
    site.urls.push(request.url())
    const headers = await request.allHeaders()
    const answered = await site.answer(request.method(), new URL(request.url()), headers.authorization ?? null)
    await route.fulfill({
      status: answered.status,
      headers: { [ROUTE_HEADER]: ROUTE_NAME, 'content-type': answered.type ?? 'application/json', ...answered.headers },
      body: answered.body,
    })
  })
  return site
}

// A chat as the lists give it, last used at `updated` (epoch ms). A project
// item carries its project's ids, a text snippet and its owner.
export const mainItem = (id: string, updated: number, fields = {}) => listItem(id, { create_time: listTime(updated - 60_000, '001'), update_time: listTime(updated), ...fields })
export const projectChat = (id: string, updated: number, fields = {}) => projectItem(id, { create_time: listTime(updated - 60_000, '001'), update_time: listTime(updated), ...fields })

// Details for a chat id, from the fixtures, each naming its own chat.
// One prompt and one answer.
export const simpleDetail = (id: string) => detail(tree(
  [ROOT, null, null],
  [nodeId(1), ROOT, prompt(nodeId(1), T0 + 1)],
  [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} answer`)],
), nodeId(2), { conversation_id: id })

// A reasoning model's reply with a web search, its results and citations.
export const reasoningChat = (id: string) => ({ ...reasoningDetail(), conversation_id: id })

// A first prompt edited: the old prompt and the new one side by side under the root.
export const editedChat = (id: string) => ({ ...editedFirstPromptDetail(), conversation_id: id })

// A prompt with two images attached, and its answer.
export const attachmentsChat = (id: string) => detail(tree(
  [ROOT, null, null],
  [nodeId(1), ROOT, {
    ...prompt(nodeId(1), T0 + 1),
    content: { content_type: 'multimodal_text', parts: [imagePart(1), imagePart(2), `${MARK} look at these`] },
    metadata: { attachments: [attachment(1), attachment(2)] },
  }],
  [nodeId(2), nodeId(1), answer(nodeId(2), T0 + 2, `${MARK} two pictures`)],
), nodeId(2), { conversation_id: id })
