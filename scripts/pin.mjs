// node scripts/pin.mjs [sha|ref]   Pin komorebi.json to a commit, resolved against the mirror (cloned or fetched on the way).
// No argument pins the tip of the default branch. Writes the full sha: the exporter runs from exactly that commit.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadPin } from '../src/config.js';
import { resolveCommit } from '../src/engine.js';

const file = fileURLToPath(new URL('../komorebi.json', import.meta.url));
const pin = loadPin(file);
const sha = await resolveCommit({ config: loadConfig(), pin, ref: process.argv[2] ?? 'HEAD' });
const next = { ...JSON.parse(readFileSync(file, 'utf8')), commit: sha };
writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
console.log(sha === pin.commit ? `already pinned to ${sha}` : `pinned ${pin.commit.slice(0, 12)} -> ${sha}`);
