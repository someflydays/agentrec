import type { CapabilitiesResponse } from "@agentrec/core/browser";
import { useEffect, useState } from "react";
import { fetchCapabilities } from "../api";

/** What the server permits never changes while it runs, so one request covers the page. */
let pending: Promise<CapabilitiesResponse> | null = null;

export function useCapabilities(): CapabilitiesResponse | null {
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    pending ??= fetchCapabilities();
    void pending.then((value) => {
      if (!cancelled) setCapabilities(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return capabilities;
}
