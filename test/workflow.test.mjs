import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgressWatch, recoveryAction, runWithReceipt, createCheckpoint, resumeCheckpoint,
  repairCandidate, budgetContext, recoveryEvent } from "../recovery.mjs";

function fixtureStore() {
  const rows = new Map();
  return {
    reserve(identity) {
      const existing = rows.get(identity.id);
      if (existing) return existing;
      rows.set(identity.id, { ...identity, state: "pending" });
      return { ...identity, state: "new" };
    },
    settle(receipt) { rows.set(receipt.id, { ...receipt, state: "done" }); },
  };
}

test("a tool finishes, the answer stalls, and recovery uses the receipt without rerunning the tool", async () => {
  let t = 0, calls = 0;
  const watch = createProgressWatch({ now: () => t, answerMs: 10 });
  const store = fixtureStore(), identity = { id: "turn-1-search", fingerprint: "search-kyoto" };
  const execute = () => { calls++; return { ref: "results-1" }; };
  watch.observe("tool-start");
  assert.equal((await runWithReceipt(store, identity, execute)).status, "executed");
  watch.observe("tool-end"); watch.observe("answer", "Kyoto");
  t = 10;
  assert.equal(watch.reason(), "stale-answer");
  const retained = await runWithReceipt(store, identity, execute);
  assert.deepEqual(retained, { status: "replayed", result: { ref: "results-1" } });
  assert.equal(recoveryAction({ toolMayHaveRun: true, hasRetainedResult: true }), "synthesize-without-tools");
  assert.equal(calls, 1);
});

test("unknown external outcomes are not repeated; identity conflicts fail closed", async () => {
  const store = fixtureStore(), identity = { id: "write-1", fingerprint: "write-a" };
  await assert.rejects(runWithReceipt(store, identity, () => { throw Error("lost connection"); }), /lost connection/);
  assert.deepEqual(await runWithReceipt(store, identity, () => assert.fail("replayed unknown write")), { status: "reconcile" });
  await assert.rejects(runWithReceipt(store, { ...identity, fingerprint: "write-b" }, () => assert.fail()), /conflict/);
});

test("resuming separates interrupted work from ready tasks and rejects invalid dependencies", () => {
  const items = [
    { id: "read", title: "Read", status: "done" },
    { id: "write", title: "Write", status: "in-progress", dependsOn: ["read"] },
    { id: "send", title: "Send", status: "todo", dependsOn: ["write"] },
    { id: "verify", title: "Verify inputs", status: "todo", dependsOn: ["read"] },
  ];
  const checkpoint = JSON.parse(JSON.stringify(createCheckpoint({ objective: "Finish report", items, receiptIds: ["write-1"] })));
  const { ready, reconcile } = resumeCheckpoint(checkpoint);
  assert.deepEqual(ready.map(item => item.id), ["verify"]);
  assert.deepEqual(reconcile.map(item => item.id), ["write"]);
  assert.throws(() => createCheckpoint({ objective: "Finish report", items: [{ ...items[0], dependsOn: ["write"] }, items[1]] }), /Cyclic/);
});

test("repairs only the invalid candidate, checks the result, and respects the repair limit", async () => {
  const input = { candidate: "broken", validate: draft => draft === "fixed" ? null : { code: "syntax" },
    repair: ({ candidate, diagnostic }) => {
      assert.equal(candidate, "broken"); assert.equal(diagnostic.code, "syntax"); return "fixed";
    } };
  assert.deepEqual(await repairCandidate(input), { status: "valid", candidate: "fixed", repairs: 1 });
  assert.deepEqual(await repairCandidate({ ...input, maxRepairs: 0 }), { status: "invalid", diagnostic: { code: "syntax" }, repairs: 0 });
  await assert.rejects(repairCandidate({ ...input, signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("context preserves the required objective and complete tool exchanges", () => {
  const goal = { cost: 4, required: true }, largeExchange = { cost: 8 }, recent = { cost: 3 };
  assert.deepEqual(budgetContext([goal, largeExchange, recent], { limit: 10, reserve: 2 }), { status: "fit", groups: [goal, recent], used: 9 });
  assert.deepEqual(budgetContext([goal], { limit: 5, reserve: 2 }), { status: "overflow", requiredCost: 6 });
});

test("events cannot carry a prompt, tool result, or arbitrary diagnostic", () => {
  assert.deepEqual(recoveryEvent({ type: "stall", requestId: "test-1", reason: "stale-answer", elapsedMs: 10, prompt: "private" }),
    { version: 1, type: "stall", requestId: "test-1", reason: "stale-answer", elapsedMs: 10 });
  assert.throws(() => recoveryEvent({ type: "stall", requestId: "test-1", reason: "raw diagnostic" }), /Unknown/);
});
