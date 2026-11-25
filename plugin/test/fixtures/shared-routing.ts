import assert from 'node:assert/strict';
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { openAdmin, type Admin } from '../../src/runtime';
import { connectRuntime } from '../../src/runtime/routing';

// Only the disposable broker test supplies this input. Never print its token.
const init = JSON.parse(await Bun.stdin.text()) as {
  url:string; desktopToken:string; stateDir:string; python:string; tokenFile:string; mode:string;
};
const env = {
  OMP_AWAY_URL:init.url, OMP_AWAY_STATE_DIR:init.stateDir,
  OMP_AWAY_TOKEN_FILE:init.tokenFile, OMP_AWAY_TUNNEL_PYTHON:init.python,
};
const active:Admin[] = [];
const errors:string[] = [];
async function desktop() {
  const notices:string[] = [];
  const ctx = {ui:{notify(text:string,type:string){notices.push(text);if(type==='error')errors.push(text)},setWidget(){}}} as unknown as ExtensionContext;
  const admin = await openAdmin(ctx,()=>true,()=>true,{
    env,connect:connectRuntime,copy:async()=>{throw Error('Unexpected enrollment')},
  });
  assert(admin);
  active.push(admin);
  return {admin,notices};
}
function status(notices:string[], enabled:boolean) {
  assert.match(notices.at(-1) ?? '', enabled ? /Ring immediately: on.*Fallback: 30s/ : /Ring immediately: off.*Fallback: 30s/);
}
try {
  if(init.mode==='legacy' || init.mode==='malformed') {
    await assert.rejects(desktop(),init.mode==='legacy' ? /shared-routing-upgrade-required/ : /secure_helper_protocol_error/);
    console.log(JSON.stringify({rejected:true}));
  } else {
    const a=await desktop(), b=await desktop();
    await a.admin.command(''); await a.admin.command('');
    await b.admin.command('fallback 30');
    await a.admin.command('status'); status(a.notices,true);
    await b.admin.command('status'); status(b.notices,true);
    const c=await desktop();
    await c.admin.command('status'); status(c.notices,true);
    await b.admin.command('off');
    await a.admin.command('status'); status(a.notices,false);
    await c.admin.command('status'); status(c.notices,false);
    await a.admin.close(); active.splice(active.indexOf(a.admin),1);
    await c.admin.command('on');
    await b.admin.command('status'); status(b.notices,true);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({globalEnable:true,inherited:true,globalDisable:true,originExitSafe:true}));
  }
} finally {
  await Promise.all(active.map(admin=>admin.close()));
}
