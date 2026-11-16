import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The REX modules change on their default branches. Every GitHub package the
// lockfile installs is a direct dependency pinned to a full commit, the one the
// extension ships for that module, so the tests run against the code it
// bundles: a module that arrives only through another one would follow that
// module's unpinned spec on the next lockfile refresh. To take a newer commit,
// change it in the extension first.
type Lock = { packages: Record<string, { resolved?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> };
const read = (file: string) => JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
const pkg = read('package.json') as Record<string, Record<string, string> | undefined>;
const lock = read('package-lock.json') as Lock;
const declared: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
const FULL_COMMIT = /#([0-9a-f]{40})$/;
// Anything installed from GitHub, whatever form its spec takes.
const fromGitHub = Object.entries(lock.packages)
  .filter(([path, entry]) => path !== '' && /^git\+|github\.com|codeload\.github/.test(entry.resolved ?? ''));

test('every GitHub package the lockfile installs is a direct dependency pinned to the commit it resolves', () => {
  assert.ok(fromGitHub.length > 0, 'the lockfile installs nothing from GitHub, so this test checks nothing');
  const wrong = fromGitHub.flatMap(([path, entry]) => {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const resolved = (entry.resolved ?? '').match(FULL_COMMIT)?.[1];
    const pinned = declared[name]?.match(FULL_COMMIT)?.[1];
    if (path !== `node_modules/${name}`) return [`${path}: a second copy under another package`];
    if (pinned === undefined) return [`${name}: installed from GitHub at ${resolved ?? 'no commit'}, but package.json pins no commit (${declared[name] ?? 'not declared'})`];
    return pinned === resolved ? [] : [`${name}: package.json ${pinned}, lockfile ${resolved ?? 'no commit'}`];
  });
  assert.deepEqual(wrong, []);
});

test('every dependency that is not from the npm registry names a full commit', () => {
  const registry = (spec: string) => spec.startsWith('npm:') || !/[/:]/.test(spec);
  assert.deepEqual(Object.entries(declared).filter(([, spec]) => !registry(spec) && !FULL_COMMIT.test(spec)), []);
});

test('the lockfile root entry names the same dependencies as package.json', () => {
  const root = lock.packages[''];
  assert.deepEqual({ ...root.dependencies, ...root.devDependencies }, declared);
});
