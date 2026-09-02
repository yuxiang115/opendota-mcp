import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Structured JSONL telemetry: every tool call and every upstream request,
 * correlated by trace_id (AsyncLocalStorage). Enabled when
 * OPENDOTA_LOG_FILE is set (or defaults to stderr-only when unset, so
 * container setups can opt in to a file and analyze sessions afterwards).
 */
export interface TraceContext {
  trace_id: string;
  tool: string;
}

export const traceStorage = new AsyncLocalStorage<TraceContext>();

const LOG_FILE = process.env.OPENDOTA_LOG_FILE ?? "";

function emit(record: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  try {
    if (LOG_FILE) {
      mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      appendFileSync(LOG_FILE, line + "\n", "utf8");
    } else {
      // stderr keeps stdout clean for the MCP protocol; visible via container logs
      process.stderr.write(line + "\n");
    }
  } catch {
    /* logging must never break the server */
  }
}

export function currentTrace(): TraceContext {
  return traceStorage.getStore() ?? { trace_id: "out-of-band", tool: "-" };
}

export function logBoot(fields: Record<string, unknown>): void {
  emit({ event: "boot", ...fields });
}

export function logToolCall(fields: {
  trace_id: string;
  tool: string;
  duration_ms: number;
  ok: boolean;
  result_bytes?: number;
  error?: string;
  args?: unknown;
}): void {
  emit({ event: "tool_call", ...fields });
}

export function logUpstream(fields: {
  trace_id: string;
  tool: string;
  method: string;
  path: string;
  status?: number;
  duration_ms: number;
  cache?: "hit" | "miss" | "seed" | "swr_stale" | "bypass" | "refresh";
  error?: string;
}): void {
  emit({ event: "upstream", ...fields });
}

export function newTraceId(): string {
  return randomUUID().slice(0, 8);
}

/** Where logs go (for diagnostics scripts). */
export const LOG_TARGET = LOG_FILE || `stderr (pid ${process.pid}, host ${os.hostname()})`;
