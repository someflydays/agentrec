import type { Command } from "commander";

export function registerExportCommand(program: Command): void {
  program
    .command("export")
    .description("(not yet implemented)")
    .action(() => {
      throw new Error("export: not yet implemented");
    });
}
