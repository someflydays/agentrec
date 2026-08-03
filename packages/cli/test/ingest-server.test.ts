import { afterEach, describe, expect, it } from "vitest";
import { type IngestServer, startIngestServer } from "../src/recorder/ingest-server.js";

let server: IngestServer | undefined;

async function start(): Promise<{ payloads: unknown[]; errors: string[] }> {
  const payloads: unknown[] = [];
  const errors: string[] = [];
  server = await startIngestServer({
    onPayload: (payload) => {
      payloads.push(payload);
    },
    onError: (message) => {
      errors.push(message);
    },
  });
  return { payloads, errors };
}

function post(url: string, body: string, token: string | undefined): Promise<Response> {
  return fetch(url, {
    method: "POST",
    ...(token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {}),
    body,
  });
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("startIngestServer", () => {
  it("accepts an authorized payload and answers before mapping it", async () => {
    const { payloads, errors } = await start();
    if (server === undefined) throw new Error("server did not start");
    const response = await post(server.url, '{"hook_event_name":"Stop"}', server.token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(payloads).toEqual([{ hook_event_name: "Stop" }]);
    expect(errors).toEqual([]);
  });

  it("binds to loopback with a fresh token per session", async () => {
    const { errors } = await start();
    const first = server;
    await server?.close();
    await start();

    expect(first?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/events$/);
    expect(first?.token).toHaveLength(64);
    expect(server?.token).not.toBe(first?.token);
    expect(errors).toEqual([]);
  });

  it("rejects a wrong token without looking at the body", async () => {
    const { payloads } = await start();
    if (server === undefined) throw new Error("server did not start");
    const response = await post(server.url, '{"hook_event_name":"Stop"}', "nope");

    expect(response.status).toBe(401);
    expect(payloads).toEqual([]);
  });

  it("answers 404 for anything but a POST to the events path", async () => {
    await start();
    if (server === undefined) throw new Error("server did not start");
    const wrongPath = await fetch(server.url.replace("/events", "/other"), {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}` },
      body: "{}",
    });
    const wrongMethod = await fetch(server.url, {
      headers: { authorization: `Bearer ${server.token}` },
    });

    expect(wrongPath.status).toBe(404);
    expect(wrongMethod.status).toBe(404);
  });

  it("never fails the hook when the body is unusable or mapping throws", async () => {
    const errors: string[] = [];
    server = await startIngestServer({
      onPayload: () => {
        throw new Error("mapping blew up");
      },
      onError: (message) => {
        errors.push(message);
      },
    });

    const malformed = await post(server.url, "not json", server.token);
    const throwing = await post(server.url, "{}", server.token);

    expect(malformed.status).toBe(200);
    expect(throwing.status).toBe(200);
    expect(errors).toEqual(["dropped a hook payload that was not valid JSON", "mapping blew up"]);
  });
});
