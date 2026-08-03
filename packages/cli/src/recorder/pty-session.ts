import { CastWriter, type SessionWriter } from "@agent-blackbox/core";
import { type IDisposable, spawn } from "@lydell/node-pty";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Ctrl+C reaches the child through raw stdin; these arrive as process signals instead. */
const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"];

export interface PtySessionOptions {
  /** argv to spawn, including anything the recorder injected. */
  command: string[];
  /** Cast title: the command as the user asked for it, without injected arguments. */
  title: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  writer: SessionWriter;
}

/**
 * Runs the agent in a pseudoterminal so it still believes it owns an
 * interactive terminal, while every byte it paints is teed to the cast file.
 * Resolves once the child has exited, the cast is flushed, and the terminal is
 * back in cooked mode.
 */
export async function runPtySession(options: PtySessionOptions): Promise<number> {
  const { command, writer } = options;
  const file = command[0];
  if (file === undefined) throw new Error("no command given to record");

  const cols = process.stdout.columns ?? DEFAULT_COLS;
  const rows = process.stdout.rows ?? DEFAULT_ROWS;

  const cast = new CastWriter(writer.castPath, {
    width: cols,
    height: rows,
    title: options.title,
    timestamp: Math.floor(Date.now() / 1000),
  });

  const pty = spawn(file, command.slice(1), {
    name: "xterm-256color",
    cols,
    rows,
    cwd: options.cwd,
    env: options.env,
  });

  const disposables: IDisposable[] = [
    pty.onData((chunk) => {
      process.stdout.write(chunk);
      cast.output(writer.elapsedMs(), chunk);
    }),
  ];

  const onStdin = (data: Buffer): void => {
    try {
      pty.write(data.toString());
    } catch {
      // Child already gone; the exit handler is about to run.
    }
  };

  const onResize = (): void => {
    const nextCols = process.stdout.columns ?? cols;
    const nextRows = process.stdout.rows ?? rows;
    try {
      pty.resize(nextCols, nextRows);
    } catch {
      return;
    }
    cast.resize(writer.elapsedMs(), nextCols, nextRows);
    writer.event("terminal.resize", { cols: nextCols, rows: nextRows });
  };

  const signalHandlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = (): void => {
      try {
        pty.kill(signal);
      } catch {
        // Already dead.
      }
    };
    return { signal, handler };
  });

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onStdin);
  process.stdout.on("resize", onResize);
  for (const { signal, handler } of signalHandlers) process.on(signal, handler);

  return new Promise<number>((resolve) => {
    disposables.push(
      pty.onExit(({ exitCode }) => {
        void (async () => {
          for (const disposable of disposables) disposable.dispose();
          process.stdin.off("data", onStdin);
          process.stdout.off("resize", onResize);
          for (const { signal, handler } of signalHandlers) process.off(signal, handler);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          await cast.close();
          resolve(exitCode);
        })();
      }),
    );
  });
}
