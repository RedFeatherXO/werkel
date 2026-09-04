// What the Claude subscription has left, and what that should change.
//
// Claude Code hands its statusLine command a JSON blob on stdin that carries
// `rate_limits` — server-reported percentages for the rolling 5-hour window and
// the weekly one, each with the epoch second it resets. That is the only
// supported way to read plan usage from a script: there is no API for it and no
// `claude usage --json`. So `werkel statusline` catches the blob as it goes past
// and leaves the numbers here.
//
// The percentage on its own is a poor signal. 41% with six days left is calm;
// 41% with six hours left is calm too, because you cannot spend the rest in
// time. What decides is whether the burn rate runs you into the ceiling before
// the window resets. Two samples give that directly, with no assumption about
// how long the window is — which matters, because the window labelled
// "seven_day" is not reliably seven days.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateDir, readJson, writeJson, which } from "./util.mjs";

const FILE = () => path.join(stateDir(), "plan-usage.json");

/** Keep enough history to measure a burn rate, not enough to become a log. */
const MAX_SAMPLES = 400;
const MAX_AGE_MS = 21 * 24 * 3600 * 1000;

/** Below this the two samples are too close together to divide by. */
const MIN_SPAN_MS = 3 * 60 * 1000;

/** How long an unchanged reading is treated as the same reading. */
const MIN_GAP_MS = 5 * 60 * 1000;

/** resets_at may wobble by a little without a reset having happened. */
const RESET_JITTER_MS = 10 * 60 * 1000;

/** After this long without a sample the reading is history, not status. */
export const STALE_MS = 45 * 60 * 1000;

/** The 5-hour window is the one whose length is in its name. */
const FIVE_HOUR_MS = 5 * 3600 * 1000;

export const WINDOWS = [
  { key: "fiveHour", from: "five_hour", label: "5h", lengthMs: FIVE_HOUR_MS },
  // Anthropic documents resets_at but not the length, and the name is not to be
  // trusted as one — so this window gets no assumed length and is judged from
  // observed burn alone.
  { key: "sevenDay", from: "seven_day", label: "weekly", lengthMs: null }
];

export function load() {
  const raw = readJson(FILE(), null);
  if (!raw || !Array.isArray(raw.samples)) return { samples: [] };
  return raw;
}

function save(state) {
  writeJson(FILE(), state);
}

/**
 * Take one `rate_limits` object as Claude Code passes it and keep it.
 * Returns the sample that was stored, or null when there was nothing to store.
 */
export function record(rateLimits, now = Date.now()) {
  if (!rateLimits || typeof rateLimits !== "object") return null;

  const sample = { at: now };
  for (const w of WINDOWS) {
    const src = rateLimits[w.from];
    if (!src || typeof src.used_percentage !== "number") continue;
    // resets_at is epoch *seconds*; everything else here is milliseconds.
    sample[w.key] = {
      pct: src.used_percentage,
      resetsAt: typeof src.resets_at === "number" ? src.resets_at * 1000 : null
    };
  }
  if (Object.keys(sample).length === 1) return null; // nothing but the timestamp

  const state = load();

  // The status line fires on every assistant message. Storing an identical
  // reading each time would fill the history with a single instant and leave no
  // span to measure a rate over, so an unchanged sample is only kept once the
  // previous one is old enough to widen the window usefully.
  const prev = state.samples[state.samples.length - 1];
  if (prev && now - prev.at < MIN_GAP_MS &&
      WINDOWS.every((w) => prev[w.key]?.pct === sample[w.key]?.pct &&
                           prev[w.key]?.resetsAt === sample[w.key]?.resetsAt)) {
    return null;
  }

  state.samples.push(sample);
  state.samples = state.samples
    .filter((s) => now - s.at <= MAX_AGE_MS)
    .slice(-MAX_SAMPLES);
  state.updatedAt = now;
  save(state);
  return sample;
}

/**
 * Every run of the hook leaves a mark, whether or not it carried numbers.
 *
 * Without this, "Claude Code never ran the command" and "it ran but the JSON had
 * no rate_limits" are indistinguishable — and they need opposite fixes. Throttled,
 * because the status line fires on every assistant message and this is a
 * heartbeat, not a log.
 */
export function noteHook(info, now = Date.now()) {
  const state = load();
  const prev = state.lastHook;
  const changed = !prev || prev.hadRateLimits !== info.hadRateLimits || prev.parsed !== info.parsed;
  if (prev && !changed && now - prev.at < 20000) return prev;
  state.lastHook = {
    at: now,
    runs: (prev?.runs ?? 0) + 1,
    parsed: !!info.parsed,
    hadRateLimits: !!info.hadRateLimits,
    // Which windows the server actually sent; absent ones are the whole question
    // when a plan turns out not to report limits at all.
    windows: info.windows ?? [],
    // Enough of the blob's shape to tell a real statusLine payload from
    // something else piping into it.
    topKeys: (info.topKeys ?? []).slice(0, 12)
  };
  save(state);
  return state.lastHook;
}

/**
 * Samples belonging to the window that is open right now.
 *
 * A reset drops the percentage back to zero, so mixing samples from either side
 * of one would read as a burn rate of roughly minus everything. Grouping by
 * resetsAt keeps that from happening without needing to know when resets occur.
 */
function currentRun(samples, key, now) {
  const seen = samples.filter((s) => s[key] && typeof s[key].pct === "number");
  const last = seen[seen.length - 1];
  if (!last) return [];
  // Claude Code drops a window once its reset time passes, so a cached sample
  // for a window that already reset describes something that no longer exists.
  if (last[key].resetsAt != null && last[key].resetsAt <= now) return [];

  const run = [last];
  for (let i = seen.length - 2; i >= 0; i--) {
    const cur = seen[i][key], head = run[0][key];
    // A reset is the only thing that makes the percentage fall, so an earlier
    // sample that sits higher than this run is on the far side of one.
    if (cur.pct > head.pct) break;
    // And it is the only thing that moves resets_at forward by a whole window.
    // Matching on that exactly would split one window in two if the server ever
    // recomputes the timestamp, so only a real jump backwards counts.
    if (cur.resetsAt != null && head.resetsAt != null &&
        head.resetsAt - cur.resetsAt > RESET_JITTER_MS) break;
    run.unshift(seen[i]);
  }
  return run;
}

/**
 * How one window is doing.
 *
 * `basis` says where the verdict came from, because they are not equally sure:
 *   burn    — measured from at least two samples in this window. Best.
 *   pace    — one sample, but the window length is known (5h), so how far
 *             through the window we are is known too.
 *   raw     — percentage only. Weakest; says nothing about rate.
 */
export function windowState(state, spec, now = Date.now()) {
  const run = currentRun(state.samples ?? [], spec.key, now);
  const last = run[run.length - 1];
  if (!last) return null;

  const cur = last[spec.key];
  const resetsIn = cur.resetsAt == null ? null : cur.resetsAt - now;
  const remaining = Math.max(0, 100 - cur.pct);

  const out = {
    label: spec.label,
    pct: cur.pct,
    resetsAt: cur.resetsAt,
    resetsIn,
    sampledAt: last.at,
    ageMs: now - last.at,
    samples: run.length,
    basis: "raw",
    burnPctPerHour: null,
    exhaustsInMs: null,
    // What this window ends at if the current rate holds. Over 100 means the
    // ceiling arrives first. This is the number worth reading out loud.
    projectedEndPct: null,
    // < 1 means the ceiling arrives before the reset does
    headroom: null
  };

  const first = run[0];
  const span = last.at - first.at;
  if (run.length >= 2 && span >= MIN_SPAN_MS) {
    const rise = cur.pct - first[spec.key].pct;
    if (rise > 0) {
      out.basis = "burn";
      out.burnPctPerHour = (rise / span) * 3600 * 1000;
      out.exhaustsInMs = (remaining / rise) * span;
    } else {
      // Flat or falling: nothing is being spent, so nothing will be exhausted.
      out.basis = "burn";
      out.burnPctPerHour = 0;
      out.exhaustsInMs = Infinity;
    }
  } else if (spec.lengthMs && resetsIn != null) {
    // One sample is enough when the window length is known: how far through the
    // window we are tells us what an even pace would have spent by now.
    const elapsed = spec.lengthMs - resetsIn;
    if (elapsed > MIN_SPAN_MS && cur.pct > 0) {
      out.basis = "pace";
      out.burnPctPerHour = (cur.pct / elapsed) * 3600 * 1000;
      out.exhaustsInMs = (remaining / cur.pct) * elapsed;
    }
  }

  if (out.burnPctPerHour != null && resetsIn != null && resetsIn > 0) {
    out.projectedEndPct = cur.pct + (out.burnPctPerHour * resetsIn) / (3600 * 1000);
    out.headroom = out.exhaustsInMs === Infinity ? Infinity : out.exhaustsInMs / resetsIn;
  }
  out.level = levelFor(out);
  return out;
}

const ORDER = ["relaxed", "watch", "conserve", "critical"];

function levelFor(w) {
  // Nearly spent is nearly spent, however slowly you got there.
  if (w.pct >= 92) return "critical";

  if (w.projectedEndPct != null) {
    // Where the current rate lands you by the time the window resets.
    if (w.projectedEndPct > 100) {
      // It runs out. How early decides how much that matters: hitting the wall
      // in the last tenth of the window is an inconvenience, hitting it in the
      // first third costs you most of the window.
      return w.headroom != null && w.headroom < 0.65 ? "critical" : "conserve";
    }
    if (w.projectedEndPct >= 92) return "conserve";
    if (w.projectedEndPct >= 80) return "watch";
    return "relaxed";
  }

  // No rate information: say what the percentage alone supports and no more.
  if (w.pct >= 80) return "conserve";
  if (w.pct >= 55) return "watch";
  return "relaxed";
}

const worse = (a, b) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

/** Human-readable "2d 4h" / "38m" for a span. */
export function humanSpan(ms) {
  if (ms == null || !Number.isFinite(ms)) return "?";
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/**
 * The whole reading: both windows, the worse of the two, and what it means.
 * `known:false` is a real answer — it means nobody has fed us a sample yet.
 */
export function pressure(now = Date.now()) {
  const state = load();
  const windows = {};
  for (const spec of WINDOWS) {
    const w = windowState(state, spec, now);
    if (w) windows[spec.key] = w;
  }
  const present = Object.values(windows);
  if (!present.length) {
    return {
      known: false,
      level: "unknown",
      stale: true,
      windows,
      reason: "no plan-usage sample yet",
      hint: "wire `werkel statusline` into Claude Code's statusLine setting — that is the only supported way to read plan limits from a script. Prefix it with `node` and use the full path, so it does not depend on an executable bit or on PATH",
      advice: ADVICE.unknown
    };
  }

  const ageMs = Math.min(...present.map((w) => w.ageMs));
  const stale = ageMs > STALE_MS;
  // The weekly window costs days to hit, the 5-hour one costs hours. Both are
  // reported; the verdict follows the worse of the two.
  let level = present.reduce((acc, w) => worse(acc, w.level), "relaxed");
  if (stale) level = level === "critical" ? "conserve" : level === "conserve" ? "watch" : level;

  const driver = present.find((w) => w.level === level) ?? present[0];
  return {
    known: true,
    level,
    stale,
    ageMs,
    windows,
    driver: driver.label,
    reason: reasonFor(driver, stale),
    advice: ADVICE[level]
  };
}

function reasonFor(w, stale) {
  const bits = [`${w.label} at ${w.pct.toFixed(0)}%`];
  if (w.resetsIn != null) bits.push(`resets in ${humanSpan(w.resetsIn)}`);
  if (w.projectedEndPct != null && w.projectedEndPct > 100) {
    bits.push(`at this rate it runs out in ${humanSpan(w.exhaustsInMs)}`);
  } else if (w.projectedEndPct != null) {
    bits.push(`on track to end at ${Math.round(w.projectedEndPct)}%`);
  }
  if (w.basis === "raw") bits.push("no burn rate yet, percentage only");
  if (stale) bits.push(`sample is ${humanSpan(w.ageMs)} old`);
  return bits.join(", ");
}

// Advice, not orders. The point is to move the threshold for what is worth
// handing off — never to hand off everything, because briefing a worker and
// reviewing its diff costs the manager plan tokens too. A one-line change is
// cheaper done directly no matter how tight the budget is.
const ADVICE = {
  unknown: "No plan reading available. Delegate on the usual grounds: size, parallelism, how mechanical the work is.",
  relaxed: "Plan budget is comfortable. Delegate what is genuinely worth delegating — bulk, parallel or mechanical work — and keep doing the rest directly.",
  watch: "Plan budget is on pace to run tight. Lower the bar a little: hand off mechanical work you would normally have done yourself, especially anything touching many files.",
  conserve: "Plan budget will run out before it resets. Delegate anything a cheap model can do under review, and spend your own turns on planning, briefing and reviewing rather than typing. Still not worth delegating: single small edits, where briefing and review cost more than the edit.",
  critical: "Plan budget is nearly gone. Delegate every task that can be specified in a brief, batch them so one review covers several, and keep your own turns short. A one-line fix is still faster done directly."
};

/**
 * Why no sample has arrived.
 *
 * "no reading yet" is a dead end on its own: the hook may be unconfigured, or
 * configured and failing, or fine and simply waiting for a session. Claude Code
 * shows nothing when a status line command fails, so a wrong path here is silent
 * in the one place you would look for it. This says which of the three it is.
 */
export function checkWiring() {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const out = { settingsPath, statusLine: null, wired: false, problems: [], next: [] };

  const raw = readJson(settingsPath, null);
  if (!raw) {
    out.problems.push(fs.existsSync(settingsPath)
      ? `${settingsPath} is not readable JSON`
      : `${settingsPath} does not exist`);
    return out;
  }

  const sl = raw.statusLine;
  const cmd = typeof sl === "string" ? sl : sl?.command;
  out.statusLine = cmd ?? null;
  if (!cmd) {
    out.problems.push("no statusLine is configured, so nothing is feeding werkel the numbers");
    return out;
  }
  if (!/statusline/i.test(cmd)) {
    out.problems.push(`the statusLine runs something else: ${cmd}`);
    out.next.push("put `werkel statusline --then '<that command>'` in front of it — stdin is passed through untouched");
    return out;
  }
  out.wired = true;

  // Claude Code runs the command in a shell, so the first token has to be
  // startable on its own. A path that lost its executable bit — copied, checked
  // out, unzipped — fails here and nowhere else.
  const tokens = String(cmd).trim().split(/\s+/);
  const first = tokens[0].replace(/^['"]|['"]$/g, "");
  const viaNode = /(^|[\\/])node(\.exe)?$/i.test(first);
  const target = viaNode ? (tokens[1] ?? "").replace(/^['"]|['"]$/g, "") : first;

  if (!target) {
    out.problems.push(`could not tell what ${cmd} runs`);
  } else if (target.includes("/") || target.includes("\\")) {
    if (!fs.existsSync(target)) {
      out.problems.push(`${target} does not exist`);
    } else if (!viaNode && process.platform !== "win32") {
      try {
        fs.accessSync(target, fs.constants.X_OK);
      } catch {
        out.problems.push(`${target} is not executable, so the shell cannot start it and Claude Code shows nothing`);
        out.next.push(`run \`node ${target} statusline\` instead — prefixing with node needs no executable bit`);
      }
    }
  } else if (!which(target)) {
    out.problems.push(`\`${target}\` is not on the PATH that Claude Code's shell sees`);
    out.next.push("use the full path to bin/werkel.mjs, prefixed with `node`");
  }

  // The heartbeat settles what the settings file cannot: whether the command is
  // ever actually run, and whether the payload carries limits when it is.
  const hook = load().lastHook;
  out.lastHook = hook ?? null;
  if (!out.problems.length) {
    if (!hook) {
      out.problems.push("Claude Code has never run this command — nothing has reached werkel at all");
      out.next.push("the statusLine belongs to the `claude` CLI: open a terminal, run `claude`, send one message there. A session in the desktop app does not run it");
      out.next.push("if you did that and this still says never: the shell Claude Code spawns may not have `node` on its PATH (nvm and similar only set it up for interactive shells) — use the full path to the node binary");
    } else if (!hook.parsed) {
      out.problems.push(`the command ran ${hook.runs}x but stdin was not JSON — something other than Claude Code is piping into it`);
    } else if (!hook.hadRateLimits) {
      out.problems.push(`the command ran ${hook.runs}x and the JSON arrived, but it carried no rate_limits`);
      out.next.push("rate_limits is sent only to Claude.ai Pro and Max subscribers, and only after the first API response of a session — an API key or a cloud provider never gets it");
      if (hook.topKeys?.length) out.next.push(`the payload had: ${hook.topKeys.join(", ")}`);
    } else {
      out.next.push(`the command ran ${hook.runs}x and did carry rate_limits (${(hook.windows ?? []).join(", ") || "no windows named"}) — a reading should exist`);
    }
  }
  return out;
}

/** One line for a status bar. */
export function statusLineText(p = pressure()) {
  if (!p.known) return "plan ?";
  const parts = [];
  for (const spec of WINDOWS) {
    const w = p.windows[spec.key];
    if (w) parts.push(`${spec.label} ${w.pct.toFixed(0)}%`);
  }
  return `plan ${parts.join(" · ")}${p.stale ? " (stale)" : ""}`;
}

/**
 * One line for Claude, appended to MCP responses. Silent when the plan is
 * comfortable or unknown — an unchanging banner on every response is noise, and
 * noise gets ignored exactly when it finally matters.
 */
export function pressureNote(p = pressure()) {
  if (!p.known || p.level === "relaxed") return null;
  return `Claude plan budget — ${p.level}: ${p.reason}. ${p.advice}`;
}
