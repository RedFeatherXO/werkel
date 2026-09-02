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

/** Every place opencode might keep its credentials, across platforms. */
export function authFileCandidates() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const out = [];
  const push = (...parts) => { if (parts[0]) out.push(path.join(...parts)); };

  // XDG layout (Linux, macOS, and opencode on Windows too when it follows XDG)
  push(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode", "auth.json");
  push(home, ".local", "share", "opencode", "auth.json");
  push(home, ".config", "opencode", "auth.json");
  // Windows conventions
  push(process.env.LOCALAPPDATA, "opencode", "auth.json");
  push(process.env.APPDATA, "opencode", "auth.json");
  push(process.env.LOCALAPPDATA, "opencode", "data", "auth.json");
  // macOS
  push(home, "Library", "Application Support", "opencode", "auth.json");

  return [...new Set(out)];
}

/** Config files opencode reads, in the same spirit. */
function configCandidates(repo) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const out = [];
  for (const base of [
    process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
    path.join(home, ".config"),
    process.env.APPDATA ? path.join(process.env.APPDATA) : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA) : null
  ].filter(Boolean)) {
    out.push(path.join(base, "opencode", "opencode.json"));
    out.push(path.join(base, "opencode", "config.json"));
  }
  if (repo) out.push(path.join(repo, "opencode.json"));
  return [...new Set(out)];
}

/**
 * Provider ids opencode has credentials for. Reads only the KEYS of auth.json —
 * never the secrets — plus providers declared in an opencode config, plus the
 * usual environment variables. Every known storage location is checked, because
 * getting this wrong silently widens the model list instead of failing loudly.
 */
export function authenticatedProviders({ repo } = {}) {
  const ids = new Set();

  for (const f of authFileCandidates()) {
    const auth = readJson(f, null);
    if (auth && typeof auth === "object") for (const k of Object.keys(auth)) ids.add(k);
  }

  for (const f of configCandidates(repo)) {
    const cfg = readJson(f, null);
    for (const k of Object.keys(cfg?.provider ?? {})) ids.add(k);
  }

  for (const [env, id] of Object.entries(ENV_PROVIDERS)) if (process.env[env]) ids.add(id);
  return [...ids];
}

/** Where the credentials were actually found — for doctor, so a wrong guess is visible. */
export function authSources() {
  return authFileCandidates().filter((f) => {
    const j = readJson(f, null);
    return j && typeof j === "object" && Object.keys(j).length > 0;
  });
}
