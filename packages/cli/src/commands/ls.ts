import type { Command } from "commander";

export function registerLsCommand(program: Command): void {
  program
    .command("ls")
    .description("(not yet implemented)")
    .action(() => {
      throw new Error("ls: not yet implemented");
    });
}
