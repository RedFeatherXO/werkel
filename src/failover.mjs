/**
 * Decide whether a failed job may be retried with a different model.
 * Pure function: no filesystem, no network, no side effects.
 */

const PROVIDER_MARKERS = [
  "apierror",
  "unknownerror",
  "cannot connect",
  "socket",
  "econnrefused",
  "etimedout",
  "fetch failed",
  "rate limit",
  "rate_limit",
  "quota",
  "insufficient",
  "unauthorized",
  "forbidden",
  "overloaded",
  "service unavailable",
  "bad gateway",
  "internal server error",
  "model not found",
  "does not exist"
];

const PROVIDER_STATUS_CODES = ["401", "402", "403", "408", "429", "500", "502", "503", "504"];

function truncate(str, max = 200) {
  const s = String(str);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Return the first error string that looks like a provider problem, or null. */
function findProviderError(sources) {
  const statusRe = new RegExp(`(^|[^0-9])(${PROVIDER_STATUS_CODES.join("|")})($|[^0-9])`);
  for (const raw of sources) {
    if (typeof raw !== "string" || !raw) continue;
    const lower = raw.toLowerCase();
    if (PROVIDER_MARKERS.some((m) => lower.includes(m))) return raw;
    if (statusRe.test(lower)) return raw;
  }
  return null;
}

/**
 * Classify a failed job. Returns { retryable, category, reason } where category
 * is one of "worker", "timeout", "provider", "none".
 */
export function classifyFailure(job, parsed) {
  try {
    const j = job || {};
    const p = parsed || {};

    const tools = Array.isArray(p.tools) ? p.tools : [];
    const producedTool = tools.some((t) => t && t.tool !== "todowrite");
    const producedText = typeof p.text === "string" && p.text.trim() !== "";

    if (producedTool || producedText) {
      return {
        retryable: false,
        category: "worker",
        reason: "worker already produced output; retrying would duplicate half-finished work"
      };
    }

    if (j.state === "timeout") {
      return { retryable: true, category: "timeout", reason: "job exceeded its timeout and can be retried" };
    }

    const sources = [];
    if (Array.isArray(p.errors)) sources.push(...p.errors);
    if (typeof j.error === "string" && j.error) sources.push(j.error);

    const providerError = findProviderError(sources);
    if (providerError) {
      return {
        retryable: true,
        category: "provider",
        reason: `provider error detected: ${truncate(providerError, 200)}`
      };
    }

    if (typeof j.exitCode === "number" && j.exitCode !== 0) {
      return {
        retryable: true,
        category: "provider",
        reason: `opencode exited with code ${j.exitCode} without producing output`
      };
    }

    return { retryable: false, category: "none", reason: "no retryable failure detected" };
  } catch {
    return { retryable: false, category: "none", reason: "could not classify failure; treating as non-retryable" };
  }
}
