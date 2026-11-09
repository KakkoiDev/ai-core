// Hosts provide storage, model calls and authorization. This module only defines their shared contracts.
const text = (value, field) => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a nonempty string`);
  return value;
};
const count = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} must be a nonnegative integer`);
  return value;
};

/**
 * Storage must atomically reserve by id and settle only a matching pending record.
 * On errors after reserve, leave the record pending: the external effect may have happened.
 */
export async function runWithReceipt(store, { id, fingerprint }, run) {
  text(id, "id"); text(fingerprint, "fingerprint");
  const receipt = await store.reserve({ id, fingerprint });
  if (receipt.id !== id || receipt.fingerprint !== fingerprint) throw new Error("Receipt identity conflict");
  if (receipt.state === "done") return { status: "replayed", result: receipt.result };
  if (receipt.state === "pending") return { status: "reconcile" };
  if (receipt.state !== "new") throw new Error("Invalid receipt state");
  const result = await run({ id });
  await store.settle({ id, fingerprint, result });
  return { status: "executed", result };
}

const states = new Set(["todo", "in-progress", "done", "declined", "blocked", "paused"]);

/** JSON-ready handoff. Artifacts and receipts are references; the host owns access and retention. */
export function createCheckpoint({ objective, items, artifactRefs = [], receiptIds = [] }) {
  text(objective, "objective");
  const byId = new Map();
  const copied = items.map(({ id, title, status, dependsOn = [] }) => {
    text(id, "item id"); text(title, "title");
    if (byId.has(id) || !states.has(status)) throw new Error("Duplicate item id or invalid status");
    const item = { id, title, status, dependsOn: [...new Set(dependsOn)] };
    byId.set(id, item);
    return item;
  });
  const active = new Set(), visited = new Set();
  function visit(id) {
    if (active.has(id)) throw new Error("Cyclic task dependencies");
    if (visited.has(id)) return;
    const item = byId.get(id);
    if (!item) throw new Error(`Unknown dependency: ${id}`);
    active.add(id);
    item.dependsOn.forEach(visit);
    active.delete(id); visited.add(id);
  }
  copied.forEach(item => visit(item.id));
  return { version: 1, objective, items: copied, artifactRefs: artifactRefs.map(ref => text(ref, "artifact ref")),
    receiptIds: receiptIds.map(id => text(id, "receipt id")) };
}

/** Separate work to reconcile after interruption from new work that can run. */
export function resumeCheckpoint(checkpoint) {
  if (checkpoint.version !== 1) throw new Error("Unsupported checkpoint version");
  const { items } = createCheckpoint(checkpoint);
  const completed = new Set(items.filter(item => item.status === "done").map(item => item.id));
  return {
    reconcile: items.filter(item => item.status === "in-progress"),
    ready: items.filter(item => item.status === "todo" && item.dependsOn.every(id => completed.has(id))),
  };
}

/** Try to fix the candidate, never execute it. Validate every draft, and bound repair attempts. */
export async function repairCandidate({ candidate, validate, repair, maxRepairs = 1, signal }) {
  count(maxRepairs, "maxRepairs");
  let repairs = 0;
  for (;;) {
    signal?.throwIfAborted();
    const diagnostic = await validate(candidate);
    signal?.throwIfAborted();
    if (diagnostic == null) return { status: "valid", candidate, repairs };
    if (repairs >= maxRepairs) return { status: "invalid", diagnostic, repairs };
    candidate = await repair({ candidate, diagnostic, attempt: ++repairs, signal });
  }
}

/** Select whole groups (for example, a tool call plus its result); required groups always win. */
export function budgetContext(groups, { limit, reserve = 0 }) {
  count(limit, "limit"); count(reserve, "reserve");
  const cost = groups.map(group => count(group.cost, "group cost"));
  let used = cost.reduce((total, value, index) => total + (groups[index].required ? value : 0), reserve);
  if (used > limit) return { status: "overflow", requiredCost: used };
  const selected = groups.map(group => Boolean(group.required));
  for (let i = groups.length - 1; i >= 0; i--) {
    if (!selected[i] && used + cost[i] <= limit) {
      selected[i] = true;
      used += cost[i];
    }
  }
  return { status: "fit", groups: groups.filter((_, index) => selected[index]), used };
}

const eventTypes = new Set(["stall", "loop", "retry", "stop", "receipt-replay", "receipt-reconcile", "checkpoint", "resume", "repair"]);
const eventReasons = new Set(["stale-opening", "stale-answer", "stale-tool", "total-timeout", "repeated-reasoning",
  "repeated-result", "repeated-failure", "alternating-actions", "cancelled", "invalid-output", "attempt-limit",
  "tool-may-have-run", "provider-interrupted"]);
const identifier = (value, field) => {
  if (typeof value !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(value)) throw new TypeError(`Invalid ${field}`);
  return value;
};

/** Build a payload-free telemetry envelope. Hosts pass opaque ids, never user or tool text. */
export function recoveryEvent({ type, requestId, attempt, reason, elapsedMs, actionId }) {
  if (!eventTypes.has(type) || (reason !== undefined && !eventReasons.has(reason))) throw new Error("Unknown recovery event or reason");
  return { version: 1, type, requestId: identifier(requestId, "requestId"),
    ...(attempt === undefined ? {} : { attempt: count(attempt, "attempt") }),
    ...(reason === undefined ? {} : { reason }),
    ...(elapsedMs === undefined ? {} : { elapsedMs: count(elapsedMs, "elapsedMs") }),
    ...(actionId === undefined ? {} : { actionId: identifier(actionId, "actionId") }) };
}
