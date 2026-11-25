// What a coding-agent harness should give each model, as measured on benches (agentbench). The choices are data
// (harness-profiles.json): each names a part, the models it applies to, and the bench result behind it. A host
// (agentbox) maps part names to its own files.
import { readFileSync } from "node:fs";

export const HARNESS_PROFILES = JSON.parse(readFileSync(new URL("./harness-profiles.json", import.meta.url), "utf8"));

function matches(rule, provider, id) {
  if (rule.providers && !rule.providers.includes(provider)) return false;
  if (rule.notProviders && rule.notProviders.includes(provider)) return false;
  if (rule.model && !new RegExp(rule.model, "i").test(id)) return false;
  return true;
}

/** The parts (extensions, prompt lines) a model gets: [{ part, kind, why, text? }]. */
export function harnessFor(model, profiles = HARNESS_PROFILES) {
  const i = model.indexOf("/");
  const provider = model.slice(0, i), id = model.slice(i + 1);
  return profiles.rules.filter((r) => matches(r.when ?? {}, provider, id)).map(({ part, kind, why, text }) => ({ part, kind, why, ...(text ? { text } : {}) }));
}

/**
 * pi's bash tool has no default timeout (2026-11-24: one command that never ended, DeepSeek fuzzing a calculator,
 * used a task's whole 15 minutes). The timeout, in seconds, a bash call should get.
 */
export function commandTimeout(asked, { fallback = 120, max = 600 } = {}) {
  return Math.min(typeof asked === "number" && asked > 0 ? asked : fallback, max);
}
