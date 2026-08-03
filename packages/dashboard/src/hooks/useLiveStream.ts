import { API_ROUTES, type SessionEvent, type StreamMessage } from "@agentrec/core/browser";
import { useEffect, useRef } from "react";

export interface LiveStreamHandlers {
  onEvent: (event: SessionEvent) => void;
  onCastLine: (line: string) => void;
  onEnd: (exitCode: number | null) => void;
}

/** Subscribes to a live session's SSE feed; a no-op once the session has ended. */
export function useLiveStream(id: string, enabled: boolean, handlers: LiveStreamHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(API_ROUTES.stream(id));

    const onMessage = (event: MessageEvent): void => {
      const message = parseMessage(event.data);
      if (message === null) return;
      switch (message.kind) {
        case "event":
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

function parseMessage(data: unknown): StreamMessage | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as StreamMessage;
  } catch {
    return null;
  }
}
