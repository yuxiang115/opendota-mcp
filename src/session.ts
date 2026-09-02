import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request upstream credentials for the HTTP transport. A client can bring
 * its OWN OpenDota API key and/or STRATZ token (headers X-OpenDota-Key /
 * X-Stratz-Token on every request) so its traffic bills to the caller's quota
 * instead of the server operator's env-configured ones. stdio mode has no
 * sessions — env credentials are the only source there.
 */
export interface SessionCreds {
  openDotaKey?: string;
  stratzToken?: string;
}

export const sessionCreds = new AsyncLocalStorage<SessionCreds>();

/** The caller's own OpenDota key for this request, if provided. */
export function sessionOpenDotaKey(): string | undefined {
  return sessionCreds.getStore()?.openDotaKey || undefined;
}

/** The caller's own STRATZ token for this request, if provided. */
export function sessionStratzToken(): string | undefined {
  return sessionCreds.getStore()?.stratzToken || undefined;
}
