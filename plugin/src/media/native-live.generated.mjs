/* Generated from omp 19.1.0 by tools/build-native-live.ts.
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

MIT License

Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// @bun
// node_modules/@oh-my-pi/pi-coding-agent/src/live/controller.ts
import * as os from "os";
import { AudioCapture } from "@oh-my-pi/pi-natives";
import { prompt, toError as toError2 } from "@oh-my-pi/pi-utils";

// away-registry:registry
import { lookup, register as nativeRegister } from "@oh-my-pi/pi-coding-agent/config/registry";
var register = (definition) => lookup(definition.id) ?? nativeRegister(definition);

// node_modules/@oh-my-pi/pi-coding-agent/src/config/auxiliary-model-policy.ts
var cfgNoJudge = register({ id: "models.noJudge", type: "boolean", default: false });
var cfgNoSpotlight = register({ id: "models.noSpotlight", type: "boolean", default: false });
var cfgOffline = register({ id: "models.offline", type: "boolean", default: false });

// node_modules/@oh-my-pi/pi-coding-agent/src/live/controller.ts
import { LIVE_DELEGATION_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent";

// node_modules/@oh-my-pi/pi-coding-agent/src/live/prompts/agent-final-message.md
var agent_final_message_default = `"Agent Final Message":

{{message}}
`;

// node_modules/@oh-my-pi/pi-coding-agent/src/live/prompts/live-instructions.md
var live_instructions_default = `<p>You: omp Live, realtime voice surface of one unified coding assistant for {{firstName}} (OS account: {{username}}).</p>
<critical>
- You + omp coding agent: one assistant, not separate agents.
- MUST delegate repository work, coding, tool use, verification to client backend.
- MUST keep conversation natural while client backend works.
</critical>
<p>User speaks to you. MUST respond directly, briefly, conversationally, with speech-friendly phrasing. NEVER use markdown, code blocks, long lists, or read implementation detail aloud unless requested.</p>
<p>Client backend: same assistant's execution surface; repository context, normal omp AgentSession, coding model, tools. Coding, investigation, repository changes, commands, or verification \u2192 MUST promptly create client delegation with complete plain-language request and all relevant conversational context; NEVER attempt tool work. New request during active work MUST create new delegation, steering same backend session.</p>
<p>Treat delegation context as own internal progress/results. NEVER describe backend as another assistant. MAY briefly acknowledge active work; NEVER claim changes, findings, or verification before backend reports. Commentary context: silent progress for conversational continuity; NEVER recite. Context beginning with <code>&quot;Agent Final Message&quot;:</code>: backend's final visible answer; MUST present useful result naturally as own, NEVER mention label, protocol, delegation, or backend.</p>
<p>Greetings, clarification, ordinary conversation needing no repository/tools: MUST answer directly without delegation. MUST ask concise clarifying question only when execution request genuinely underspecified.</p>
<critical>
MUST preserve one-assistant continuity: converse here, delegate execution, communicate returned result as own.
</critical>
`;

// node_modules/@oh-my-pi/pi-coding-agent/src/live/protocol.ts
import { isRecord } from "@oh-my-pi/pi-utils";
var LIVE_MODEL = "gpt-live-1-codex";
var CONTEXT_CHUNK_BYTES = 500;
function parsePayload(payload) {
  let parsed = payload;
  if (typeof payload === "string") {
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  return isRecord(parsed) ? parsed : null;
}
function parseSessionEvent(type, payload) {
  const session = payload.session;
  if (!isRecord(session) || typeof session.id !== "string")
    return null;
  if (typeof session.instructions === "string") {
    return { type, session: { id: session.id, instructions: session.instructions } };
  }
  return { type, session: { id: session.id } };
}
function parseTranscriptAddedEvent(type, payload) {
  const item = payload.item;
  if (!isRecord(item) || typeof item.text !== "string")
    return null;
  return { type, item: { text: item.text } };
}
function parseTurnDoneEvent(payload) {
  const turn = payload.turn;
  if (!isRecord(turn) || turn.role !== "user" && turn.role !== "assistant")
    return null;
  if (typeof turn.transcript !== "string")
    return null;
  return { type: "turn.done", turn: { role: turn.role, transcript: turn.transcript } };
}
function parseDelegationCreatedEvent(payload) {
  const item = payload.item;
  if (!isRecord(item) || item.type !== "delegation" || item.target !== "client" || typeof item.id !== "string") {
    return null;
  }
  if (!Array.isArray(item.content))
    return null;
  const content = [];
  for (const candidate of item.content) {
    if (!isRecord(candidate) || candidate.type !== "input_text" || typeof candidate.text !== "string")
      continue;
    content.push({ type: "input_text", text: candidate.text });
  }
  return {
    type: "delegation.created",
    item: { type: "delegation", target: "client", id: item.id, content }
  };
}
function stringifyErrorValue(value) {
  if (typeof value === "string")
    return value;
  if (value === undefined)
    return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return String(value);
  }
}
function parseErrorEvent(payload) {
  if (typeof payload.message === "string")
    return { type: "error", message: payload.message };
  const error = payload.error;
  if (isRecord(error) && typeof error.message === "string") {
    return { type: "error", message: error.message };
  }
  const message = stringifyErrorValue(error);
  return message === null ? null : { type: "error", message };
}
function parseLiveServerEvent(payload) {
  const parsed = parsePayload(payload);
  if (!parsed || typeof parsed.type !== "string")
    return null;
  switch (parsed.type) {
    case "session.started":
    case "session.updated":
      return parseSessionEvent(parsed.type, parsed);
    case "output_audio.delta":
      return typeof parsed.audio === "string" ? { type: parsed.type, audio: parsed.audio } : null;
    case "input_transcript.added":
    case "output_transcript.added":
      return parseTranscriptAddedEvent(parsed.type, parsed);
    case "turn.done":
      return parseTurnDoneEvent(parsed);
    case "delegation.created":
      return parseDelegationCreatedEvent(parsed);
    case "error":
      return parseErrorEvent(parsed);
    default:
      return { type: "unknown", wireType: parsed.type };
  }
}
function buildLiveSessionPayload(instructions, voice) {
  return {
    model: LIVE_MODEL,
    instructions,
    audio: { output: { voice } },
    delegation: { type: "client" }
  };
}
function buildLiveSessionUpdate(instructions, voice) {
  return {
    type: "session.update",
    session: { type: "realtime", instructions, audio: { output: { voice } }, delegation: { type: "client" } }
  };
}
function buildDelegationContextAppend(delegationItemId, text, channel) {
  return {
    type: "delegation.context.append",
    delegation_item_id: delegationItemId,
    ...channel === undefined ? {} : { channel },
    content: [{ type: "input_text", text }]
  };
}
function buildSessionClose() {
  return { type: "session.close" };
}
function utf8ByteLength(codePoint) {
  if (codePoint <= 127)
    return 1;
  if (codePoint <= 2047)
    return 2;
  if (codePoint <= 65535)
    return 3;
  return 4;
}
function chunkLiveContext(text) {
  if (text.length === 0)
    return [""];
  const chunks = [];
  let chunkStart = 0;
  let chunkBytes = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined)
      break;
    const characterLength = codePoint > 65535 ? 2 : 1;
    const characterBytes = utf8ByteLength(codePoint);
    if (chunkBytes + characterBytes > CONTEXT_CHUNK_BYTES) {
      chunks.push(text.slice(chunkStart, index));
      chunkStart = index;
      chunkBytes = 0;
    }
    chunkBytes += characterBytes;
    index += characterLength;
  }
  chunks.push(text.slice(chunkStart));
  return chunks;
}

// node_modules/@oh-my-pi/pi-coding-agent/src/live/output-activity.ts
var OUTPUT_ACTIVE_LEVEL = 0.015;
var OUTPUT_RELEASE_MS = 400;

class OutputActivity {
  #onRelease;
  #releaseTimer;
  constructor(onRelease) {
    this.#onRelease = onRelease;
  }
  get active() {
    return this.#releaseTimer !== undefined;
  }
  observe(level) {
    if (level <= OUTPUT_ACTIVE_LEVEL)
      return;
    clearTimeout(this.#releaseTimer);
    this.#releaseTimer = setTimeout(() => {
      this.#releaseTimer = undefined;
      this.#onRelease();
    }, OUTPUT_RELEASE_MS);
  }
  dispose() {
    clearTimeout(this.#releaseTimer);
    this.#releaseTimer = undefined;
  }
}

// node_modules/@oh-my-pi/pi-coding-agent/src/live/transport.ts
import { withOAuthAccess } from "@oh-my-pi/pi-ai";
import { getProxyForUrl, wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";

// node_modules/@oh-my-pi/pi-catalog/src/wire/codex.ts
var CODEX_BASE_URL = "https://chatgpt.com/backend-api";
var OFFICIAL_CODEX_URL = new URL(CODEX_BASE_URL);
var CODEX_CLIENT_VERSION = "0.169.0";
var OPENAI_HEADERS = {
  BETA: "OpenAI-Beta",
  CODEX_BETA_FEATURES: "x-codex-beta-features",
  ACCOUNT_ID: "chatgpt-account-id",
  ORIGINATOR: "originator",
  VERSION: "version",
  SESSION_ID: "session-id",
  THREAD_ID: "thread-id",
  INSTALLATION_ID: "x-codex-installation-id",
  WINDOW_ID: "x-codex-window-id",
  TURN_METADATA: "x-codex-turn-metadata",
  PARENT_THREAD_ID: "x-codex-parent-thread-id",
  SUBAGENT: "x-openai-subagent",
  RESPONSES_LITE: "x-openai-internal-codex-responses-lite",
  ATTESTATION: "x-oai-attestation",
  RESIDENCY: "x-openai-internal-codex-residency",
  ROUTING_HINT: "x-codex-routing-hint"
};
var JWT_CLAIM_PATH = "https://api.openai.com/auth";
function getCodexAccountId(accessToken) {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3)
      return;
    const decoded = Buffer.from(parts[1] ?? "", "base64").toString("utf-8");
    const payload = JSON.parse(decoded);
    const auth = payload[JWT_CLAIM_PATH];
    return auth?.chatgpt_account_id ?? undefined;
  } catch {
    return;
  }
}

// node_modules/@oh-my-pi/pi-catalog/src/wire/codex-version.ts
import * as fs from "fs";
import { getCodexClientVersionPath, logger } from "@oh-my-pi/pi-utils";
var NPM_LATEST_URL = "https://registry.npmjs.org/@openai/codex/latest";
var REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
var FETCH_TIMEOUT_MS = 5000;
var SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
var resolvedVersion = null;
var refreshStarted = false;
var refreshInFlight = null;
function compareSemver(a, b) {
  const pa = SEMVER_PATTERN.exec(a);
  const pb = SEMVER_PATTERN.exec(b);
  if (!pa || !pb)
    return 0;
  for (let i = 1;i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0)
      return diff;
  }
  return 0;
}
function newerOf(candidate) {
  if (!candidate || !SEMVER_PATTERN.test(candidate))
    return CODEX_CLIENT_VERSION;
  return compareSemver(candidate, CODEX_CLIENT_VERSION) > 0 ? candidate : CODEX_CLIENT_VERSION;
}
function isDynamicResolutionDisabled() {
  return Boolean(process.env.PI_AI_CODEX_CLIENT_VERSION) || false;
}
function readRecord() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getCodexClientVersionPath(), "utf-8"));
    if (typeof parsed !== "object" || parsed === null)
      return null;
    const version = Reflect.get(parsed, "version");
    const checkedAt = Reflect.get(parsed, "checkedAt");
    if (typeof version !== "string" || typeof checkedAt !== "number")
      return null;
    return { version, checkedAt };
  } catch {
    return null;
  }
}
async function refreshRecord() {
  try {
    const response = await fetch(NPM_LATEST_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok)
      return;
    const data = await response.json();
    const version = typeof data === "object" && data !== null ? Reflect.get(data, "version") : undefined;
    if (typeof version !== "string" || !SEMVER_PATTERN.test(version))
      return;
    const record = { version, checkedAt: Date.now() };
    const target = getCodexClientVersionPath();
    const temp = `${target}.${process.pid}.tmp`;
    await Bun.write(temp, JSON.stringify(record));
    fs.renameSync(temp, target);
  } catch (error) {
    logger.debug("codex client version refresh failed", { error: String(error) });
  }
}
function getCodexClientVersion() {
  const override = process.env.PI_AI_CODEX_CLIENT_VERSION;
  if (override)
    return override;
  if (resolvedVersion !== null)
    return resolvedVersion;
  if (isDynamicResolutionDisabled()) {
    resolvedVersion = CODEX_CLIENT_VERSION;
    return resolvedVersion;
  }
  const record = readRecord();
  resolvedVersion = newerOf(record?.version);
  if (!refreshStarted && (!record || Date.now() - record.checkedAt > REFRESH_INTERVAL_MS)) {
    refreshStarted = true;
    refreshInFlight = refreshRecord();
  }
  return resolvedVersion;
}

// node_modules/@oh-my-pi/pi-coding-agent/src/live/transport.ts
import { LiveWebRtcPeer } from "@oh-my-pi/pi-natives";
import { toError } from "@oh-my-pi/pi-utils";

// node_modules/@oh-my-pi/pi-coding-agent/src/config/resolve-config-value.ts
import { executeShell } from "@oh-my-pi/pi-natives";
import { $envExact, directoryIsEnterable, getProjectDir, logger as logger2, ptree, untilAborted } from "@oh-my-pi/pi-utils";
var COMMAND_FAILURE_RETRY_MS = 30000;
var commandResultCache = new Map;
var commandFailureRetryAt = new Map;
var commandInFlight = new Map;
var commandGeneration = new Map;
function isCommandConfigValue(valueConfig) {
  return valueConfig?.startsWith("!") === true;
}
function commandKey(valueConfig) {
  return valueConfig.slice(1).trim();
}
async function executeCommand(valueConfig) {
  const command = commandKey(valueConfig);
  const cached = commandResultCache.get(command);
  if (cached !== undefined)
    return cached;
  const retryAt = commandFailureRetryAt.get(command);
  if (retryAt !== undefined && Date.now() < retryAt)
    return;
  const existing = commandInFlight.get(command);
  if (existing)
    return await existing;
  const generation = commandGeneration.get(command) ?? 0;
  const promise = (async () => {
    const cwd = getProjectDir();
    if (!await directoryIsEnterable(cwd))
      return;
    return await runShellCommand(command, 1e4, cwd);
  })().then((result) => {
    if ((commandGeneration.get(command) ?? 0) !== generation)
      return result;
    if (result === undefined) {
      commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
    } else {
      commandFailureRetryAt.delete(command);
      commandResultCache.set(command, result);
    }
    return result;
  }).catch((error) => {
    const code = typeof error?.code === "string" ? error.code : "unknown";
    logger2.warn("config: !command value resolution failed", { code });
    if ((commandGeneration.get(command) ?? 0) === generation) {
      commandFailureRetryAt.set(command, Date.now() + COMMAND_FAILURE_RETRY_MS);
    }
    return;
  }).finally(() => {
    if (commandInFlight.get(command) === promise)
      commandInFlight.delete(command);
  });
  commandInFlight.set(command, promise);
  return await promise;
}
async function resolveConfigValue(valueConfig) {
  if (isCommandConfigValue(valueConfig))
    return await executeCommand(valueConfig);
  const envValue = $envExact(valueConfig);
  return envValue || valueConfig;
}
async function runShellCommand(command, timeoutMs, cwd = getProjectDir()) {
  try {
    if (process.platform === "win32") {
      let output = "";
      const result = await executeShell({ command, cwd, timeoutMs }, (err, chunk) => {
        if (!err)
          output += chunk;
      });
      if (result.timedOut || result.exitCode !== 0)
        return;
      const trimmed = output.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    const result = await ptree.exec(["/bin/sh", "-c", command], {
      cwd,
      timeout: timeoutMs,
      allowNonZero: true,
      allowAbort: true,
      detached: true,
      subreaper: process.platform === "linux"
    });
    if (!result.ok || result.exitError?.aborted)
      return;
    const trimmed = result.stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return;
  }
}

// node_modules/@oh-my-pi/pi-coding-agent/src/live/attestation.ts
import { deviceCheckGenerateToken } from "@oh-my-pi/pi-natives";
var CHATGPT_BUNDLE_ID = "com.openai.codex";
var APP_SESSION_ID = crypto.randomUUID();
function cborHeader(major, value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid CBOR length: ${value}`);
  if (value < 24)
    return Buffer.from([major + value]);
  if (value <= 255)
    return Buffer.from([major + 24, value]);
  if (value <= 65535) {
    const output = Buffer.allocUnsafe(3);
    output[0] = major + 25;
    output.writeUInt16BE(value, 1);
    return output;
  }
  if (value <= 4294967295) {
    const output = Buffer.allocUnsafe(5);
    output[0] = major + 26;
    output.writeUInt32BE(value, 1);
    return output;
  }
  throw new Error(`CBOR length is too large: ${value}`);
}
function cborUnsigned(value) {
  return cborHeader(0, value);
}
function cborText(value) {
  const text = Buffer.from(value, "utf8");
  return Buffer.concat([cborHeader(96, text.length), text]);
}
function cborMap(entries) {
  const values = [cborHeader(160, entries.length)];
  for (const [key, value] of entries)
    values.push(key, value);
  return Buffer.concat(values);
}
function attestationSignals() {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const locale = (resolved.locale || "unknown").slice(0, 64);
  const timezone = (resolved.timeZone || "unknown").slice(0, 64);
  const preferredLanguages = Buffer.concat([cborHeader(128, 1), cborText(locale)]);
  return cborMap([
    [cborUnsigned(0), cborUnsigned(1)],
    [cborUnsigned(1), preferredLanguages],
    [cborUnsigned(2), cborText(locale)],
    [cborUnsigned(3), cborText(timezone)],
    [cborUnsigned(4), cborUnsigned(0)],
    [cborUnsigned(5), cborUnsigned(1)],
    [cborUnsigned(6), cborText(APP_SESSION_ID.slice(0, 128))]
  ]);
}
function buildClientAttestation(result) {
  const entries = [];
  if (result.supported && result.tokenBase64) {
    entries.push([cborText("token"), cborText(result.tokenBase64)]);
  } else {
    entries.push([cborText("error_code"), cborUnsigned(result.supported ? 4 : 3)]);
  }
  entries.push([cborText("bundle_id"), cborText(CHATGPT_BUNDLE_ID)]);
  const signals = attestationSignals();
  entries.push([cborText("f"), Buffer.concat([cborHeader(64, signals.length), signals])]);
  if (result.latencyMs !== undefined && result.latencyMs !== null) {
    const latency = Buffer.allocUnsafe(9);
    latency[0] = 251;
    latency.writeDoubleBE(result.latencyMs, 1);
    entries.push([cborText("t"), latency]);
  }
  return `v1.${cborMap(entries).toString("base64url")}`;
}
async function generateCodexAttestation() {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    return;
  let result;
  try {
    result = await deviceCheckGenerateToken();
  } catch {
    return;
  }
  return JSON.stringify({ v: 1, s: 0, t: buildClientAttestation(result) });
}

// node_modules/@oh-my-pi/pi-coding-agent/src/live/voices.ts
var LIVE_VOICE_OPTIONS = [
  { value: "arbor", label: "Arbor" },
  { value: "breeze", label: "Breeze" },
  { value: "cove", label: "Cove" },
  { value: "ember", label: "Ember" },
  { value: "juniper", label: "Juniper" },
  { value: "maple", label: "Maple" },
  { value: "sol", label: "Sol" },
  { value: "spruce", label: "Spruce" },
  { value: "vale", label: "Vale" }
];
var DEFAULT_LIVE_VOICE = "sol";

// node_modules/@oh-my-pi/pi-coding-agent/src/live/settings.ts
var cfgLiveVoice = register({
  id: "live.voice",
  type: "string",
  default: DEFAULT_LIVE_VOICE,
  ui: {
    tab: "providers",
    group: "Services",
    label: "Live Voice",
    description: "Voice of realtime voice sessions; a custom live endpoint may take other names (set in config)",
    options: LIVE_VOICE_OPTIONS
  }
});
function validateLiveEndpoint(raw) {
  if (typeof raw !== "string" || !raw.trim())
    return;
  let protocol;
  try {
    protocol = new URL(raw.trim()).protocol;
  } catch {
    throw new Error(`live.endpoint must be an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`live.endpoint must be an http(s) URL, got ${JSON.stringify(raw)}`);
  }
}
var cfgLiveEndpoint = register({
  id: "live.endpoint",
  type: "string",
  default: undefined,
  validate: validateLiveEndpoint,
  ui: {
    tab: "providers",
    group: "Services",
    label: "Live Endpoint",
    description: "Base URL of an OpenAI Realtime WebRTC-compatible server (e.g. http://127.0.0.1:8080/v1) used for live voice instead of Codex; empty uses Codex"
  }
});
var cfgLiveApiKey = register({
  id: "live.apiKey",
  type: "string",
  default: undefined,
  credential: true,
  ui: {
    tab: "providers",
    group: "Services",
    label: "Live Endpoint API Key",
    description: "Bearer key sent only to the live endpoint: a literal, an environment variable name, or !command"
  }
});
function resolveLiveVoice(scope, voice) {
  return voice?.trim() || cfgLiveVoice.get(scope).trim() || DEFAULT_LIVE_VOICE;
}

// node_modules/@oh-my-pi/pi-coding-agent/src/live/transport.ts
var SIGNALING_URL = `${CODEX_BASE_URL}/codex/realtime/calls?intent=quicksilver&architecture=avas`;
var MAX_ERROR_BODY_LENGTH = 2048;
var SIDEBAND_CONNECT_ATTEMPTS = 5;
var SIDEBAND_CONNECT_TIMEOUT_MS = 15000;
var LIVE_PROVIDER = "openai-codex";
var LIVE_ORIGINATOR = "Codex Desktop";
var LIVE_CALL_ID_PATTERN = /^rtc_[\w-]+$/;
var LIVE_ENDPOINT_PROXY = "live";
var MAX_ENDPOINT_REDIRECTS = 5;
async function resolveLiveEndpoint(scope) {
  const baseUrl = cfgLiveEndpoint.get(scope)?.trim();
  if (!baseUrl)
    return;
  const keyConfig = cfgLiveApiKey.get(scope)?.trim();
  if (!keyConfig)
    return { baseUrl };
  const apiKey = await resolveConfigValue(keyConfig);
  if (!apiKey)
    throw new Error("live.apiKey resolved to no key: its command failed or printed nothing");
  return { baseUrl, apiKey };
}

class LiveSignalingError extends Error {
  status;
  errorMessage;
  constructor(status, message) {
    super(message);
    this.name = "LiveSignalingError";
    this.status = status;
    this.errorMessage = message;
  }
}
function parseLiveCallId(location) {
  if (!location)
    return;
  return location.split("?", 1)[0]?.split("/").find((segment) => LIVE_CALL_ID_PATTERN.test(segment));
}
function buildLiveSidebandUrl(callId) {
  const url = new URL(`https://api.openai.com/v1/live/${encodeURIComponent(callId)}`);
  url.protocol = "wss:";
  return url.toString();
}
function liveEndpointUrl(baseUrl, path) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
  return url;
}
function liveEndpointCallsUrl(baseUrl) {
  return liveEndpointUrl(baseUrl, "realtime/calls").toString();
}
function liveEndpointSidebandUrl(baseUrl, callId) {
  const url = liveEndpointUrl(baseUrl, "realtime");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("call_id", callId);
  return url.toString();
}
function parseLiveEndpointCallId(location) {
  const segment = location?.split(/[?#]/, 1)[0]?.split("/").filter((part) => part.length > 0).at(-1);
  if (!segment)
    return;
  try {
    return decodeURIComponent(segment) || undefined;
  } catch {
    return;
  }
}
function liveEndpointHeaders(endpoint) {
  return endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {};
}
function liveSessionHeaders(access, sessionId, realtimeSessionId, attestation) {
  const headers = {
    Authorization: `Bearer ${access.accessToken}`,
    "OpenAI-Alpha": "quicksilver=v2",
    "User-Agent": `Codex Desktop/${getCodexClientVersion()}`,
    "x-session-id": realtimeSessionId,
    [OPENAI_HEADERS.ORIGINATOR]: LIVE_ORIGINATOR,
    [OPENAI_HEADERS.VERSION]: getCodexClientVersion(),
    [OPENAI_HEADERS.SESSION_ID]: sessionId,
    [OPENAI_HEADERS.THREAD_ID]: sessionId
  };
  const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
  if (accountId)
    headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
  if (attestation)
    headers["x-oai-attestation"] = attestation;
  return headers;
}
function boundedErrorBody(body, statusText) {
  const normalized = body.trim().replaceAll(/\s+/g, " ");
  if (!normalized)
    return statusText || "empty response body";
  if (normalized.length <= MAX_ERROR_BODY_LENGTH)
    return normalized;
  return `${normalized.slice(0, MAX_ERROR_BODY_LENGTH)}\u2026`;
}
function abortReason(signal) {
  if (signal?.reason instanceof Error)
    return signal.reason;
  return new DOMException("Live connection aborted", "AbortError");
}

class LiveTransport {
  #options;
  #label;
  #peer;
  #sdpAnswer;
  #realtimeSessionId = crypto.randomUUID();
  #sideband;
  #state = "idle";
  #connectPromise;
  #closePromise;
  #sendTail = Promise.resolve();
  #muted = false;
  #unexpectedFailureReported = false;
  #abortListener;
  constructor(options) {
    this.#options = options;
    this.#label = options.endpoint ? "Live endpoint" : "Codex live";
    this.#abortListener = () => {
      this.close();
    };
    if (!options.signal?.aborted)
      options.signal?.addEventListener("abort", this.#abortListener, { once: true });
  }
  get sdpAnswer() {
    return this.#sdpAnswer;
  }
  connect() {
    if (this.#state === "connected")
      return Promise.resolve();
    if (this.#connectPromise)
      return this.#connectPromise;
    if (this.#state === "closing" || this.#state === "closed")
      return Promise.reject(new Error("Live transport is closed"));
    if (this.#options.signal?.aborted)
      return Promise.reject(abortReason(this.#options.signal));
    this.#state = "connecting";
    const operation = this.#connect().catch(async (error) => {
      await this.close();
      throw error;
    });
    this.#connectPromise = operation;
    return operation;
  }
  async#connect() {
    let offer = this.#options.sdpOffer;
    let peer;
    if (offer === undefined) {
      peer = this.#createPeer();
      this.#peer = peer;
      offer = await peer.createOffer();
    }
    if (this.#state !== "connecting")
      throw abortReason(this.#options.signal);
    const signaling = await this.#signal(offer);
    if (peer) {
      await peer.acceptAnswer(signaling.answer);
      peer.setMuted(this.#muted);
      await peer.waitForOpen();
    } else {
      this.#sdpAnswer = signaling.answer;
    }
    if (this.#state !== "connecting")
      throw abortReason(this.#options.signal);
    await this.#connectSideband(signaling.sideband);
    if (this.#state !== "connecting")
      throw abortReason(this.#options.signal);
    if (this.#options.endpoint) {
      const update = buildLiveSessionUpdate(this.#options.instructions, this.#options.voice);
      this.#sideband?.send(JSON.stringify(update));
    }
    this.#state = "connected";
  }
  #createPeer() {
    return new LiveWebRtcPeer((error, payload) => {
      if (error) {
        this.#reportFailure(error.message);
      } else {
        this.#handleServerEvent(payload);
      }
    }, (error, level) => {
      if (error) {
        this.#reportFailure(error.message);
      } else {
        this.#handleOutputLevel(level);
      }
    }, (error, message) => this.#reportFailure(error?.message ?? message));
  }
  async#signal(offer) {
    if (this.#options.endpoint)
      return await this.#signalEndpoint(offer, this.#options.endpoint);
    const attestation = await generateCodexAttestation();
    return await withOAuthAccess(this.#options.authStorage, LIVE_PROVIDER, (access) => this.#signalWithAccess(offer, access, attestation), {
      sessionId: this.#options.sessionId,
      signal: this.#options.signal,
      missingAccessMessage: "No Codex OAuth credential is available for a live call."
    });
  }
  async#signalWithAccess(offer, access, attestation) {
    const headers = new Headers({
      ...liveSessionHeaders(access, this.#options.sessionId, this.#realtimeSessionId, attestation),
      Accept: "*/*",
      "Content-Type": "application/json"
    });
    const fetchImpl = wrapFetchForProxy(fetch, LIVE_PROVIDER);
    this.#options.signal?.throwIfAborted();
    const response = await fetchImpl(SIGNALING_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sdp: offer,
        session: buildLiveSessionPayload(this.#options.instructions, this.#options.voice)
      }),
      signal: this.#options.signal
    });
    const responseBody = await response.text();
    if (!response.ok) {
      const detail = boundedErrorBody(responseBody, response.statusText);
      throw new LiveSignalingError(response.status, `Codex live signaling failed (${response.status}): ${detail}`);
    }
    const answer = responseBody;
    if (!answer.trim())
      throw new LiveSignalingError(response.status, "Codex live signaling returned an empty SDP answer");
    const callId = parseLiveCallId(response.headers.get("location"));
    if (!callId) {
      throw new LiveSignalingError(response.status, "Codex live signaling returned no valid call ID");
    }
    const sideband = {
      url: buildLiveSidebandUrl(callId),
      headers: liveSessionHeaders(access, this.#options.sessionId, this.#realtimeSessionId, attestation),
      proxyScope: LIVE_PROVIDER
    };
    return { answer, sideband };
  }
  async#signalEndpoint(offer, endpoint) {
    const credentials = liveEndpointHeaders(endpoint);
    let url = new URL(liveEndpointCallsUrl(endpoint.baseUrl));
    const origin = url.origin;
    for (let redirects = 0;; redirects++) {
      this.#options.signal?.throwIfAborted();
      const response = await fetch(url, {
        method: "POST",
        headers: { ...credentials, "Content-Type": "application/sdp" },
        body: offer,
        redirect: "manual",
        proxy: getProxyForUrl(LIVE_ENDPOINT_PROXY, url),
        signal: this.#options.signal
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const target = location ? new URL(location, url) : undefined;
        const preservesPost = response.status === 307 || response.status === 308;
        if (!target || !preservesPost || target.origin !== origin || redirects >= MAX_ENDPOINT_REDIRECTS) {
          throw new LiveSignalingError(response.status, `Live endpoint signaling was redirected (${response.status}) to ${location ?? "nowhere"}; ` + "only same-origin 307/308 redirects are followed");
        }
        url = target;
        continue;
      }
      const answer = await response.text();
      if (!response.ok) {
        const detail = boundedErrorBody(answer, response.statusText);
        throw new LiveSignalingError(response.status, `Live endpoint signaling failed (${response.status}): ${detail}`);
      }
      if (!answer.trim()) {
        throw new LiveSignalingError(response.status, "Live endpoint signaling returned an empty SDP answer");
      }
      const callId = parseLiveEndpointCallId(location);
      if (!callId) {
        throw new LiveSignalingError(response.status, "Live endpoint signaling returned no call ID in Location");
      }
      const sideband = {
        url: liveEndpointSidebandUrl(endpoint.baseUrl, callId),
        headers: credentials,
        proxyScope: LIVE_ENDPOINT_PROXY
      };
      return { answer, sideband };
    }
  }
  async#connectSideband(sideband) {
    let failure = new Error(`${this.#label} sideband connection failed`);
    for (let attempt = 0;attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt++) {
      this.#options.signal?.throwIfAborted();
      try {
        await this.#openSideband(sideband);
        return;
      } catch (cause) {
        failure = toError(cause);
        if (this.#options.signal?.aborted)
          throw abortReason(this.#options.signal);
        if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS)
          await Bun.sleep(200 * 2 ** attempt);
      }
    }
    throw failure;
  }
  async#openSideband(sideband) {
    const options = {
      headers: sideband.headers,
      proxy: getProxyForUrl(sideband.proxyScope, new URL(sideband.url))
    };
    const socket = Reflect.construct(WebSocket, [sideband.url, options]);
    socket.binaryType = "nodebuffer";
    const { promise, resolve, reject } = Promise.withResolvers();
    let opened = false;
    let settled = false;
    let timeout;
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      this.#options.signal?.removeEventListener("abort", onAbort);
    };
    const rejectConnect = (error) => {
      if (settled)
        return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      socket.close(1000, "aborted");
      rejectConnect(abortReason(this.#options.signal));
    };
    socket.onopen = () => {
      if (settled) {
        socket.close(1000, "stale");
        return;
      }
      opened = true;
      settled = true;
      cleanup();
      this.#sideband = socket;
      resolve();
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        this.#reportFailure(`${this.#label} sideband returned an unexpected binary frame.`);
        return;
      }
      this.#handleSidebandEvent(event.data);
    };
    socket.onerror = (event) => {
      const detail = event instanceof ErrorEvent && event.message ? `: ${event.message}` : "";
      if (!opened) {
        rejectConnect(new Error(`${this.#label} sideband connection failed${detail}`));
        socket.close(1011, "connection failed");
        return;
      }
      this.#reportFailure(`${this.#label} sideband failed${detail}`);
    };
    socket.onclose = (event) => {
      if (!opened) {
        rejectConnect(new Error(`${this.#label} sideband closed before connecting (${event.code})`));
        return;
      }
      if (this.#sideband !== socket)
        return;
      this.#sideband = undefined;
      if (this.#state === "connecting" || this.#state === "connected") {
        const detail = event.reason ? `: ${event.reason}` : "";
        this.#reportFailure(`${this.#label} sideband closed (${event.code})${detail}`);
      }
    };
    if (this.#options.signal?.aborted) {
      onAbort();
    } else {
      this.#options.signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => {
        socket.close(1000, "connect timeout");
        rejectConnect(new Error(`${this.#label} sideband connection timed out`));
      }, SIDEBAND_CONNECT_TIMEOUT_MS);
      timeout.unref?.();
    }
    await promise;
  }
  #handleSidebandEvent(payload) {
    if (this.#state === "closing" || this.#state === "closed")
      return;
    const event = parseLiveServerEvent(payload);
    if (!event)
      return;
    try {
      this.#options.callbacks.onEvent(event);
    } catch {}
  }
  #handleServerEvent(payload) {
    if (this.#state === "closing" || this.#state === "closed")
      return;
    const event = parseLiveServerEvent(payload);
    if (!event || this.#sideband?.readyState === WebSocket.OPEN && event.type !== "error")
      return;
    try {
      this.#options.callbacks.onEvent(event);
    } catch {}
  }
  #handleOutputLevel(level) {
    if (this.#state !== "connected" || !Number.isFinite(level))
      return;
    try {
      this.#options.callbacks.onOutputLevel(Math.min(1, Math.max(0, level)));
    } catch {}
  }
  #reportFailure(message) {
    if (this.#state !== "connecting" && this.#state !== "connected" || this.#unexpectedFailureReported) {
      return;
    }
    this.#unexpectedFailureReported = true;
    try {
      this.#options.callbacks.onEvent({ type: "error", message });
    } catch {}
  }
  send(message) {
    const operation = this.#sendTail.then(() => {
      if (this.#state !== "connected")
        throw new Error("Live transport is not connected");
      const sideband = this.#sideband;
      if (!sideband || sideband.readyState !== WebSocket.OPEN) {
        throw new Error(`${this.#label} sideband is not connected`);
      }
      sideband.send(JSON.stringify(message));
    });
    this.#sendTail = operation.catch(() => {});
    return operation;
  }
  pushAudio(samples) {
    if (this.#state !== "connected" || this.#muted || samples.length === 0)
      return;
    this.#peer?.pushAudio(samples);
  }
  async setMuted(muted) {
    this.#muted = muted;
    if (this.#state === "connected")
      this.#peer?.setMuted(muted);
  }
  close() {
    if (this.#closePromise)
      return this.#closePromise;
    this.#state = "closing";
    const operation = this.#close();
    this.#closePromise = operation;
    return operation;
  }
  async#close() {
    this.#options.signal?.removeEventListener("abort", this.#abortListener);
    const sideband = this.#sideband;
    const peer = this.#peer;
    this.#sideband = undefined;
    this.#peer = undefined;
    if (sideband && (sideband.readyState === WebSocket.OPEN || sideband.readyState === WebSocket.CONNECTING)) {
      sideband.close(1000, "done");
    }
    if (peer) {
      try {
        await peer.close();
      } catch {}
    }
    this.#state = "closed";
  }
}

// node_modules/@oh-my-pi/pi-coding-agent/src/live/controller.ts
var MIN_BARGE_IN_LEVEL = 0.04;
var OUTPUT_ECHO_RATIO = 0.65;
function clampLevel(level) {
  if (!Number.isFinite(level) || level <= 0)
    return 0;
  return Math.min(1, level);
}
function microphoneLevel(samples) {
  if (samples.length === 0)
    return 0;
  let sumSquares = 0;
  for (let index = 0;index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sumSquares += sample * sample;
  }
  return clampLevel(Math.sqrt(sumSquares / samples.length));
}
function currentUser() {
  let username = "user";
  try {
    const candidate = os.userInfo().username.trim();
    if (candidate)
      username = candidate;
  } catch {}
  const firstPart = username.split(/[._\-\s]+/).find((part) => part.length > 0);
  return { username, firstName: firstPart ?? "there" };
}

class LiveSessionController {
  #session;
  #callbacks;
  #extractAssistantText;
  #voice;
  #instructionsTemplate;
  #sdpOffer;
  #transport;
  #endpoint;
  #transportAbort = new AbortController;
  #recorder;
  #unsubscribeSession;
  #sendChain = Promise.resolve();
  #stopPromise;
  #started = false;
  #stopped = false;
  #terminalEmitted = false;
  #failure;
  #muted = false;
  #phase = "connecting";
  #inputLevel = 0;
  #outputLevel = 0;
  #emittedInputLevel = -1;
  #emittedOutputLevel = -1;
  #activeDelegationId;
  #userTranscript = "";
  #assistantTranscript = "";
  #userTranscriptFinal = false;
  #assistantTranscriptFinal = false;
  #userTranscriptTurn = 0;
  #assistantTranscriptTurn = 0;
  #lastTranscript;
  #outputActivity = new OutputActivity(() => this.#guardEvent(() => {
    if (!this.#activeDelegationId)
      this.#refreshAudioPhase();
  }));
  constructor(options) {
    this.#session = options.session;
    this.#callbacks = options.callbacks;
    this.#extractAssistantText = options.extractAssistantText;
    this.#voice = options.voice?.trim() || DEFAULT_LIVE_VOICE;
    this.#instructionsTemplate = options.instructions ?? live_instructions_default;
    this.#sdpOffer = options.sdpOffer;
  }
  get phase() {
    return this.#phase;
  }
  get muted() {
    return this.#muted;
  }
  get sdpAnswer() {
    return this.#transport?.sdpAnswer;
  }
  async start() {
    if (this.#stopped) {
      throw this.#failure ?? new Error("This live session has already stopped; create a new controller to reconnect.");
    }
    if (this.#started)
      return;
    this.#started = true;
    this.#emitPhase("connecting", true);
    this.#emitTranscript(undefined);
    if (this.#stopped) {
      throw this.#failure ?? new Error("The live session stopped while starting.");
    }
    try {
      this.#endpoint = await resolveLiveEndpoint(this.#session.settings);
      if (this.#stopped) {
        throw this.#failure ?? new Error("The live session stopped while starting.");
      }
      this.#assertProviderAllowed();
      this.#unsubscribeSession = this.#session.subscribe((event) => this.#guardEvent(() => this.#handleSessionEvent(event)));
      const user = currentUser();
      const instructions = prompt.render(this.#instructionsTemplate, user);
      const transport = new LiveTransport({
        authStorage: this.#session.modelRegistry.authStorage,
        endpoint: this.#endpoint,
        sessionId: this.#session.sessionId,
        instructions,
        voice: this.#voice,
        sdpOffer: this.#sdpOffer,
        signal: this.#transportAbort.signal,
        callbacks: {
          onEvent: (event) => this.#guardEvent(() => this.#handleLiveEvent(event)),
          onOutputLevel: (level) => this.#guardEvent(() => this.#handleOutputLevel(level))
        }
      });
      this.#transport = transport;
      await transport.connect();
      if (this.#stopped) {
        throw this.#failure ?? new Error("The live session stopped while connecting.");
      }
      this.#assertProviderAllowed();
      if (this.#muted)
        await transport.setMuted(true);
      if (this.#stopped) {
        throw this.#failure ?? new Error("The live session stopped before recording began.");
      }
      if (this.#sdpOffer !== undefined) {
        this.#refreshAudioPhase();
        return;
      }
      const recorder = new AudioCapture(16000, (error, samples) => {
        if (error) {
          this.#reportFailure(error);
          return;
        }
        this.#handleMicrophoneAudio(samples);
      });
      if (this.#stopped) {
        try {
          recorder.stop();
        } catch {}
        throw this.#failure ?? new Error("The live session stopped while recording began.");
      }
      this.#recorder = recorder;
      this.#refreshAudioPhase();
    } catch (cause) {
      const error = toError2(cause);
      this.#reportFailure(error);
      await this.stop();
      throw error;
    }
  }
  toggleMute() {
    if (this.#stopped)
      return;
    this.#muted = !this.#muted;
    if (this.#muted && this.#sdpOffer === undefined) {
      this.#inputLevel = 0;
      this.#emitLevels();
    }
    this.#refreshAudioPhase();
    const transport = this.#transport;
    if (transport) {
      transport.setMuted(this.#muted).catch((cause) => this.#reportFailure(toError2(cause)));
    }
  }
  stop() {
    if (!this.#stopPromise)
      this.#stopPromise = this.#stop();
    return this.#stopPromise;
  }
  async#stop() {
    this.#stopped = true;
    if (this.#phase === "connecting" || cfgOffline.get(this.#session.settings) && this.#session.model?.provider !== "openai-codex") {
      this.#transportAbort.abort();
    }
    this.#outputActivity.dispose();
    this.#unsubscribeSession?.();
    this.#unsubscribeSession = undefined;
    let cleanupError;
    const recorder = this.#recorder;
    this.#recorder = undefined;
    if (recorder) {
      try {
        recorder.stop();
      } catch (cause) {
        cleanupError = toError2(cause);
      }
    }
    await this.#sendChain;
    const transport = this.#transport;
    this.#transport = undefined;
    if (transport) {
      try {
        if (!this.#transportAbort.signal.aborted && (!cfgOffline.get(this.#session.settings) || this.#session.model?.provider === "openai-codex")) {
          await transport.send(buildSessionClose());
        }
      } catch (cause) {
        cleanupError ??= toError2(cause);
      }
      try {
        this.#transportAbort.abort();
        await transport.close();
      } catch (cause) {
        cleanupError ??= toError2(cause);
      }
    }
    if (cleanupError)
      this.#emitPhaseSafely("error");
    this.#emitTerminal(cleanupError);
  }
  #guardEvent(handler) {
    if (this.#stopped)
      return;
    try {
      handler();
    } catch (cause) {
      this.#reportFailure(toError2(cause));
    }
  }
  #handleLiveEvent(event) {
    switch (event.type) {
      case "session.started":
        this.#refreshAudioPhase();
        break;
      case "session.updated":
      case "output_audio.delta":
      case "unknown":
        break;
      case "input_transcript.added":
        this.#addTranscript("user", event.item.text);
        break;
      case "output_transcript.added":
        this.#addTranscript("assistant", event.item.text);
        break;
      case "turn.done":
        this.#finishTranscript(event.turn.role, event.turn.transcript);
        break;
      case "delegation.created":
        this.#handleDelegation(event);
        break;
      case "error":
        this.#reportFailure(new Error(event.message));
        break;
    }
  }
  #handleDelegation(event) {
    let request = "";
    for (const content of event.item.content) {
      if (content.type !== "input_text")
        continue;
      request += `${request ? `
` : ""}${content.text}`;
    }
    request = request.trim();
    if (!request)
      return;
    this.#activeDelegationId = event.item.id;
    this.#refreshAudioPhase();
    this.#session.sendCustomMessage({
      customType: LIVE_DELEGATION_MESSAGE_TYPE,
      content: request,
      display: true,
      attribution: "agent"
    }, { triggerTurn: true }).catch((cause) => this.#reportFailure(toError2(cause)));
  }
  #assertProviderAllowed() {
    if (this.#endpoint || !cfgOffline.get(this.#session.settings))
      return;
    if (this.#session.model?.provider !== "openai-codex") {
      throw new Error("Live audio requires the openai-codex session provider or live.endpoint in offline mode.");
    }
  }
  #handleSessionEvent(event) {
    if (event.type === "model_changed")
      this.#assertProviderAllowed();
    if (event.type === "message_end" && event.message.role === "assistant") {
      if (event.message.stopReason === "toolUse")
        this.#appendProgress(event.message);
      return;
    }
    if (event.type !== "agent_end")
      return;
    this.#appendFinalResponse(event.messages);
  }
  #appendProgress(message) {
    const delegationId = this.#activeDelegationId;
    if (!delegationId)
      return;
    const progress = this.#extractAssistantText(message).trim();
    if (!progress)
      return;
    for (const chunk of chunkLiveContext(progress)) {
      this.#queueSend(buildDelegationContextAppend(delegationId, chunk, "commentary"));
    }
  }
  #appendFinalResponse(messages) {
    const delegationId = this.#activeDelegationId;
    if (!delegationId)
      return;
    for (let index = messages.length - 1;index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant")
        continue;
      const text = this.#extractAssistantText(message).trim();
      if (!text)
        continue;
      const finalContext = prompt.render(agent_final_message_default, { message: text });
      for (const chunk of chunkLiveContext(finalContext)) {
        this.#queueSend(buildDelegationContextAppend(delegationId, chunk));
      }
      break;
    }
    this.#activeDelegationId = undefined;
    this.#refreshAudioPhase();
  }
  #handleOutputLevel(level) {
    this.#outputLevel = clampLevel(level);
    this.#outputActivity.observe(this.#outputLevel);
    this.#emitLevels();
    if (!this.#activeDelegationId)
      this.#refreshAudioPhase();
  }
  #handleMicrophoneAudio(samples) {
    if (this.#stopped || !this.#transport)
      return;
    try {
      this.#assertProviderAllowed();
    } catch (cause) {
      this.#reportFailure(toError2(cause));
      return;
    }
    if (this.#muted)
      return;
    this.#inputLevel = microphoneLevel(samples);
    this.#emitLevels();
    const outputActive = this.#outputLevel > OUTPUT_ACTIVE_LEVEL;
    const echoThreshold = Math.max(MIN_BARGE_IN_LEVEL, this.#outputLevel * OUTPUT_ECHO_RATIO);
    if (outputActive && this.#inputLevel < echoThreshold)
      return;
    try {
      this.#transport.pushAudio(samples);
    } catch (cause) {
      this.#reportFailure(toError2(cause));
    }
  }
  #addTranscript(role, text) {
    if (!text)
      return;
    const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
    const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
    let next;
    if (!current) {
      this.#startTranscriptTurn(role);
      next = text;
    } else if (wasFinal) {
      if (text === current || current.endsWith(text))
        return;
      this.#startTranscriptTurn(role);
      next = text;
    } else if (text.startsWith(current)) {
      next = text;
    } else if (current.endsWith(text)) {
      next = current;
    } else {
      next = current + text;
    }
    this.#storeTranscript(role, next, false);
  }
  #finishTranscript(role, text) {
    if (!text)
      return;
    const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
    const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
    if (!current) {
      this.#startTranscriptTurn(role);
    } else if (wasFinal) {
      if (text === current)
        return;
      this.#startTranscriptTurn(role);
    }
    const next = !wasFinal && current.startsWith(text) && current.length > text.length ? current : text;
    this.#storeTranscript(role, next, true);
  }
  #startTranscriptTurn(role) {
    if (role === "user") {
      this.#userTranscriptTurn += 1;
    } else {
      this.#assistantTranscriptTurn += 1;
    }
  }
  #storeTranscript(role, text, final) {
    const normalized = text.trim();
    if (!normalized)
      return;
    const turn = role === "user" ? this.#userTranscriptTurn : this.#assistantTranscriptTurn;
    if (role === "user") {
      this.#userTranscript = normalized;
      this.#userTranscriptFinal = final;
    } else {
      this.#assistantTranscript = normalized;
      this.#assistantTranscriptFinal = final;
    }
    if (this.#lastTranscript?.role === role && this.#lastTranscript.turn === turn && this.#lastTranscript.text === normalized && this.#lastTranscript.final === final) {
      return;
    }
    this.#emitTranscript({ role, turn, text: normalized, final });
  }
  #queueSend(message) {
    const transport = this.#transport;
    if (!transport || this.#stopped)
      return;
    this.#sendChain = this.#sendChain.then(async () => {
      if (!this.#stopped) {
        this.#assertProviderAllowed();
        await transport.send(message);
      }
    }).catch((cause) => this.#reportFailure(toError2(cause)));
  }
  #refreshAudioPhase() {
    if (this.#stopped)
      return;
    if (this.#muted) {
      this.#emitPhase("muted");
    } else if (this.#activeDelegationId) {
      this.#emitPhase("working");
    } else if (this.#outputActivity.active) {
      this.#emitPhase("speaking");
    } else {
      this.#emitPhase("listening");
    }
  }
  #emitPhase(phase, force = false) {
    if (!force && this.#phase === phase)
      return;
    this.#phase = phase;
    try {
      this.#callbacks.onPhase(phase);
    } catch (cause) {
      this.#reportFailure(toError2(cause));
    }
  }
  #emitPhaseSafely(phase) {
    this.#phase = phase;
    try {
      this.#callbacks.onPhase(phase);
    } catch {}
  }
  #emitLevels() {
    if (this.#inputLevel === this.#emittedInputLevel && this.#outputLevel === this.#emittedOutputLevel)
      return;
    const input = this.#inputLevel;
    const output = this.#outputLevel;
    try {
      this.#callbacks.onLevels(input, output);
      this.#emittedInputLevel = input;
      this.#emittedOutputLevel = output;
    } catch (cause) {
      this.#reportFailure(toError2(cause));
    }
  }
  #emitTranscript(transcript) {
    this.#lastTranscript = transcript;
    try {
      this.#callbacks.onTranscript(transcript);
    } catch (cause) {
      this.#reportFailure(toError2(cause));
    }
  }
  #reportFailure(error) {
    if (this.#terminalEmitted)
      return;
    this.#failure = error;
    this.#emitPhaseSafely("error");
    this.#emitTerminal(error);
    this.stop();
  }
  #emitTerminal(error) {
    if (this.#terminalEmitted)
      return;
    this.#terminalEmitted = true;
    try {
      this.#callbacks.onTerminal(error);
    } catch {}
  }
}
export {
  LiveSessionController,
  live_instructions_default as nativeInstructions,
  resolveLiveVoice
};
