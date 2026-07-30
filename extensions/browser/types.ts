import type { Browser, BrowserContext, Page } from "playwright";

export type BrowserMode = "managed" | "cdp";
export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";
export type BrowserEventLevel = "all" | "error" | "warning" | "info" | "log";

export interface BrowserEvent {
  readonly at: string;
  readonly kind: "console" | "pageerror" | "requestfailed" | "response";
  readonly level?: string;
  readonly text: string;
  readonly url?: string;
  readonly status?: number;
}

export interface BrowserTab {
  readonly name: string;
  readonly mode: BrowserMode;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly ownsBrowser: boolean;
  refs: Map<string, string>;
  events: BrowserEvent[];
  stopTracking: () => void;
}

export interface ObservedElement {
  readonly ref: string;
  readonly role: string | null;
  readonly name: string;
  readonly tag: string;
  readonly type: string | null;
  readonly text: string;
  readonly disabled: boolean;
}

export interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  isError?: boolean;
}
