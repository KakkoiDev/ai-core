// Model providers for a pi-based agent, as learned by benching (2026-11): which models a local server has, the
// context each really gets, and the pi models.json entries that make pi send the right settings.

/** The models an Ollama server has ([] if it does not answer). */
export async function ollamaModels(url = "http://127.0.0.1:11434") {
  try {
    const r = await fetch(url + "/api/tags", { signal: AbortSignal.timeout(3000) });
    return (await r.json()).models.map((m) => m.name);
  } catch { return []; }
}

/**
 * The context window Ollama gives a model: its num_ctx if set, else its trained length, capped at 32k for GGUF
 * (llama.cpp runner) models; MLX/safetensors models get their full length. A pi config that claims more than this
 * makes pi overfill the window and the model loses the start of the task.
 */
export async function ollamaContext(name, url = "http://127.0.0.1:11434", ggufCap = 32768) {
  try {
    const r = await fetch(url + "/api/show", { method: "POST", body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const set = /num_ctx\s+(\d+)/.exec(j.parameters ?? "");
    if (set) return Number(set[1]);
    const trained = Object.entries(j.model_info ?? {}).find(([k]) => k.endsWith(".context_length"))?.[1] ?? ggufCap;
    return j.details?.format === "gguf" ? Math.min(trained, ggufCap) : trained;
  } catch { return ggufCap; }
}

/**
 * pi models.json providers. DeepSeek through a loopback proxy (deepseek.mjs): model "flash" follows pi's --thinking
 * (off, high, max: thinkingFormat "deepseek" and a level map, else pi treats it as a non-reasoning model and only
 * allows "off"); flash-max/high/off fix the effort in the proxy.
 */
export function piProviders({ ollamaUrl = "http://127.0.0.1:11434", ollama = [], contexts = {}, deepseekPort = 8096 } = {}) {
  return {
    ollama: {
      api: "openai-completions", apiKey: "ollama", baseUrl: ollamaUrl + "/v1",
      compat: { supportsStore: false, supportsStrictMode: false },
      models: ollama.map((id) => (contexts[id] ? { id, contextWindow: contexts[id] } : { id })),
    },
    deepseek: {
      api: "openai-completions", apiKey: "proxy", baseUrl: `http://127.0.0.1:${deepseekPort}/v1`,
      compat: { supportsStore: false, supportsStrictMode: false, thinkingFormat: "deepseek", supportsReasoningEffort: true,
        requiresReasoningContentOnAssistantMessages: true },
      models: [
        { id: "flash", reasoning: true, contextWindow: 1000000, maxTokens: 131072,
          thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" } },
        ...["flash-max", "flash-high", "flash-off"].map((id) => ({ id, reasoning: false, contextWindow: 1000000, maxTokens: 131072 })),
      ],
    },
  };
}

/**
 * pi matches an unknown model id to a similar one without a word (2026-11-25: deepseek/flash ran as flash-off when
 * the config lacked it). Returns an error message when `provider/id` is not in the config's providers, else null.
 */
export function unknownModel(providers, model) {
  const i = model.indexOf("/");
  const p = model.slice(0, i), id = model.slice(i + 1);
  const known = providers[p]?.models?.map((m) => m.id);
  if (!known) return null;
  return known.includes(id) ? null : `${model} is not a known model; ${p} has: ${known.join(", ") || "none"}`;
}
