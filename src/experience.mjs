import path from "node:path";
import { stateDir, ensureDir, readJson, writeJson } from "./util.mjs";

/**
 * What the fleet has learned about how each model actually performs on this
 * machine.
 *
 * Benchmarks rank models, but they were measured on someone else's machine
 * with someone else's prompts. Every finished job is one more measurement on
 * *this* machine, and throwing it away means paying for the same lesson
 * forever. This ledger stores those outcomes and turns them into a small,
 * bounded adjustment on top of the benchmark score.
 *
 * The formulas avoid three traps:
 * - Volume bias: everything works on decayed rates, never raw counts, so the
 *   most-used model cannot win by merely being used most.
 * - Small samples: a bare rate would let one lucky job beat 170 out of 200,
 *   so the adjustment is scaled by `confidence = effectiveN / (effectiveN+8)`
 *   and a uniform Beta prior keeps the first few jobs from moving much.
 * - Frozen rankings: in explore mode the score is a Thompson sample, so a
 *   model with early bad luck keeps getting chances.
 */
const FILE = () => path.join(ensureDir(stateDir()), "experience.json");

// A verdict's weight halves every 45 days: models get updated silently behind
// the same id, so what was true three months ago is only half as true now.
const DEFAULT_HALF_LIFE_DAYS = 45;

// Raw counts are never trusted for scoring, but the ledger still needs a
// ceiling so one chatty caller cannot grow the file without end.
const MAX_EVENTS = 200;

// Uniform Beta prior: a model with no evidence behaves like one with a single
// good and a single bad job — nearly neutral, and easily outvoted.
const PRIOR = 1;

// effectiveN at which the adjustment reaches half strength. 8 means roughly
// eight decayed jobs before experience is taken fully seriously.
const CONFIDENCE_K = 8;

const DAY_MS = 86_400_000;

const bucketKey = (model, profile) => `${profile ?? "*"}|${model}`;

/** Only events record() could have written — a corrupt entry must not poison the statistics. */
function eventsOf(bucket) {
  const evs = Array.isArray(bucket?.events) ? bucket.events : [];
  return evs.filter((e) => e && typeof e === "object"
    && Number.isFinite(e.t)
    && Number.isFinite(e.o) && e.o >= 0 && e.o <= 1
    && Number.isFinite(e.w) && e.w > 0);
}

/** The in-memory store, or an empty one when the file is missing or unusable. */
export function load() {
  const data = readJson(FILE(), {});
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out = {};
  for (const [key, bucket] of Object.entries(data)) {
    if (key === "__proto__" || !bucket || typeof bucket !== "object") continue;
    out[key] = { events: eventsOf(bucket) };
  }
  return out;
}

export function save(data) {
  writeJson(FILE(), data ?? {});
}

/**
 * Append one outcome. `profile` may be null — the model is then bucketed
 * under "*", because which profile ran the job does not change the verdict.
 * Nonsense from a caller (outcome outside [0,1], weight <= 0) is ignored
 * entirely: one bad call must not corrupt the store.
 */
export function record({ model, profile, outcome, weight = 1, source, note, at = Date.now() } = {}) {
  if (!model) return null;
  if (!Number.isFinite(outcome) || outcome < 0 || outcome > 1) return null;
  if (!Number.isFinite(weight) || weight <= 0) return null;
  const data = load();
  const key = bucketKey(model, profile);
  const bucket = data[key] ?? { events: [] };
  const ev = { t: at, o: outcome, w: weight, s: source ?? null };
  if (note != null) ev.n = String(note);
  bucket.events.push(ev);
  // Newest kept: the oldest sit at the front, so the cap trims from there.
  if (bucket.events.length > MAX_EVENTS) bucket.events.splice(0, bucket.events.length - MAX_EVENTS);
  data[key] = bucket;
  save(data);
  return key;
}

/**
 * Decay-weighted statistics for one bucket. A weight from ageDays ago counts
 * as `w * 0.5 ** (ageDays / halfLifeDays)`, so a verdict from one half-life
 * back is worth half of one from today.
 */
export function statsFor(model, profile, { now = Date.now(), halfLifeDays = DEFAULT_HALF_LIFE_DAYS, data } = {}) {
  const bucket = (data ?? load())[bucketKey(model, profile)];
  const events = eventsOf(bucket);
  let successes = 0, failures = 0, lastAt = null;
  const noted = [];
  for (const e of events) {
    const w = e.w * Math.pow(0.5, (now - e.t) / DAY_MS / halfLifeDays);
    successes += w * e.o;
    failures += w * (1 - e.o);
    if (lastAt == null || e.t > lastAt) lastAt = e.t;
    if (e.n != null) noted.push(e);
  }
  const effectiveN = successes + failures;
  return {
    n: events.length,
    effectiveN,
    successes,
    failures,
    rate: effectiveN > 0 ? successes / effectiveN : null,
    confidence: effectiveN / (effectiveN + CONFIDENCE_K),
    notes: noted.sort((a, b) => b.t - a.t).slice(0, 3).map((e) => ({ at: e.t, source: e.s, note: e.n })),
    lastAt
  };
}

/**
 * Sample Gamma(shape) from uniforms drawn from `random`: Marsaglia-Tsang for
 * shape >= 1, and for shape < 1 the boost G(a) = G(a+1) * U^(1/a), so one
 * method serves both. Every random number comes from the injected `random` —
 * that is what makes explore mode reproducible in tests.
 */
function sampleGamma(shape, random) {
  if (shape < 1) return sampleGamma(shape + 1, random) * Math.pow(random(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      // Box-Muller: two uniforms per normal draw (u1 is guarded against 0)
      const u1 = random() || 2 ** -53;
      const u2 = random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Sample Beta(alpha, beta) as the ratio of two Gamma samples. */
function sampleBeta(alpha, beta, random) {
  const g1 = sampleGamma(alpha, random);
  const g2 = sampleGamma(beta, random);
  const sum = g1 + g2;
  return sum > 0 ? g1 / sum : 0.5;
}

/**
 * The number added to a model's benchmark score. The posterior over its true
 * quality is Beta(1 + successes, 1 + failures); explore samples it (Thompson
 * sampling, so an unlucky model keeps getting chances) while explore:false
 * takes the posterior mean (stable numbers for summaries and rankings).
 *
 * `confidence` is what keeps this honest: two unlucky jobs cannot exile a
 * model, and twenty good ones cannot let it outrank a far better benchmark.
 * With no evidence at all the bonus is exactly 0 — an unused model sits
 * exactly at its benchmark rank, not at a guess.
 */
export function bonusFor(model, profile, { maxShift = 10, explore = true, now, halfLifeDays, data, random = Math.random } = {}) {
  const s = statsFor(model, profile, { now, halfLifeDays, data });
  if (!(s.effectiveN > 0)) return 0;
  const alpha = PRIOR + s.successes;
  const beta = PRIOR + s.failures;
  const p = explore ? sampleBeta(alpha, beta, random) : alpha / (alpha + beta);
  const shift = (p - 0.5) * 2 * maxShift * s.confidence;
  // confidence is < 1 and p is in (0, 1), so this clamps nothing in practice —
  // it exists so the ±maxShift contract holds even if a future-dated event
  // momentarily pushes a weight above 1.
  return Math.max(-maxShift, Math.min(maxShift, shift));
}

/** One row per bucket, busiest evidence first. The bonus is explore:false so the table does not jitter between reads. */
export function summary({ now, halfLifeDays, data } = {}) {
  const store = data ?? load();
  const at = now ?? Date.now();
  return Object.entries(store)
    .map(([key]) => {
      const i = key.indexOf("|");
      const profile = i < 0 ? "*" : key.slice(0, i);
      const model = i < 0 ? key : key.slice(i + 1);
      const s = statsFor(model, profile, { now: at, halfLifeDays, data: store });
      return {
        profile, model,
        n: s.n, effectiveN: s.effectiveN, rate: s.rate, confidence: s.confidence,
        bonus: bonusFor(model, profile, { explore: false, now: at, halfLifeDays, data: store }),
        lastAt: s.lastAt, notes: s.notes
      };
    })
    .sort((a, b) => b.effectiveN - a.effectiveN);
}

/**
 * Drop one bucket — or every bucket of the model when profile is null — so a
 * deliberate reset beats waiting 45 days for decay. Returns how many buckets
 * were removed.
 */
export function forget(model, profile) {
  const data = load();
  let removed = 0;
  if (profile == null) {
    for (const key of Object.keys(data)) {
      if (key.slice(key.indexOf("|") + 1) === model) { delete data[key]; removed += 1; }
    }
  } else if (bucketKey(model, profile) in data) {
    delete data[bucketKey(model, profile)];
    removed = 1;
  }
  if (removed > 0) save(data);
  return removed;
}
