import { statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENTLOG_EXTENSION,
  AGENTLOG_VERSION,
  exportSession,
  packBundle,
  type RedactionSummary,
  redactBundle,
  SessionStore,
} from "@agentrec/core";
import type { Command } from "commander";
import pc from "picocolors";
import { formatBytes } from "../format.js";

function exportRedacted(store: SessionStore, id: string, outPath: string): RedactionSummary {
  const { bundle, summary } = redactBundle({
    format: "agentlog",
    version: AGENTLOG_VERSION,
    meta: store.readMeta(id),
    events: store.readEvents(id),
    cast: store.readCast(id),
  });
  const { meta, events, cast } = bundle;
  writeFileSync(outPath, packBundle({ meta, events, cast }));
  return summary;
}

function printRedactionSummary(summary: RedactionSummary): void {
  if (summary.totalReplacements === 0) {
    console.log(pc.dim("Redaction found nothing to replace."));
    return;
  }
  console.log(`Redacted ${summary.totalReplacements} values from the exported copy:`);
  const byCount = Object.entries(summary.byPattern).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  for (const [name, count] of byCount) {
    console.log(`  ${pc.yellow(name)} ${pc.dim(`× ${count}`)}`);
  }
}

export function registerExportCommand(program: Command): void {
  program
    .command("export")
    .description("Export a session to a portable .agentlog file")
    .argument("<session>", "session id or unique id prefix")
    .option("-o, --output <file>", "file to write (default: <id>.agentlog)")
    .option("--redact", "scrub secrets from the exported copy (the stored session is untouched)")
    .action((session: string, options: { output?: string; redact?: boolean }) => {
      const store = new SessionStore();
      const id = store.resolveId(session);
      const outPath = resolve(options.output ?? `${id}${AGENTLOG_EXTENSION}`);
      let summary: RedactionSummary | null = null;
      if (options.redact === true) {
        summary = exportRedacted(store, id, outPath);
      } else {
        exportSession(store, id, outPath);
      }
      console.log(`${outPath} ${pc.dim(`(${formatBytes(statSync(outPath).size)})`)}`);
      if (summary !== null) printRedactionSummary(summary);
    });
}
