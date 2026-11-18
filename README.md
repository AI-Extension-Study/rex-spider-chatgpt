# rex-spider-chatgpt

The ChatGPT crawler for a research browser extension (this fork of bric-digital's `rex-spider-chatgpt`). While a participant's browser is open and signed in to chatgpt.com, it reads the account's ChatGPT chats with the participant's own sign-in and uploads one record for each new or changed chat. A summary record holds the chat's times, a few flags and hashes of its title and ids. A detail record adds one turn per prompt and per reply, with counts made in the browser: characters, words, citations, search results and attached files. No record holds a title or message text. Records follow the conversation record layout the Gemini fork also uses, and carry the data format the served configuration names (1 when it names none; see "The data format"). Where the served configuration turns it on, it also sends a `rex-account` record of the account's plan and settings (see "The account record").

**Where it stands, 2026-11-13.** The code described here is `74712d8`. The extension installs this fork at `74712d8` from its release v0.0.59 (2026-11-13) on. The account record (see "The account record") is newer: it is on `main` from the merge that closes #21, and no extension build pins it yet.

## What it collects

| | summary mode | detail mode |
|---|---|---|
| per chat | id, created and last-changed times from the chat list, archived, starred, pinned time, temporary, do-not-remember, memory scope, async status, and SHA-256 hashes of the title, the gizmo id (a project or a custom GPT) and the template id | the same keys from the chat itself except async status, plus the default model, study mode, the id of the message ChatGPT shows as current, the gizmo type, and `user_agent` |
| per turn: a prompt, or a reply | nothing | the message id, speaker, time, parent turn, whether it is on the branch ChatGPT shows, and five counts; ChatGPT's extras: content type and status, and for a reply its model and how many messages it folds |
| per message of the chat's tree | nothing | the tree without its content (`metadata.mapping`): ids and links, author role and name, times, status, weight, `end_turn`, recipient, channel, content type, and ten metadata keys: two model names, the message type, the thinking effort, three timings, and the ids `request_id`, `working_turn_id` and `turn_exchange_id` |

Never collected: titles (only the hash), message text (only the counts), thinking, tool inputs and results, file names or contents, links, search queries, project names, and the owner details and text snippet a project's chat list carries.

## How a pass works

The extension starts a crawl round every minute, but only while an ID is stored and only when its configuration request gets an HTTP answer. rex-spider starts a ChatGPT pass when none is running and `sleep_delay` has passed since the last one.

1. Read `https://chatgpt.com/` for the access token the site's own page carries.
2. If the account read is on and due, read the four account sources with that token and send the account record if it changed (see "The account record").
3. Walk the chat lists, `crawl_delay` between any two requests: the main list (`/backend-api/conversations`, 28 chats a page, newest change first, archived and starred chats left out), the same list for archived chats and for starred chats, the project sidebar, and each project's list. A chat list stops at an empty page or a page with no chat in the crawl window. A chat on several lists counts once.
4. Check each chat in the window against the upload keys (see "Modes and the re-send"). The chats not sent yet go out newest change first.
5. Summary mode builds each record from the list item. Detail mode reads the chat (`/backend-api/conversation/<id>`), one read per `crawl_delay` and never closer than 3 s, and builds the record from that.
6. Send one completion event (see "Reading the completion events").

Detail reads stop once a pass has spent 360 s reading (requests, parsing and storage calls; the waits do not count), counted from its first detail read. Chats not reached keep no key and go out in a later pass. Waits run in steps of at most 20 s with a cheap extension call before each, so Chrome does not stop the service worker mid-pass, and every request gives up after 20 s. A list is cut after 1,000 pages, or after 3 pages in a row with no new chat; a pass makes at most 5,000 list requests.

## What a record holds

Top level: `name` (`rex-conversation`), `platform` (`chatgpt`), `identifier` (the chat id, a UUID), `format_version` (the data format), `is_summary`, `date`, `started`, `ended`, `turns`, `metadata`. In a summary record, `started` and `ended` are the list's `create_time` and `update_time`, `date` is `ended` in epoch ms, and `turns` is empty. A detail record has `started` from the chat's creation, `ended` from its latest message, `date` from `started` (else `ended`) in epoch ms, and adds `turns_complete` and `user_agent`: `Browser` when the root of the chat's tree is `client-created-root`, the root the web page makes, else `App (Mobile or Desktop)`.

`metadata` in a summary record: `create_time`, `update_time`, `is_archived`, `is_starred`, `pinned_time`, `is_temporary_chat`, `is_do_not_remember`, `memory_scope`, `async_status`, `title_hash`, `gizmo_id_hash`, `conversation_template_id_hash`. In a detail record: `conversation_id`, `create_time`, `update_time`, `default_model_slug`, `is_archived`, `is_starred`, `pinned_time`, `is_temporary_chat`, `is_do_not_remember`, `memory_scope`, `is_study_mode`, `current_node`, `gizmo_type`, the three hashes, and `mapping`. The times in `metadata` are ISO strings in a summary and epoch seconds in a detail record, as ChatGPT sends them. `is_starred` is `true` or null, never `false`.

A turn is one prompt or one reply. A reply folds every visible assistant message from a prompt to the next prompt on its branch, so text, a web search and more text make one reply, and a retry is a second reply to the same prompt. System and tool messages, thinking, calls addressed to a tool and hidden messages are not turns; they stay in `mapping`. Turns run oldest first.

| key | what it is |
|---|---|
| `identifier` | the message id: the prompt's, or the last message a reply folds |
| `parent` | the nearest turn above it on its branch; null for the first |
| `speaker` | `user` or `assistant` |
| `when` | the prompt's time, or the reply's first message's, in UTC to the microsecond |
| `on_current_branch` | on the path to the message ChatGPT shows as current; turns on a branch ChatGPT does not show (after a retry or an edit) are `false`; null on every turn when that path cannot be traced |
| `text_chars`, `text_words` | Unicode code points, and runs of non-space characters holding a letter or a digit, in the string parts of `text` and `multimodal_text` content and in a voice transcript. Code and its output count 0; images, files and a Deep Research report are not counted |
| `citation_count` | cited passages: entries of `content_references` of type `grouped_webpages`. 0 on a prompt; null when no message of the reply carries `content_references` |
| `search_result_count` | distinct web search results returned to the reply: from the tool messages on the path from the turn above to the reply's last message, else from the reply's own messages. 0 on a prompt and when no search ran; null when a search ran and no results are stored |
| `attachments` | entries of the `attachments` lists of the prompt, or of the reply's messages; no list counts 0 |
| `content_type`, `status` | extras: the content type and status (`finished_successfully`, `in_progress` or `unrecognised`) of the prompt, or of the reply's last message |
| `model_slug`, `nodes` | extras on a reply: its last message's model, and how many messages it folds |

A count is null when what it is made from is missing or has another form, so a change on ChatGPT's side shows as nulls, not zeros. `turns_complete` is false when a message could not be read, a link names a message the tree does not hold, part of the tree hangs from no root, or the turns were cut to the newest 1,000 or to 512 KB of JSON. `mapping` is never cut.

## The account record

Off unless the served configuration has `account: {"enabled": true}` for this spider. When on, a pass reads four sources right after the home page, `crawl_delay` before each, and sends one `rex-account` point:

| source | URL (`https://chatgpt.com/backend-api/...`) | keys it fills |
|---|---|---|
| `user_system_messages` | `user_system_messages` | `web_search_enabled` (`browser` not among `disabled_tools`), `custom_instructions_set` |
| `accounts_check` | `accounts/check/v4-2023-04-27` | `plan` (`plan_type`), `paid`, `workspace`, `account_created`; metadata `is_trial`, `cancels_at`, `renews_at`, `will_renew` |
| `settings_user` | `settings/user` | `training_allowed`, `memory_enabled` (`m3m`); metadata `hive_referenced_in_internal_knowledge`, `connector_search_enabled`, `free_ads_opt_out`, `last_used_model` |
| `memories` | `memories` | metadata `memories`, the number of saved memories |

`/backend-api/me` is never requested: it holds the email, the name and the phone number.

Every record has, in this order: `name` (`rex-account`), `platform` (`chatgpt`), `format_version` (the data format), `date` (the read, epoch ms), `plan`, `paid`, `workspace` (`personal`, `team`, `enterprise` or `edu`), `web_search_enabled`, `training_allowed`, `history_saved` (always null: ChatGPT has no such setting), `memory_enabled`, `custom_instructions_set`, `account_created`, `source_status` (each source's HTTP status, -1 for no answer) and `metadata`. A key is null when its source did not answer 200 with a JSON object, the site has no such key, or the value has the wrong form. `plan` must match `^[a-z0-9][a-z0-9_. -]{0,39}$` and `last_used_model` `^[a-z0-9][a-z0-9.-]{0,39}$` with no leading `g-` (a custom GPT's or a project's id), and neither may hold a UUID-like run or 12 hex digits in a row. Times are ISO 8601 instants in UTC ending in `Z`. A metadata value of the wrong form is left out; `cancels_at` and `renews_at` keep the site's null.

Never in the record: emails, names, phone numbers, ids of any kind (account, user, subscription, organization), organization names, billing details, the text of custom instructions or memories (only whether any instruction is written, and how many memories), and the home page line the token comes from. `src/redact.mts` and `src/keep.mts` cover `rex-conversation` records only; the extension checks a `rex-account` record against its own allow-list.

**When it is read.** When no read is stored, once `interval_minutes` (default 60) have passed since the last, or when the stored read time is more than 5 minutes ahead of the clock (the clock went back).

**When it is sent.** When nothing was sent before, when the record differs from the last one sent (SHA-256 of the record without `date`, keys sorted), or at the first read a day or more after the last send. So a gap of more than 24 hours plus `interval_minutes` between two records means the account could not be read in that time. A read happens at the first pass after the interval, not on the minute, so allow about 10 minutes more (longer while a long detail sweep runs). A refresh that switches the account read or the spider off during the reads sends nothing. The read time, and the hash and time of the last send, are stored under `rex-spider-chatgpt-account`, 3 s after a dispatch so the record is stored first.

**When a read fails.** A 429, a 503, a `Retry-After` header, a challenge, a 401, a 403, or an answer the browser reached through a redirect (a sign-in page, or a page a browser rule sent the request on to) on any source stops the account reads, and nothing is sent. Any other failure of one source (a 5xx, a 404, a page that is not JSON, no answer) leaves that source's keys null, and the other sources are still read; a record goes out only if at least one source answered 200 with a JSON object. Either way the read time is stored, so the next read waits out the interval. The account read never sets the back-off, never changes a completion event, and never stops the conversation pass; an error in it is logged by the error's name and the pass goes on.

## Modes and the re-send

`summarize: true` is summary mode; absent or `false` is detail mode. The spider takes the setting again, in both directions, at every configuration refresh whose configuration has a `chatgpt` or `default` block, and checks it before each chat: a change during a pass ends the sending, and the next pass runs in the new mode.

Each mode has its own upload key: the bare chat id in summary mode, the key earlier builds wrote for both modes, and `<chat id>-detail` in detail mode. A chat with a key in the served mode at its current list time is not sent again, and one with no key in either mode is sent. The spider stores the served mode and when this browser's first pass in it ran (`rex-spider-chatgpt-mode`). A chat with a key only in the other mode is sent again, once, if its last change is no earlier than 90 days before that pass; older chats keep the record they have. A browser with no stored mode counts as switching on its first pass. So an update to this build sends nothing again where summary mode is served, and where detail mode is served it sends the chats changed in the 90 days before, once, as detail records.

## The data format

`data_format` in the served block is one number for the layout of every record the spider sends: each conversation record and the account record carry it as `format_version`. Absent, or anything but an integer from 1 to 999, it is 1, the layout and keys of the builds before the setting existed. The spider takes it again at every configuration refresh, and a pass reads it once, when it starts; one served during a pass applies from the next.

Format 1 keeps the upload keys above. A later format n adds `-f<n>` to both: `<chat id>-f<n>` in summary mode and `<chat id>-detail-f<n>` in detail mode. So when the served format changes, no chat in the crawl window has a key under the new one, and the following passes send every chat in the window once, in the served mode, whenever it was last used: the 90-day limit of a mode switch does not apply. Within one format, a switch of mode works as above, on that format's keys only. The account record's hash includes `format_version`, so the first account read under a new format sends a record.

The wait after a failed detail read (see "When something fails") is kept per format too, under `rex-spider-chatgpt-detail-memo-<chat id>` in format 1 and `...-f<n>` after. So a chat whose detail read failed before the change is read again at the first pass under the new format, and a read that fails then sends its summary in its place, under the new format.

## What is removed, and how

1. The spider builds each record from the keys above and nothing else, each value in a checked form: a time must read as a time, and a label must be a type name (lowercase letters, digits, `_`, `.` and `-`, at most 64 characters). Any other value becomes null, or `unrecognised` where a label was expected. The title and the gizmo and template ids are hashed with SHA-256 in the spider, and the counts are made in the browser, so no text leaves the spider.
2. The extension runs the redactor, `src/redact.mts` with its tables in `src/keep.mts`, on every `rex-conversation` record with `platform` `chatgpt` before upload, with the data format the extension accepts. A record the spider built under that format comes back key for key, each value written again from its checked form, and anything else is dropped at every level. The redactor also holds every id to one form, a UUID or `client-created-root` for the root of a tree: an id in another form reads null, and a tree entry under such a key is dropped, which makes `turns_complete` false. Any other such record, one of another format included, keeps only `date`, `name`, `platform`, `identifier` (a UUID) and the uploader's own keys (`generatorId`, `_pdk_trace_context`, `passive-data-metadata`). The redactor never throws, because rex-content-processing uploads a failed processor's input unredacted. Completion events are not filtered.

The hashes use no secret key, so someone who guesses a title exactly can confirm the guess, and two chats with the same title share a hash.

## When something fails

- A 429, a 503, any `Retry-After` header, or a Cloudflare challenge stops the pass and starts a back-off kept in the extension's storage: 5 minutes, doubling with each refusal in a row, longer if `Retry-After` asks, at most 6 hours. Passes during it end at once with no request. A pass that reads a list page with no refusal clears it.
- No token on the home page, or a 401, ends the pass with no back-off; the next pass reads the token again.
- Any other failed detail read is that chat's alone. Its summary record goes out in the detail's place, once per list time, unless one already went out at that time under the same data format. The chat then waits 1 day before the next try after a first failure that may pass by itself (no answer, a 5xx, a page that is not JSON) and 7 days otherwise; a chat that changes is read at once. Failed reads also end the pass's reads, as `halt_on_error` sets (see "Settings it reads").

## Reading the completion events

Each pass sends one event, `rex-spider-chatgpt-complete`, with `crawled_count`, `crawled_ids` and `reason`. Only `ok` comes with a count of 0 or more (the records sent) and the ids of every chat listed in the crawl window. Every other reason comes with -1 and no ids, so a list read in part never looks like deleted chats. A reason is a code followed by `key=value` fields, never free text, such as `ok seen=40 dispatched=8 failed=3 left=30 stop=failed-reads ms=560000` (made-up numbers).

| code | meaning |
|---|---|
| `ok` | every list read to its end: `seen` chats in the window, `dispatched` records sent |
| `partial` | a list failed or was cut; the same fields as `ok` |
| `not-signed-in` | no token, or a 401 at the home page or a list; a 401 during the detail reads shows as `stop=not-signed-in` |
| `rate-limited`, `challenge` | the site asked for a wait, and a back-off started |
| `backoff` | skipped: a back-off runs `until` the time given |
| `list-failed` | the lists were read only in part and gave no chat in the window |
| `http-error`, `network`, `timeout` | the home page did not answer properly |
| `disabled`, `store`, `internal` | switched off; the extension's storage did not answer; an unexpected error |
| `[chatgpt] Still crawling.` | sent by rex-spider each minute a pass is still running; not a pass |

On `ok` and `partial`, `stop` says why the sending ended before every due chat was handled (`budget`, `mode`, `disabled`, `rate-limited`, `challenge`, `not-signed-in`, `failed-reads`, `halt-on-error`, `store` or `internal`), `failed` counts failed detail reads, `held` the chats held back for a later pass, and `left` the due chats a later pass sends.

## Settings it reads

rex-spider merges `spider.spiders.chatgpt` over `spider.spiders.default` from the served configuration.

| key | default | effect |
|---|---|---|
| `enabled` | `true` | `false` stops a pass before its next request |
| `summarize` | absent | `true` for summary mode, else detail mode |
| `halt_on_error` | `true` | `true` ends the detail reads at the first failed read, `false` at three in a row |
| `crawl_delay` | `30000` | ms between requests; any value that does not read as a number of 0 or more counts as 30000 |
| `sleep_delay` | `300000` | ms between passes, applied by rex-spider |
| `start`, `end`, `time_anchor` | none, none, `runtime` | the crawl window: `start` and `end` in ms from the install time (`install`) or from now (`runtime`), or as epoch ms (`absolute`); a chat is in it by its list `update_time` |
| `account` | absent (off) | `{"enabled": true}` turns the account read on; `interval_minutes`, an integer from 15 to 1440 (else 60), is the time between reads. A `chatgpt` block's `account` replaces the `default` block's whole |
| `data_format` | absent (1) | an integer from 1 to 999 is the data format the records carry and the upload keys are built for; anything else is 1 (see "The data format") |

## What it cannot see

- Anything while the browser is closed or signed out of chatgpt.com. The next pass picks up every chat that changed meanwhile, but a summary record carries only each chat's last change.
- Which app a chat came from, beyond `user_agent`: phone and desktop apps both read `App (Mobile or Desktop)`.
- A deletion as an event: a deleted chat stops appearing in the `crawled_ids` of `ok` events.

## Running the tests

Node 24.11 or later. `npm ci`, then `npm run lint` and `npm run test:unit` (Node's test runner, no browser). `npm run test:specs` builds a test extension and runs it in Chromium with Playwright, and `npm test` runs both suites. CI runs the build, lint and both suites on every pull request and on `main` (`.github/workflows/ci.yml`).

## How a change reaches the extension

The extension installs this module from a pinned commit and carries a copy of `src/redact.mts` and `src/keep.mts` from that commit as its ChatGPT case, which it calls with the data format it accepts. A change here reaches participants only after the extension pins the new commit, its copy of the two files is made again from that commit, and a release ships both.

## Where to read next

| to... | read |
|---|---|
| see how a record is built | `src/record.mts`, then `src/detail.mts` for turns and `src/counts.mts` for the counts |
| see what the redactor keeps | `src/keep.mts`, then `src/redact.mts` |
| follow one pass | `src/pass.mts`, then `src/list.mts` |
| see how the account record is built, and when it is sent | `src/account.mts`, then `readAccount` in `src/pass.mts` |
| decode a completion reason | `src/reasons.mts` |

## What is in this repo

| path | what it holds |
|---|---|
| `src/` | the crawler: the entry point the extension imports (`service-worker.mts`), the spider (`spider.mts`) and one module per job. `browser.mts` and `extension.mts` are empty, since the crawler runs only in the service worker |
| `tests/unit/` | Node unit tests and their fixtures |
| `tests/specs/`, `tests/src/`, `tests/extension/` | the Playwright spec and the test extension it loads |
| `.github/workflows/ci.yml` | CI |

## Keeping this current

A pull request that changes what a record holds, what is removed, which lists or account sources are read, the pace, the reasons, the settings or the keys updates this README in the same pull request.
