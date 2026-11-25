/* Generated with bun media/build-sdk.ts from omp 19.2.1. Do not hand edit.
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
// node_modules/@oh-my-pi/pi-coding-agent/src/live/transport.ts
import { withOAuthAccess } from "@oh-my-pi/pi-ai";
import { getProxyForUrl, wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import { CODEX_BASE_URL, getCodexAccountId, OPENAI_HEADERS } from "@oh-my-pi/pi-catalog/wire/codex";
import { getCodexClientVersion } from "@oh-my-pi/pi-catalog/wire/codex-version";
import { LiveWebRtcPeer } from "@oh-my-pi/pi-natives";
import { toError } from "@oh-my-pi/pi-utils";

// node_modules/@oh-my-pi/pi-coding-agent/src/config/resolve-config-value.ts
import { executeShell } from "@oh-my-pi/pi-natives";
import { $envExact, directoryIsEnterable, getProjectDir, logger, ptree, untilAborted } from "@oh-my-pi/pi-utils";
var commandResultCache = new Map;
var commandFailureRetryAt = new Map;
var commandInFlight = new Map;
var commandGeneration = new Map;

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
function buildSessionContextAppend(text, channel) {
  return {
    type: "session.context.append",
    ...channel === undefined ? {} : { channel },
    content: [{ type: "input_text", text }]
  };
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

// src/media/protocol.ts
import { isRecord as isRecord2 } from "@oh-my-pi/pi-utils";
function parseLiveServerEvent2(payload) {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord2(value))
    return parseLiveServerEvent(value);
  if (value.type !== "session.output_audio.delta") {
    const event = parseLiveServerEvent(value);
    if (event?.type === "input_transcript.added" || event?.type === "turn.done" || event?.type === "unknown" && event.wireType === "session.context.appended") {
      const range = event.type === "turn.done" ? value.turn : value;
      if (isRecord2(range) && typeof range.start_ms === "number" && typeof range.end_ms === "number" && Number.isFinite(range.start_ms) && Number.isFinite(range.end_ms) && range.start_ms >= 0 && range.end_ms >= range.start_ms)
        return { ...event, startMs: range.start_ms, endMs: range.end_ms };
    }
    return event;
  }
  const { delta, start_ms: start, end_ms: end } = value;
  if (typeof delta !== "string" || typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0) {
    return { type: "error", message: "Invalid ordered voice audio" };
  }
  const duration = end - start;
  if (duration <= 0 || duration > 1000 || duration % 20 !== 0 || delta.length !== duration * 64 || !/^[A-Za-z0-9+/]+$/.test(delta)) {
    return { type: "error", message: "Invalid ordered voice audio" };
  }
  return { type: "output_audio.delta", audio: delta };
}

// node_modules/@oh-my-pi/pi-coding-agent/src/config/registry.ts
import { logger as logger2, parseFlag } from "@oh-my-pi/pi-utils";
function settingsOf(scope) {
  return "settings" in scope ? scope.settings : scope;
}
var nextSlot = 0;

class Derived {
  slot = nextSlot++;
  get(scope) {
    const settings = settingsOf(scope);
    const revision = settings.revision;
    const cached = settings.valueCache[this.slot];
    if (cached?.revision === revision)
      return cached.value;
    const inputs = this.inputs(settings);
    if (!cached) {
      const value = this.compute(inputs, settings);
      settings.valueCache[this.slot] = { revision, inputs, value };
      return value;
    }
    if (!sameInputs(cached.inputs, inputs)) {
      const value = this.compute(inputs, settings);
      if (!settingValuesEqual(cached.value, value))
        cached.value = value;
      cached.inputs = inputs;
    }
    cached.revision = revision;
    return cached.value;
  }
  map(fn) {
    return new MappedValue(this, fn);
  }
  listen(scope, onChange) {
    const settings = settingsOf(scope);
    const sources = this.sources;
    const run = (next, previous) => {
      try {
        const result = onChange(next, previous);
        if (result instanceof Promise)
          result.catch((error) => reportListenerError(sources, error));
      } catch (error) {
        reportListenerError(sources, error);
      }
    };
    let current = this.get(settings);
    let queued = false;
    let active = true;
    const stop = settings.onEffectiveChange(sources, () => {
      if (queued)
        return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!active)
          return;
        const next = this.get(settings);
        if (settingValuesEqual(next, current))
          return;
        const previous = current;
        current = next;
        run(next, previous);
      });
    });
    const unsubscribe = () => {
      active = false;
      stop();
    };
    if ("settings" in scope)
      scope.addDisposer?.(unsubscribe);
    return unsubscribe;
  }
}
function settingValuesEqual(a, b) {
  if (Object.is(a, b))
    return true;
  if (isArray(a) && isArray(b)) {
    if (a.length !== b.length)
      return false;
    for (let i = 0;i < a.length; i++)
      if (!settingValuesEqual(a[i], b[i]))
        return false;
    return true;
  }
  if (!isPlainObject(a) || !isPlainObject(b))
    return Bun.deepEquals(a, b);
  const otherKeys = Object.keys(b);
  let index = 0;
  for (const key in a) {
    if (key !== otherKeys[index++] || !settingValuesEqual(a[key], b[key]))
      return false;
  }
  return index === otherKeys.length;
}
function isArray(value) {
  return Array.isArray(value);
}
function isPlainObject(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function sameInputs(a, b) {
  if (a.length !== b.length)
    return false;
  for (let i = 0;i < a.length; i++)
    if (!Object.is(a[i], b[i]))
      return false;
  return true;
}
function reportListenerError(sources, error) {
  logger2.warn("Settings: listener failed", {
    settings: sources.map((source) => source.id).join(","),
    error: String(error)
  });
}

class MappedValue extends Derived {
  #source;
  #fn;
  constructor(source, fn) {
    super();
    this.#source = source;
    this.#fn = fn;
  }
  get sources() {
    return this.#source.sources;
  }
  inputs(settings) {
    return [this.#source.get(settings)];
  }
  compute(inputs) {
    return this.#fn(inputs[0]);
  }
}
class Setting extends Derived {
  id;
  segments;
  definition;
  #sources;
  envName;
  envFallback;
  #parseEnv;
  #envRaw;
  #envParsed;
  constructor(definition) {
    super();
    this.id = definition.id;
    this.segments = definition.id.split(".");
    this.definition = definition;
    this.#sources = [this];
    const env = definition.env;
    this.envName = typeof env === "string" ? env : env?.name;
    this.#parseEnv = typeof env === "object" && env.parse ? env.parse : env ? (raw) => this.#parseEnvText(raw) : undefined;
    this.envFallback = typeof env === "object" ? env.fallback ?? false : false;
  }
  get sources() {
    return this.#sources;
  }
  get default() {
    const value = this.definition.default;
    return typeof value === "object" && value !== null ? structuredClone(value) : value;
  }
  get type() {
    return this.definition.type;
  }
  get enumValues() {
    return this.definition.type === "enum" ? this.definition.values : undefined;
  }
  get ui() {
    return this.definition.ui;
  }
  get isCredential() {
    return this.definition.credential === true || this.ui?.secret === true;
  }
  envValue() {
    if (!this.envName || !this.#parseEnv)
      return;
    const raw = Bun.env[this.envName];
    if (raw === undefined)
      return;
    if (raw !== this.#envRaw) {
      this.#envParsed = this.#parseEnv(raw);
      this.#envRaw = raw;
    }
    return this.#envParsed;
  }
  #effectiveEnv(scope) {
    const value = this.envValue();
    if (value === undefined)
      return;
    const settings = settingsOf(scope);
    if (!this.envFallback)
      return settings.hasRuntimeOverride(this) ? undefined : value;
    if (this.envFallback === true)
      return settings.isConfigured(this) ? undefined : value;
    const configured = settings.rawValue(this);
    return configured === undefined || typeof configured === "string" && configured.trim() === "" ? value : undefined;
  }
  get(scope) {
    return this.#effectiveEnv(scope) ?? super.get(scope);
  }
  layered(scope) {
    return super.get(scope);
  }
  parse(text) {
    const value = this.#parseText(text);
    return this.definition.normalize ? this.definition.normalize(value) : value;
  }
  #parseText(text) {
    const trimmed = text.trim();
    switch (this.definition.type) {
      case "boolean": {
        const lower = trimmed.toLowerCase();
        if (["true", "1", "yes", "on"].includes(lower))
          return true;
        if (["false", "0", "no", "off"].includes(lower))
          return false;
        throw new Error(`Invalid boolean value: ${text}. Use true/false, yes/no, on/off, or 1/0`);
      }
      case "number": {
        const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
        if (!Number.isFinite(parsed))
          throw new Error(`Invalid number: ${text}`);
        return parsed;
      }
      case "array":
      case "record": {
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          throw new Error(`Invalid ${this.definition.type} JSON: ${text}`);
        }
        if (!this.accepts(parsed))
          throw new Error(`Invalid ${this.definition.type} JSON: ${text}`);
        return parsed;
      }
      case "string":
      case "enum": {
        let value = trimmed;
        if (value.startsWith('"')) {
          try {
            const unquoted = JSON.parse(value);
            if (typeof unquoted === "string")
              value = unquoted;
          } catch {}
        }
        const valid = this.enumValues;
        if (valid && !valid.includes(value)) {
          throw new Error(`Invalid value: ${text}. Valid values: ${valid.join(", ")}`);
        }
        return value;
      }
    }
  }
  accepts(value) {
    switch (this.definition.type) {
      case "boolean":
        return typeof value === "boolean";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "string":
        return typeof value === "string";
      case "enum":
        return typeof value === "string" && this.definition.values.includes(value);
      case "array":
        return Array.isArray(value);
      case "record":
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }
  }
  #parseEnvText(raw) {
    if (this.definition.type === "boolean")
      return raw === "" ? undefined : parseFlag(raw);
    if (raw.trim() === "")
      return;
    try {
      return this.parse(raw);
    } catch {
      return;
    }
  }
  inputs(settings) {
    return [settings.rawValue(this)];
  }
  compute(inputs, settings) {
    const raw = inputs[0];
    if (raw === undefined || this.accepts(raw)) {
      settings.warnState.invalid.delete(this.id);
      return raw === undefined ? this.default : raw;
    }
    const warned = settings.warnState.invalid;
    if (!warned.has(this.id) || !Bun.deepEquals(warned.get(this.id), raw)) {
      warned.set(this.id, raw);
      logger2.warn("Settings: ignoring invalid value, using the default", { setting: this.id, value: raw });
    }
    return this.default;
  }
  assertWritable(value) {
    const unknown = this.#unknownItems(value);
    if (unknown.length > 0 && this.definition.type === "array" && this.definition.items) {
      const { values, label } = this.definition.items;
      const noun = unknown.length === 1 ? label : `${label}s`;
      throw new Error(`Unknown ${noun}: ${unknown.join(", ")}. Valid ${label}s: ${values.join(", ")}`);
    }
    this.definition.validate?.(value);
    if (!this.accepts(value)) {
      const expected = this.enumValues ? `one of ${this.enumValues.join(", ")}` : `a ${this.definition.type}`;
      throw new Error(`Invalid value for ${this.id}: ${Bun.inspect(value)} (expected ${expected})`);
    }
  }
  checkConfigured(settings, raw) {
    this.definition.validate?.(raw);
    const unknown = this.#unknownItems(raw);
    const items = settings.warnState.items;
    let warned = items.get(this.id);
    for (const entry of warned ?? [])
      if (!unknown.includes(entry))
        warned?.delete(entry);
    if (unknown.length === 0)
      return;
    if (!warned) {
      warned = new Set;
      items.set(this.id, warned);
    }
    const label = this.definition.type === "array" ? this.definition.items?.label : undefined;
    for (const entry of unknown) {
      if (warned.has(entry))
        continue;
      warned.add(entry);
      logger2.warn(`Settings: unknown ${label} ${entry}`, { setting: this.id });
    }
  }
  #unknownItems(value) {
    const items = this.definition.type === "array" ? this.definition.items : undefined;
    if (!items || !Array.isArray(value))
      return [];
    const unknown = new Set;
    for (const entry of value) {
      if (!items.values.includes(entry))
        unknown.add(typeof entry === "string" ? JSON.stringify(entry) : String(entry));
    }
    return [...unknown];
  }
  set(scope, value) {
    if (value === undefined)
      settingsOf(scope).unsetGlobalValue(this);
    else
      settingsOf(scope).writeValue(this, this.#normalize(value), "global");
  }
  override(scope, value) {
    if (value === undefined)
      settingsOf(scope).clearOverrideValue(this);
    else
      settingsOf(scope).writeValue(this, this.#normalize(value), "override");
  }
  unset(scope) {
    settingsOf(scope).unsetGlobalValue(this);
  }
  setEntry(scope, key, value) {
    settingsOf(scope).writeEntry(this, key, value === undefined ? undefined : this.#normalizeEntry(key, value));
  }
  setMember(scope, item, options) {
    settingsOf(scope).writeMember(this, item, options);
  }
  pinDefault(scope) {
    if (this.envValue() === undefined)
      settingsOf(scope).pinDefaultValue(this);
  }
  #normalize(value) {
    return this.definition.normalize ? this.definition.normalize(value) : value;
  }
  #normalizeEntry(key, value) {
    const normalize = this.definition.normalize;
    return normalize ? normalize({ [key]: value })[key] : value;
  }
  clearOverride(scope) {
    settingsOf(scope).clearOverrideValue(this);
  }
  isConfigured(scope) {
    return this.envValue() !== undefined || settingsOf(scope).isConfigured(this);
  }
  provenance(scope) {
    return this.#effectiveEnv(scope) !== undefined ? "env" : settingsOf(scope).getProvenance(this);
  }
}
var byId = new Map;
var ordered = [];
function register(definition) {
  if (byId.has(definition.id))
    throw new Error(`Setting "${definition.id}" is registered twice`);
  const handle = new Setting(definition);
  byId.set(definition.id, handle);
  ordered.push(handle);
  return handle;
}
var effects = new Set;

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
    const event = parseLiveServerEvent2(payload);
    if (!event)
      return;
    try {
      this.#options.callbacks.onEvent(event);
    } catch {}
  }
  #handleServerEvent(payload) {
    if (this.#state === "closing" || this.#state === "closed")
      return;
    const event = parseLiveServerEvent2(payload);
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
export {
  LiveTransport,
  buildDelegationContextAppend,
  buildSessionContextAppend,
  chunkLiveContext
};
