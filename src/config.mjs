import fs from "node:fs";
import path from "node:path";
import { expandHome, stateDir, readJson, merge } from "./util.mjs";

/**
 * Default fleet policy. Everything here can be overridden by
 *   ~/.opencode-fleet/fleet.config.json      (global)
 *   <repo>/.opencode-fleet.json              (per project, wins)
 *   OPENCODE_FLEET_CONFIG=<file>             (explicit, wins over both)
 *
 * All prices are USD per 1,000,000 tokens — the unit humans read on pricing pages.
 */
export const DEFAULTS = {
  opencodeBin: "opencode",

  defaults: {
    profile: "balanced",
    timeoutSec: 1200,
    worktree: true,
    autoApprove: true,      // pass --auto to opencode (safe because of worktree isolation)
    autoCommit: true,       // commit the worker's changes on its own branch when the job ends
    maxConcurrentJobs: 4,
    failover: true,         // on a provider failure, retry with the profile's next candidate
    maxAttempts: 3,         // hard cap on attempts per job, including the first
    agent: null,            // opencode agent name, e.g. "build" or a custom subagent
    variant: null           // reasoning effort, e.g. "high" (provider specific)
  },

  budget: {
    maxPromptUsdPerMTok: 1.5,     // hard ceiling: input price
    maxCompletionUsdPerMTok: 5.0, // hard ceiling: output price
    maxJobUsd: 0.75,              // abort/flag a single job above this
    maxDailyUsd: 10.0,            // refuse new jobs once today's spend crosses this
    requireToolSupport: true,     // a worker without tool calling cannot edit files
    minContext: 100000,           // refuse models that cannot hold a real repo context
    allowUnpriced: false,         // models with unknown price are refused unless allowlisted
    allow: [],                    // glob allowlist, always permitted, e.g. "zai/*"
    deny: ["*gpt-5*", "*claude*", "*gemini*-pro*", "*opus*"]  // never route to premium models
  },

  // Ordered candidates. First one that exists in `opencode models` AND passes the
  // budget guard wins. Add your own; these are only sane starting points.
  // Ordered candidates. First one that is affordable and reachable wins.
  // `ocfleet suggest --write` rewrites this from the providers you are actually
  // authenticated for — much better than these generic defaults.
  profiles: {
    free: {
      description: "Free models — bulk work at zero cost",
      candidates: [
        "openrouter/z-ai/glm-5.2:free",
        "opencode/glm-4.7-free",
        "opencode/north-mini-code-free",
        "opencode/deepseek-v4-flash-free"
      ]
    },
    cheap: {
      description: "Boilerplate, tests, renames, mechanical refactors",
      candidates: [
        "openrouter/z-ai/glm-5.3-flash",
        "opencode/deepseek-v4-flash",
        "openrouter/qwen/qwen3-coder-30b-a3b-instruct",
        "openrouter/deepseek/deepseek-v4-flash"
      ]
    },
    balanced: {
      description: "Default worker: feature work, bug fixes, medium refactors",
      candidates: [
        "openrouter/z-ai/glm-5.3-flash",
        "openrouter/qwen/qwen3-coder",
        "openrouter/z-ai/glm-5",
        "opencode/glm-4.7",
        "openrouter/mistralai/codestral-2508"
      ]
    },
    strong: {
      description: "Tricky logic, cross-file changes, debugging with unclear cause",
      candidates: [
        "openrouter/z-ai/glm-5.3",
        "openrouter/qwen/qwen3-coder-plus",
        "opencode/kimi-k2.7-code",
        "openrouter/moonshotai/kimi-k2.7-code"
      ]
    },
    longcontext: {
      description: "Jobs that must read a lot of files at once (1M+ context)",
      candidates: [
        "openrouter/z-ai/glm-5.3-flash",
        "opencode/nemotron-3-ultra-free",
        "opencode/deepseek-v4-flash",
        "openrouter/deepseek/deepseek-v4-flash"
      ]
    },
    local: {
      description: "Free local models via Ollama/LM Studio (configure the provider first)",
      candidates: ["ollama/qwen3-coder:30b", "lmstudio/qwen3-coder-30b"]
    }
  },

  // Price overrides. Prices normally come from models.dev (every provider
  // opencode knows) and the live OpenRouter catalogue; entries here win over both
  // and cover anything neither knows, such as a local endpoint.
  staticPricing: {
    "zai/glm-4.7": { prompt: 0.60, completion: 2.20, context: 200000, tools: true },
    "zai/glm-4.7-flash": { prompt: 0.06, completion: 0.40, context: 200000, tools: true },
    "zai/glm-5.3": { prompt: 1.40, completion: 4.40, context: 1310720, tools: true },
    "deepseek/deepseek-chat": { prompt: 0.28, completion: 0.42, context: 128000, tools: true },
    "deepseek/deepseek-reasoner": { prompt: 0.28, completion: 0.42, context: 128000, tools: true },
    "ollama/*": { prompt: 0, completion: 0, context: 128000, tools: true, note: "local, free" },
    "lmstudio/*": { prompt: 0, completion: 0, context: 128000, tools: true, note: "local, free" }
  },

  worktree: {
    root: "~/.opencode-fleet/worktrees",
    branchPrefix: "fleet/",
    keepOnSuccess: true,   // keep until fleet_cleanup so the manager can inspect the diff
    keepOnFailure: true
  },

  limits: {
    diffCharsInResult: 12000,
    logTailLines: 120,
    promptCharsMax: 60000
  }
};

export function configPaths(repoDir) {
  const list = [path.join(stateDir(), "fleet.config.json")];
  if (repoDir) list.push(path.join(repoDir, ".opencode-fleet.json"));
  if (process.env.OPENCODE_FLEET_CONFIG) list.push(expandHome(process.env.OPENCODE_FLEET_CONFIG));
  return list;
}

/** Drop _comment/_readme keys so documented example configs stay safe to copy. */
function stripComments(v) {
  if (Array.isArray(v)) return v.map(stripComments);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("_")).map(([k, x]) => [k, stripComments(x)]));
  }
  return v;
}

export function loadConfig(repoDir) {
  let cfg = DEFAULTS;
  const sources = [];
  for (const p of configPaths(repoDir)) {
    if (fs.existsSync(p)) {
      const data = readJson(p);
      if (data) {
        cfg = merge(cfg, stripComments(data));
        sources.push(p);
      }
    }
  }
  cfg._sources = sources;
  return cfg;
}
