// @ts-nocheck

// Checks a rex-conversation record of this spider, as the data-upload module
// gets it (JSON), against the shared conversation record (format 1) and the
// keys this spider adds to it. Returns the problems as short sentences that
// carry no value from the record, so a failure prints nothing a chat held.
// Pure.

const STANDARD = ['identifier', 'parent', 'speaker', 'when', 'on_current_branch', 'text_chars', 'text_words', 'citation_count', 'search_result_count', 'attachments']
const COUNTS = ['text_chars', 'text_words', 'citation_count', 'search_result_count', 'attachments']
// The extras after the standard keys: the content type and status of the
// turn's message, and on a reply the model and how many messages it folds.
const USER_TURN = [...STANDARD, 'content_type', 'status']
const ASSISTANT_TURN = [...STANDARD, 'content_type', 'status', 'model_slug', 'nodes']

const SUMMARY_KEYS = new Set(['name', 'platform', 'identifier', 'format_version', 'is_summary', 'date', 'started', 'ended', 'turns', 'metadata'])
const DETAIL_KEYS = new Set([...SUMMARY_KEYS, 'turns_complete', 'user_agent'])
const REQUIRED = ['name', 'platform', 'identifier', 'format_version', 'is_summary', 'date', 'ended', 'turns', 'metadata']

// The list keys a summary keeps, and the conversation keys a detail keeps,
// each with the hashes of the title and the project's ids.
const HASHES = ['title_hash', 'gizmo_id_hash', 'conversation_template_id_hash']
const SUMMARY_METADATA = ['create_time', 'update_time', 'is_archived', 'is_starred', 'pinned_time', 'is_temporary_chat', 'is_do_not_remember', 'memory_scope', 'async_status', ...HASHES]
const DETAIL_METADATA = [
  'conversation_id', 'create_time', 'update_time', 'default_model_slug', 'is_archived', 'is_starred', 'pinned_time', 'is_temporary_chat',
  'is_do_not_remember', 'memory_scope', 'is_study_mode', 'current_node', 'gizmo_type', ...HASHES, 'mapping',
]

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/
const SHA256 = /^[0-9a-f]{64}$/
const TYPE_NAME = /^[a-z0-9_.-]{1,64}$/
const STATUSES = new Set(['finished_successfully', 'in_progress', 'unrecognised'])
const USER_AGENTS = new Set(['Browser', 'App (Mobile or Desktop)'])

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
const isCountOrNull = (value) => value === null || isCount(value)
const isId = (value) => typeof value === 'string' && value !== ''
const sameKeys = (object, keys) => JSON.stringify(Object.keys(object)) === JSON.stringify(keys)
const sameKeySet = (object, keys) => JSON.stringify(Object.keys(object).sort()) === JSON.stringify([...keys].sort())
// Epoch ms of an ISO instant. Date.parse reads milliseconds at most, and the
// digits past them are cut, as a DateString's timestamp() cuts them.
const msOf = (iso) => Date.parse(iso.replace(/(\.\d{3})\d+Z$/, '$1Z').replace(/\.(\d{1,2})Z$/, (_, digits) => `.${digits.padEnd(3, '0')}Z`))

function checkTurns(turns, complete, problems) {
  const seen = new Set()
  let previousWhen = null
  const branches = new Set(turns.map((turn) => turn?.on_current_branch === null))
  if (branches.size > 1) problems.push('on_current_branch is null on some turns and not on others')
  turns.forEach((turn, at) => {
    const where = `turn ${at}`
    if (!isObject(turn)) {
      problems.push(`${where} is not an object`)
      return
    }
    if (turn.speaker === 'user') {
      if (!sameKeys(turn, USER_TURN)) problems.push(`${where}: a user turn's keys are not the standard ones in order, then content_type and status`)
      if (turn.citation_count !== 0 || turn.search_result_count !== 0) problems.push(`${where}: a user turn has citations or search results`)
    } else if (turn.speaker === 'assistant') {
      if (!sameKeys(turn, ASSISTANT_TURN)) problems.push(`${where}: an assistant turn's keys are not the standard ones in order, then content_type, status, model_slug and nodes`)
      if (!(Number.isSafeInteger(turn.nodes) && turn.nodes > 0)) problems.push(`${where}: nodes is not a positive count`)
      if (turn.model_slug !== null && !TYPE_NAME.test(turn.model_slug ?? '') && turn.model_slug !== 'unrecognised') problems.push(`${where}: model_slug is not a type name or null`)
    } else {
      problems.push(`${where}: speaker is not user or assistant`)
    }
    if (!isId(turn.identifier)) problems.push(`${where}: identifier is not an id`)
    else if (seen.has(turn.identifier)) problems.push(`${where}: identifier repeats an earlier turn's`)
    if (turn.parent !== null && !isId(turn.parent)) problems.push(`${where}: parent is not an id or null`)
    // The record says it holds every turn, so a parent must be one of them,
    // above it.
    if (complete === true && turn.parent !== null && !seen.has(turn.parent)) problems.push(`${where}: parent names no earlier turn of a complete record`)
    if (turn.when !== null && !INSTANT.test(turn.when ?? '')) problems.push(`${where}: when is not an instant or null`)
    if (turn.when !== null && INSTANT.test(turn.when ?? '')) {
      if (previousWhen !== null && msOf(turn.when) < msOf(previousWhen)) problems.push(`${where}: turns are not oldest first`)
      previousWhen = turn.when
    }
    if (turn.on_current_branch !== null && typeof turn.on_current_branch !== 'boolean') problems.push(`${where}: on_current_branch is not a flag or null`)
    for (const key of COUNTS) {
      if (!isCountOrNull(turn[key])) problems.push(`${where}: ${key} is not a count or null`)
    }
    if (turn.content_type !== null && !TYPE_NAME.test(turn.content_type ?? '')) problems.push(`${where}: content_type is not a type name or null`)
    if (turn.status !== null && !STATUSES.has(turn.status)) problems.push(`${where}: status is not in its closed set or null`)
    seen.add(turn.identifier)
  })
}

function checkHashes(metadata, problems) {
  for (const key of HASHES) {
    if (metadata[key] !== null && !SHA256.test(metadata[key] ?? '')) problems.push(`metadata.${key} is not a SHA-256 in hex or null`)
  }
}

export function checkRecord(record, mark) {
  if (!isObject(record) || record.name !== 'rex-conversation' || record.platform !== 'chatgpt') return ['not a rex-conversation record of this spider']
  const problems = []
  if (mark !== undefined && JSON.stringify(record).includes(mark)) problems.push('the record holds text from the chat')
  if (!isId(record.identifier)) problems.push('identifier is not an id')
  if (record.format_version !== 1) problems.push('format_version is not 1')
  if (typeof record.is_summary !== 'boolean') return [...problems, 'is_summary is not a flag']
  const allowed = record.is_summary ? SUMMARY_KEYS : DETAIL_KEYS
  if (Object.keys(record).some((key) => !allowed.has(key))) problems.push('the record has a key the layout does not name')
  if (REQUIRED.some((key) => !(key in record))) problems.push('the record lacks a key the layout requires')
  if (!INSTANT.test(record.ended ?? '')) problems.push('ended is not an instant')
  if ('started' in record && !INSTANT.test(record.started ?? '')) problems.push('started is not an instant')
  if (!isObject(record.metadata)) return [...problems, 'metadata is not an object']
  checkHashes(record.metadata, problems)
  if (record.is_summary) {
    if (!Array.isArray(record.turns) || record.turns.length !== 0) problems.push('a summary record has turns')
    if (INSTANT.test(record.ended ?? '') && record.date !== msOf(record.ended)) problems.push('date is not ended in epoch ms')
    if (!sameKeySet(record.metadata, SUMMARY_METADATA)) problems.push('summary metadata keys are not the list keys the design keeps')
    return problems
  }
  const dated = 'started' in record ? record.started : record.ended
  if (INSTANT.test(dated ?? '') && record.date !== msOf(dated)) problems.push('date is not started in epoch ms, or ended when there is no start')
  if (typeof record.turns_complete !== 'boolean') problems.push('turns_complete is not a flag')
  if (!USER_AGENTS.has(record.user_agent)) problems.push('user_agent is not one of its two values')
  if (!sameKeySet(record.metadata, DETAIL_METADATA)) problems.push('detail metadata keys are not the conversation keys the design keeps')
  if (record.metadata.conversation_id !== record.identifier) problems.push('metadata.conversation_id is not the record\'s chat')
  if (!isObject(record.metadata.mapping)) problems.push('metadata.mapping is not the tree\'s skeleton')
  else if (record.metadata.current_node !== null && !Object.hasOwn(record.metadata.mapping, record.metadata.current_node ?? '')) problems.push('metadata.current_node names no node of the skeleton')
  if (!Array.isArray(record.turns)) return [...problems, 'turns is not a list']
  checkTurns(record.turns, record.turns_complete, problems)
  return problems
}
