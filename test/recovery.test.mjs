import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgressWatch, createReasoningWatch, createActionWatch, recoveryAction } from "../recovery.mjs";

test("partial answer stalls even when whitespace, reasoning or fragments continue", () => {
  let t = 0;
  const watch = createProgressWatch({ now: () => t, openingMs: 20, answerMs: 10 });
  t = 4; watch.observe("answer", "room");
  t = 9; watch.observe("answer", " ");
  t = 12; watch.observe("reasoning", "still thinking"); watch.observe("answer", "x");
  t = 14; watch.observe("answer", "late meaningful output");
  assert.equal(watch.reason(), "stale-answer");
});

test("tools get their own deadline, and useful output never overrides the total cap", () => {
  let t = 0;
  const watch = createProgressWatch({ now: () => t, openingMs: 10, answerMs: 10, toolMs: 15, totalMs: 25 });
  t = 6; watch.observe("tool-start");
  t = 18; assert.equal(watch.reason(), null);
  watch.observe("tool-end");
  t = 24; watch.observe("answer", "done");
  t = 25; assert.equal(watch.reason(), "total-timeout");
});

test("reasoning loops are detected across chunk boundaries", () => {
  const watch = createReasoningWatch();
  assert.equal(watch("plan\nread\nche"), false);
  assert.equal(watch("ck\nplan\nread\ncheck\n"), true);
});

test("repeated tool actions stop even when a failure's text changes", () => {
  const watch = createActionWatch();
  assert.equal(watch({ callKey: "x", resultKey: "first", failed: true }), null);
  assert.equal(watch({ callKey: "x", resultKey: "second", failed: true }), null);
  assert.equal(watch({ callKey: "x", resultKey: "third", failed: true }), "repeated-failure");
  for (const [i, key] of ["x", "y", "x", "y", "x", "y"].entries())
    assert.equal(watch({ callKey: key, resultKey: i }), i === 5 ? "alternating-actions" : null);
});

test("recovery never replays a tool or retries after cancellation or visible output", () => {
  assert.equal(recoveryAction(), "retry");
  assert.equal(recoveryAction({ toolMayHaveRun: true }), "stop");
  assert.equal(recoveryAction({ toolMayHaveRun: true, hasRetainedResult: true }), "synthesize-without-tools");
  for (const opts of [{ attempt: 2 }, { cancelled: true }, { answerPublished: true }])
    assert.equal(recoveryAction({ ...opts, hasRetainedResult: true }), "stop");
});
