/// <reference path="../../plugin/node_modules/@types/bun/index.d.ts" />
// Explicit -e only. Read host events; no tools, provider, network, submission, prompts or event rewrites.
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ExtensionAPI } from '../../plugin/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const codex = (m: {provider?: string; api?: string}) => m.provider === 'openai-codex' && m.api === 'openai-codex-responses';

export default function observe(pi: ExtensionAPI) {
  const dir = process.env.AWAY_ACCEPT_DIR;
  if (!dir || !isAbsolute(dir)) throw Error('Acceptance observer requires a dedicated absolute directory');
  const {run, marker, note} = JSON.parse(readFileSync(join(dir,'scenario.json'), 'utf8'));
  if (!/^[0-9a-f]{32}$/.test(run) || ![marker,note].every(s => /^[a-z]+ [a-z]+$/.test(s))) throw Error('Invalid acceptance scenario');
  let session = '', fd: number | undefined;
  let sawEnd = false;
  const record = (event: string, data: Record<string, unknown> = {}, at = Date.now()) => {
    if (fd !== undefined) writeSync(fd, JSON.stringify({run, session, event, at, ...data})+'\n');
  };
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');
  pi.on('session_start', (_,ctx) => {
    if (ctx.agent.kind !== 'main' || ctx.mode !== 'tui') return;
    fd = openSync(join(dir, 'host.ndjson'), 'wx', 0o600);
    session = digest(ctx.sessionManager.getSessionId());
    record('session', {canary:basename(ctx.cwd) === 'work-AWAY-CHECK-'+run});
  });
  const unsub = pi.events.on('omp-away:offer-observed', raw => {
    // Production metadata notification; no HTML, form values or submission capability.
    const {toolCallId, requestId} = raw as {toolCallId:string; requestId:string};
    record('offered', {tool:digest(toolCallId),request:digest(requestId)});
  });
  pi.on('agent_start', (_,ctx) => { if (ctx.agent.kind === 'main') record('agent-start'); });
  pi.on('message_end', (e,ctx) => {
    if (ctx.agent.kind !== 'main' || e.message.role !== 'assistant') return;
    const m = e.message;
    for (const block of m.content) {
      if (block.type === 'toolCall' && block.name === 'ask') record('model-asked',{tool:digest(block.id),paidCodex:codex(m)});
    }
    if (sawEnd && m.stopReason === 'stop') {
      const text = norm(m.content.flatMap(b => b.type === 'text' ? [b.text] : []).join(' '));
      record('model-received',{echo:text.includes('blue') && text.includes(note),paidCodex:codex(m)});
    }
  });
  pi.on('tool_execution_start',(e,ctx) => {
    if (ctx.agent.kind !== 'main') return;
    if (e.toolName !== 'ask') { record('unexpected-tool'); return; }
    const tools = pi.getAllTools().filter(t => t.name === 'ask');
    record('ask-start',{tool:digest(e.toolCallId),builtin:tools.length === 1 && tools[0].sourceInfo.path === '<builtin:ask>' && tools[0].sourceInfo.source === 'builtin'});
  });
  pi.on('tool_execution_end',(e,ctx) => {
    if (ctx.agent.kind !== 'main' || e.toolName !== 'ask') return;
    const result = e.result as {details?:{timedOut?:boolean;answers?:unknown[]};content?:{type:string;text?:string}[]};
    const block = result?.content?.[0];
    const prefix = 'User answers:\n';
    let values: {mode:string;note:string} | null = null;
    if (block?.type === 'text' && block.text?.startsWith(prefix)) {
      try {
        const v = JSON.parse(block.text.slice(prefix.length).split('\nOption notes:\n',1)[0]);
        // No unrecognized result contents go to disk.
        if (v && Object.keys(v).length === 2 && v.mode === 'blue' && v.note === note) values = {mode:v.mode,note:v.note};
      } catch { /* report mismatch without logging private output */ }
    }
    record('native-end',{tool:digest(e.toolCallId),ok:!e.isError && !result?.details?.timedOut && Array.isArray(result?.details?.answers),values});
    sawEnd = true;
  });
  pi.on('agent_end', (_,ctx) => {
    if (ctx.agent.kind !== 'main') return;
    for (const e of ctx.sessionManager.getEntries()) {
      if (e.type !== 'model_usage' || !['away-brief','away-consult','away-extract'].includes(e.purpose)) continue;
      const reply = e.completion?.reply ?? '';
      record(e.purpose.slice(5), {entry:digest(e.id),paidCodex:codex(e),ok:e.stopReason === 'stop' && !!reply.trim(),marker:norm(reply).includes(marker)}, Date.parse(e.timestamp));
    }
    record('agent-end');
  });
  pi.on('session_shutdown', (_,ctx) => {
    if (ctx.agent.kind !== 'main' || fd === undefined) return;
    record('shutdown'); unsub(); closeSync(fd); fd = undefined;
  });
}
