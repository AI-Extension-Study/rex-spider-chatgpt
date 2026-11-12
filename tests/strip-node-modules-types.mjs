// Loaded with `node --import` by the test:unit script. The @bric packages
// ship TypeScript source (rex-types exports src/types.mts). Node strips types
// from this repo's own .mts files but refuses to for files under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so this load hook strips
// those with Node's own stripper. A test then imports the real DateString,
// not a stand-in, with no bundler.
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const TYPESCRIPT_IN_NODE_MODULES = /\/node_modules\/.*\.mts$/;

registerHooks({
  load(url, context, nextLoad) {
    if (!TYPESCRIPT_IN_NODE_MODULES.test(url)) {
      return nextLoad(url, context);
    }
    const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'strip' });
    return { format: 'module', source, shortCircuit: true };
  },
});
