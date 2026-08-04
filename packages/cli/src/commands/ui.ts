import type { Command } from "commander";
import { DEFAULT_UI_PORT, startUiServer } from "../server/index.js";

interface UiOptions {
  port: string;
  open: boolean;
  allowFork?: boolean;
}

export function registerUiCommand(program: Command): void {
  program
    .command("ui")
    .description("Browse and replay recorded sessions in a local dashboard")
    .option("--port <n>", "port to listen on", String(DEFAULT_UI_PORT))
    .option("--no-open", "do not open a browser window")
    .option("--allow-fork", "let the dashboard start forked agent sessions")
    .action(async (options: UiOptions) => {
      await startUiServer({
        port: parsePort(options.port),
        open: options.open,
        allowFork: options.allowFork === true,
      });
    });
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port value "${value}"`);
  }
  return port;
}
