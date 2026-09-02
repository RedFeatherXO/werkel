/**
 * The manager (Claude) knows the repo; the worker model does not.
 * A delegated job therefore ships as a briefing, not a one-liner —
 * this is what turns a cheap model into a useful executor.
 */
export function buildWorkerPrompt(job) {
  const L = [];
  L.push(`# Work order ${job.id}${job.title ? " — " + job.title : ""}`);
  L.push("");
  L.push("You are an autonomous worker agent operating in an isolated git worktree.");
  L.push("A manager agent delegated this task to you and will review your diff line by line.");
  L.push("Nobody is watching interactively: never ask a question, never wait for approval.");
  L.push("");
  L.push("## Task");
  L.push(job.task.trim());

  if (job.context?.trim()) {
    L.push("", "## Context from the manager (already researched — trust it)");
    L.push(job.context.trim());
  }
  if (job.files?.length) {
    L.push("", "## Files that matter");
    for (const f of job.files) L.push(`- ${f}`);
  }
  if (job.constraints?.length) {
    L.push("", "## Hard constraints");
    for (const c of job.constraints) L.push(`- ${c}`);
  }

  L.push("", "## Ground rules");
  L.push(`- Your working directory is ${job.dir}. Stay inside it.`);
  L.push("- Do NOT run git commit, git push, git rebase, git checkout or any history rewriting. The harness handles version control.");
  L.push("- Make the smallest change that fully solves the task. No drive-by refactors, no reformatting untouched code, no new dependencies unless asked.");
  L.push("- Match the existing code style, naming and structure of the files you touch.");
  L.push("- Do not create README/summary/notes files unless the task asks for them. Your report goes in the final message.");
  if (job.readOnly) {
    L.push("- READ-ONLY JOB: you may not modify files. Investigate and report your findings and a concrete proposal.");
    L.push(job.allowBash
      ? "- You may run shell commands to inspect and test, but nothing that writes, installs, or changes state."
      : "- Shell commands are disabled too. Use the read, grep and glob tools.");
  }

  if (job.verify) {
    L.push("", "## Verification (run this, report the real output)");
    L.push("```", job.verify, "```");
    L.push("If it fails, fix your work and run it again. Do not report success on a failing command.");
  }

  L.push("", "## Definition of done");
  L.push(job.done?.trim() || "The task is implemented, the verification passes, and nothing unrelated changed.");

  L.push("", "## Final message format (max ~300 words, no code dumps)");
  L.push("SUMMARY: what you did, in 1-3 sentences");
  L.push("FILES: one line per file — path — what changed and why");
  L.push("VERIFICATION: command → actual result (or 'not run' and why)");
  L.push("ASSUMPTIONS: anything you had to guess (or 'none')");
  L.push("BLOCKED: what you could not do and why (or 'none')");
  return L.join("\n");
}

export function buildFollowupPrompt(message, job) {
  return [
    `# Follow-up on work order ${job.id}`,
    "",
    "The manager reviewed your diff. Address the feedback below in the same worktree.",
    "Same ground rules as before: no git commands, smallest possible change, same final message format.",
    "",
    "## Feedback",
    message.trim()
  ].join("\n");
}
