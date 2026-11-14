import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLooseObject, parseTextToolCalls, classifyTurn, turnRecovery, createStallWatch, requestAdjustments,
} from "../recovery.mjs";

const tools = ["bash", "read", "edit", "write"];

test("loose objects: unquoted keys, quotes, trailing commas, nesting; never eval", () => {
  assert.deepEqual(parseLooseObject('{ command: "ls -R", }'), { command: "ls -R" });
  assert.deepEqual(parseLooseObject("{'a': [1, 2.5, true, null,], b: {c: `x\\ny`}}"), { a: [1, 2.5, true, null], b: { c: "x\ny" } });
  assert.equal(parseLooseObject("{a: process.exit()}"), undefined);
  assert.equal(parseLooseObject("[1, 2]"), undefined);
  assert.equal(parseLooseObject("{a: 1} trailing"), undefined);
});

test("gemma's <tool> text call (from the agentic bench) is recovered", () => {
  const text = 'I will begin by listing the files.\n<tool> bash {   command: "ls -R" } </tool>';
  const { calls, text: rest } = parseTextToolCalls(text, { tools });
  assert.deepEqual(calls.map(c => [c.name, c.arguments]), [["bash", { command: "ls -R" }]]);
  assert.equal(rest, "I will begin by listing the files.");
});

test("native and common text formats are recovered, in order", () => {
  const text = [
    '<|tool_call>call:read{path:<|"|>todo.py<|"|>}<tool_call|>',
    '<tool_call>{"name": "edit", "arguments": {"path": "a.py", "edits": []}}</tool_call>',
    "<function=write><parameter=path>b.py</parameter><parameter=content>\nprint(1)\n</parameter></function>",
    '```json\n{"tool": "bash", "args": {"command": "python3 -m unittest"}}\n```',
  ].join("\n");
  const { calls, text: rest } = parseTextToolCalls(text, { tools });
  assert.deepEqual(calls.map(c => c.name), ["read", "edit", "write", "bash"]);
  assert.deepEqual(calls[0].arguments, { path: "todo.py" });
  assert.deepEqual(calls[2].arguments, { path: "b.py", content: "print(1)" });
  assert.equal(rest, "");
});

test("unknown tools, prose and code examples are left alone", () => {
  assert.equal(parseTextToolCalls('<tool> rm_rf {path: "/"} </tool>', { tools }).calls.length, 0);
  assert.equal(parseTextToolCalls('Use {"name": "Ada", "arguments": "none"} as data.', { tools }).calls.length, 0);
  assert.equal(parseTextToolCalls("def f():\n    return {'a': 1}", { tools }).calls.length, 0);
});

test("turns are classified by what the model actually did", () => {
  assert.equal(classifyTurn({ toolCalls: [{ name: "bash" }] }), "tool-call");
  assert.equal(classifyTurn({ text: "All tests pass. I fixed two bugs." }), "answer");
  assert.equal(classifyTurn({ text: "Done. Let me know if you need anything else." }), "answer");
  assert.equal(classifyTurn({ text: '<tool> bash {command: "ls"} </tool>', tools }), "text-tool-call");
  assert.equal(classifyTurn({ text: "I read the files.\nNow I will edit todo.py to add complete()." }), "intent-without-action");
  assert.equal(classifyTurn({ text: "Now I will edit todo.py.", agentic: false }), "answer");
  assert.equal(classifyTurn({ thinking: "Let me plan the change..." }), "thinking-only");
  assert.equal(classifyTurn({ text: " \n" }), "empty");
  assert.equal(classifyTurn({ text: "partial", stopReason: "length" }), "truncated");
  assert.equal(classifyTurn({ text: "x", stopReason: "aborted" }), "error");
});

test("recovery repairs text calls, nudges a bounded number of times, and leaves progress alone", () => {
  assert.equal(turnRecovery({ kind: "answer" }).action, "none");
  assert.equal(turnRecovery({ kind: "tool-call" }).action, "none");
  assert.equal(turnRecovery({ kind: "text-tool-call" }).action, "repair");
  assert.equal(turnRecovery({ kind: "text-tool-call", canRepair: false }).action, "nudge");
  const first = turnRecovery({ kind: "thinking-only", nudges: 0, maxNudges: 2 });
  assert.equal(first.action, "nudge");
  assert.match(first.message, /call a tool/);
  assert.equal(turnRecovery({ kind: "thinking-only", nudges: 2, maxNudges: 2 }).action, "stop");
});

test("stall watch counts any activity, including thinking, and caps the total", () => {
  let t = 0;
  const watch = createStallWatch({ now: () => t, idleMs: 10, totalMs: 50 });
  t = 9; watch.observe();
  t = 18; assert.equal(watch.reason(), null);
  t = 19; assert.equal(watch.reason(), "stalled");
  watch.observe(); // a late chunk cannot revive a stalled request
  assert.equal(watch.reason(), "stalled");
  let u = 0;
  const capped = createStallWatch({ now: () => u, idleMs: 10, totalMs: 25 });
  for (u = 5; u < 25; u += 5) capped.observe();
  assert.equal(capped.reason(), "total-timeout");
});

test("request adjustments: gemma4 on Ollama with thinking off gets reasoning_effort none", () => {
  assert.deepEqual(requestAdjustments({ provider: "ollama", model: "gemma4:26b-mlx", thinking: "off" }),
    { patch: { reasoning_effort: "none" }, rules: ["gemma4-ollama-thinking-off"] });
  assert.equal(requestAdjustments({ provider: "ollama", model: "gemma4:26b-mlx", thinking: "medium" }), null);
  assert.equal(requestAdjustments({ provider: "ollama", model: "qwen3.8:27b-mlx", thinking: "off" }), null);
  assert.equal(requestAdjustments({ provider: "openai", model: "gemma4", thinking: "off" }), null);
});
