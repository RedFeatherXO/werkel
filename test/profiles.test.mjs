import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Profiles rewrite themselves when they go stale, because a candidate list is
// worthless as a one-off in a field where new models appear every few weeks.
// These tests cover the two ways that could go wrong: writing something the
// budget guard refuses, and writing when nobody asked.

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocfleet-prof-"));
process.env.OPENCODE_FLEET_HOME = home;
const CONFIG = path.join(home, "fleet.config.json");

const M = await import("../src/models.mjs");

// coding/agentic are what capabilityOf scores on, and they only ever arrive via
// the OpenRouter catalogue — staticPricing deliberately carries prices, not
// benchmarks. So the fixture is a catalogue, exactly like the real one.
const CATALOG = {
  "z-ai/glm-5.3-flash":   { prompt: 0.075, completion: 0.25, context: 1310720, tools: true, coding: 72, agentic: 68 },
  "openai/gpt-5.6-luna":  { prompt: 0.30,  completion: 1.20, context: 400000,  tools: true, coding: 95, agentic: 93 },
  "acme/cheap-strong":    { prompt: 0.05,  completion: 0.20, context: 200000,  tools: true, coding: 88, agentic: 86 },
  "acme/overpriced":      { prompt: 9.00,  completion: 30.0, context: 200000,  tools: true, coding: 99, agentic: 99 }
};
const INSTALLED = Object.keys(CATALOG).map((m) => "openrouter/" + m);
const OR = CATALOG;   // keyed by model id, the way openrouterCatalog returns it

function baseCfg(extra = {}) {
  return {
    defaults: { profile: "balanced", profileMaxAgeDays: 7, rankCandidates: true, modelCooldownMin: 30 },
    budget: {
      maxPromptUsdPerMTok: 1.5, maxCompletionUsdPerMTok: 5, requireToolSupport: true,
      minContext: 100000, allowUnpriced: false, allow: [],
      deny: ["*gpt-5*", "*claude*"]
    },
    staticPricing: {},
    profiles: { balanced: { description: "d", candidates: ["openrouter/z-ai/glm-5.3-flash"] } },
    ...extra
  };
}
const writeConfig = (cfg) => fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));

test("a suggested profile never contains a model the guard would refuse", async () => {
  const cfg = baseCfg();
  const r = await M.suggestProfiles(cfg, {
    installedOverride: INSTALLED, authOverride: ["openrouter"], catalogOverride: OR, cwd: home
  });
  const all = Object.values(r.profiles ?? {}).flatMap((p) => p.candidates ?? []);
  assert.ok(all.length, "no profiles were built at all");
  // this is the regression: a denylisted gpt-5 used to be suggested, then refused
  // on every single job, sitting in the list looking like a working fallback
  assert.ok(!all.some((m) => /gpt-5/.test(m)), `denylisted model suggested: ${all.join(", ")}`);
  assert.ok(!all.some((m) => /overpriced/.test(m)), `model above the ceiling suggested: ${all.join(", ")}`);
  for (const m of all) {
    assert.equal(M.budgetCheck(m, cfg, OR, {}).allowed, true, `${m} would be refused at delegate time`);
  }
});

test("a config this mechanism did not write is never touched", async () => {
  // The regression that matters: someone with hand-written profiles and no stamp
  // must not lose them to an "refresh" on their very next delegation.
  const cfg = baseCfg();                       // no profilesWrittenAt at all
  writeConfig(cfg);
  const before = fs.readFileSync(CONFIG, "utf8");
  assert.equal(await M.refreshProfilesIfStale(cfg, { cwd: home }), null);
  assert.equal(fs.readFileSync(CONFIG, "utf8"), before, "hand-written profiles were overwritten");
});

test("fresh profiles are left alone", async () => {
  const cfg = baseCfg({ profilesWrittenAt: new Date().toISOString() });
  writeConfig(cfg);
  const before = fs.readFileSync(CONFIG, "utf8");
  const r = await M.refreshProfilesIfStale(cfg, { cwd: home });
  assert.equal(r, null);
  assert.equal(fs.readFileSync(CONFIG, "utf8"), before, "the config was touched for no reason");
});

test("stale profiles are rewritten, and the old list is kept", async () => {
  const cfg = baseCfg({ profilesWrittenAt: new Date(Date.now() - 30 * 86400e3).toISOString() });
  writeConfig(cfg);
  const r = await M.refreshProfilesIfStale(cfg, { cwd: home, force: true,
    catalogOverride: OR, installedOverride: INSTALLED, authOverride: ["openrouter"] });
  assert.ok(r?.rewritten, JSON.stringify(r));
  assert.ok(fs.existsSync(CONFIG + ".bak"), "the previous candidate list must survive one file away");
  const after = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  assert.ok(after.profilesWrittenAt, "the new file must record when it was written");
  assert.notEqual(after.profilesWrittenAt, cfg.profilesWrittenAt);
});

test("profileMaxAgeDays: 0 switches the whole thing off", async () => {
  const cfg = baseCfg({ profilesWrittenAt: new Date(Date.now() - 900 * 86400e3).toISOString() });
  cfg.defaults.profileMaxAgeDays = 0;
  writeConfig(cfg);
  assert.equal(await M.refreshProfilesIfStale(cfg, { cwd: home }), null);
});

test("it updates a config, it never invents one", async () => {
  fs.rmSync(CONFIG, { force: true });
  fs.rmSync(CONFIG + ".bak", { force: true });
  const cfg = baseCfg({ profilesWrittenAt: new Date(0).toISOString() });
  const r = await M.refreshProfilesIfStale(cfg, { cwd: home, force: true,
    catalogOverride: OR, installedOverride: INSTALLED, authOverride: ["openrouter"] });
  assert.equal(r, null, "a user with no config file did not ask for one");
  assert.equal(fs.existsSync(CONFIG), false);
});

test("within a profile the better model is tried first, whatever the order on disk", async () => {
  const cfg = baseCfg();
  // deliberately the wrong way round: the weaker model is written first
  cfg.profiles.balanced.candidates = ["openrouter/z-ai/glm-5.3-flash", "openrouter/acme/cheap-strong"];
  const picked = await M.resolveModel({ profile: "balanced" }, cfg,
    { orCatalog: OR, mdCatalog: {}, installed: INSTALLED, cwd: home });
  assert.equal(picked.model, "openrouter/acme/cheap-strong", picked.error ?? picked.model);
  assert.match(picked.reordered ?? "", /ranked ahead of/);
  // and the failover chain has to follow the same order the first choice used
  assert.deepEqual(picked.order, ["openrouter/acme/cheap-strong", "openrouter/z-ai/glm-5.3-flash"]);
});

test("rankCandidates: false means the config order is meant literally", async () => {
  const cfg = baseCfg();
  cfg.defaults.rankCandidates = false;
  cfg.profiles.balanced.candidates = ["openrouter/z-ai/glm-5.3-flash", "openrouter/acme/cheap-strong"];
  const picked = await M.resolveModel({ profile: "balanced" }, cfg,
    { orCatalog: OR, mdCatalog: {}, installed: INSTALLED, cwd: home });
  assert.equal(picked.model, "openrouter/z-ai/glm-5.3-flash");
  assert.equal(picked.reordered, undefined);
});

test("a denylisted model is still refused even if someone hand-writes it into a profile", async () => {
  const cfg = baseCfg();
  cfg.profiles.balanced.candidates = ["openrouter/openai/gpt-5.6-luna", "openrouter/acme/cheap-strong"];
  const picked = await M.resolveModel({ profile: "balanced" }, cfg,
    { orCatalog: OR, mdCatalog: {}, installed: INSTALLED, cwd: home });
  assert.equal(picked.model, "openrouter/acme/cheap-strong",
    "ranking must never promote a model past the guard");
});
