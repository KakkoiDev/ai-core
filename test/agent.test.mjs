import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepseekPeak, nextOffPeak, deepseekCost, deepseekRequest, createReasoningStore, createDeepSeekProxy } from "../deepseek.mjs";
import { macSandboxProfile, holdsHome } from "../sandbox.mjs";
import { piProviders, unknownModel } from "../providers.mjs";
import { harnessFor, commandTimeout } from "../harness.mjs";

test("peak hours: 01-04 and 06-10 UTC on weekdays only", () => {
  assert.equal(deepseekPeak(new Date("2026-11-25T02:30:00Z")), true);    // Wednesday
  assert.equal(deepseekPeak(new Date("2026-11-25T05:00:00Z")), false);
  assert.equal(deepseekPeak(new Date("2026-11-28T02:30:00Z")), false);   // Saturday
  assert.equal(nextOffPeak(30, new Date("2026-11-25T05:45:00Z")).toISOString(), "2026-11-25T10:00:00.000Z");
});

test("cost doubles at peak", () => {
  const u = { prompt_cache_hit_tokens: 1e6, prompt_cache_miss_tokens: 1e6, completion_tokens: 1e6 };
  assert.equal(deepseekCost(u, new Date("2026-11-25T05:00:00Z")).toFixed(3), "0.753");
  assert.equal(deepseekCost(u, new Date("2026-11-25T02:00:00Z")).toFixed(3), "1.506");
});

test("flash follows the client's thinking; fixed aliases ignore it", () => {
  const on = deepseekRequest({ model: "flash", thinking: { type: "enabled" }, reasoning_effort: "max", store: false });
  assert.deepEqual([on.body.model, on.body.reasoning_effort, on.effort, "store" in on.body], ["deepseek-flash", "max", "max", false]);
  assert.equal(deepseekRequest({ model: "flash", thinking: { type: "enabled" }, reasoning_effort: "high" }).body.reasoning_effort, "high");
  const off = deepseekRequest({ model: "flash" });
  assert.deepEqual([off.body.thinking.type, off.effort, "temperature" in off.body], ["disabled", "off", false]);
  const fixed = deepseekRequest({ model: "flash-off", thinking: { type: "enabled" }, reasoning_effort: "max" });
  assert.deepEqual([fixed.body.thinking.type, fixed.body.temperature, fixed.effort], ["disabled", 0, "off"]);
  assert.match(deepseekRequest({ model: "flash-ultra" }).error, /unknown model/);
});

test("reasoning is handed back by tool-call id or reply text", () => {
  const s = createReasoningStore();
  s.remember({ content: "", reasoning_content: "R1", tool_calls: [{ id: "t1" }] });
  s.remember({ content: "done", reasoning_content: "R2" });
  const msgs = [{ role: "assistant", tool_calls: [{ id: "t1" }] }, { role: "assistant", content: "done" }, { role: "assistant", content: "?" }];
  assert.equal(s.restore(msgs), 2);
  assert.deepEqual(msgs.map((m) => m.reasoning_content), ["R1", "R2", ""]);
});

test("the proxy keeps the key, logs cost and stops at the cap", async () => {
  const d = mkdtempSync(join(tmpdir(), "aicore-"));
  writeFileSync(join(d, "key"), "sk-test\n");
  let seen;
  const fakeFetch = async (url, init) => { seen = init; return new Response(JSON.stringify({ model: "deepseek-flash", usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ message: { content: "ok" } }] }), { status: 200 }); };
  const srv = createDeepSeekProxy({ keyFile: join(d, "key"), usageFile: join(d, "usage.jsonl"), budgetFile: join(d, "budget.json"), fetchImpl: fakeFetch });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${srv.address().port}/v1/chat/completions`;
  const r = await fetch(url, { method: "POST", body: JSON.stringify({ model: "flash", messages: [] }) });
  assert.equal((await r.json()).choices[0].message.content, "ok");
  assert.equal(seen.headers.Authorization, "Bearer sk-test");
  const rec = JSON.parse(readFileSync(join(d, "usage.jsonl"), "utf8"));
  assert.deepEqual([rec.alias, rec.effort, rec.served], ["flash", "off", "deepseek-flash"]);
  assert.ok(!JSON.stringify(rec).includes("sk-test"));
  writeFileSync(join(d, "budget.json"), JSON.stringify({ usd: 0 }));
  assert.equal((await fetch(url, { method: "POST", body: JSON.stringify({ model: "flash", messages: [] }) })).status, 429);
  srv.close();
});

test("sandbox profile: home closed, secrets closed, own tmp, one port", () => {
  const p = macSandboxProfile({ home: "/Users/a", writable: ["/Users/a/proj"], readable: ["/Users/a/.gitconfig"], tmp: "/Users/a/.state/tmp/1", cache: "/var/c", port: 11434 });
  assert.match(p, /\(deny file-read\* \(subpath "\/Users\/a"\)\)/);
  assert.match(p, /\(subpath "\/Users\/a\/\.ssh"\)/);
  assert.match(p, /remote ip "localhost:11434"/);
  assert.ok(p.indexOf('(deny file-read* (subpath "/Users/a"))') < p.indexOf('(subpath "/Users/a/proj")', p.indexOf("(allow file-read*")));
  assert.ok(!macSandboxProfile({ home: "/Users/a", writable: ["/x"], net: true }).includes("network-outbound"));
  assert.equal(holdsHome("/Users/a", "/Users/a"), true);
  assert.equal(holdsHome("/Users", "/Users/a"), true);
  assert.equal(holdsHome("/Users/a/proj", "/Users/a"), false);
});

test("pi providers and unknown models", () => {
  const p = piProviders({ ollama: ["qwen3.8:27b"], contexts: { "qwen3.8:27b": 65536 } });
  assert.equal(p.ollama.models[0].contextWindow, 65536);
  assert.equal(p.deepseek.models[0].thinkingLevelMap.max, "max");
  assert.equal(unknownModel(p, "deepseek/flash"), null);
  assert.match(unknownModel(p, "deepseek/flsh"), /not a known model/);
  assert.equal(unknownModel(p, "other/x"), null);
});

test("harness profiles pick parts per model", () => {
  assert.deepEqual(harnessFor("ollama/gemma4:26b-mlx").map((x) => x.part), ["command-timeout", "local-model-guard"]);
  assert.deepEqual(harnessFor("ollama/qwen3.8:27b").map((x) => x.part), ["command-timeout"]);
  assert.deepEqual(harnessFor("deepseek/flash").map((x) => x.part), ["command-timeout"]);
  assert.equal(commandTimeout(undefined), 120);
  assert.equal(commandTimeout(9999), 600);
  assert.equal(commandTimeout(30), 30);
});
