// The spider rex-spider runs for ChatGPT: its name, the URLs the extension
// lets it reach, the served mode and halt_on_error, and a crawl that is one
// pass (src/pass.mts). src/service-worker.mts makes the instance and
// registers it.
import { sha256 } from '@bric/rex-core/common';
import rexCorePlugin, { dispatchEvent } from '@bric/rex-core/service-worker';
import { REXSpider, type REXSpiderCrawlResult } from '@bric/rex-spider/service-worker';

import { createClient } from './client.mts';
import { HOME_URL, accessToken } from './home.mts';
import { sleep } from './pacing.mts';
import { runPass } from './pass.mts';
import { createStore } from './store.mts';

// A key nothing stores. Reading it is the cheap extension call that keeps the
// worker awake through a wait or a slow call (src/pacing.mts).
const KEEP_ALIVE_KEY = 'rex-spider-chatgpt-keep-alive';

const keepAlive = () => chrome.storage.local.get(KEEP_ALIVE_KEY);

export class ChatGPTSpider extends REXSpider {
  // summarize as served on the last refresh: true is summary mode, absent or
  // false is detail. rex-spider keeps a flag of its own that only ever turns
  // on, so a config that turned summary off again would not take.
  summarizes = false;

  // halt_on_error as served on the last refresh: true, rex-spider's default,
  // ends a pass's detail reads at the first that fails. rex-spider's own flag
  // only ever turns off.
  haltsOnError = true;

  // rex-spider calls this on each refresh whose config has a block for this
  // spider or a default one, with the blocks merged. With neither, what was
  // last served stays until the worker restarts, as enabled does.
  updateConfiguration(configuration: Parameters<REXSpider['updateConfiguration']>[0]): void {
    super.updateConfiguration(configuration);
    this.summarizes = configuration.summarize === true;
    this.haltsOnError = configuration.halt_on_error !== false;
  }

  justSummarize(): boolean {
    return this.summarizes;
  }

  continueAfterError(): boolean {
    return !this.haltsOnError;
  }

  // As before. Nothing in rex-spider calls it.
  fetchUrls(): string[] {
    return ['https://www.chatgpt.com/'];
  }

  name(): string {
    return 'ChatGPT';
  }

  // rex-spider names this spider's keys after it (rex-spider-chatgpt-...), and
  // src/keys.mts writes under the same prefix.
  identifier(): string {
    return 'chatgpt';
  }

  loginUrl(): string {
    return HOME_URL;
  }

  // As before. Nothing in rex-spider calls it.
  fetchInitialUrls(): string[] {
    return ['https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false'];
  }

  // The requests a pass makes: the home page, the three conversation lists,
  // the project sidebar and each project's list, and a chat's detail.
  allowedUrls(): string[] {
    return [
      '^https://chatgpt.com/$',
      '^https://chatgpt.com/backend-api/conversations\\?.*',
      '^https://chatgpt.com/backend-api/conversation/.*',
      '^https://chatgpt.com/backend-api/gizmos/.*/conversations\\?.*',
      '^https://chatgpt.com/backend-api/gizmos/snorlax/sidebar\\?.*',
    ];
  }

  // Whether the home page holds an access token. Nothing in rex-spider calls
  // it; it resolves false on any failure, where the old one could hang.
  async checkLogin(): Promise<boolean> {
    try {
      const home = await createClient({ keepAlive }).get(HOME_URL);
      return home.status >= 200 && home.status <= 299 && accessToken(home.text) !== null;
    } catch {
      return false;
    }
  }

  // The base stamps the crawl's start and sets its crawling flag. The pass
  // never throws, and its outcome is the crawl's one completion event, which
  // clears the flag again.
  async doBackgroundCrawl(): Promise<REXSpiderCrawlResult> {
    const result = await super.doBackgroundCrawl();
    const outcome = await runPass({
      client: (token) => createClient({ token, keepAlive }),
      framework: this,
      store: createStore(rexCorePlugin.handleMessage),
      // A shallow copy: rex-core's EventPayload has an index signature.
      dispatch: (record) => dispatchEvent({ name: 'rex-conversation', ...record }),
      sleep: (ms) => sleep(ms, { keepAlive }),
      keepAlive,
      hash: sha256,
    }, Date.now);
    if (outcome.count === -1) {
      result.issues.push({ url: this.loginUrl(), message: outcome.reason });
    }
    this.signalCrawlComplete(outcome.count, outcome.ids, outcome.reason);
    return result;
  }
}
