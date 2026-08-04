import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@agentrec/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequestListener } from "../src/server/router.js";

let temp: string;
let server: Server | undefined;
let base: string;
let port: number;

/** fetch drops a Host header, so the rebinding case needs a raw request. */
function requestWithHost(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeEach(async () => {
  temp = mkdtempSync(join(tmpdir(), "agentrec-security-"));
  const store = new SessionStore(join(temp, "home"));
  store.ensure();
  const distDir = join(temp, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<html><head></head></html>");

  server = createServer(createRequestListener({ store, distDir }));
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) {
      resolve();
      return;
    }
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
  server = undefined;
  rmSync(temp, { recursive: true, force: true });
});

describe("origin and host guard", () => {
  it("refuses a cross-origin request to the API and to static assets", async () => {
    const api = await fetch(`${base}/api/sessions`, {
      headers: { origin: "https://evil.example" },
    });
    const asset = await fetch(`${base}/`, { headers: { origin: "https://evil.example" } });

    expect(api.status).toBe(403);
    expect(await api.json()).toEqual({ error: expect.stringContaining("evil.example") });
    expect(asset.status).toBe(403);
  });

  it("refuses a loopback origin on another port", async () => {
    const response = await fetch(`${base}/api/sessions`, {
      headers: { origin: `http://127.0.0.1:${port + 1}` },
    });

    expect(response.status).toBe(403);
  });

  it("allows its own origin and a request that declares none", async () => {
    const sameOrigin = await fetch(`${base}/api/sessions`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    const noOrigin = await fetch(`${base}/api/sessions`);

    expect(sameOrigin.status).toBe(200);
    expect(noOrigin.status).toBe(200);
  });

  it("refuses a request whose Host is not loopback", async () => {
    await expect(requestWithHost("/api/sessions", "evil.example")).resolves.toBe(403);
    await expect(requestWithHost("/api/sessions", `localhost:${port}`)).resolves.toBe(200);
  });
});
