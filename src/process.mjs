import { spawnSync } from "node:child_process";

/**
 * Kill a process and everything it started.
 *
 * Windows has no process groups and no signals: taskkill /T walks the tree and
 * /F is the only reliable way to stop a child that ignores the close request.
 * POSIX gets the negative pid, which addresses the whole group — that only
 * works because the runner starts its child detached.
 */
export function killTree(pid, signal = "SIGTERM") {
  if (!pid) return false;
  if (process.platform === "win32") {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return r.status === 0;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try { process.kill(pid, signal); return true; } catch { return false; }
  }
}

/** Is this pid still alive? Same question, two very different answers per OS. */
export function isAlive(pid) {
  if (!pid) return false;
  if (process.platform === "win32") {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true });
    return typeof r.stdout === "string" && r.stdout.includes(String(pid));
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The command that would be used to kill a tree — exposed so tests can check
 *  the Windows branch on a machine that is not Windows. */
export function killCommandFor(platform, pid) {
  return platform === "win32"
    ? { command: "taskkill", args: ["/PID", String(pid), "/T", "/F"] }
    : { command: "kill", args: ["-TERM", `-${pid}`] };
}
