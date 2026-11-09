// Policies only: callers own model streams, timers, cancellation, and tool execution.
export function createProgressWatch({
  now = () => performance.now(), openingMs = 40_000, answerMs = 22_000,
  toolMs = 40_000, totalMs = 120_000, minAnswerChars = 12,
} = {}) {
  for (const value of [openingMs, answerMs, toolMs, totalMs, minAnswerChars]) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError("Expected a positive finite recovery limit");
  }
  const start = now();
  let phase = "opening", deadline = start + openingMs, pending = 0, hasAnswer = false;
  const expiration = () => Math.min(deadline, start + totalMs);
  const reason = () => {
    const current = now();
    if (current >= start + totalMs) return "total-timeout";
    return current >= deadline ? `stale-${phase}` : null;
  };
  function observe(event, text = "") {
    if (reason()) return; // A late chunk cannot revive an expired attempt.
    const current = now();
    if (event === "tool-start") {
      phase = "tool"; deadline = current + toolMs; pending = 0; hasAnswer = false;
    } else if (event === "tool-end") {
      phase = "opening"; deadline = current + openingMs; pending = 0; hasAnswer = false;
    } else if (event === "answer" && phase !== "tool") {
      const chars = text.replace(/\s/g, "").length;
      pending += chars;
      if (chars && (!hasAnswer || pending >= minAnswerChars)) {
        hasAnswer = true; pending = 0; phase = "answer"; deadline = current + answerMs;
      }
    }
  }
  return { observe, reason, remainingMs: () => Math.max(0, expiration() - now()) };
}

export function createReasoningWatch() {
  let tail = "", lines = [];
  return delta => {
    const parts = (tail + delta).split("\n");
    tail = (parts.pop() ?? "").slice(-500);
    if (!parts.length) return false;
    lines = [...lines, ...parts.map(line => line.trim().slice(0, 500)).filter(Boolean)].slice(-100);
    const seen = new Map();
    for (let i = 0; i + 2 < lines.length; i++) {
      const key = JSON.stringify(lines.slice(i, i + 3));
      const first = seen.get(key);
      if (first !== undefined && i - first >= 3) return true;
      if (first === undefined) seen.set(key, i);
    }
    return false;
  };
}

export function detectActionLoop(steps) {
  const current = steps.at(-1);
  if (!current) return null;
  const { callKey, resultKey, failed = false } = current;
  const last = n => steps.slice(-n);
  const six = last(6);
  return steps.length >= 4 && last(4).every(s => s.callKey === callKey && s.resultKey === resultKey && (s.failed ?? false) === failed)
    ? "repeated-result"
    : steps.length >= 3 && last(3).every(s => s.callKey === callKey && s.failed)
    ? "repeated-failure"
    : six.length === 6 && six[0].callKey !== six[1].callKey && six.every((s, i) => s.callKey === six[i % 2].callKey)
    ? "alternating-actions" : null;
}

export function createActionWatch() {
  let steps = [];
  return step => {
    steps = [...steps, step].slice(-6);
    const pattern = detectActionLoop(steps);
    if (pattern) steps = [];
    return pattern;
  };
}

/** Pass uncertainty conservatively: a tool may have executed as soon as its call was accepted. */
export function recoveryAction({
  cancelled = false, attempt = 1, maxAttempts = 2,
  answerPublished = false, toolMayHaveRun = false, hasRetainedResult = false,
} = {}) {
  if (cancelled || attempt >= maxAttempts || answerPublished) return "stop";
  if (hasRetainedResult) return "synthesize-without-tools";
  return toolMayHaveRun ? "stop" : "retry";
}

export { runWithReceipt, createCheckpoint, resumeCheckpoint, repairCandidate, budgetContext, recoveryEvent } from "./workflow.mjs";
