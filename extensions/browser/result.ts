import type { ToolTextResult } from "./types.js";

export function textResult(text: string, details?: unknown): ToolTextResult {
  return { content: [{ type: "text", text }], details: details ?? {} };
}

export function formatError(error: unknown): ToolTextResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], details: {}, isError: true };
}

export function requireNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Browser action cancelled.");
}

export function timeout(value?: number): number {
  return Math.min(Math.max(value ?? 30_000, 1_000), 300_000);
}

export async function waitForDuration(value: string | undefined, maximum: number, signal?: AbortSignal): Promise<void> {
  const duration = Number(value ?? 250);
  if (!Number.isFinite(duration) || duration < 0 || duration > maximum) {
    throw new Error(`Wait duration must be between 0 and ${maximum} milliseconds.`);
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, duration);
    const onAbort = (): void => done(new Error("Browser action cancelled."));
    function done(error?: Error): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
