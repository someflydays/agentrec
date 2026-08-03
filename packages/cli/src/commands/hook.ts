import type { Command } from "commander";

export function registerHookCommand(program: Command): void {
  program
    .command("hook")
    .description("(not yet implemented)")
    .action(() => {
      throw new Error("hook: not yet implemented");
    });
}
