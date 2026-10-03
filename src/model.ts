// The only module that starts an external process. Wraps a single-shot model call with
// one retry and a content-addressed cache, which also serves as resume after interruption.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRunner } from "./types.ts";

export type Invoke = (prompt: string) => Promise<{ ok: boolean; text: string; error?: string }>;

export interface RunnerOptions {
  model: string;
  /** Successful, accepted replies are stored here, keyed by model and prompt content. */
  cacheDir?: string;
}

const MAX_ATTEMPTS = 2;

export function makeRunner(invoke: Invoke, options: RunnerOptions): ModelRunner {
  return async (prompt, accept) => {
    const started = Date.now();
    const key = createHash("sha256").update(options.model).update("\0").update(prompt).digest("hex");
    const cacheFile = options.cacheDir ? join(options.cacheDir, `${key}.txt`) : undefined;
    if (cacheFile && existsSync(cacheFile)) {
      return { ok: true, text: readFileSync(cacheFile, "utf8"), ms: Date.now() - started, attempts: 0, cached: true };
    }

    let error = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const reply = await invoke(prompt);
      if (reply.ok && accept(reply.text)) {
        if (cacheFile) {
          mkdirSync(options.cacheDir!, { recursive: true });
          writeFileSync(cacheFile, reply.text);
        }
        return { ok: true, text: reply.text, ms: Date.now() - started, attempts: attempt, cached: false };
      }
      error = reply.ok ? "unusable reply" : (reply.error ?? "call failed");
    }
    return { ok: false, text: "", ms: Date.now() - started, attempts: MAX_ATTEMPTS, cached: false, error };
  };
}

export interface OmpOptions {
  model: string;
  /** Prompts are written here and passed to omp as a file; nothing is written to the source. */
  workDir: string;
  timeoutMs?: number;
}

/**
 * Calls the locally logged-in omp non-interactively. The call saves no session and loads no
 * tools, skills, rules or extensions, so producing a report never adds to the session records.
 */
export function ompInvoke(options: OmpOptions): Invoke {
  const dir = join(options.workDir, "prompts");
  return async (prompt) => {
    mkdirSync(dir, { recursive: true });
    const name = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
    const promptFile = join(dir, `${name}.md`);
    writeFileSync(promptFile, prompt);
    const args = [
      "omp", "-p", "--no-session", "--no-tools", "--no-skills", "--no-rules", "--no-extensions", "--no-title",
      "--thinking", "low", "--model", options.model,
      "--system-prompt", "You are a data extraction function. Output only what the task asks for.",
      `@${promptFile}`,
    ];
    try {
      // stdin must be closed: omp -p waits on piped input otherwise.
      const proc = Bun.spawn(args, { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 15 * 60_000);
      const [text, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timer);
      writeFileSync(join(dir, `${name}.reply.txt`), text);
      if (code !== 0) return { ok: false, text, error: `omp exit ${code}: ${stderr.slice(0, 300)}` };
      return { ok: true, text };
    } catch (e) {
      return { ok: false, text: "", error: `could not start omp: ${String(e)}` };
    }
  };
}
