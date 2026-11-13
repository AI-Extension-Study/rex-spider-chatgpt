// One chat's detail (GET /backend-api/conversation/{id}) into its turns, the
// counts on each, and the content-free skeleton of its tree. Pure.
//
// The detail holds a tree: mapping names each node by id, with its parent,
// its children and its message (null on the root). A turn is one prompt or
// one reply. A prompt is a user message that is not hidden. A reply is every
// visible assistant message from a prompt to the next prompt on its branch:
// to all, not hidden, and not thinking (thoughts, reasoning_recap). They fold
// into one turn, so text, a search call and more text is one reply; a retry
// is a second reply under the same prompt. System and tool messages, calls
// addressed to a tool, thinking and hidden messages are no turn, and stay in
// the skeleton.
//
// Turns are read from every node of the mapping, so a node that cannot be
// read, or that a link names and the mapping does not hold, loses only what
// it held. Either, or a part of the tree that hangs from no root (its parent
// links loop), leaves the turns incomplete.
import { type Counts, promptCounts, replyCounts } from './counts.mts';
import { field, instantOf, isObject, statusOf, typeName } from './forms.mts';
import { skeletonOf } from './skeleton.mts';

// At most this many turns, the newest kept, and their JSON at most this many
// characters (every value a turn holds is ASCII but an id), so one chat
// cannot fill the upload queue every collector shares. Either cut leaves the
// turns incomplete. The skeleton is not cut: it is sent whole, as before.
export const MAX_TURNS = 1000;
export const TURNS_JSON_LIMIT = 512 * 1024;

interface StandardTurn extends Counts {
  // The message's id, the key of its node: the prompt's, or the last message
  // a reply folds, which the next prompt names as its parent.
  readonly identifier: string;
  // The nearest turn above on its branch, by the same id; a node that could
  // not be read or that the tree does not hold is named, since it may have
  // been one. Null for the first turn.
  readonly parent: string | null;
  readonly speaker: 'user' | 'assistant';
  // create_time as an ISO instant, to the microsecond: the prompt's, or the
  // first message a reply folds. Null when it is not epoch seconds.
  readonly when: string | null;
  // Whether the turn is on the path from the root to current_node, a reply by
  // its first message. Null on every turn when that path cannot be traced: no
  // current_node, one the mapping does not hold, parent links that loop, or a
  // node on it that could not be read or is not held.
  readonly on_current_branch: boolean | null;
  // The content type of the prompt, or of the reply's last message, as a type
  // name.
  readonly content_type: string | null;
  // The same message's status: finished_successfully, in_progress, or
  // 'unrecognised' for any other string.
  readonly status: string | null;
}

export interface PromptTurn extends StandardTurn {
  readonly speaker: 'user';
}

export interface ReplyTurn extends StandardTurn {
  readonly speaker: 'assistant';
  // metadata.model_slug of the reply's last message, as a type name.
  readonly model_slug: string | null;
  // How many messages the reply folds.
  readonly nodes: number;
}

export type Turn = PromptTurn | ReplyTurn;

export interface Detail {
  // Oldest first by when; of two at one time, a message before its children.
  readonly turns: Turn[];
  // Whether turns hold every prompt and reply of the tree: every node read,
  // every node named held, a root, and no cut.
  readonly complete: boolean;
  readonly skeleton: Record<string, unknown>;
}

type Message = Readonly<Record<string, unknown>>;

interface TreeNode {
  readonly id: string;
  readonly parent: string | null;
  readonly children: readonly string[];
  readonly message: Message | null;
  readonly kind: 'prompt' | 'reply' | 'other';
}

// What a message is to the turns, or null when that cannot be told: a role
// that is not a string, metadata of another form, or a message to all whose
// content type is not a string.
function kindOf(message: Message): TreeNode['kind'] | null {
  const role = field(field(message, 'author'), 'role');
  if (typeof role !== 'string') {
    return null;
  }
  if (role !== 'user' && role !== 'assistant') {
    return 'other';
  }
  const metadata = field(message, 'metadata');
  if (metadata !== undefined && !isObject(metadata)) {
    return null;
  }
  if (field(metadata, 'is_visually_hidden_from_conversation') === true) {
    return 'other';
  }
  if (role === 'user') {
    return 'prompt';
  }
  const recipient = field(message, 'recipient');
  if (typeof recipient !== 'string') {
    return null;
  }
  if (recipient !== 'all') {
    return 'other';
  }
  const type = field(field(message, 'content'), 'content_type');
  if (typeof type !== 'string') {
    return null;
  }
  return type === 'thoughts' || type === 'reasoning_recap' ? 'other' : 'reply';
}

// A node in the form all 459 nodes of the capture had (id, message, parent,
// children), or null.
function readNode(id: string, raw: unknown): TreeNode | null {
  const parent = field(raw, 'parent');
  const children = field(raw, 'children');
  const message = field(raw, 'message');
  if (field(raw, 'id') !== id || (parent !== null && typeof parent !== 'string')) {
    return null;
  }
  if (!Array.isArray(children) || !children.every((child) => typeof child === 'string')) {
    return null;
  }
  if (message === null) {
    return { id, parent, children, message: null, kind: 'other' };
  }
  const kind = isObject(message) ? kindOf(message) : null;
  return kind === null ? null : { id, parent, children, message: message as Message, kind };
}

// The path below the last turn, one link per node, read upwards.
interface Link {
  readonly node: TreeNode;
  readonly up: Link | null;
}

// A turn while the tree is walked. A reply's links are its folded nodes'.
interface Prompt {
  readonly node: TreeNode;
  readonly above: Above;
}

interface Reply {
  readonly folded: TreeNode[];
  readonly links: Link[];
  readonly above: Above;
}

// What a turn hangs from: a turn, the id of a node not read or not held, or
// nothing.
type Above = Prompt | Reply | string | null;

interface Visit {
  readonly node: TreeNode;
  readonly above: Above;
  // The reply still taking messages on this branch.
  readonly open: Reply | null;
  readonly up: Link | null;
}

const lastOf = (reply: Reply): TreeNode => reply.folded[reply.folded.length - 1];
const identifierOf = (turn: Prompt | Reply): string => ('node' in turn ? turn.node.id : lastOf(turn).id);
const parentOf = (above: Above): string | null => (above === null || typeof above === 'string' ? above : identifierOf(above));

// The ids from current_node up to the root, or null when that path cannot be
// traced.
function currentBranch(nodes: ReadonlyMap<string, TreeNode | null>, current: unknown): ReadonlySet<string> | null {
  if (typeof current !== 'string') {
    return null;
  }
  const path = new Set<string>();
  for (let at: string | null = current; at !== null;) {
    const node = nodes.get(at);
    if (node === undefined || node === null || path.has(at)) {
      return null;
    }
    path.add(at);
    at = node.parent;
  }
  return path;
}

// The links between `stop` and `link`, as a path of their own whose top has
// nothing above it: what lies between a reply's last message and the node
// where the tree branches, which is on every branch's path.
function after(link: Link | null, stop: Link): Link | null {
  const between: TreeNode[] = [];
  for (let at = link; at !== null && at !== stop; at = at.up) {
    between.push(at.node);
  }
  let path: Link | null = null;
  for (let at = between.length - 1; at >= 0; at -= 1) {
    path = { node: between[at], up: path };
  }
  return path;
}

function pathOf(link: Link): unknown[] {
  const path: unknown[] = [];
  for (let at: Link | null = link; at !== null; at = at.up) {
    path.push(at.node.message);
  }
  return path.reverse();
}

// The newest turns within both bounds, in their order. When the newest alone
// is over the bound, none is kept.
function newest(turns: readonly Turn[]): Turn[] {
  const kept: Turn[] = [];
  let length = 2;
  for (let at = turns.length - 1; at >= 0 && kept.length < MAX_TURNS; at -= 1) {
    const cost = JSON.stringify(turns[at]).length + (kept.length > 0 ? 1 : 0);
    if (length + cost > TURNS_JSON_LIMIT) {
      break;
    }
    length += cost;
    kept.push(turns[at]);
  }
  return kept.reverse();
}

export function parseDetail(json: unknown): Detail {
  const mapping = field(json, 'mapping');
  if (!isObject(mapping)) {
    return { turns: [], complete: false, skeleton: {} };
  }
  const nodes = new Map<string, TreeNode | null>();
  for (const [id, raw] of Object.entries(mapping)) {
    nodes.set(id, readNode(id, raw));
  }

  // Each node under its parent, by the parent links. A node whose parent is
  // null, not held or not read starts a walk.
  let whole = true;
  let rooted = false;
  let readable = 0;
  const below = new Map<string, TreeNode[]>();
  const starts: Visit[] = [];
  for (const node of nodes.values()) {
    if (node === null) {
      whole = false;
      continue;
    }
    readable += 1;
    if (node.children.some((child) => !nodes.has(child))) {
      whole = false;
    }
    const parent = node.parent === null ? null : nodes.get(node.parent);
    if (parent === undefined) {
      whole = false;
    }
    if (node.parent === null) {
      rooted = true;
    }
    const siblings = parent === null || parent === undefined ? undefined : below.get(parent.id);
    if (parent === null || parent === undefined) {
      starts.push({ node, above: node.parent, open: null, up: null });
    } else if (siblings === undefined) {
      below.set(parent.id, [node]);
    } else {
      siblings.push(node);
    }
  }

  // Depth first, so every turn is made after the turns above it. A reply ends
  // where the tree branches below it, so no message is in two turns and a
  // turn's identifier is above everything that hangs from it. The messages
  // between its last folded message and the branch, a search call say, are on
  // each branch's path.
  const made: Array<Prompt | Reply> = [];
  const stack = [...starts].reverse();
  let walked = 0;
  for (let visit = stack.pop(); visit !== undefined; visit = stack.pop()) {
    const { node, above, open, up } = visit;
    walked += 1;
    const link: Link = { node, up };
    let next: Omit<Visit, 'node'>;
    if (node.kind === 'prompt') {
      const prompt: Prompt = { node, above };
      made.push(prompt);
      next = { above: prompt, open: null, up: null };
    } else if (node.kind === 'reply') {
      const reply: Reply = open ?? { folded: [], links: [], above };
      if (open === null) {
        made.push(reply);
      }
      reply.folded.push(node);
      reply.links.push(link);
      next = { above: reply, open: reply, up: link };
    } else {
      next = { above, open, up: link };
    }
    const children = below.get(node.id) ?? [];
    const shared = children.length > 1 && next.open !== null
      ? { above: next.above, open: null, up: after(next.up, next.open.links[next.open.links.length - 1]) }
      : next;
    for (let at = children.length - 1; at >= 0; at -= 1) {
      stack.push({ node: children[at], ...shared });
    }
  }
  if (!rooted || walked < readable) {
    whole = false;
  }

  const branch = currentBranch(nodes, field(json, 'current_node'));
  const onBranch = (node: TreeNode): boolean | null => (branch === null ? null : branch.has(node.id));
  const timed = made.map((turn): { turn: Turn; at: bigint | null } => {
    const first = 'node' in turn ? turn.node : turn.folded[0];
    const when = instantOf(field(first.message, 'create_time'));
    const standard = {
      identifier: identifierOf(turn),
      parent: parentOf(turn.above),
      when: when === null ? null : when.toJSON(),
      on_current_branch: onBranch(first),
    };
    if ('node' in turn) {
      const { message } = turn.node;
      return {
        at: when?.value?.epochNanoseconds ?? null,
        turn: {
          identifier: standard.identifier, parent: standard.parent, speaker: 'user', when: standard.when, on_current_branch: standard.on_current_branch,
          ...promptCounts(message),
          content_type: typeName(field(field(message, 'content'), 'content_type')),
          status: statusOf(field(message, 'status')),
        },
      };
    }
    const { message } = lastOf(turn);
    return {
      at: when?.value?.epochNanoseconds ?? null,
      turn: {
        identifier: standard.identifier, parent: standard.parent, speaker: 'assistant', when: standard.when, on_current_branch: standard.on_current_branch,
        ...replyCounts(turn.folded.map((folded) => folded.message), pathOf(turn.links[turn.links.length - 1])),
        content_type: typeName(field(field(message, 'content'), 'content_type')),
        status: statusOf(field(message, 'status')),
        model_slug: typeName(field(field(message, 'metadata'), 'model_slug')),
        nodes: turn.folded.length,
      },
    };
  });
  // Oldest first; made is in walk order, so a sort that keeps the order of
  // equal times puts a message before its children. No time sorts last.
  timed.sort((a, b) => (a.at === null || b.at === null ? Number(a.at === null) - Number(b.at === null) : a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const turns = timed.map(({ turn }) => turn);
  const kept = newest(turns);
  return { turns: kept, complete: whole && kept.length === turns.length, skeleton: skeletonOf(mapping) };
}
