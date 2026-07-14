#!/usr/bin/env node
// scripts/stamp-site.mjs: deploy-time stamping of the site's JS module URLs
// with a per-deploy version, applied to the deploy artifact only (repo
// sources keep the constant ?v=m10 fallback and stay static, per the
// no-build-step rule; this runs in the deploy job, like the wasm hash stamp
// in build-wasm.sh).
//
// Why this exists (D7 follow-up): web/_headers pins Cache-Control: no-cache
// at the Pages origin, but the diff.wtf zone's Browser Cache TTL setting
// rewrites the browser-facing header to max-age=14400 for edge-cacheable
// types (.js), verified against both diff.wtf (rewritten, even on MISS) and
// diffwtf.pages.dev (clean no-cache). Rather than depend on a dashboard
// setting, stamping keys every JS URL to the deploy: the always-revalidated
// HTML references app.js?v=<stamp>, app.js imports its modules and the wasm
// glue at ?v=<stamp>, and the glue already fetches the wasm by content hash
// (build-wasm.sh). A browser may then cache any JS or wasm file for as long
// as it likes: the URLs change when a deploy changes them, so a stale file
// can never be paired with a fresh one.
//
// Usage: node scripts/stamp-site.mjs <site-dir> <stamp>
// Every rewrite below must match exactly once or the script fails loudly,
// so a drifted import line breaks the deploy instead of shipping unstamped.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, stamp] = process.argv.slice(2);
if (!dir || !/^[0-9a-z]{4,40}$/.test(stamp ?? '')) {
  console.error('usage: stamp-site.mjs <site-dir> <stamp>   (stamp: 4 to 40 chars, [0-9a-z])');
  process.exit(2);
}

const REWRITES = [
  {
    file: 'index.html',
    replacements: [['src="js/app.js?v=m10"', `src="js/app.js?v=${stamp}"`]],
  },
  {
    file: 'js/app.js',
    replacements: [
      ["from './engine.js'", `from './engine.js?v=${stamp}'`],
      ["from './rowmodel.js'", `from './rowmodel.js?v=${stamp}'`],
      ["from './render.js'", `from './render.js?v=${stamp}'`],
      ["from './virtual.js'", `from './virtual.js?v=${stamp}'`],
      ["from './selection.js'", `from './selection.js?v=${stamp}'`],
      ["from './samples.js'", `from './samples.js?v=${stamp}'`],
    ],
  },
  {
    // The engine client spawns the worker and holds the main-thread
    // fallback import; both URLs must be deploy-keyed like static imports.
    file: 'js/engine.js',
    replacements: [
      ["new URL('./worker.js', import.meta.url)", `new URL('./worker.js?v=${stamp}', import.meta.url)`],
      ["import('../pkg/diffwtf_wasm.js?v=m10')", `import('../pkg/diffwtf_wasm.js?v=${stamp}')`],
    ],
  },
  {
    file: 'js/worker.js',
    replacements: [
      ["from '../pkg/diffwtf_wasm.js?v=m10'", `from '../pkg/diffwtf_wasm.js?v=${stamp}'`],
    ],
  },
  {
    // Not on the page path since M10 (the page reads rowmodel.js directly)
    // but still shipped and importable; keep its import graph deploy-keyed.
    file: 'js/assemble.js',
    replacements: [
      ["from './rowmodel.js'", `from './rowmodel.js?v=${stamp}'`],
    ],
  },
];

for (const { file, replacements } of REWRITES) {
  const path = join(dir, file);
  let text = readFileSync(path, 'utf8');
  for (const [needle, replacement] of replacements) {
    const count = text.split(needle).length - 1;
    if (count !== 1) {
      console.error(`stamp-site: expected exactly one occurrence of ${JSON.stringify(needle)} in ${file}, found ${count}`);
      process.exit(1);
    }
    text = text.replace(needle, replacement);
  }
  writeFileSync(path, text);
  console.log(`stamped ${file} (${replacements.length} URL${replacements.length === 1 ? '' : 's'}) with v=${stamp}`);
}
