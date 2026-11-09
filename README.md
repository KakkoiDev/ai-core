# AI Core

Small recovery policies for local model harnesses. One ES module, zero dependencies, no provider SDK or background process. Requires Node 20+.

Install the public package from a pinned GitHub commit; no npm registry publication or GitHub credentials are needed.

```sh
npm install @kakkoidev/ai-core@https://codeload.github.com/KakkoiDev/ai-core/tar.gz/refs/tags/v0.2.0
```

Import from `@kakkoidev/ai-core`. Use one watch per attempt (one action watch per task):

- `createProgressWatch()`: opening, answer, and tool deadlines plus a hard cap. Feed answer deltas and accepted/completed tool events. Arm a timer for `remainingMs()` and inspect `reason()` on expiry; only the host aborts the provider.
- `createReasoningWatch()`: feed private reasoning deltas. It detects repeated three-line sequences and never needs to log the reasoning. Do not feed generated code or the final answer.
- `createActionWatch()`: feed completed tool actions using stable, host-normalized call and result keys. It flags repeated results, repeated failures, and alternating actions.
- `recoveryAction()`: decide whether to retry, stop, or synthesize from retained results with tools disabled. An accepted tool request may already have executed. Set `toolMayHaveRun` conservatively. This policy does not provide exactly-once execution; use durable action receipts if restarting a process that can write externally.

Rich AI Chat can map AI SDK answer and tool events to the progress watch while retaining answer buffering and Activity in its adapter. Pi Local Harness (PLH) can feed reasoning deltas and completed tool events from its Pi hooks; keep PLH's wake-up, task state and intervention messages in PLH. For either host, keep private prompts and traces out of the shared policy and tests.

Commit the host lockfile and use `npm ci` when packaging the host. Run `npm test` for deterministic fault injection; these tests make no model or network calls.

Version 0.2 also provides tool receipts, task checkpoints, targeted repair, context budgeting and structured recovery events. See the [integration guide](docs/integration.md) for API contracts and an end-to-end example.
