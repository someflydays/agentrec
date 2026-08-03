import type { Command } from "commander";

export function registerUiCommand(program: Command): void {
  program
    .command("ui")
    .description("(not yet implemented)")
    .action(() => {
      throw new Error("ui: not yet implemented");
    });
}
