import fs from "node:fs";
import path from "node:path";
import { stateDir, ensureDir, readJson, writeJson } from "./util.mjs";

/**
 * models.dev is the catalogue opencode itself resolves models against, so its
 * ids match `provider/model` exactly and it covers every provider — OpenCode Zen,
 * Z.ai, DeepSeek, Ollama, OpenRouter — not just the one with a public price API.
 * Costs are already USD per 1M tokens.
 */
const URL = "https://models.dev/api.json";
const cacheFile = () => path.join(ensureDir(path.join(stateDir(), "cache")), "modelsdev.json");

function fresh(file, ttlMs) {
  try { return Date.now() - fs.statSync(file).mtimeMs < ttlMs; } catch { return false; }
}

/** provider -> model -> {prompt, completion, context, tools, name, status} */
export async function modelsDevCatalog({ refresh = false, ttlHours = 24 } = {}) {
  const file = cacheFile();
  if (!refresh && fresh(file, ttlHours * 3600e3)) {
    const cached = readJson(file);
    if (cached) return cached;
  }
  try {
    const res = await fetch(URL, { headers: { "user-agent": "opencode-fleet" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const out = {};
    for (const [provider, pdata] of Object.entries(raw)) {
      const models = {};
      for (const [id, m] of Object.entries(pdata?.models ?? {})) {
        const r4 = (n) => (typeof n === "number" ? Math.round(n * 10000) / 10000 : null);
        models[id] = {
          prompt: r4(m.cost?.input),
          completion: r4(m.cost?.output),
          cacheRead: r4(m.cost?.cache_read),
          context: m.limit?.context ?? null,
          tools: m.tool_call === true,
          reasoning: m.reasoning === true,
          name: m.name,
          status: m.status ?? null
        };
      }
      // keep the 4 MB source out of our cache — only what the guard needs
      out[provider] = models;
    }
    writeJson(file, out);
    return out;
  } catch (e) {
    const stale = readJson(file);
    if (stale) return stale;
    return {};
  }
}

export function lookupModelsDev(catalog, provider, model) {
  const hit = catalog?.[provider]?.[model];
  return hit ? { ...hit, source: "models.dev" } : null;
}

/** Everything a provider offers, cheapest first — used to suggest candidates. */
export function providerModels(catalog, provider, { toolsOnly = true, maxPrompt = null } = {}) {
  const models = catalog?.[provider] ?? {};
  return Object.entries(models)
    .filter(([, m]) => (!toolsOnly || m.tools) && m.status !== "deprecated")
    .filter(([, m]) => maxPrompt == null || (m.prompt != null && m.prompt <= maxPrompt))
    .map(([id, m]) => ({ model: `${provider}/${id}`, ...m }))
    .sort((a, b) => (a.prompt ?? 1e9) - (b.prompt ?? 1e9) || (b.context ?? 0) - (a.context ?? 0));
}

// ---- which providers can this machine actually reach ----------------------

const ENV_PROVIDERS = {
  OPENROUTER_API_KEY: "openrouter", ZAI_API_KEY: "zai", ZHIPUAI_API_KEY: "zhipuai",
  DEEPSEEK_API_KEY: "deepseek", GROQ_API_KEY: "groq", MISTRAL_API_KEY: "mistral",
  TOGETHER_API_KEY: "togetherai", FIREWORKS_API_KEY: "fireworks-ai",
  OPENAI_API_KEY: "openai", ANTHROPIC_API_KEY: "anthropic", GEMINI_API_KEY: "google",
  CEREBRAS_API_KEY: "cerebras", XAI_API_KEY: "xai"
};

/**
 * Provider ids opencode has credentials for. Reads only the KEYS of auth.json —
 * never the secrets — plus providers declared in an opencode config, plus the
 * usual environment variables.
 */
export function authenticatedProviders({ repo } = {}) {
  const home = process.env.HOME || "";
  const ids = new Set();

  const auth = readJson(path.join(home, ".local/share/opencode/auth.json"), {});
  for (const k of Object.keys(auth ?? {})) ids.add(k);

  for (const f of [
    path.join(home, ".config/opencode/opencode.json"),
    path.join(home, ".config/opencode/config.json"),
    repo ? path.join(repo, "opencode.json") : null
  ].filter(Boolean)) {
    const cfg = readJson(f, null);
    for (const k of Object.keys(cfg?.provider ?? {})) ids.add(k);
  }

  for (const [env, id] of Object.entries(ENV_PROVIDERS)) if (process.env[env]) ids.add(id);
  return [...ids];
}
