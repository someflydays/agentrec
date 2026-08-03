import type { Command } from "commander";

export function registerRecordCommand(program: Command): void {
  program
    .command("record")
    .description("(not yet implemented)")
    .action(() => {
      throw new Error("record: not yet implemented");
    });
}
