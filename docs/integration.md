# Integrate AI Core into a harness

AI Core is a dependency-free Node ES module. Pin a public GitHub commit, commit your lockfile and use `npm ci`. It has no daemon, database, prompt store, model SDK or automatic tool execution. You can adopt just one function.

## Hook points

1. **Model stream:** Create a progress watch for each attempt, feed answer deltas and tool lifecycle events, and schedule an abort using `remainingMs()`. If the timer fires, read `reason()`. Buffer the answer if you intend to retry before publishing. Feed private reasoning separately to the reasoning watch, and completed tool signatures to the action watch.
2. **Tool dispatcher:** Choose a stable operation ID from task, step and action slot, independent of provider call IDs. Supply a canonical fingerprint of the tool and input, and call `runWithReceipt` around execution. The adapter must reserve atomically across workers, persist before execution, and settle only a matching pending record. Store a result or opaque reference. A pending outcome must be reconciled by inspecting the external system, or by asking the user if it cannot be verified. Only the host can decide whether a repeat is safe.
3. **Task boundary:** Persist the JSON returned by `createCheckpoint` alongside your task history. On restart, `resumeCheckpoint` returns interrupted items to reconcile and new items whose dependencies are done. A declined, paused or blocked prerequisite does not satisfy a dependency. Use separate host leases or transactions to claim ready work.
4. **Validation boundary:** Pass a proposed patch, parsed tool input, or artifact to `repairCandidate`. Its callback gets the previous draft and one diagnostic. Return a new draft, validate it again, and only execute it through the host's normal authorization and receipt path. Don't use this to retry a tool that may have executed.
5. **Before a model request:** Use `budgetContext` with caller-estimated costs in one unit (usually tokens). Reserve capacity for the response, mark the current objective and mandatory instructions as required, and group linked messages such as tool calls and results. Required overflow is a signal to compact or narrow the task; never silently drop mandatory inputs.
6. **End of a model turn (agent hosts):** Pass the finished turn's visible text, thinking, real tool calls, stop reason and tool names to `classifyTurn`. Then call `turnRecovery` with the kind and how many nudges this request has used. On `repair`, turn the calls from `parseTextToolCalls` into real tool calls through the host's normal tool path (authorization and receipts still apply). On `nudge`, send the returned message once and let the model continue. On `stop`, leave the turn and record it. Count nudges per user request so the model cannot loop.
7. **Before each provider request:** Call `requestAdjustments` with the provider, model and thinking level and merge `patch` into the payload. Each rule names the evidence for it in `why`.
8. **Stalls:** Feed every stream event, including reasoning, to `createStallWatch` and abort the request when `reason()` is set. Use it alongside the progress watch when long thinking is expected.
9. **Activity:** Write `recoveryEvent` output to the host's existing event sink. Pass opaque IDs and enumerated reason codes. Do not encode user content in IDs. The event shape never includes raw arguments, prompts, reasoning or tool results.

```js
import { runWithReceipt, recoveryAction, recoveryEvent } from "@kakkoidev/ai-core";

const identity = { id: "job-42-step-3", fingerprint: "canonical-input-digest" };
const operation = await runWithReceipt(receiptStore, identity, ({ id }) =>
  tools.fetchReport({ idempotencyKey: id })
);

if (operation.status === "reconcile") {
  activity.write(recoveryEvent({
    type: "receipt-reconcile", requestId: "job-42", actionId: identity.id,
    reason: "tool-may-have-run"
  }));
  return; // Inspect the effect before continuing.
}

// If the answer then stalls:
if (recoveryAction({ toolMayHaveRun: true, hasRetainedResult: true }) === "synthesize-without-tools") {
  await model.answerFrom(operation.result, { tools: [] });
}
```

## What we borrowed

- **Pi Local Harness** (`harness/extension.mjs`, `recovery-context.mjs`, `task-box.mjs`): bounded wake-ups, a compact recent-history fallback, and task state kept outside the model. Its provider-specific repair proxy and Pi lifecycle stay in PLH.
- **Rich AI Chat** (`src/lib/tasks/store.ts`, `jobs.ts`, `worker.ts`): SQLite receipts from coding-core, verified progress, checkpoints, and leases. Keep the existing database and transaction implementation. The AI Core receipt API is a portable contract for wrapping effects; it does not replace coding-core's database helpers.
- **[Notes Keeping](https://github.com/KakkoiDev/notes-keeping)** (`hooks/todo.ts`, README): the session notes retain objectives and open todos through compaction, and continuation copies unfinished work without modifying the old session. AI Core uses a small, JSON-ready task snapshot, with the same todo status vocabulary. Markdown and panel interactions belong to the plugin.
- **[LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence):** resume from checkpoints and retain completed work. AI Core applies that idea without requiring a graph runtime.
- **[Temporal activities](https://docs.temporal.io/activity-definition):** an activity can complete externally without its completion being recorded. Use a stable idempotency key where the provider supports it; otherwise inspect pending outcomes before replaying.
- **[Claude compaction](https://platform.claude.com/docs/en/build-with-claude/compaction):** summarization is useful when a conversation approaches its window. AI Core selects groups and reports overflow; the host chooses whether and how to summarize.

## First verification in a new host

Inject a synthetic tool result, stall after the first answer token, restart synthesis with tools disabled, and assert the tool ran exactly once. Repeat with a lost receipt settlement and confirm that the harness requests reconciliation. Then test cancellation, context overflow and a resume with a blocked dependency. The core's offline tests demonstrate these contracts without paid calls.
