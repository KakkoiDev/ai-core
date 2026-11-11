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

## Browser WebMCP board tools

Import `registerRevisionedBoardTools` from `@kakkoidev/ai-core/webmcp`.
The browser adapter registers `get_board` and `apply_board_edit` on the
supplied WebMCP context. Pass the board's `getProject`, `editSchema`, and
`applyEdits(project, edits)` functions, plus a
`commitProject(project, message)` function that returns `{ ok: true }`
after the write is accepted, or an error result. Use `isReady` to indicate
whether a remote board is connected. The adapter handles tab-scoped revisions,
while the application defines valid edits and commits them.

## HTTP and SSE live guest transport

For applications that need terminal guests, AI Core provides an optional Node
HTTP server and a browser host adapter. The application supplies the live
session protocol and tool definitions.

- Import `createBridgeServer` from `@kakkoidev/ai-core/sse-bridge`. Pass
  `createLiveSession`, `registerTools`, and the browser origins to allow.
  Call `.listen()` on the returned Node HTTP server. Serve it through HTTPS
  with response buffering disabled when connecting from a public site.
- Import `connectAgentBridge` from `@kakkoidev/ai-core/sse-bridge/host`.
  Call it with `(room, invite, address, onDisconnect)` before registering
  the host's room handlers. Use its returned room as the host transport.
  The invite contains `room` and `password`, each 32 lowercase hex digits.
- `createLiveSession(options)` constructs the terminal guest. It installs
  room handlers and calls `onAvailability(true)` once the host board is
  available. The bridge calls `registerAgent()` and expects an `{ ok }`
  result. Forward available work through `onAIRequest({ sequence, noteId })`.
  The adapter also exposes `ready`, `submitAIEdit`, `waitForAIRequest`,
  `reportAIActivity`, and `stop`. The room protocol uses `read`, `state`,
  `edit`, `end`, `presence`, `agent`, and `ask` messages.
- `registerTools(editor, context, options)` receives an editor with
  `getProject()`, a context with `registerTool({ name, description,
  inputSchema, execute })`, and the session callbacks `isReady`,
  `commitProject`, `waitForAIRequest`, and `reportAIActivity`.

Guests can read `GET /v1` for discovery. POST to `/v1/rooms/{room}/agents`
using the invite password as a bearer credential. Use the returned guest token
to open the `events` URL with `curl --no-buffer` and discover tools at the
`tools` URL. An `ask_ai` event advertises a request. The guest calls
`wait_for_ai_request` to claim it before acting. Closing the stream removes the
guest. The host session owns the board and decides which edits to accept.
