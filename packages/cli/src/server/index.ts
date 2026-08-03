import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { SessionStore } from "@agent-blackbox/core";
import pc from "picocolors";
import { openBrowser } from "./open-browser.js";
import { createRequestListener } from "./router.js";

/** Recordings are private; never bind anything but loopback. */
const HOST = "127.0.0.1";

export const DEFAULT_UI_PORT = 4040;

export interface UiServerOptions {
  port: number;
  open: boolean;
  store?: SessionStore;
}

export async function startUiServer(options: UiServerOptions): Promise<Server> {
  const store = options.store ?? new SessionStore();
  const distDir = resolveDashboardDist();
  const server = createServer(createRequestListener({ store, distDir }));
  const port = await listen(server, options.port);
  const url = `http://${HOST}:${port}`;

  console.log(`${pc.bold("agent-blackbox")} dashboard  ${pc.cyan(url)}`);
  console.log(pc.dim(`  sessions  ${store.sessionsDir}`));
  console.log(pc.dim("  ctrl-c to stop"));

  if (options.open) openBrowser(url);
  return server;
}

/**
 * The SPA ships as a sibling workspace package, so its dist lives next to its
 * own package.json wherever the CLI was installed from.
 */
function resolveDashboardDist(): string {
  const require = createRequire(import.meta.url);
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve("@agent-blackbox/dashboard/package.json");
  } catch {
    throw new Error(
      "dashboard package not found — reinstall agent-blackbox, or run `pnpm --filter @agent-blackbox/dashboard build` in a checkout",
    );
  }
  const distDir = resolve(dirname(packageJsonPath), "dist");
  if (!existsSync(join(distDir, "index.html"))) {
    throw new Error(
      `dashboard assets are missing at ${distDir} — build them with \`pnpm --filter @agent-blackbox/dashboard build\``,
    );
  }
  return distDir;
}

async function listen(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    server.once("error", (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        reject(new Error(`port ${port} is already in use — try \`--port ${port + 1}\``));
        return;
      }
      reject(error);
    });
    server.listen(port, HOST, () => {
      const address = server.address();
      resolvePort(typeof address === "object" && address !== null ? address.port : port);
    });
  });
}
