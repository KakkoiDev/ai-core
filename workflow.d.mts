export interface ReceiptIdentity { id: string; fingerprint: string }
export interface ReceiptStore<T> {
  reserve(identity: ReceiptIdentity): Promise<ReceiptIdentity & ({ state: "new" | "pending" } | { state: "done"; result: T })> | (ReceiptIdentity & ({ state: "new" | "pending" } | { state: "done"; result: T }));
  settle(receipt: ReceiptIdentity & { result: T }): unknown;
}
export function runWithReceipt<T>(store: ReceiptStore<T>, identity: ReceiptIdentity, run: (input: { id: string }) => T | Promise<T>): Promise<{ status: "reconcile" } | { status: "executed" | "replayed"; result: T }>;
export type TaskStatus = "todo" | "in-progress" | "done" | "declined" | "blocked" | "paused";
export interface TaskItem { id: string; title: string; status: TaskStatus; dependsOn?: readonly string[] }
export interface CheckpointInput { objective: string; items: readonly TaskItem[]; artifactRefs?: readonly string[]; receiptIds?: readonly string[] }
export interface Checkpoint { version: 1; objective: string; items: Required<TaskItem>[]; artifactRefs: string[]; receiptIds: string[] }
export function createCheckpoint(input: CheckpointInput): Checkpoint;
export function resumeCheckpoint(checkpoint: Checkpoint): { reconcile: Required<TaskItem>[]; ready: Required<TaskItem>[] };
export function repairCandidate<T, D>(input: { candidate: T; validate: (candidate: T) => D | null | undefined | Promise<D | null | undefined>; repair: (input: { candidate: T; diagnostic: D; attempt: number; signal?: AbortSignal }) => T | Promise<T>; maxRepairs?: number; signal?: AbortSignal }): Promise<{ status: "valid"; candidate: T; repairs: number } | { status: "invalid"; diagnostic: D; repairs: number }>;
export function budgetContext<T extends { cost: number; required?: boolean }>(groups: readonly T[], input: { limit: number; reserve?: number }): { status: "overflow"; requiredCost: number } | { status: "fit"; groups: T[]; used: number };
export interface RecoveryEvent {
  type: "stall" | "loop" | "retry" | "stop" | "receipt-replay" | "receipt-reconcile" | "checkpoint" | "resume" | "repair";
  requestId: string;
  attempt?: number;
  reason?: "stale-opening" | "stale-answer" | "stale-tool" | "total-timeout" | "repeated-reasoning" | "repeated-result" | "repeated-failure" | "alternating-actions" | "cancelled" | "invalid-output" | "attempt-limit" | "tool-may-have-run" | "provider-interrupted";
  elapsedMs?: number;
  actionId?: string;
}
export function recoveryEvent(event: RecoveryEvent): RecoveryEvent & { version: 1 };
