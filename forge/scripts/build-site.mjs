/**
 * Forge — site build via headless Claude Code (LANE B, private repo).
 *
 * Runs in JOB "build" with ONLY ANTHROPIC_API_KEY in scope (no Blob/Vercel/
 * Pexels token) — a hijacked agent can reach neither client data nor deploy.
 *
 * Spawns the `claude` CLI headless with tools scoped to file writes + read-only
 * ls/cat, cwd ./build, so the agent writes index.html (+ optional assets) into
 * ./build. The prompt is prompts/build-site-prompt.md with the PII-stripped
 * brief and the media manifest interpolated in.
 *
 * Guardrails: --max-turns 40 AND a 20-minute wall clock (kill -> non-zero exit).
 * The verbose transcript is DISCARDED — only stage/duration/outcome are logged.
 *
 * Fix-loop hook: if ./work/test-failures.json exists (written by a prior
 * test-gate run), its failures are appended to the prompt so a re-run of this
 * script edits the existing ./build in place.
 */

import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

import { logStage, requireEnv } from "./lib.mjs";

const BUILD_DIR = path.resolve("build");
const WALL_CLOCK_MS = 20 * 60 * 1000;
const MAX_TURNS = "40";
const ALLOWED_TOOLS = "Read,Write,Edit,Bash(ls:*),Bash(cat:*)";
const PROMPT_TEMPLATE = path.resolve("prompts", "build-site-prompt.md");

async function fileExists(p) {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadPrompt() {
  const [template, briefJson, manifestJson] = await Promise.all([
    readFile(PROMPT_TEMPLATE, "utf8"),
    readFile(path.resolve("work", "brief.json"), "utf8"),
    readFile(path.join(BUILD_DIR, "assets", "manifest.json"), "utf8"),
  ]);

  let prompt = template
    .replaceAll("{{BRIEF_JSON}}", briefJson.trim())
    .replaceAll("{{MEDIA_MANIFEST}}", manifestJson.trim());

  // Fix-loop: fold in the previous run's hard failures, if any.
  const failuresPath = path.resolve("work", "test-failures.json");
  if (await fileExists(failuresPath)) {
    const failures = await readFile(failuresPath, "utf8");
    prompt += `\n\n## FIX THESE TEST FAILURES (previous attempt)\nThe current ./build already exists. Edit it in place to resolve every failure below, then stop:\n\n\`\`\`json\n${failures.trim()}\n\`\`\`\n`;
    logStage("build", "fix-loop", { note: "consuming test-failures.json" });
  }

  return prompt;
}

function runClaude(prompt) {
  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--max-turns",
        MAX_TURNS,
        "--allowedTools",
        ALLOWED_TOOLS,
      ],
      {
        cwd: BUILD_DIR,
        env: { ...process.env, ANTHROPIC_API_KEY: requireEnv("ANTHROPIC_API_KEY") },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    // Buffer only stdout (the single JSON result with --output-format json).
    // The transcript is never streamed to our logs.
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.length > 2_000_000) out = out.slice(-1_000_000); // cap memory
    });
    child.stderr.on("data", () => {}); // discard

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, WALL_CLOCK_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, timedOut, out, spawnError: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, out });
    });
  });
}

function summarizeResult(out) {
  // Never log the result TEXT (may echo brief content). Only structured facts.
  try {
    const parsed = JSON.parse(out);
    return {
      subtype: parsed.subtype ?? null,
      isError: parsed.is_error ?? null,
      numTurns: parsed.num_turns ?? null,
      durationMs: parsed.duration_ms ?? null,
      costUsd: parsed.total_cost_usd ?? null,
    };
  } catch {
    return { subtype: "unparsed" };
  }
}

async function main() {
  const started = Date.now();
  const prompt = await loadPrompt();
  logStage("build", "start", { maxTurns: MAX_TURNS, wallClockMs: WALL_CLOCK_MS });

  const { code, timedOut, out, spawnError } = await runClaude(prompt);
  const wall = Date.now() - started;

  if (spawnError) {
    logStage("build", "error", { reason: `claude spawn failed: ${spawnError}`, durationMs: wall });
    process.exit(1);
  }
  if (timedOut) {
    logStage("build", "timeout", { durationMs: wall });
    process.exit(1);
  }

  const indexOk = await fileExists(path.join(BUILD_DIR, "index.html"));
  const result = summarizeResult(out);
  logStage("build", code === 0 && indexOk ? "ok" : "failed", {
    exitCode: code,
    indexHtml: indexOk,
    durationMs: wall,
    ...result,
  });

  if (code !== 0 || !indexOk) process.exit(1);
}

main().catch((err) => {
  logStage("build", "error", { reason: err?.message || "unknown error" });
  process.exit(1);
});
