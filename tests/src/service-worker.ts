import corePlugin, { REXServiceWorkerModule, registerREXModule } from '@bric/rex-core/service-worker'
import rexSpider from '@bric/rex-spider/service-worker'
import chatGPTSpider from '@bric/rex-spider-chatgpt/service-worker'

import { KEY_PREFIX } from '../../src/keys.mts'

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
// The prefix of every key the spider's own modules write, for the spec that
// checks it against the spider's identifier.
self['rexChatGPTKeyPrefix'] = KEY_PREFIX

corePlugin.setup()
