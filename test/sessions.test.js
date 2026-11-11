import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec } from '../src/spec.js';
import { exporterArgs } from '../src/exporter.js';

const raw={preset:'3',size:'1080p',seconds:10};
test('fixed render session is separate from legacy quality and supersampling',()=>{
  const spec=validateSpec({...raw,session:{quality:'balanced',presentation:'projector'},ss:2});
  assert.deepEqual(spec.session,{quality:'balanced',presentation:'projector'});
  assert.equal(spec.ss,2);
  assert.equal(spec.quality,undefined);
  assert.throws(()=>validateSpec({...raw,session:{},quality:'authored'}),/quality.*session|session.*quality/);
  assert.throws(()=>validateSpec({...raw,session:{quality:'mystery'}}),/session.quality/);
  assert.throws(()=>validateSpec({...raw,session:{presentation:'mystery'}}),/session.presentation/);
  assert.throws(()=>validateSpec({...raw,ss:2}),/ss/);
  const args=exporterArgs({script:'render-video.mjs',commit:'a'.repeat(40),folder:'/out',spec});
  assert.equal(args[args.indexOf('--session-json')+1],'/out/session-input.json');
  assert.equal(args[args.indexOf('--ss')+1],'2');
  assert.ok(!args.includes('--set'));
});

test('playlist display preference is portable and job selection can override it',()=>{
  const spec=validateSpec({playlist:{presentation:'projector',items:[{params:{}},{params:{}}]},size:'1080p',seconds:10,session:{presentation:'screen'}});
  assert.equal(spec.playlist.presentation,'projector');
  assert.equal(spec.session.presentation,'screen');
});
