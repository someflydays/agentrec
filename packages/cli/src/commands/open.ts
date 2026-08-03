import type { Command } from "commander";

export function registerOpenCommand(program: Command): void {
  program
    .command("open")
    .description("(not yet implemented)")
    .action(() => {
      throw new Error("open: not yet implemented");
    });
}
