import fs from "node:fs";
import path from "node:path";
import { stateDir, ensureDir, readJson, writeJson, run, globMatch, today, resolveBin } from "./util.mjs";
import { modelsDevCatalog, lookupModelsDev, providerModels, authenticatedProviders } from "./catalog.mjs";

const CACHE = () => ensureDir(path.join(stateDir(), "cache"));
const OR_URL = "https://openrouter.ai/api/v1/models";

const PER_MTOK = 1_000_000;

function cacheFile(name) { return path.join(CACHE(), name); }

function fresh(file, ttlMs) {
  try { return Date.now() - fs.statSync(file).mtimeMs < ttlMs; } catch { return false; }
}

/** OpenRouter public catalogue: id -> {prompt, completion, context, tools} in USD/1M tok. */
export async function openrouterCatalog({ refresh = false, ttlHours = 24 } = {}) {
  const file = cacheFile("openrouter.json");
  if (!refresh && fresh(file, ttlHours * 3600e3)) {
    const cached = readJson(file);
    if (cached) return cached;
  }
  try {
    const res = await fetch(OR_URL, { headers: { "user-agent": "opencode-fleet" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const out = {};
    for (const m of json.data ?? []) {
      const r4 = (n) => Math.round(n * 10000) / 10000;
      const p = r4(Number(m.pricing?.prompt ?? NaN) * PER_MTOK);
      const c = r4(Number(m.pricing?.completion ?? NaN) * PER_MTOK);
      const aa = m.benchmarks?.artificial_analysis ?? null;
      const arena = Array.isArray(m.benchmarks?.design_arena)
        ? m.benchmarks.design_arena.filter((a) => typeof a?.elo === "number")
        : [];
      out[m.id] = {
        prompt: Number.isFinite(p) && p >= 0 ? p : null,
        completion: Number.isFinite(c) && c >= 0 ? c : null,
        context: m.context_length ?? null,
        tools: (m.supported_parameters ?? []).includes("tools"),
        name: m.name,
        // Artificial Analysis indices, shipped inside the OpenRouter catalogue.
        // Only ~40% of models carry them, so every consumer must handle null.
        coding: typeof aa?.coding_index === "number" ? aa.coding_index : null,
        agentic: typeof aa?.agentic_index === "number" ? aa.agentic_index : null,
        intelligence: typeof aa?.intelligence_index === "number" ? aa.intelligence_index : null,
        elo: arena.length ? Math.round(Math.max(...arena.map((a) => a.elo))) : null
      };
    }
    writeJson(file, out);
    return out;
  } catch (e) {
    const stale = readJson(file);
    if (stale) return stale;
    throw new Error(`could not load OpenRouter catalogue (${e.message}) and no cache available`);
  }
}

/** Models opencode actually has configured, as "provider/model" strings.
 *  Directory matters: a project's opencode.json can define its own providers. */
export async function installedModels({ bin, cwd = process.cwd(), refresh = false, ttlMin = 15 } = {}) {
  bin = bin ?? resolveBin(null);
  const key = Buffer.from(cwd).toString("base64url").slice(-40);
  const file = cacheFile(`opencode-models-${key}.json`);
  if (!refresh && fresh(file, ttlMin * 60e3)) {
    const cached = readJson(file);
    if (cached?.length) return cached;
  }
  const r = await run(bin, ["models"], { timeout: 90_000, cwd });
  if (!r.ok && !r.stdout) return readJson(file, []);
  const list = r.stdout.split("\n").map((s) => s.trim()).filter((s) => s && s.includes("/") && !s.startsWith("#"));
  // `opencode models` can return a short partial list while it is still fetching
  // its catalogue — caching that would silently shrink the fleet for an hour.
  if (list.length >= 5) writeJson(file, list);
  return list.length ? list : readJson(file, []);
}

/** Load the model list, retrying once when it clearly predates provider setup.
 *  opencode's first `models` call in a new project can answer before it has
 *  resolved project-local providers — one retry turns a false "not configured"
 *  into the real list. */
export async function installedModelsSmart(cfg, { bin, cwd, refresh = false } = {}) {
  bin = bin ?? resolveBin(cfg);
  let list = await installedModels({ bin, cwd, refresh });
  // a cold start can answer before opencode has loaded any provider at all
  if (list.length < 5) {
    await new Promise((r) => setTimeout(r, 1000));
    const retry = await installedModels({ bin, cwd, refresh: true });
    if (retry.length > list.length) list = retry;
  }
  const wanted = Object.values(cfg.profiles ?? {}).flatMap((p) => p.candidates ?? []);
  if (wanted.length && !wanted.some((m) => list.includes(m))) {
    const again = await installedModels({ bin, cwd, refresh: true });
    if (again.length > list.length || again.some((m) => wanted.includes(m))) list = again;
  }
  return list;
}

export function splitRef(ref) {
  const i = ref.indexOf("/");
  return i === -1 ? { provider: ref, model: "" } : { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

function staticLookup(cfg, ref) {
  const table = cfg.staticPricing ?? {};
  if (table[ref]) return { ...table[ref], source: "static" };
  for (const [pattern, val] of Object.entries(table)) {
    if (pattern.includes("*") && globMatch(pattern, ref)) return { ...val, source: "static:" + pattern };
  }
  return null;
}

/** Price + capability lookup for a "provider/model" reference.
 *  Order: explicit staticPricing → live OpenRouter API → models.dev (every other
 *  provider opencode can reach) → unknown (which the guard refuses). */
export function priceInfo(ref, cfg, orCatalog, mdCatalog) {
  const { provider, model } = splitRef(ref);

  const s = staticLookup(cfg, ref);
  if (s) return { prompt: s.prompt, completion: s.completion, context: s.context ?? null, tools: s.tools !== false, source: s.source, note: s.note };

  if (provider === "openrouter" && orCatalog?.[model]) return { ...orCatalog[model], source: "openrouter" };

  const md = lookupModelsDev(mdCatalog, provider, model);
  if (md) return md;

  if (orCatalog?.[ref]) return { ...orCatalog[ref], source: "openrouter:proxy" };
  if (provider === "openrouter" && mdCatalog?.openrouter?.[model]) return { ...mdCatalog.openrouter[model], source: "models.dev" };
  return { prompt: null, completion: null, context: null, tools: null, source: "unknown" };
}

/** The gate every delegation passes through. */
export function budgetCheck(ref, cfg, orCatalog, { spentToday = 0, mdCatalog } = {}) {
  const b = cfg.budget ?? {};
  const info = priceInfo(ref, cfg, orCatalog, mdCatalog);
  const allowlisted = (b.allow ?? []).some((p) => globMatch(p, ref));

  const deny = (b.deny ?? []).find((p) => globMatch(p, ref));
  if (deny && !allowlisted) return { allowed: false, reason: `denylist match "${deny}"`, info };

  if (b.maxDailyUsd != null && spentToday >= b.maxDailyUsd) {
    return { allowed: false, reason: `daily budget exhausted (${spentToday.toFixed(2)} / ${b.maxDailyUsd} USD)`, info, budgetStop: true };
  }

  if (allowlisted) return { allowed: true, reason: "allowlisted", info };

  if (info.prompt == null || info.completion == null) {
    if (!b.allowUnpriced) return { allowed: false, reason: `no price known for ${ref} (source: ${info.source}); add it to staticPricing or budget.allow`, info };
    return { allowed: true, reason: "unpriced but allowUnpriced=true", info };
  }
  if (b.maxPromptUsdPerMTok != null && info.prompt > b.maxPromptUsdPerMTok) {
    return { allowed: false, reason: `input price $${info.prompt.toFixed(2)}/Mtok exceeds limit $${b.maxPromptUsdPerMTok}/Mtok`, info };
  }
  if (b.maxCompletionUsdPerMTok != null && info.completion > b.maxCompletionUsdPerMTok) {
    return { allowed: false, reason: `output price $${info.completion.toFixed(2)}/Mtok exceeds limit $${b.maxCompletionUsdPerMTok}/Mtok`, info };
  }
  if (b.requireToolSupport && info.tools === false) {
    return { allowed: false, reason: `model has no tool calling — it cannot edit files`, info };
  }
  if (b.minContext != null && info.context != null && info.context < b.minContext) {
    return { allowed: false, reason: `context ${info.context} below required ${b.minContext}`, info };
  }
  return { allowed: true, reason: "within budget", info };
}

/** Pick a concrete model for an explicit ref or a profile name. */
export async function resolveModel({ model, profile }, cfg, { bin, cwd, orCatalog, mdCatalog, installed, spentToday = 0 } = {}) {
  orCatalog = orCatalog ?? (await openrouterCatalog().catch(() => ({})));
  mdCatalog = mdCatalog ?? (await modelsDevCatalog().catch(() => ({})));
  installed = installed ?? (await installedModels({ bin: bin ?? resolveBin(cfg), cwd }));
  let known = new Set(installed);
  let refreshedOnce = false;
  const rejected = [];

  // The model list can be incomplete right after a provider is added, so a miss
  // triggers exactly one refresh before we downgrade it to a warning.
  const isKnown = async (ref) => {
    if (known.has(ref) || known.size === 0) return true;
    if (!refreshedOnce) {
      refreshedOnce = true;
      const fresh = await installedModels({ bin, cwd, refresh: true });
      if (fresh.length) known = new Set(fresh);
    }
    return known.has(ref);
  };

  const budgetOk = (ref) => {
    const chk = budgetCheck(ref, cfg, orCatalog, { spentToday, mdCatalog });
    if (!chk.allowed) { rejected.push({ ref, reason: chk.reason, budgetStop: chk.budgetStop }); return null; }
    return chk;
  };

  if (model) {
    const chk = budgetOk(model);
    if (!chk) return { error: `model "${model}" refused: ${rejected[rejected.length - 1]?.reason}`, rejected };
    const avail = await isKnown(model);
    return {
      model, price: chk.info, why: "explicit",
      warning: avail ? undefined : "not listed by `opencode models` — running anyway; if that provider is not configured the job will fail on its timeout"
    };
  }

  const name = profile ?? cfg.defaults.profile;
  const prof = cfg.profiles?.[name];
  if (!prof) return { error: `unknown profile "${name}". Known: ${Object.keys(cfg.profiles ?? {}).join(", ")}`, rejected };

  const affordable = [];
  for (const cand of prof.candidates ?? []) {
    const chk = budgetOk(cand);
    if (!chk) continue;
    affordable.push({ cand, chk });
    if (await isKnown(cand)) return { model: cand, price: chk.info, why: `profile "${name}"` };
  }
  if (affordable.length) {
    const { cand, chk } = affordable[0];
    return {
      model: cand, price: chk.info, why: `profile "${name}" (fallback)`,
      warning: `no candidate of profile "${name}" appears in \`opencode models\` — trying ${cand} anyway. Run \`ocfleet doctor\` if it fails.`
    };
  }
  return {
    error: `no candidate of profile "${name}" is usable`,
    rejected,
    hint: "run `ocfleet doctor` — usually the provider is not authenticated (`opencode auth login`), the model id changed, or the budget limits are too tight"
  };
}

/** Every installed model that passes the guard, cheapest first. */
export async function allowedModels(cfg, { bin, cwd, refresh = false } = {}) {
  const orCatalog = await openrouterCatalog({ refresh }).catch(() => ({}));
  const mdCatalog = await modelsDevCatalog({ refresh }).catch(() => ({}));
  const installed = await installedModelsSmart(cfg, { bin, cwd, refresh });
  const rows = [];
  for (const ref of installed) {
    const chk = budgetCheck(ref, cfg, orCatalog, { mdCatalog });
    const cap = capabilityOf(ref, chk.info);
    rows.push({
      model: ref, allowed: chk.allowed, reason: chk.reason, ...chk.info,
      capability: Math.round(cap.value * 10) / 10, capabilitySource: cap.source,
      value: Math.round(valueScore(ref, chk.info) * 10) / 10
    });
  }
  rows.sort((a, b) => (a.prompt ?? 1e9) - (b.prompt ?? 1e9));
  return rows;
}

// ---- spend tracking -------------------------------------------------------

export function spendFile(day = today()) { return path.join(stateDir(), "spend", `${day}.json`); }

export function spentToday(day = today()) {
  return readJson(spendFile(day), { total: 0, jobs: [] });
}

export function recordSpend(jobId, model, usd, day = today()) {
  const cur = spentToday(day);
  cur.total = Number(((cur.total ?? 0) + (usd || 0)).toFixed(6));
  cur.jobs = (cur.jobs ?? []).concat([{ jobId, model, usd: usd || 0, at: new Date().toISOString() }]).slice(-500);
  writeJson(spendFile(day), cur);
  return cur.total;
}

/** Rough cost estimate from token counts when the provider reports none. */
export function estimateCost(tokens, price) {
  if (!price || price.prompt == null) return null;
  const inTok = (tokens?.input ?? 0) + (tokens?.cache?.read ?? 0) * 0.5;
  const outTok = tokens?.output ?? 0;
  return (inTok / PER_MTOK) * price.prompt + (outTok / PER_MTOK) * price.completion;
}

// ---- profile suggestions --------------------------------------------------

/**
 * Ranking a model without benchmarks: name families that are built for coding
 * score up, names that advertise a small/preview variant score down, and each
 * tier sorts in the direction that tier actually wants — cheapest first for the
 * budget tiers, most capable first for the strong ones.
 */
const FAMILY_STRONG = /(qwen3(\.\d+)?-coder(-plus|-next)?|glm-5(\.\d+)?|kimi-k[23](\.\d+)?(-code)?|codestral|deepseek-v\d-pro|kat-coder|seed-\d+-code|north-mini-code|devstral|grok-code|minimax-m\d)/i;
const FAMILY_CODING = /(coder|code|glm|deepseek|qwen|kimi|codestral|mistral|minimax|ling|nemotron|llama|gpt-oss)/i;
// \b matters: without it "gemini" matches "mini" and every Gemini model gets
// penalised as a small variant.
const WEAK_NAME = /\b(nano|mini|tiny|lite|small|micro|preview|experimental|draft|distill)\b|[-_.](0\.\d|[1-9])b\b/i;
const UNSTABLE_ID = /^~|:(batch|extended|thinking)$|latest$/i;

/**
 * What the model is worth per dollar. Benchmarks first — Artificial Analysis
 * publishes a coding and an agentic index through the OpenRouter catalogue, and
 * a fleet worker needs both: write the code, then drive the tools. Only models
 * without published numbers fall back to reading the name.
 */
export function capabilityOf(ref, info) {
  if (info?.coding != null || info?.agentic != null) {
    const coding = info.coding ?? info.intelligence ?? 0;
    const agentic = info.agentic ?? coding;
    return { value: 0.6 * coding + 0.4 * agentic, source: "artificial-analysis" };
  }
  if (info?.intelligence != null) return { value: info.intelligence * 0.9, source: "intelligence-index" };
  // No published benchmark: estimate from the name, deliberately below a
  // measured mid-tier model so unknowns never outrank proven ones.
  const name = splitRef(ref).model;
  let guess = 30;
  if (FAMILY_STRONG.test(name)) guess = 45;
  else if (FAMILY_CODING.test(name)) guess = 38;
  if (WEAK_NAME.test(name)) guess -= 18;
  return { value: guess, source: "estimated-from-name" };
}

/** Blended price of a typical coding turn: much more input than output. */
export function blendedCost(info) {
  const inTok = info?.prompt ?? 0;
  const outTok = info?.completion ?? inTok;
  return (3 * inTok + outTok) / 4;
}

/** Capability per dollar. The +1 keeps free models near their raw capability. */
export function valueScore(ref, info) {
  return capabilityOf(ref, info).value / (1 + blendedCost(info));
}

function qualityScore(ref, info) {
  const cap = capabilityOf(ref, info);
  let score = cap.value;
  if ((info.context ?? 0) >= 1000000) score += 6;
  else if ((info.context ?? 0) >= 250000) score += 3;
  if (WEAK_NAME.test(splitRef(ref).model) && cap.source === "estimated-from-name") score -= 5;
  return score;
}

/** Group prices into ~2x bands, so near-identical prices tie and capability decides. */
function priceBand(usdPerMtok) {
  if (!usdPerMtok) return -99;
  return Math.floor(Math.log10(usdPerMtok) * 3);
}

/** "z-ai/glm-5.3-flash" -> "glm", so one family cannot fill a whole profile. */
function familyOf(ref) {
  const name = splitRef(ref).model.split("/").pop().toLowerCase();
  const strong = name.match(FAMILY_STRONG);
  if (strong) return strong[0].replace(/[\d.]+.*$/, "");
  return name.replace(/[:@].*$/, "").split(/[-_.]/)[0].replace(/\d+$/, "");
}

// order "value" = most capability per dollar, "quality" = most capability, period.
const TIERS = [
  { name: "free",     min: 0,     max: 0,    order: "quality", minScore: 0,  description: "Free models — bulk work at zero cost" },
  { name: "cheap",    min: 0.001, max: 0.3,  order: "value",   minScore: 35, description: "Boilerplate, tests, renames, mechanical refactors" },
  { name: "balanced", min: 0.05,  max: 0.9,  order: "quality", minScore: 45, description: "Default worker: features, bug fixes, medium refactors" },
  { name: "strong",   min: 0.4,   max: null, order: "quality", minScore: 55, description: "Tricky logic, cross-file changes, unclear bugs" }
];

/**
 * Build profile candidate lists from the models this machine is authenticated
 * for. A model may appear in several profiles — that is normal, glm-5.3-flash is
 * both the cheap workhorse and the long-context one.
 */
export async function suggestProfiles(cfg, { bin, cwd, refresh = false, minContext = 100000, installedOverride, authOverride } = {}) {
  const orCatalog = await openrouterCatalog({ refresh }).catch(() => ({}));
  const mdCatalog = await modelsDevCatalog({ refresh }).catch(() => ({}));
  const installed = installedOverride ?? (await installedModelsSmart(cfg, { bin, cwd, refresh }));

  // `opencode models` lists providers you have no credentials for; suggesting
  // those would produce profiles that hang or 401 on first use.
  const auth = new Set(authOverride ?? authenticatedProviders({ repo: cwd }));
  const reachable = auth.size ? installed.filter((ref) => auth.has(splitRef(ref).provider)) : installed;

  const ceiling = cfg.budget?.maxPromptUsdPerMTok ?? 1.5;
  const outCeiling = cfg.budget?.maxCompletionUsdPerMTok ?? 5;

  const priced = reachable
    .filter((ref) => !UNSTABLE_ID.test(splitRef(ref).model))
    .map((ref) => ({ ref, info: priceInfo(ref, cfg, orCatalog, mdCatalog) }))
    .filter((r) => r.info.prompt != null && r.info.completion != null && r.info.tools !== false)
    .filter((r) => (r.info.context ?? 0) >= minContext)
    .filter((r) => r.info.status !== "deprecated")
    .filter((r) => r.info.prompt <= ceiling && r.info.completion <= outCeiling)
    .map((r) => ({ ...r, score: qualityScore(r.ref, r.info), value: valueScore(r.ref, r.info) }));

  const pickDiverse = (pool, description, limit = 4) => {
    const picks = [];
    const seen = new Map();
    for (const r of pool) {
      const fam = familyOf(r.ref);
      if ((seen.get(fam) ?? 0) >= 2) continue;   // at most two of one family
      seen.set(fam, (seen.get(fam) ?? 0) + 1);
      picks.push(r.ref);
      if (picks.length >= limit) break;
    }
    return picks.length ? { description, candidates: picks } : null;
  };

  const profiles = {};
  for (const tier of TIERS) {
    const pool = priced
      .filter((r) => r.info.prompt >= tier.min && (tier.max == null || r.info.prompt <= tier.max))
      .filter((r) => r.score >= tier.minScore)
      .sort((a, b) => tier.order === "value"
        ? b.value - a.value || b.score - a.score
        : b.score - a.score || a.info.prompt - b.info.prompt);
    const built = pickDiverse(pool, tier.description);
    if (built) profiles[tier.name] = built;
  }

  // long context wants reach and value, not the priciest model that fits
  const long = priced.filter((r) => (r.info.context ?? 0) >= 500000)
    .sort((a, b) => b.value - a.value)
    .slice(0, 4).map((r) => r.ref);
  if (long.length) profiles.longcontext = { description: "Jobs that must read a lot at once (500k+ context)", candidates: long };

  return {
    profiles,
    authenticatedProviders: [...auth],
    considered: priced.length,
    installed: installed.length,
    note: priced.length ? undefined : "no priced, tool-capable model found — is a provider authenticated? (opencode auth login)"
  };
}

export { modelsDevCatalog, providerModels, authenticatedProviders };
