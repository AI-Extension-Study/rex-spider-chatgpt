import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The REX modules change on their default branches. Every GitHub dependency
// names the full commit the extension that bundles this module ships, so the
// tests run against the code it bundles, and the lockfile resolves that same
// commit. To take a newer commit, change it in the extension first.
type Json = Record<string, Record<string, string> | undefined>;
const read = (file: string): Json & { packages?: Record<string, { resolved?: string }> } =>
  JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
const githubSpecs = (pkg: Json): Array<[string, string]> =>
  Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.overrides })
    .filter(([, spec]) => typeof spec === 'string' && /^(github:|git\+|git:)/.test(spec));

test('every GitHub dependency is pinned to a full commit', () => {
  assert.deepEqual(githubSpecs(read('package.json')).filter(([, spec]) => !/#[0-9a-f]{40}$/.test(spec)), []);
});

test('the lockfile resolves each GitHub dependency to its pinned commit', () => {
  const lock = read('package-lock.json');
  const mismatched = githubSpecs(read('package.json')).flatMap(([name, spec]) => {
    const pinned = spec.match(/#([0-9a-f]{40})$/)?.[1];
    const resolved = (lock.packages?.[`node_modules/${name}`]?.resolved ?? '').match(/#([0-9a-f]{40})$/)?.[1];
    return pinned !== undefined && pinned === resolved ? [] : [`${name}: package.json ${pinned ?? 'unpinned'}, lockfile ${resolved ?? 'none'}`];
  });
  assert.deepEqual(mismatched, []);
});
