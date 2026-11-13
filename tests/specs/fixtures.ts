// @ts-nocheck

import { test as base, chromium, type BrowserContext } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url';

export const test = base.extend<{
  context: BrowserContext
  extensionId: string,
  serviceWorker:ServiceWorker,
  unrouted: string[],
}>({
  context: async ({ }, use) => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const pathToExtension = path.join(__dirname, '../extension')

    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
      ],
    });

    use(context)
      .then(() => {
        setTimeout(() => {
          context.close();
        }, 10000)
    })
  },
  extensionId: async ({ context }, use) => {
    // for manifest v3:
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker)
      serviceWorker = await context.waitForEvent('serviceworker');

    const extensionId = serviceWorker.url().split('/')[2];
    await use(extensionId);
  },
  serviceWorker: async ({ context }, use) => {
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }

    context.on('console', msg => {
      console.log(msg);
    })

    use(serviceWorker)
      .then(() => {
        context.close();
    })
  },
  // Every http(s) request no route of the spec answers is aborted here and
  // written down, so nothing a spec runs reaches a real site. Routes the spec
  // adds later are tried before this one.
  //
  // A route sees the worker's requests only while Playwright watches the
  // worker's network, which PLAYWRIGHT_DISABLE_SERVICE_WORKER_NETWORK or
  // serviceWorkers: 'block' turns off; a crawl would then go to the real
  // chatgpt.com. So before the spec starts, the worker fetches a canary on a
  // host that never resolves, and the spec goes on only if a route answered
  // it and nothing else was asked.
  unrouted: async ({ context, serviceWorker }, use) => {
    const urls: string[] = []
    await context.route(/^https?:\/\//, async (route) => {
      urls.push(route.request().url())
      await route.abort()
    })
    const canary = 'https://spec-canary.invalid/'
    const seen: string[] = []
    await context.route(`${canary}**`, async (route) => {
      seen.push(route.request().url())
      await route.fulfill({ status: 200, headers: { 'x-spec-route': 'canary' }, body: '' })
    })
    // The worker's log of its requests (tests/src/service-worker.ts) holds
    // the canary alone, and loses it, so the specs' own checks start empty.
    const worker = await serviceWorker.evaluate(async (url) => {
      let answer: string | null = null
      try {
        answer = (await fetch(url)).headers.get('x-spec-route')
      } catch {
        // No answer: the route did not see it, and it went to DNS.
      }
      const asked = self.workerRequests.splice(0).map((request) => request.url)
      return { answer, asked }
    }, canary)
    if (worker.answer !== 'canary' || JSON.stringify(seen) !== JSON.stringify([canary]) || JSON.stringify(worker.asked) !== JSON.stringify([canary]) || urls.length > 0) {
      const counts = `the worker asked ${worker.asked.length}, the routes saw ${seen.length}, the catch-all ${urls.length}, and the canary's answer was ${worker.answer === null ? 'none' : 'another route\'s'}`
      throw new Error(`the worker's requests do not reach the spec's routes (${counts}), so a crawl would go to the real site; the spec stops before it`)
    }
    await use(urls)
  },
});

export const expect = test.expect;
