import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Hooks are short-lived child processes of the recorded agent, so they need a
 * rendezvous point: a loopback-only HTTP endpoint whose URL and bearer token are
 * passed to the agent through the environment. The hook blocks the agent while
 * it waits, so every request is answered before its payload is looked at.
 */
export const INGEST_PATH = "/events";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface IngestHandlers {
  /** Runs after the response was sent; throwing is reported, not propagated. */
  onPayload: (payload: unknown) => void;
  onError: (message: string) => void;
}

export interface IngestServer {
  url: string;
  token: string;
  close: () => Promise<void>;
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  handlers: IngestHandlers,
): void {
  if (req.method !== "POST" || req.url !== INGEST_PATH) {
    res.writeHead(404).end();
    return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;

  req.on("error", (error) => {
    handlers.onError(`ingest request failed: ${error.message}`);
  });
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      oversized = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    if (oversized) {
      handlers.onError(`dropped a hook payload larger than ${MAX_BODY_BYTES} bytes`);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      handlers.onError("dropped a hook payload that was not valid JSON");
      return;
    }
    try {
      handlers.onPayload(payload);
    } catch (error) {
      handlers.onError(error instanceof Error ? error.message : String(error));
    }
  });
}

export async function startIngestServer(handlers: IngestHandlers): Promise<IngestServer> {
  const token = randomBytes(32).toString("hex");
  const server = createServer((req, res) => {
    handleRequest(req, res, token, handlers);
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onListenError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onListenError);
      resolve();
    });
  });
  server.on("error", (error) => {
    handlers.onError(`ingest server error: ${error.message}`);
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}${INGEST_PATH}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        // Keep-alive sockets would otherwise hold the server open past the exit.
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
