// DeepSeek's hosted API, as learned by benching it (2026-11-24/25): thinking modes, the reasoning hand-back thinking
// mode needs with tools, prices and peak hours, and a loopback proxy that keeps the API key away from the agent.
// Zero dependencies (node:http, node:fs, global fetch).
import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

export const DEEPSEEK_UPSTREAM = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_PORT = 8096;

// Model ids a client asks the proxy for. "client" follows the client's own thinking setting (pi's --thinking with
// thinkingFormat "deepseek"); the others fix the effort whatever the client asks.
export const DEEPSEEK_ALIASES = {
  "flash": { model: "deepseek-flash", effort: "client" },
  "flash-max": { model: "deepseek-flash", effort: "max" },
  "flash-high": { model: "deepseek-flash", effort: "high" },
  "flash-off": { model: "deepseek-flash", effort: null },
};

// $ per 1M tokens (api-docs.deepseek.com/quick_start/pricing, read 2026-11-24), off-peak; peak hours cost double.
export const DEEPSEEK_PRICE = { hit: 0.003, miss: 0.15, out: 0.6 };

/** DeepSeek's peak hours, when prices double: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday. */
export function deepseekPeak(date = new Date()) {
  const d = date.getUTCDay(), h = date.getUTCHours();
  return d >= 1 && d <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

/** The first moment from `from` with `minutes` of off-peak time ahead (checked minute by minute). */
export function nextOffPeak(minutes, from = new Date()) {
  const clear = (t) => { for (let m = 0; m <= minutes + 1; m++) if (deepseekPeak(new Date(t + m * 60000))) return false; return true; };
  let t = from.getTime();
  while (!clear(t)) t += 60000;
  return new Date(t);
}

export function deepseekCost(usage = {}, date = new Date()) {
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - hit);
  const c = (hit * DEEPSEEK_PRICE.hit + miss * DEEPSEEK_PRICE.miss + (usage.completion_tokens ?? 0) * DEEPSEEK_PRICE.out) / 1e6;
  return c * (deepseekPeak(date) ? 2 : 1);
}

/**
 * Rewrite a client's chat request for DeepSeek. Returns { body, effort } or { error }.
 * DeepSeek has two efforts, high and max: pi's xhigh/max map to max, anything else thinking-on to high.
 */
export function deepseekRequest(body) {
  const alias = DEEPSEEK_ALIASES[body.model];
  if (!alias) return { error: `unknown model ${body.model}; one of ${Object.keys(DEEPSEEK_ALIASES).join(", ")}` };
  const out = { ...body, model: alias.model };
  let effort = alias.effort;
  delete out.store;
  if (effort === "client") {
    effort = out.thinking?.type === "enabled" ? (["xhigh", "max"].includes(out.reasoning_effort) ? "max" : "high") : null;
  } else {
    for (const k of ["reasoning_effort", "reasoning", "thinking", "temperature", "top_p"]) delete out[k];
  }
  if (effort) { out.thinking = { type: "enabled" }; out.reasoning_effort = effort; }
  else { out.thinking = { type: "disabled" }; delete out.reasoning_effort; if (alias.effort !== "client") out.temperature = 0; }
  if (out.stream) out.stream_options = { include_usage: true };
  return { body: out, effort: effort ?? "off" };
}

/**
 * DeepSeek's thinking mode with tools needs every earlier assistant turn's reasoning_content sent back (else HTTP
 * 400). Clients that drop it get it restored, keyed by tool-call id or by the reply's text.
 */
export function createReasoningStore() {
  const seen = new Map();
  const textKey = (c) => "c:" + createHash("sha256").update(String(c ?? "").trim()).digest("hex");
  return {
    remember(msg) {
      const rc = msg?.reasoning_content;
      if (!rc) return;
      for (const tc of msg.tool_calls ?? []) if (tc.id) seen.set(tc.id, rc);
      if (String(msg.content ?? "").trim()) seen.set(textKey(msg.content), rc);
    },
    restore(messages = []) {
      let n = 0;
      for (const m of messages) {
        if (m.role !== "assistant" || m.reasoning_content) continue;
        const ids = (m.tool_calls ?? []).map((t) => t.id);
        const rc = ids.map((i) => seen.get(i)).find(Boolean) ?? seen.get(textKey(typeof m.content === "string" ? m.content : ""));
        m.reasoning_content = rc ?? "";
        if (rc) n++;
      }
      return n;
    },
  };
}

function spentFrom(usageFile) {
  if (!existsSync(usageFile)) return 0;
  return readFileSync(usageFile, "utf8").split("\n").filter(Boolean).reduce((s, l) => s + (JSON.parse(l).cost ?? 0), 0);
}

function capFrom(budgetFile, fallback) {
  try { return JSON.parse(readFileSync(budgetFile, "utf8")).usd ?? fallback; } catch { return fallback; }
}

/**
 * A loopback proxy to DeepSeek: the key stays in this process (read from keyFile per request, never logged), every
 * request's tokens and cost go to usageFile, and requests stop once budgetFile's cap (default $25) is spent.
 * Returns the http.Server (call .listen(port, "127.0.0.1")).
 */
export function createDeepSeekProxy({ keyFile, usageFile, budgetFile, cap = 25, upstream = DEEPSEEK_UPSTREAM, fetchImpl = fetch }) {
  mkdirSync(dirname(usageFile), { recursive: true });
  const store = createReasoningStore();
  const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) }); res.end(b); };
  return createServer(async (req, res) => {
    if (req.method === "GET" && /\/models\/?$/.test(req.url)) {
      return send(res, 200, { object: "list", data: Object.keys(DEEPSEEK_ALIASES).map((id) => ({ id, object: "model" })) });
    }
    if (req.method !== "POST" || !/\/chat\/completions\/?$/.test(req.url)) return send(res, 404, { error: { message: "only /v1/chat/completions" } });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const limit = capFrom(budgetFile, cap);
    if (spentFrom(usageFile) >= limit) return send(res, 429, { error: { message: `DeepSeek budget reached ($${limit}); raise "usd" in ${budgetFile}` } });
    const r = deepseekRequest(JSON.parse(raw || "{}"));
    if (r.error) return send(res, 400, { error: { message: r.error } });
    const alias = JSON.parse(raw).model;
    const restored = store.restore(r.body.messages);
    const t0 = Date.now();
    let up;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        up = await fetchImpl(upstream, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + readFileSync(keyFile, "utf8").trim() }, body: JSON.stringify(r.body) });
        if ([429, 500, 502, 503].includes(up.status) && attempt < 3) { await new Promise((ok) => setTimeout(ok, 10000 * (attempt + 1))); continue; }
        break;
      } catch (e) {
        if (attempt === 3) return send(res, 502, { error: { message: `upstream: ${e.message}` } });
        await new Promise((ok) => setTimeout(ok, 10000 * (attempt + 1)));
      }
    }
    if (!up.ok) return send(res, up.status, await up.json().catch(() => ({ error: { message: `upstream ${up.status}` } })));
    let usage = {}, served = null;
    if (!r.body.stream) {
      const data = await up.json();
      usage = data.usage ?? {}; served = data.model;
      for (const ch of data.choices ?? []) store.remember(ch.message);
      send(res, 200, data);
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "close" });
      const acc = new Map();
      let buf = "";
      const decoder = new TextDecoder();
      for await (const chunk of up.body) {
        res.write(chunk);
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:") || line === "data: [DONE]") continue;
          let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          served = ev.model ?? served;
          if (ev.usage) usage = ev.usage;
          for (const ch of ev.choices ?? []) {
            const m = acc.get(ch.index ?? 0) ?? { content: "", reasoning_content: "", ids: new Map() };
            acc.set(ch.index ?? 0, m);
            const d = ch.delta ?? {};
            m.content += d.content ?? ""; m.reasoning_content += d.reasoning_content ?? "";
            for (const tc of d.tool_calls ?? []) if (tc.id) m.ids.set(tc.index ?? 0, tc.id);
          }
        }
      }
      res.end();
      for (const m of acc.values()) store.remember({ content: m.content, reasoning_content: m.reasoning_content, tool_calls: [...m.ids.values()].map((id) => ({ id })) });
    }
    const now = new Date();
    appendFileSync(usageFile, JSON.stringify({ t: now.toISOString().slice(0, 19) + "Z", alias, effort: r.effort, served, seconds: Math.round((Date.now() - t0) / 100) / 10, usage, cost: Math.round(deepseekCost(usage, now) * 1e6) / 1e6, peak: deepseekPeak(now), restored_reasoning: restored }) + "\n");
  });
}

export function deepseekSpent(usageFile) { return spentFrom(usageFile); }
export function deepseekCap(budgetFile, fallback = 25) { return capFrom(budgetFile, fallback); }
