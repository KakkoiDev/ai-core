export type ProgressEvent = "answer" | "reasoning" | "tool-start" | "tool-end";
export type TimeoutReason = "stale-opening" | "stale-answer" | "stale-tool" | "total-timeout";
export function createProgressWatch(options?: {
  now?: () => number;
  openingMs?: number;
  answerMs?: number;
  toolMs?: number;
  totalMs?: number;
  minAnswerChars?: number;
}): {
  observe(event: ProgressEvent, text?: string): void;
  reason(): TimeoutReason | null;
  remainingMs(): number;
};
export function createReasoningWatch(): (delta: string) => boolean;
export interface ToolAction {
  callKey: string;
  resultKey: string | number;
  failed?: boolean;
}
export type ActionLoop = "repeated-result" | "repeated-failure" | "alternating-actions";
export function detectActionLoop(steps: readonly ToolAction[]): ActionLoop | null;
export function createActionWatch(): (step: ToolAction) => ActionLoop | null;
export function recoveryAction(options?: {
  cancelled?: boolean;
  attempt?: number;
  maxAttempts?: number;
  answerPublished?: boolean;
  toolMayHaveRun?: boolean;
  hasRetainedResult?: boolean;
}): "stop" | "synthesize-without-tools" | "retry";

export * from "./workflow.mjs";
export * from "./turns.mjs";
