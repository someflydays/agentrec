import type { AgentlogBundle } from "./agentlog.js";
import type { SessionEvent, SessionMeta } from "./types.js";

/**
 * Redaction only ever runs on an exported copy, and it is one-way: a missed
 * secret is a leak the user can still catch by reading the export, but a false
 * positive silently corrupts a recording someone is about to share and cannot
 * be recovered from the .agentlog file. Every heuristic here therefore errs
 * toward leaving text alone. The entropy pass in particular refuses whole
 * classes of secret-shaped strings this data is full of (session ULIDs, UUIDs,
 * git SHAs, paths, base64-encoded text) and leans on the named patterns to
 * catch credentials that live inside them.
 *
 * Regexes carrying the `g` flag are stateful. The module-level ones are only
 * ever handed to `matchAll`, which reads `lastIndex` but never writes it back;
 * caller-supplied patterns are recompiled per use so a stale `lastIndex` or a
 * missing `g` cannot change the result.
 */

export interface RedactionPattern {
  /** Label that appears in the `[REDACTED:<name>]` replacement. */
  name: string;
  /**
   * A named `keep` group is preserved in place (used to leave `API_KEY=` and
   * `Authorization: Bearer ` readable); the rest of the match is replaced.
   */
  pattern: RegExp;
}

export interface EntropyOptions {
  minLength?: number;
  /** Shannon bits per character, above which a token is treated as a secret. */
  threshold?: number;
}

export interface RedactionOptions {
  patterns?: RedactionPattern[];
  /** Default: on. */
  entropy?: boolean | EntropyOptions;
}

export interface RedactedText {
  text: string;
  /** Per-pattern hit counts; patterns that did not fire are absent. */
  counts: Record<string, number>;
}

export type RedactionChannel = "cast" | "events" | "meta";

export interface RedactionSummary {
  totalReplacements: number;
  byPattern: Record<string, number>;
  channels: Record<RedactionChannel, number>;
}

export interface RedactedBundle {
  bundle: AgentlogBundle;
  summary: RedactionSummary;
}

export const HIGH_ENTROPY_NAME = "high-entropy";

export const DEFAULT_ENTROPY_MIN_LENGTH = 24;
export const DEFAULT_ENTROPY_THRESHOLD = 3.5;

/**
 * Ordered most specific first: an earlier pattern claims its span, so
 * `API_KEY=sk-ant-...` is labelled as an Anthropic key rather than as a
 * generic assignment.
 */
export const DEFAULT_PATTERNS: RedactionPattern[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g,
  },
  { name: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g },
  {
    name: "openai-api-key",
    pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
  },
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    name: "aws-secret-access-key",
    pattern: /(?<keep>aws_secret_access_key["']?[ \t]*[=:][ \t]*)["']?[A-Za-z0-9/+=]{40}["']?/gi,
  },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "google-api-key", pattern: /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g },
  {
    name: "authorization-header",
    pattern: /(?<keep>authorization[ \t]*:[ \t]*(?:bearer|basic|token)[ \t]+)[\w.~+/=-]{8,}/gi,
  },
  {
    // The keyword can sit anywhere in a segmented name (`AWS_SECRET_ACCESS_KEY=`,
    // `DB_PASSWORD_PRIMARY:`), not only at its end, so the surrounding segments are
    // part of the kept key name. The value must hold a letter and six characters so
    // that a rendered "tokens: 4231" counter is not mistaken for a credential.
    name: "secret-assignment",
    pattern:
      /(?<keep>\b(?:[A-Za-z0-9]+[._-])*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)S?(?:[._-][A-Za-z0-9]+)*["']?[ \t]*[=:][ \t]*)(?=\S*[A-Za-z])\S{6,}/gi,
  },
];

const PLACEHOLDER = /\[REDACTED:[A-Za-z0-9-]+]/g;

/** Delimiters that never appear inside a credential; everything else glues. */
const ENTROPY_TOKEN = /[^\s"'`,;(){}[\]<>|]+/g;

/** Refuses `/`, `\`, `.` and `:`, so paths, URLs, domains and versions drop out. */
const SECRET_CHARSET = /^[A-Za-z0-9+_=-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Wider than Crockford base32 on purpose: every session id in this data is one. */
const ULID = /^[0-9A-Z]{26}$/;
const ALL_HEX = /^[0-9a-f]+$/i;
const INTEGRITY_HASH = /^sha(?:1|256|384|512)-/i;
/** Claude Code request, message and tool ids are base62 and litter this data. */
const AGENT_ID = /^(?:req|msg|toolu)_[A-Za-z0-9]+$/;
const BASE64_CHARSET = /^[A-Za-z0-9+/=]+$/;
const HAS_DIGIT = /\d/;
const HAS_LETTER = /[A-Za-z]/;
const IDENTIFIER_WORD = /^(?:[A-Za-z]+|\d+)$/;
/** Left of an `=`: an env var, a config key or a long-form flag. */
const ASSIGNMENT_NAME = /^-{0,2}[A-Za-z_][A-Za-z0-9_.-]*$/;
const NOT_PADDING = /[^=]/;

interface Span {
  start: number;
  end: number;
  name: string;
  text: string;
}

type Scrub = (text: string) => string;

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** True when a base64 token decodes to something a human wrote. */
function decodesToText(token: string): boolean {
  if (!BASE64_CHARSET.test(token) || token.length % 4 === 1) return false;
  let decoded: string;
  try {
    decoded = atob(token);
  } catch {
    return false;
  }
  if (decoded.length === 0) return false;
  let printable = 0;
  for (const char of decoded) {
    const code = char.charCodeAt(0);
    if ((code >= 0x20 && code <= 0x7e) || code === 0x09 || code === 0x0a || code === 0x0d) {
      printable += 1;
    }
  }
  return printable / decoded.length >= 0.9;
}

/** `MY_LONG_CONSTANT_NAME_123` is a name; `xK3-9fLmQz_pW8tRv2Ns` is not. */
function isSeparatedIdentifier(token: string): boolean {
  if (!token.includes("_") && !token.includes("-")) return false;
  return token.split(/[_-]/).every((part) => part.length > 0 && IDENTIFIER_WORD.test(part));
}

function looksHighEntropy(token: string, minLength: number, threshold: number): boolean {
  if (token.length < minLength) return false;
  if (!SECRET_CHARSET.test(token)) return false;
  if (UUID.test(token) || ULID.test(token) || ALL_HEX.test(token)) return false;
  if (INTEGRITY_HASH.test(token) || AGENT_ID.test(token)) return false;
  if (!HAS_DIGIT.test(token) || !HAS_LETTER.test(token)) return false;
  if (isSeparatedIdentifier(token)) return false;
  if (decodesToText(token)) return false;
  return shannonEntropy(token) > threshold;
}

/**
 * `AWS_SECRET_ACCESS_KEY=abc…` arrives at the entropy pass as a single token,
 * because `_` and `=` are both credential characters. Judging and replacing the
 * value on its own keeps the key name readable in the export. Base64 padding is
 * not an assignment: the text after the first `=` has to be more than further `=`.
 */
function assignedValue(token: string): { offset: number; value: string } | null {
  const eq = token.indexOf("=");
  if (eq <= 0) return null;
  const value = token.slice(eq + 1);
  if (!NOT_PADDING.test(value)) return null;
  if (!ASSIGNMENT_NAME.test(token.slice(0, eq))) return null;
  return { offset: eq + 1, value };
}

function overlaps(spans: Span[], start: number, end: number): boolean {
  return spans.some((span) => start < span.end && span.start < end);
}

function globalize(pattern: RegExp): RegExp {
  return pattern.global
    ? new RegExp(pattern.source, pattern.flags)
    : new RegExp(pattern.source, `${pattern.flags}g`);
}

function entropySettings(entropy: RedactionOptions["entropy"]): EntropyOptions | null {
  if (entropy === false) return null;
  if (entropy === undefined || entropy === true) return {};
  return entropy;
}

export function redactText(text: string, options: RedactionOptions = {}): RedactedText {
  const counts: Record<string, number> = {};
  if (text.length === 0) return { text, counts };

  // Placeholders written by an earlier pass are off limits, so redacting twice
  // cannot relabel or re-count this function's own output.
  const reserved: Span[] = [...text.matchAll(PLACEHOLDER)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    name: "",
    text: match[0],
  }));
  const spans: Span[] = [];

  const claim = (start: number, end: number, name: string, replacement: string): void => {
    if (end <= start) return;
    if (overlaps(spans, start, end) || overlaps(reserved, start, end)) return;
    spans.push({ start, end, name, text: replacement });
    counts[name] = (counts[name] ?? 0) + 1;
  };

  for (const { name, pattern } of options.patterns ?? DEFAULT_PATTERNS) {
    for (const match of text.matchAll(globalize(pattern))) {
      const keep = match.groups?.keep ?? "";
      claim(match.index, match.index + match[0].length, name, `${keep}[REDACTED:${name}]`);
    }
  }

  const entropy = entropySettings(options.entropy);
  if (entropy !== null) {
    const minLength = entropy.minLength ?? DEFAULT_ENTROPY_MIN_LENGTH;
    const threshold = entropy.threshold ?? DEFAULT_ENTROPY_THRESHOLD;
    for (const match of text.matchAll(ENTROPY_TOKEN)) {
      const assigned = assignedValue(match[0]);
      const candidate = assigned?.value ?? match[0];
      const start = match.index + (assigned?.offset ?? 0);
      if (!looksHighEntropy(candidate, minLength, threshold)) continue;
      claim(start, start + candidate.length, HIGH_ENTROPY_NAME, `[REDACTED:${HIGH_ENTROPY_NAME}]`);
    }
  }

  if (spans.length === 0) return { text, counts };

  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + span.text;
    cursor = span.end;
  }
  return { text: out + text.slice(cursor), counts };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactJson(value: unknown, scrub: Scrub): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, scrub));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactJson(item, scrub);
    return out;
  }
  return value;
}

function redactMeta(meta: SessionMeta, scrub: Scrub): SessionMeta {
  return {
    ...meta,
    ...(meta.title !== undefined ? { title: scrub(meta.title) } : {}),
    command: meta.command.map((arg) => scrub(arg)),
    cwd: scrub(meta.cwd),
  };
}

function redactEvent(event: SessionEvent, scrub: Scrub): SessionEvent {
  switch (event.type) {
    case "session.start":
      return { ...event, data: { meta: redactMeta(event.data.meta, scrub) } };
    case "session.title":
      return { ...event, data: { ...event.data, title: scrub(event.data.title) } };
    case "prompt":
    case "assistant.text":
      return { ...event, data: { ...event.data, text: scrub(event.data.text) } };
    case "notification":
      return { ...event, data: { ...event.data, message: scrub(event.data.message) } };
    case "tool.start":
      return { ...event, data: { ...event.data, input: redactJson(event.data.input, scrub) } };
    case "tool.end":
      return event.data.output === undefined
        ? event
        : { ...event, data: { ...event.data, output: scrub(event.data.output) } };
    case "file.change":
      return event.data.diff === undefined
        ? event
        : { ...event, data: { ...event.data, diff: scrub(event.data.diff) } };
    default:
      return event;
  }
}

function redactCastHeader(line: string, scrub: Scrub): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isPlainObject(parsed)) return line;

  const next: Record<string, unknown> = { ...parsed };
  let changed = false;
  if (typeof parsed.title === "string") {
    const title = scrub(parsed.title);
    changed ||= title !== parsed.title;
    next.title = title;
  }
  if (isPlainObject(parsed.env)) {
    const env: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed.env)) {
      if (typeof value !== "string") {
        env[key] = value;
        continue;
      }
      const scrubbed = scrub(value);
      changed ||= scrubbed !== value;
      env[key] = scrubbed;
    }
    next.env = env;
  }
  return changed ? JSON.stringify(next) : line;
}

function redactCastEvent(line: string, scrub: Scrub): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return line;
  const [t, code, data] = parsed as [unknown, unknown, unknown];
  if (typeof t !== "number" || typeof code !== "string" || typeof data !== "string") return line;
  const scrubbed = scrub(data);
  if (scrubbed === data) return line;
  // The recorded timestamp text (fixed six-decimal seconds) is reused verbatim
  // rather than reformatted from the parsed number.
  const comma = line.indexOf(",");
  const seconds = comma > 0 ? line.slice(1, comma).trim() : String(t);
  return `[${seconds}, ${JSON.stringify(code)}, ${JSON.stringify(scrubbed)}]`;
}

function redactCast(cast: string, scrub: Scrub): string {
  const lines = cast.split("\n");
  const out: string[] = [];
  let seenHeader = false;
  for (const line of lines) {
    if (line.trim().length === 0) {
      out.push(line);
      continue;
    }
    out.push(seenHeader ? redactCastEvent(line, scrub) : redactCastHeader(line, scrub));
    seenHeader = true;
  }
  return out.join("\n");
}

/** Returns a new bundle; the input and everything reachable from it is untouched. */
export function redactBundle(
  bundle: AgentlogBundle,
  options: RedactionOptions = {},
): RedactedBundle {
  const byPattern: Record<string, number> = {};
  const channels: Record<RedactionChannel, number> = { cast: 0, events: 0, meta: 0 };

  const scrubber =
    (channel: RedactionChannel): Scrub =>
    (text) => {
      const result = redactText(text, options);
      for (const [name, count] of Object.entries(result.counts)) {
        byPattern[name] = (byPattern[name] ?? 0) + count;
        channels[channel] += count;
      }
      return result.text;
    };

  const meta = redactMeta(bundle.meta, scrubber("meta"));
  const scrubEvent = scrubber("events");
  const events = bundle.events.map((event) => redactEvent(event, scrubEvent));
  const cast = bundle.cast === null ? null : redactCast(bundle.cast, scrubber("cast"));

  return {
    bundle: { ...bundle, meta, events, cast },
    summary: {
      totalReplacements: channels.cast + channels.events + channels.meta,
      byPattern,
      channels,
    },
  };
}
