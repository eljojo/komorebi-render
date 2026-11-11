// node scripts/pin.mjs [sha|ref]   Pin komorebi.json to a commit, resolved against the mirror (cloned or fetched on the way).
// No argument pins the tip of the default branch. Writes the full sha: the exporter runs from exactly that commit.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadPin } from '../src/config.js';
import { resolveCommit } from '../src/engine.js';

const file = fileURLToPath(new URL('../komorebi.json', import.meta.url));
const pin = loadPin(file);
const config = loadConfig();
const sha = await resolveCommit({ config, pin, ref: process.argv[2] ?? 'HEAD' });
// Linux runs the engine's Playwright against Nix's Chromium, which only one Playwright version can drive;
// the flake's playwright check compares this to nixpkgs' playwright-driver.
const engine = JSON.parse(execFileSync('git', ['-C', config.mirror, 'show', `${sha}:test-gl/package.json`], { encoding: 'utf8' }));
const next = { ...JSON.parse(readFileSync(file, 'utf8')), commit: sha, playwright: engine.dependencies.playwright };
const {mkdtempSync,rmSync,existsSync}=await import('node:fs');
const {tmpdir}=await import('node:os');
const {join}=await import('node:path');
const {pathToFileURL}=await import('node:url');
const stage=mkdtempSync(join(tmpdir(),'komorebi-render-profiles-'));
try{
  const archive=execFileSync('git',['-C',config.mirror,'archive',sha],{maxBuffer:1<<30});
  execFileSync('tar',['-x','-C',stage],{input:archive});
  if(existsSync(join(stage,'komorebi-session.js'))){
    const {QUALITY_PROFILES,PRESENTATION_PROFILES}=await import(pathToFileURL(join(stage,'komorebi-session.js')).href);
    next.sessions={quality:Object.keys(QUALITY_PROFILES),presentation:Object.keys(PRESENTATION_PROFILES)};
  }else delete next.sessions;
}finally{rmSync(stage,{recursive:true,force:true});}
writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
console.log(sha === pin.commit ? `already pinned to ${sha}` : `pinned ${pin.commit.slice(0, 12)} -> ${sha}`);
