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
