import type { Command } from "commander";
import { HOOK_COMMAND_NAME } from "../recorder/hooks-settings.js";

/**
 * Claude Code runs this for every hook it fires, with the payload on stdin. A
 * hook that is slow, noisy, or non-zero degrades the session it is observing, so
 * this command is deliberately mute: it never writes to stdout or stderr, never
 * exits non-zero, and gives up after a short budget.
 */
const BUDGET_MS = 3000;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const finish = (): void => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, BUDGET_MS);
    timer.unref();
    process.stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function forwardHookPayload(): Promise<void> {
  try {
    const url = process.env.AGENTREC_INGEST_URL;
    const token = process.env.AGENTREC_INGEST_TOKEN;
    if (url === undefined || token === undefined) return;
    const body = await readStdin();
    if (body.length === 0) return;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(BUDGET_MS),
    });
  } catch {
    // Not recording, recorder already gone, or the network refused us: stay silent.
  }
}

export function registerHookCommand(program: Command): void {
  program
    .command(HOOK_COMMAND_NAME, { hidden: true })
    .description("Internal: forward a Claude Code hook payload to the active recorder")
    .action(async () => {
      await forwardHookPayload();
    });
}
