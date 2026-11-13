import corePlugin, { dispatchEvent } from '@bric/rex-core/service-worker'
import rexSpider from '@bric/rex-spider/service-worker'
import chatGPTSpider from '@bric/rex-spider-chatgpt/service-worker'

import { KEY_PREFIX } from '../../src/keys.mts'

console.log(`Imported ${corePlugin} into service worker context...`)

self['rexCorePlugin'] = corePlugin
self['rexSpiderPlugin'] = rexSpider
self['rexChatGPTPlugin'] = chatGPTSpider
// The prefix of every key the spider's own modules write, for the spec that
// checks it against the spider's identifier.
self['rexChatGPTKeyPrefix'] = KEY_PREFIX

corePlugin.setup()
