import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { CastWriter, type SessionWriter } from "@agentrec/core";

/** A headless run owns no terminal, so its cast is written at a fixed size. */
const CAST_COLS = 80;
const CAST_ROWS = 24;

export interface ChildSessionOptions {
  /** argv to spawn, including anything the recorder injected. */
  command: string[];
  /** Cast title: the command as the user asked for it, without injected arguments. */
  title: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  writer: SessionWriter;
}

/**
 * Runs the agent as an ordinary child process with its output piped into the
 * cast, for sessions nobody is watching (a fork started from the dashboard).
 * Nothing is spawned through a shell, so an argument that came from a browser
 * is never interpreted. Resolves once the child has exited and the cast is
 * flushed; rejects only when the agent could not be started at all.
 */
export async function runChildSession(options: ChildSessionOptions): Promise<number | null> {
  const { command, writer } = options;
  const file = command[0];
  if (file === undefined) throw new Error("no command given to record");

  const cast = new CastWriter(writer.castPath, {
    width: CAST_COLS,
    height: CAST_ROWS,
    title: options.title,
    timestamp: Math.floor(Date.now() / 1000),
  });

  const child = spawn(file, command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const tee = (stream: Readable | null): void => {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      cast.output(writer.elapsedMs(), chunk);
    });
  };
  tee(child.stdout);
  tee(child.stderr);

  return new Promise<number | null>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: { exitCode: number | null } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      void cast.close().finally(() => {
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.exitCode);
      });
    };
    child.once("error", (error: Error) => {
      settle({ error });
    });
    child.once("close", (exitCode) => {
      settle({ exitCode });
    });
  });
}
