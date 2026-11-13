// The entry point the extension imports: one ChatGPT spider, registered with
// rex-spider when this module loads.
import rexSpiderPlugin from '@bric/rex-spider/service-worker';

import { ChatGPTSpider } from './spider.mts';

const chatGPTSpider = new ChatGPTSpider();

rexSpiderPlugin.registerSpider(chatGPTSpider);

export { ChatGPTSpider };

export default chatGPTSpider;
