import { API_ROUTES, type SessionEvent, type StreamMessage } from "@agentrec/core/browser";
import { useEffect, useRef } from "react";

export interface LiveStreamHandlers {
  onEvent: (event: SessionEvent) => void;
  onCastLine: (line: string) => void;
  onEnd: (exitCode: number | null) => void;
}

/**
 * Subscribes to a live session's SSE feed; a no-op once the session has ended.
 *
 * `sinceSeq` is the highest event seq the caller already holds from its initial
 * fetch. The server replays anything past it before tailing, so an event written
 * between that fetch and this subscription still arrives. It is read only when a
 * connection is opened, which is what lets the caller pass a value that changes
 * with every event without tearing the stream down.
 */
export function useLiveStream(
  id: string,
  enabled: boolean,
  handlers: LiveStreamHandlers,
  sinceSeq?: number | null,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const sinceSeqRef = useRef(sinceSeq);
  sinceSeqRef.current = sinceSeq;

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(streamUrl(id, sinceSeqRef.current));
    // EventSource reconnects on its own using the URL it was opened with, so a
    // dropped connection replays from the original point; anything already
    // handed over is dropped here rather than delivered twice.
    let delivered = sinceSeqRef.current ?? Number.NEGATIVE_INFINITY;

    const onMessage = (event: MessageEvent): void => {
      const message = parseMessage(event.data);
      if (message === null) return;
      switch (message.kind) {
        case "event":
          if (message.event.seq <= delivered) return;
          delivered = message.event.seq;
          handlersRef.current.onEvent(message.event);
          return;
        case "cast":
          handlersRef.current.onCastLine(message.line);
          return;
        case "end":
          // The server closes after `end`; closing here stops EventSource from
          // reconnecting in a loop.
          source.close();
          handlersRef.current.onEnd(message.exitCode);
      }
    };

    source.addEventListener("event", onMessage);
    source.addEventListener("cast", onMessage);
    source.addEventListener("end", onMessage);
    return () => {
      source.close();
    };
  }, [id, enabled]);
}

function streamUrl(id: string, sinceSeq: number | null | undefined): string {
  const path = API_ROUTES.stream(id);
  if (sinceSeq === null || sinceSeq === undefined) return path;
  return `${path}?${new URLSearchParams({ "since-seq": String(sinceSeq) }).toString()}`;
}

function parseMessage(data: unknown): StreamMessage | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as StreamMessage;
  } catch {
    return null;
  }
}
