export function parseLooseObject(source: string): Record<string, unknown> | undefined;
export interface TextToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** The text that was recognised as the call. */
  raw: string;
}
export function parseTextToolCalls(text: string, options?: { tools?: Iterable<string> }): {
  calls: TextToolCall[];
  /** The text with the recognised calls removed. */
  text: string;
};
export type TurnKind = "tool-call" | "answer" | "text-tool-call" | "intent-without-action"
  | "thinking-only" | "empty" | "truncated" | "error";
export function classifyTurn(turn?: {
  text?: string;
  thinking?: string;
  toolCalls?: readonly unknown[];
  stopReason?: string;
  tools?: Iterable<string>;
  /** false for plain chat, where a reply ending in "I will..." is a normal answer. */
  agentic?: boolean;
}): TurnKind;
export function turnRecovery(options?: {
  kind?: TurnKind;
  nudges?: number;
  maxNudges?: number;
  canRepair?: boolean;
}): { action: "none" } | { action: "repair" | "stop"; reason: TurnKind } | { action: "nudge"; reason: TurnKind; message: string };
export function createStallWatch(options?: { now?: () => number; idleMs?: number; totalMs?: number }): {
  observe(): void;
  reason(): "stalled" | "total-timeout" | null;
  remainingMs(): number;
};
export interface RequestInfo {
  provider?: string;
  model?: string;
  thinking?: string | boolean;
  api?: string;
}
export interface RequestRule {
  id: string;
  why: string;
  match(info: RequestInfo): boolean;
  patch: Record<string, unknown>;
}
export const REQUEST_RULES: readonly RequestRule[];
export function requestAdjustments(info?: RequestInfo, rules?: readonly RequestRule[]): { patch: Record<string, unknown>; rules: string[] } | null;
