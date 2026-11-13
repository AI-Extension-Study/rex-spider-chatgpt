import corePlugin, { REXServiceWorkerModule, registerREXModule } from '@bric/rex-core/service-worker'
import rexSpider from '@bric/rex-spider/service-worker'
import chatGPTSpider from '@bric/rex-spider-chatgpt/service-worker'
import { DateString } from '@bric/rex-types/types'

import { KEY_PREFIX } from '../../src/keys.mts'

// Every request the worker makes, written down when it is made, with the
// value of the header the specs' route puts on each answer it makes
// (tests/specs/chatgpt-site.ts): null for an answer from anywhere else, and
// for a request that got no answer. The specs answer chatgpt.com from that
// route, and read this to check that no answer came from the real site.
const workerRequests: { url: string, routed: string | null }[] = []
const realFetch = self.fetch.bind(self)

self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request: { url: string, routed: string | null } = { url: input instanceof Request ? input.url : String(input), routed: null }
  workerRequests.push(request)
  const response = await realFetch(input, init)
  request.routed = response.headers.get('x-spec-route')
  return response
}

// Keeps every event rex-core dispatches to its modules, so a spec can read
// the records a crawl sent as the data-upload module would get them.
class EventRecorder extends REXServiceWorkerModule {
  events: object[] = []

  moduleName() {
    return 'EventRecorder'
  }

  logEvent(event: object) {
    this.events.push(JSON.parse(JSON.stringify(event)))
  }
}

const recorder = new EventRecorder()

registerREXModule(recorder)

self['rexCorePlugin'] = corePlugin
self['rexSpiderPlugin'] = rexSpider
self['rexChatGPTPlugin'] = chatGPTSpider
self['eventRecorder'] = recorder
self['workerRequests'] = workerRequests
// rex-types' DateString, the class the spider's list times are read into, so
// a spec can ask rex-spider for the upload key it builds from one.
self['rexDateString'] = DateString
// The prefix of every key the spider's own modules write, for the spec that
// checks it against the spider's identifier.
self['rexChatGPTKeyPrefix'] = KEY_PREFIX

corePlugin.setup()
