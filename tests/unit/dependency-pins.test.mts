import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// This package is a module: the extension installs it, and npm takes each
// shared module's commit from the extension's own pin. So a runtime dependency
// on a GitHub module names no commit or ref: npm accepts any commit of that
// repo for it and keeps the extension's single copy, while a commit here that
// differs from the extension's makes npm install a second copy under this
// package, which registers with an instance the extension never runs. Dev-only
// GitHub modules are pinned to a full commit. This repo's own installs take
// their commits from the lockfile, which holds the ones the extension ships.
type Lock = { packages: Record<string, { resolved?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> };
const read = (file: string) => JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
const pkg = read('package.json') as Record<string, Record<string, string> | undefined>;
const lock = read('package-lock.json') as Lock;
const runtime: Record<string, string> = { ...pkg.dependencies };
const devOnly: Record<string, string> = { ...pkg.devDependencies };
const FULL_COMMIT = /#([0-9a-f]{40})$/;
const notFromRegistry = (spec: string) => !spec.startsWith('npm:') && /[/:]/.test(spec);
// Anything installed from GitHub, whatever form its spec takes.
const fromGitHub = Object.entries(lock.packages)
  .filter(([path, entry]) => path !== '' && /^git\+|github\.com|codeload\.github/.test(entry.resolved ?? ''));

test('every runtime dependency from GitHub names no commit or ref, so the extension\'s pin decides it', () => {
  assert.deepEqual(Object.entries(runtime).filter(([, spec]) => notFromRegistry(spec) && spec.includes('#')), []);
});

test('every dev-only dependency from GitHub names a full commit', () => {
  assert.deepEqual(Object.entries(devOnly).filter(([, spec]) => notFromRegistry(spec) && !FULL_COMMIT.test(spec)), []);
});

test('every GitHub package the lockfile installs is declared here, installed once, at a full commit', () => {
  assert.ok(fromGitHub.length > 0, 'the lockfile installs nothing from GitHub, so this test checks nothing');
  const wrong = fromGitHub.flatMap(([path, entry]) => {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (path !== `node_modules/${name}`) return [`${path}: a second copy under another package`];
    if (!(name in runtime) && !(name in devOnly)) return [`${name}: installed from GitHub but not declared here, so another package's spec decides its commit`];
    return FULL_COMMIT.test(entry.resolved ?? '') ? [] : [`${name}: the lockfile resolves no full commit (${entry.resolved})`];
  });
  assert.deepEqual(wrong, []);
});

test('the lockfile root entry names the same dependencies as package.json', () => {
  const root = lock.packages[''];
  assert.deepEqual({ ...root.dependencies, ...root.devDependencies }, { ...runtime, ...devOnly });
});
