import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { importBundle, SessionStore, unpackBundle } from "@agentrec/core";
import type { Command } from "commander";
import pc from "picocolors";

export function registerOpenCommand(program: Command): void {
  program
    .command("open")
    .description("Import a .agentlog file into the local session store")
    .argument("<file>", "path to a .agentlog file")
    .option("--overwrite", "replace an existing session with the same id")
    .action((file: string, options: { overwrite?: boolean }) => {
      const store = new SessionStore();
      store.ensure();
      const bundle = unpackBundle(readFileSync(resolve(file)));
      if (store.has(bundle.meta.id) && options.overwrite !== true) {
        throw new Error(
          `session ${bundle.meta.id} is already in the store — pass --overwrite to replace it`,
        );
      }
      const id = importBundle(store, bundle, { overwrite: true });
      console.log(`imported ${id}`);
      console.log(pc.dim("replay it with: agentrec ui"));
    });
}
