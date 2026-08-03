import { Command } from "commander";
import { registerExportCommand } from "./commands/export.js";
import { registerHookCommand } from "./commands/hook.js";
import { registerLsCommand } from "./commands/ls.js";
import { registerOpenCommand } from "./commands/open.js";
import { registerRecordCommand } from "./commands/record.js";
import { registerUiCommand } from "./commands/ui.js";
import { cliVersion } from "./version.js";

const program = new Command();

program
  .name("agentrec")
  .description("Flight recorder for Claude Code sessions: record, replay, share")
  .version(cliVersion())
  .enablePositionalOptions();

registerRecordCommand(program);
registerLsCommand(program);
registerUiCommand(program);
registerExportCommand(program);
registerOpenCommand(program);
registerHookCommand(program);

// Sugar: `agentrec claude [...]` records a claude session directly.
const argv = [...process.argv];
if (argv[2] === "claude") {
  argv.splice(2, 0, "record");
}

program.parseAsync(argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`agentrec: ${message}`);
  process.exitCode = 1;
});
