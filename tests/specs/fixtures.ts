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
  unrouted: async ({ context }, use) => {
    const urls: string[] = []
    await context.route(/^https?:\/\//, async (route) => {
      urls.push(route.request().url())
      await route.abort()
    })
    await use(urls)
  },
});

export const expect = test.expect;
