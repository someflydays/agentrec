import { statSync } from "node:fs";
import { resolve } from "node:path";
import { AGENTLOG_EXTENSION, exportSession, SessionStore } from "@agent-blackbox/core";
import type { Command } from "commander";
import pc from "picocolors";
import { formatBytes } from "../format.js";

export function registerExportCommand(program: Command): void {
  program
    .command("export")
    .description("Export a session to a portable .agentlog file")
    .argument("<session>", "session id or unique id prefix")
    .option("-o, --output <file>", "file to write (default: <id>.agentlog)")
    .action((session: string, options: { output?: string }) => {
      const store = new SessionStore();
      const id = store.resolveId(session);
      const outPath = resolve(options.output ?? `${id}${AGENTLOG_EXTENSION}`);
      exportSession(store, id, outPath);
      console.log(`${outPath} ${pc.dim(`(${formatBytes(statSync(outPath).size)})`)}`);
    });
}
