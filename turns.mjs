// Turn policies for agent harnesses that drive local models. Policies only: the host owns
// the model stream, tool execution, the conversation and any message it sends back.

const VISIBLE = /[^\s\p{Cf}]/u;

/**
 * Parse a JavaScript-like object literal without eval: JSON plus unquoted keys,
 * single- or back-quoted strings and trailing commas. Returns undefined when the
 * text is not one object.
 */
export function parseLooseObject(source) {
  let i = 0;
  const s = String(source);
  const fail = () => { throw new SyntaxError(`Unexpected input at ${i}`); };
  const space = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  function string() {
    const quote = s[i++];
    let out = "";
    while (i < s.length && s[i] !== quote) {
      if (s[i] === "\\") {
        const next = s[++i];
        const map = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "0": "\0" };
        if (next === "u") { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 5; continue; }
        out += map[next] ?? next; i++;
      } else out += s[i++];
    }
    if (s[i] !== quote) fail();
    i++;
    return out;
  }
  function key() {
    space();
    if (s[i] === '"' || s[i] === "'" || s[i] === "`") return string();
    const m = /^[A-Za-z_$][\w$-]*/.exec(s.slice(i));
    if (!m) fail();
    i += m[0].length;
    return m[0];
  }
  function value() {
    space();
    const c = s[i];
    if (c === "{") {
      i++; const obj = {};
      for (;;) {
        space();
        if (s[i] === "}") { i++; return obj; }
        const k = key(); space();
        if (s[i] !== ":" && s[i] !== "=") fail();
        i++;
        obj[k] = value(); space();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "}") { i++; return obj; }
        fail();
      }
    }
    if (c === "[") {
      i++; const arr = [];
      for (;;) {
        space();
        if (s[i] === "]") { i++; return arr; }
        arr.push(value()); space();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "]") { i++; return arr; }
        fail();
      }
    }
    if (c === '"' || c === "'" || c === "`") return string();
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|undefined)/.exec(s.slice(i));
    if (!m) fail();
    i += m[0].length;
    return m[0] === "undefined" ? null : JSON.parse(m[0]);
  }
  try {
    const result = value(); space();
    return i === s.length && result && typeof result === "object" && !Array.isArray(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

/** Index just past the object that starts at `start` (a "{"), respecting strings; -1 if unbalanced. */
function objectEnd(text, start) {
  let depth = 0, quote = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

// Models that leak their native tool syntax quote strings with special tokens such as <|"|>.
const unwrapTokens = text => text.replace(/<\|"\|>/g, '"').replace(/<\|'\|>/g, "'");

function argsFrom(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") return parseLooseObject(value);
  return undefined;
}

/**
 * Find tool calls a model wrote as text instead of using the tool-call channel.
 * Recognised forms (only for names in `tools`, when given):
 *   <tool> name {...} </tool>                         (seen from Gemma 4)
 *   call:name{...}  /  <|tool_call>call:name{...}<tool_call|>   (Gemma native syntax)
 *   <tool_call>{"name": ..., "arguments": {...}}</tool_call>    (Qwen / Hermes)
 *   <function=name>{...}</function> and <function=name><parameter=k>v</parameter></function>
 *   a JSON object {"name"|"tool": ..., "arguments"|"args"|"parameters"|"input": {...}}
 * Returns { calls: [{ name, arguments, raw }], text } where text has the calls removed.
 */
export function parseTextToolCalls(input, { tools } = {}) {
  const text = unwrapTokens(String(input ?? ""));
  const allowed = tools ? new Set(tools) : null;
  const ok = name => typeof name === "string" && name && (!allowed || allowed.has(name));
  const calls = [];
  const spans = [];
  const taken = (a, b) => spans.some(([x, y]) => a < y && b > x);
  const add = (name, args, start, end) => {
    if (!ok(name) || !args || taken(start, end)) return;
    calls.push({ name, arguments: args, raw: text.slice(start, end) });
    spans.push([start, end]);
  };
  let m;
  // <function=name><parameter=key>value</parameter>...</function>
  const fn = /<function=([\w.-]+)>([\s\S]*?)<\/function>/g;
  while ((m = fn.exec(text))) {
    const body = m[2].trim();
    let args = body.startsWith("{") ? parseLooseObject(body) : undefined;
    if (!args) {
      const params = [...body.matchAll(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g)];
      if (params.length) args = Object.fromEntries(params.map(p => [p[1], p[2].replace(/^\n|\n$/g, "")]));
      else if (!body) args = {};
    }
    add(m[1], args, m.index, m.index + m[0].length);
  }
  // <tool> name {...} </tool>  and  call:name{...}
  const named = /(?:<tool>\s*|<\|tool_call>\s*call:|\bcall:)([\w.-]+)\s*(?=\{)/g;
  while ((m = named.exec(text))) {
    const open = m.index + m[0].length;
    const end = objectEnd(text, open);
    if (end < 0) continue;
    let stop = end;
    const tail = /^\s*(?:<\/tool>|<tool_call\|>)/.exec(text.slice(end));
    if (tail) stop += tail[0].length;
    add(m[1], parseLooseObject(text.slice(open, end)), m.index, stop);
  }
  // JSON objects naming a tool, inside <tool_call>, a code fence or bare text
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    if (taken(start, start + 1)) continue;
    const end = objectEnd(text, start);
    if (end < 0) continue;
    const obj = parseLooseObject(text.slice(start, end));
    if (!obj) continue;
    const name = obj.name ?? obj.tool ?? obj.tool_name ?? obj.function?.name;
    const args = argsFrom(obj.arguments ?? obj.args ?? obj.parameters ?? obj.input ?? obj.function?.arguments);
    if (!ok(name) || !args) continue;
    let a = start, b = end;
    const before = text.slice(0, a), after = text.slice(b);
    const wrap = /(<tool_call>\s*|```(?:json|tool_call)?\s*)$/.exec(before);
    const close = /^(\s*<\/tool_call>|\s*```)/.exec(after);
    if (wrap && close) { a -= wrap[0].length; b += close[0].length; }
    add(name, args, a, b);
    start = end - 1;
  }
  const order = calls.map((c, k) => [spans[k][0], c]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
  let rest = text;
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) rest = rest.slice(0, a) + rest.slice(b);
  return { calls: order, text: rest.trim() };
}

// The last sentence promises an action ("I will now edit the file.") but nothing was called.
const INTENT = /^(?:i will|i'll|i am going to|i'm going to|let me(?! know)|let's|now,? i|next,? i|first,? i|then,? i|i need to|i should)\b/i;
function lastSentence(text) {
  const line = text.trim().split("\n").filter(l => VISIBLE.test(l)).at(-1) ?? "";
  return line.split(/(?<=[.!?…])\s+/).filter(x => VISIBLE.test(x)).at(-1)?.trim() ?? "";
}

/**
 * Classify a finished assistant turn so the host knows whether the model made progress.
 * Kinds: "tool-call", "answer", "text-tool-call", "intent-without-action", "thinking-only",
 * "empty", "truncated", "error".
 */
export function classifyTurn({ text = "", thinking = "", toolCalls = [], stopReason, tools, agentic = true } = {}) {
  if (stopReason === "error" || stopReason === "aborted") return "error";
  if (toolCalls.length) return "tool-call";
  if (stopReason === "length" || stopReason === "max_tokens") return "truncated";
  if (VISIBLE.test(text)) {
    if (parseTextToolCalls(text, { tools }).calls.length) return "text-tool-call";
    if (agentic && INTENT.test(lastSentence(text))) return "intent-without-action";
    return "answer";
  }
  return VISIBLE.test(thinking) ? "thinking-only" : "empty";
}

const NUDGES = {
  "text-tool-call": "Your last message wrote a tool call as plain text, so it did not run. Call the tool through the tool-calling interface instead.",
  "intent-without-action": "You said what you would do next but did not call a tool, so nothing happened. Call the tool now to do it. If the task is already complete, reply with your final answer.",
  "thinking-only": "Your last turn ended after thinking, with no tool call and no answer, so nothing happened. Continue the task now: call a tool to make progress, or reply with your final answer.",
  "empty": "Your last turn was empty. Continue the task: call a tool to make progress, or reply with your final answer.",
  "truncated": "Your last message was cut off at the length limit. Continue from where it stopped, and keep it shorter.",
};

/**
 * Decide what the host does after a turn of the given kind.
 * "repair": turn the text tool calls into real ones (host-side), then continue normally.
 * "nudge": send `message` as a short follow-up and continue once.
 * "stop": out of nudges; leave the turn as it is and report.
 * "none": the turn made progress or answered.
 */
export function turnRecovery({ kind, nudges = 0, maxNudges = 2, canRepair = true } = {}) {
  if (!(kind in NUDGES)) return { action: "none" };
  if (kind === "text-tool-call" && canRepair) return { action: "repair", reason: kind };
  if (nudges >= maxNudges) return { action: "stop", reason: kind };
  return { action: "nudge", reason: kind, message: NUDGES[kind] };
}

/**
 * Watch one model request for a stall: no stream activity at all (text, thinking or tool
 * arguments) for `idleMs`, or the whole request running past `totalMs`. Unlike
 * createProgressWatch it counts thinking as activity, so long reasoning is not cut off.
 */
export function createStallWatch({ now = () => performance.now(), idleMs = 120_000, totalMs = 900_000 } = {}) {
  for (const value of [idleMs, totalMs]) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError("Expected a positive finite stall limit");
  }
  const start = now();
  let last = start;
  const reason = () => {
    const t = now();
    if (t - start >= totalMs) return "total-timeout";
    return t - last >= idleMs ? "stalled" : null;
  };
  return {
    observe() { if (!reason()) last = now(); },
    reason,
    remainingMs: () => Math.max(0, Math.min(last + idleMs, start + totalMs) - now()),
  };
}

/**
 * Request fields some local models need. Returns an object to merge into the provider
 * payload, or null. Each rule names the evidence for it.
 */
export const REQUEST_RULES = [
  {
    id: "gemma4-ollama-thinking-off",
    why: "Gemma 4 on Ollama's OpenAI-compatible API keeps thinking unless reasoning_effort is \"none\"; turns then end with thinking only.",
    match: ({ provider, model, thinking }) => provider === "ollama" && /^gemma4(?::|-|$)/i.test(model ?? "") && (thinking === "off" || thinking === false),
    patch: { reasoning_effort: "none" },
  },
];

export function requestAdjustments(info = {}, rules = REQUEST_RULES) {
  const hits = rules.filter(rule => rule.match(info));
  if (!hits.length) return null;
  return { patch: Object.assign({}, ...hits.map(rule => rule.patch)), rules: hits.map(rule => rule.id) };
}
