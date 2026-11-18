import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  ACCOUNT_SOURCES, type AccountRecord, type AccountState, accountDue, accountHash, accountSettings, buildChatGPTAccount, hasUsableAnswer,
  isAccountState, shouldSend,
} from '../../src/account.mts';
import { MARK } from './fixtures.mts';
import { ACCOUNT_KEY, CANCELS_AT_UTC, CREATED_TIME_UTC, type FixtureAnswer, MEMORY_COUNT, accountAnswers } from './account-fixtures.mts';

type Json = Record<string, unknown>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// 2026-11-17T12:00:00Z.
const NOW = Date.UTC(2026, 10, 17, 12);
const HASH = 'a'.repeat(64);

const STANDARD_KEYS = [
  'name', 'platform', 'format_version', 'date',
  'plan', 'paid', 'workspace', 'web_search_enabled', 'training_allowed', 'history_saved', 'memory_enabled', 'custom_instructions_set',
  'account_created', 'source_status', 'metadata',
];

// An object inside a fixture answer, to change one value in a test.
function at(value: unknown, ...path: string[]): Json {
  return path.reduce((inner, key) => (inner as Json)[key], value) as Json;
}
const theAccount = (answers: Record<string, FixtureAnswer>): Json => at(answers.accounts_check.body, 'accounts', ACCOUNT_KEY, 'account');
const settingsOf = (answers: Record<string, FixtureAnswer>): Json => at(answers.settings_user.body, 'settings');
const systemOf = (answers: Record<string, FixtureAnswer>): Json => answers.user_system_messages.body as Json;

// The builder, each record checked for any value of the answers that must
// not be sent, whatever the test.
function build(answers: Record<string, FixtureAnswer>): AccountRecord {
  const record = buildChatGPTAccount(answers, NOW);
  assert.equal(JSON.stringify(record).includes(MARK), false, 'a value of the answers is in the record');
  return record;
}

// --- accountSettings ---

test('the account read is off unless the block says enabled: true, whatever else it holds', () => {
  for (const block of [undefined, null, {}, { enabled: 'true' }, { enabled: 1 }, 'true', [true]]) {
    assert.equal(accountSettings(block).enabled, false, JSON.stringify(block));
  }
  // An interval with no switch is still off, and the interval is read anyway.
  assert.deepEqual(accountSettings({ interval_minutes: 30 }), { enabled: false, intervalMinutes: 30 });
  assert.deepEqual(accountSettings(undefined), { enabled: false, intervalMinutes: 60 });
});

test('the interval is an integer from 15 to 1440 minutes, else 60', () => {
  assert.deepEqual(accountSettings({ enabled: true }), { enabled: true, intervalMinutes: 60 });
  for (const interval of [14, 1441, 30.5, '30', 0, -60, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    assert.deepEqual(accountSettings({ enabled: true, interval_minutes: interval }), { enabled: true, intervalMinutes: 60 }, String(interval));
  }
  assert.deepEqual(accountSettings({ enabled: true, interval_minutes: 15 }), { enabled: true, intervalMinutes: 15 });
  assert.deepEqual(accountSettings({ enabled: true, interval_minutes: 1440 }), { enabled: true, intervalMinutes: 1440 });
});

test('a key the block only inherits is not read', () => {
  const inherited = Object.create({ enabled: true, interval_minutes: 30 }) as unknown;
  assert.deepEqual(accountSettings(inherited), { enabled: false, intervalMinutes: 60 });
});

// --- accountDue ---

const readAt = (time: number): AccountState => ({ hash: HASH, sentAt: time, readAt: time });

test('a read is due with nothing stored, and once the interval has passed since the last', () => {
  assert.equal(accountDue(null, NOW, 60), true);
  assert.equal(accountDue(readAt(NOW - 59 * MINUTE), NOW, 60), false);
  assert.equal(accountDue(readAt(NOW - 60 * MINUTE), NOW, 60), true);
  assert.equal(accountDue(readAt(NOW - 15 * MINUTE), NOW, 15), true);
  assert.equal(accountDue(readAt(NOW - 14 * MINUTE), NOW, 15), false);
});

test('a last read more than 5 minutes ahead of the clock means the clock went back, and a read is due', () => {
  assert.equal(accountDue(readAt(NOW + 6 * MINUTE), NOW, 60), true);
  assert.equal(accountDue(readAt(NOW + 5 * MINUTE), NOW, 60), false);
  assert.equal(accountDue(readAt(NOW + 4 * MINUTE), NOW, 60), false);
});

test('an interval passed in out of range counts as 60 minutes', () => {
  assert.equal(accountDue(readAt(NOW - 60 * MINUTE), NOW, 0), true);
  assert.equal(accountDue(readAt(NOW - 59 * MINUTE), NOW, 0), false);
});

// --- shouldSend ---

test('a record is sent when none was, when it changed, or when the last was sent a day ago', () => {
  assert.equal(shouldSend(null, HASH, NOW), true);
  assert.equal(shouldSend({ hash: HASH, sentAt: NOW - 23 * HOUR, readAt: NOW - HOUR }, HASH, NOW), false);
  assert.equal(shouldSend({ hash: HASH, sentAt: NOW - 24 * HOUR, readAt: NOW - HOUR }, HASH, NOW), true);
  assert.equal(shouldSend({ hash: HASH, sentAt: NOW, readAt: NOW }, 'b'.repeat(64), NOW), true);
});

test('a last send more than 5 minutes ahead of the clock means the clock went back, and the record is sent', () => {
  assert.equal(shouldSend({ hash: HASH, sentAt: NOW + 6 * MINUTE, readAt: NOW }, HASH, NOW), true);
  assert.equal(shouldSend({ hash: HASH, sentAt: NOW + 5 * MINUTE, readAt: NOW }, HASH, NOW), false);
  assert.equal(shouldSend({ hash: HASH, sentAt: NOW + 4 * MINUTE, readAt: NOW }, HASH, NOW), false);
});

// --- isAccountState ---

test('only a stored state of the right form is trusted', () => {
  assert.equal(isAccountState({ hash: HASH, sentAt: NOW, readAt: NOW }), true);
  // An empty hash is a form the hook can store before anything was sent.
  assert.equal(isAccountState({ hash: '', sentAt: 0, readAt: NOW }), true);
  for (const value of [
    null, undefined, 'state', [HASH, NOW, NOW], {},
    { hash: 1, sentAt: NOW, readAt: NOW }, { sentAt: NOW, readAt: NOW },
    { hash: HASH, sentAt: String(NOW), readAt: NOW }, { hash: HASH, sentAt: NOW },
    { hash: HASH, sentAt: NOW, readAt: Number.NaN }, { hash: HASH, sentAt: Number.POSITIVE_INFINITY, readAt: NOW },
    Object.create({ hash: HASH, sentAt: NOW, readAt: NOW }),
  ]) {
    assert.equal(isAccountState(value), false, JSON.stringify(value));
  }
});

// --- buildChatGPTAccount ---

test('the four answers of 2026-11-17 give that day\'s record, with no id, name or text in it', () => {
  const record = build(accountAnswers());
  assert.equal(record.name, 'rex-account');
  assert.equal(record.platform, 'chatgpt');
  assert.equal(record.format_version, 1);
  assert.equal(record.date, NOW);
  assert.equal(record.plan, 'free');
  assert.equal(record.paid, false);
  assert.equal(record.workspace, 'personal');
  assert.equal(record.web_search_enabled, true);
  assert.equal(record.training_allowed, true);
  assert.equal(record.history_saved, null);
  assert.equal(record.memory_enabled, true);
  assert.equal(record.custom_instructions_set, false);
  assert.equal(record.account_created, CREATED_TIME_UTC);
  assert.deepEqual(record.source_status, { user_system_messages: 200, accounts_check: 200, settings_user: 200, memories: 200 });
  assert.deepEqual(record.metadata, {
    hive_referenced_in_internal_knowledge: true,
    connector_search_enabled: false,
    free_ads_opt_out: false,
    last_used_model: 'gpt-5-3',
    memories: MEMORY_COUNT,
    is_trial: false,
    cancels_at: CANCELS_AT_UTC,
    renews_at: null,
    will_renew: false,
  });
});

test('the record holds the standard keys, in their order, and nothing else', () => {
  assert.deepEqual(Object.keys(build(accountAnswers())), STANDARD_KEYS);
  // Every source failed: still every key.
  const failed = buildChatGPTAccount({}, NOW);
  assert.deepEqual(Object.keys(failed), STANDARD_KEYS);
  assert.deepEqual(failed.source_status, { user_system_messages: -1, accounts_check: -1, settings_user: -1, memories: -1 });
  assert.deepEqual(failed.metadata, {});
  for (const key of STANDARD_KEYS.slice(4, 13)) {
    assert.equal((failed as unknown as Json)[key], null, key);
  }
});

test('the four sources are the four account URLs, in the order they are read', () => {
  assert.deepEqual(ACCOUNT_SOURCES.map(([name, url]) => [name, url]), [
    ['user_system_messages', 'https://chatgpt.com/backend-api/user_system_messages'],
    ['accounts_check', 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27'],
    ['settings_user', 'https://chatgpt.com/backend-api/settings/user'],
    ['memories', 'https://chatgpt.com/backend-api/memories'],
  ]);
});

test('web search is off when browser is among the disabled tools, and unknown when the list is not one', () => {
  const answers = accountAnswers();
  systemOf(answers).disabled_tools = ['browser'];
  assert.equal(build(answers).web_search_enabled, false);
  systemOf(answers).disabled_tools = [`${MARK}-other-tool`];
  assert.equal(build(answers).web_search_enabled, true);
  delete systemOf(answers).disabled_tools;
  assert.equal(build(answers).web_search_enabled, null);
  systemOf(answers).disabled_tools = 'browser';
  assert.equal(build(answers).web_search_enabled, null);
});

test('a rate-limited settings read leaves its keys null and the others as they are', () => {
  const answers = accountAnswers();
  answers.settings_user.status = 429;
  const record = build(answers);
  assert.equal(record.training_allowed, null);
  assert.equal(record.memory_enabled, null);
  assert.equal(record.plan, 'free');
  assert.equal(record.web_search_enabled, true);
  assert.equal(record.source_status.settings_user, 429);
  assert.deepEqual(record.metadata, { memories: MEMORY_COUNT, is_trial: false, cancels_at: CANCELS_AT_UTC, renews_at: null, will_renew: false });
});

test('a settings answer without training_allowed leaves only that key null', () => {
  const answers = accountAnswers();
  delete settingsOf(answers).training_allowed;
  const record = build(answers);
  const full = build(accountAnswers());
  assert.equal(record.training_allowed, null);
  assert.deepEqual({ ...record, training_allowed: true }, full);
});

test('a challenge page or a body of another form with 200 counts as no answer for that source, and is recorded as 200', () => {
  for (const body of [`<!DOCTYPE html><html>${MARK} challenge</html>`, null, [], 42]) {
    const answers = accountAnswers();
    answers.settings_user.body = body;
    const record = build(answers);
    assert.equal(record.training_allowed, null);
    assert.equal(record.memory_enabled, null);
    assert.equal(record.source_status.settings_user, 200);
    assert.equal(record.plan, 'free');
    assert.equal('last_used_model' in record.metadata, false);
  }
});

test('a source with no answer is -1, and a status that is no HTTP status reads as none', () => {
  const answers = accountAnswers();
  delete answers.memories;
  answers.accounts_check.status = -1;
  answers.settings_user.status = 0;
  const record = build(answers);
  assert.deepEqual(record.source_status, { user_system_messages: 200, accounts_check: -1, settings_user: -1, memories: -1 });
  assert.equal(record.plan, null);
  assert.equal(record.training_allowed, null);
  assert.equal(record.web_search_enabled, true);
  assert.deepEqual(record.metadata, {});
});

test('a text value where an enum belongs is null, or left out of metadata', () => {
  const answers = accountAnswers();
  theAccount(answers).plan_type = 'Name Surname <a@b.com>';
  at(settingsOf(answers), 'last_used_model_config', 'slugs').web = 'name.surname@example.com';
  const record = build(answers);
  assert.equal(record.plan, null);
  assert.equal('last_used_model' in record.metadata, false);
  // A long plan is no plan either, even in the plan's characters.
  theAccount(answers).plan_type = 'a'.repeat(200);
  assert.equal(build(answers).plan, null);
  theAccount(answers).plan_type = 'plus';
  assert.equal(build(answers).plan, 'plus');
});

test('a plan or a model slug that holds an id is null, or left out of metadata, though it fits the form', () => {
  const answers = accountAnswers();
  const slugs = at(settingsOf(answers), 'last_used_model_config', 'slugs');
  // A UUID, a project id, a UUID's first three groups inside a longer value,
  // and 12 hex digits in a row.
  for (const [plan, model] of [
    ['0b8e2c4a-1111-4a2b-8c3d-000000000001', 'g-p-0123456789abcdef'],
    ['free-0b8e2c4a-1111-4a2b', 'gpt-0b8e2c4a-1111-4a2b'],
    ['plus 0123456789ab', 'gpt-0123456789ab'],
  ]) {
    theAccount(answers).plan_type = plan;
    slugs.web = model;
    const record = build(answers);
    assert.equal(record.plan, null, plan);
    assert.equal('last_used_model' in record.metadata, false, model);
  }
  // Values the site sends, and 11 hex digits in a row, still pass.
  for (const [plan, model] of [['free', 'gpt-5-3'], ['plus', 'gpt-4o'], ['pro_max 5x', 'o4-mini-high'], ['team', 'gpt-0123456789a']]) {
    theAccount(answers).plan_type = plan;
    slugs.web = model;
    const record = build(answers);
    assert.equal(record.plan, plan);
    assert.equal(record.metadata.last_used_model, model);
  }
});

test('a model slug that starts with g- is a custom GPT\'s or a project\'s id, and is left out of metadata though it fits the form', () => {
  const answers = accountAnswers();
  const slugs = at(settingsOf(answers), 'last_used_model_config', 'slugs');
  // A custom GPT's id is g- and 9 characters, too few hex digits in a row
  // for the id check; a project's is g-p- and 32 hex digits.
  for (const model of ['g-abc123def', 'g-0a1b2c3d4', 'g-p-0123', 'g-']) {
    slugs.web = model;
    assert.equal('last_used_model' in build(answers).metadata, false, model);
  }
  // Slugs that start with g but not g- are kept.
  for (const model of ['gpt-4o', 'gpt-5-3', 'g1-mini']) {
    slugs.web = model;
    assert.equal(build(answers).metadata.last_used_model, model);
  }
});

test('a plan or a model slug of more than 40 characters is null, or left out of metadata, and one of 40 is kept', () => {
  const answers = accountAnswers();
  const slugs = at(settingsOf(answers), 'last_used_model_config', 'slugs');
  // z is no hex digit, so only the length can refuse these.
  theAccount(answers).plan_type = 'z'.repeat(41);
  slugs.web = 'z'.repeat(41);
  let record = build(answers);
  assert.equal(record.plan, null);
  assert.equal('last_used_model' in record.metadata, false);
  theAccount(answers).plan_type = 'z'.repeat(40);
  slugs.web = 'z'.repeat(40);
  record = build(answers);
  assert.equal(record.plan, 'z'.repeat(40));
  assert.equal(record.metadata.last_used_model, 'z'.repeat(40));
});

test('the account is the first one not under default, wherever default comes', () => {
  const answers = accountAnswers();
  const accounts = at(answers.accounts_check.body, 'accounts');
  const own = accounts[ACCOUNT_KEY] as Json;
  const other = structuredClone(own);
  (other.account as Json).plan_type = 'plus';
  answers.accounts_check.body = { accounts: { default: other, [ACCOUNT_KEY]: own } };
  assert.equal(build(answers).plan, 'free');
  // Only default: no account.
  answers.accounts_check.body = { accounts: { default: other } };
  assert.equal(build(answers).plan, null);
});

test('workspace is personal for a personal account, else the plan when it is a workspace plan', () => {
  const answers = accountAnswers();
  const account = theAccount(answers);
  account.structure = 'workspace';
  for (const plan of ['team', 'enterprise', 'edu']) {
    account.plan_type = plan;
    assert.equal(build(answers).workspace, plan);
  }
  account.plan_type = 'plus';
  assert.equal(build(answers).workspace, null);
  account.plan_type = 'team';
  account.structure = `${MARK}-structure`;
  assert.equal(build(answers).workspace, null);
  delete account.structure;
  assert.equal(build(answers).workspace, null);
});

test('paid is the entitlement\'s active subscription, and nothing else', () => {
  const answers = accountAnswers();
  const entitlement = at(answers.accounts_check.body, 'accounts', ACCOUNT_KEY, 'entitlement');
  entitlement.has_active_subscription = true;
  assert.equal(build(answers).paid, true);
  entitlement.has_active_subscription = 'true';
  assert.equal(build(answers).paid, null);
});

test('custom instructions count when any of the four texts is written and they are on, never the nickname', () => {
  for (const key of ['about_user_message', 'about_model_message', 'traits_model_message', 'other_user_message']) {
    const answers = accountAnswers();
    systemOf(answers)[key] = `${MARK} instruction`;
    assert.equal(build(answers).custom_instructions_set, true, key);
    // Written but switched off.
    systemOf(answers).enabled = false;
    assert.equal(build(answers).custom_instructions_set, false, key);
  }
  // A missing key could hold one, so with the rest empty it is unknown.
  const missing = accountAnswers();
  delete systemOf(missing).other_user_message;
  assert.equal(build(missing).custom_instructions_set, null);
  systemOf(missing).about_user_message = `${MARK} instruction`;
  assert.equal(build(missing).custom_instructions_set, true);
  const none = accountAnswers();
  for (const key of ['about_user_message', 'about_model_message', 'traits_model_message', 'other_user_message']) {
    delete systemOf(none)[key];
  }
  assert.equal(build(none).custom_instructions_set, null);
});

test('account_created and the metadata times are kept only as instants, written in UTC', () => {
  const answers = accountAnswers();
  const account = theAccount(answers);
  const entitlement = at(answers.accounts_check.body, 'accounts', ACCOUNT_KEY, 'entitlement');
  account.created_time = '2023-02-14T09:30:00Z';
  entitlement.renews_at = '2026-12-17T08:00:00.500-05:00';
  let record = build(answers);
  assert.equal(record.account_created, '2023-02-14T09:30:00Z');
  assert.equal(record.metadata.renews_at, '2026-12-17T13:00:00.5Z');
  // Shaped like an instant but none (30 February), not shaped, or a number.
  account.created_time = '2026-02-30T00:00:00Z';
  entitlement.cancels_at = `${MARK}-cancels-at`;
  entitlement.renews_at = 1794956400;
  record = build(answers);
  assert.equal(record.account_created, null);
  assert.equal('cancels_at' in record.metadata, false);
  assert.equal('renews_at' in record.metadata, false);
});

test('every time sent has the one form: UTC, Z, a four-digit year', () => {
  const answers = accountAnswers();
  const entitlement = at(answers.accounts_check.body, 'accounts', ACCOUNT_KEY, 'entitlement');
  entitlement.cancels_at = '2026-12-01T10:20:30.123456789+0130';
  entitlement.renews_at = '2026-12-01T10:20:30+01';
  let record = build(answers);
  const sent = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
  for (const time of [record.account_created, record.metadata.cancels_at, record.metadata.renews_at]) {
    assert.match(String(time), sent);
  }
  assert.equal(record.metadata.cancels_at, '2026-12-01T08:50:30.123456789Z');
  // An offset that carries the year past 9999 would be written +010000-...
  theAccount(answers).created_time = '9999-12-31T23:00:00-05:00';
  entitlement.cancels_at = '9999-12-31T23:00:00-05:00';
  record = build(answers);
  assert.equal(record.account_created, null);
  assert.equal('cancels_at' in record.metadata, false);
});

test('a metadata value of the wrong form is left out, and the rest kept', () => {
  const answers = accountAnswers();
  settingsOf(answers).hive_referenced_in_internal_knowledge = 'yes';
  delete settingsOf(answers).free_ads_opt_out;
  (answers.memories.body as Json).memories = { count: 9 };
  at(answers.accounts_check.body, 'accounts', ACCOUNT_KEY, 'last_active_subscription').will_renew = null;
  const record = build(answers);
  assert.deepEqual(record.metadata, {
    connector_search_enabled: false, last_used_model: 'gpt-5-3', is_trial: false, cancels_at: CANCELS_AT_UTC, renews_at: null,
  });
  // An empty list is a count of 0.
  (answers.memories.body as Json).memories = [];
  assert.equal(build(answers).metadata.memories, 0);
});

test('a count of saved memories over 1e6 is left out of metadata, and 1e6 is kept', () => {
  const answers = accountAnswers();
  (answers.memories.body as Json).memories = new Array(1_000_001);
  assert.equal('memories' in build(answers).metadata, false);
  (answers.memories.body as Json).memories = new Array(1_000_000);
  assert.equal(build(answers).metadata.memories, 1_000_000);
});

// --- hasUsableAnswer ---

test('a record has something to send only when a source answered 200 with an object', () => {
  assert.equal(hasUsableAnswer(accountAnswers()), true);
  assert.equal(hasUsableAnswer({}), false);
  const failed: Record<string, FixtureAnswer> = {};
  for (const [name] of ACCOUNT_SOURCES) {
    failed[name] = { status: 500, body: { error: `${MARK} error` } };
  }
  assert.equal(hasUsableAnswer(failed), false);
  failed.settings_user = { status: 200, body: '<html></html>' };
  assert.equal(hasUsableAnswer(failed), false);
  failed.memories = { status: 200, body: { memories: [] } };
  assert.equal(hasUsableAnswer(failed), true);
  // A key that is no source does not count.
  assert.equal(hasUsableAnswer({ me: { status: 200, body: {} } }), false);
});

test('answers that are no map count as no answer, and the builder gives the all-null record', () => {
  for (const answers of [null, undefined, 'answers', 42, [accountAnswers().settings_user]]) {
    const given = answers as unknown as Record<string, FixtureAnswer>;
    assert.equal(hasUsableAnswer(given), false, JSON.stringify(answers));
    const record = build(given);
    assert.deepEqual(record.source_status, { user_system_messages: -1, accounts_check: -1, settings_user: -1, memories: -1 });
    assert.deepEqual([record.plan, record.paid, record.workspace, record.training_allowed, record.account_created], [null, null, null, null, null]);
    assert.deepEqual(record.metadata, {});
  }
});

// --- accountHash ---

test('the hash is SHA-256 of the record without date, keys sorted at every level', async () => {
  const record = {
    name: 'rex-account', platform: 'chatgpt', format_version: 1, date: 5,
    plan: 'free', paid: null, workspace: null, web_search_enabled: null, training_allowed: null, history_saved: null,
    memory_enabled: null, custom_instructions_set: null, account_created: null,
    source_status: { settings_user: 200, accounts_check: -1 },
    metadata: { will_renew: true, connector_search_enabled: null },
  } as unknown as AccountRecord;
  const text = '{"account_created":null,"custom_instructions_set":null,"format_version":1,"history_saved":null,"memory_enabled":null,'
    + '"metadata":{"connector_search_enabled":null,"will_renew":true},"name":"rex-account","paid":null,"plan":"free","platform":"chatgpt",'
    + '"source_status":{"accounts_check":-1,"settings_user":200},"training_allowed":null,"web_search_enabled":null,"workspace":null}';
  assert.equal(await accountHash(record), createHash('sha256').update(text).digest('hex'));
});

test('the hash rejects when the digest fails or gives a digest of another form, so no record goes out without one', async (t) => {
  const record = build(accountAnswers());
  const digest = t.mock.method(crypto.subtle, 'digest', async (): Promise<ArrayBuffer> => {
    throw new Error('no digest');
  });
  await assert.rejects(accountHash(record), /the account hash failed/);
  // 16 bytes: hex, but not a SHA-256.
  digest.mock.mockImplementation(async () => new ArrayBuffer(16));
  await assert.rejects(accountHash(record), /the account hash failed/);
});

test('the hash ignores the read time and key order, and changes with any value', async () => {
  const record = build(accountAnswers());
  const hash = await accountHash(record);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await accountHash({ ...record, date: NOW + HOUR }), hash);
  const reordered = Object.fromEntries(Object.entries(record).reverse()) as unknown as AccountRecord;
  assert.equal(await accountHash({ ...reordered, metadata: Object.fromEntries(Object.entries(record.metadata).reverse()) }), hash);
  assert.notEqual(await accountHash({ ...record, memory_enabled: false }), hash);
  assert.notEqual(await accountHash({ ...record, metadata: { ...record.metadata, memories: MEMORY_COUNT + 1 } }), hash);
  assert.notEqual(await accountHash({ ...record, source_status: { ...record.source_status, memories: 500 } }), hash);
});
