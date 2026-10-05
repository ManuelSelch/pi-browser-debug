import type { Browser, BrowserContext, Page, Video } from "playwright";

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

export interface VideoArtifact {
  readonly name: string;
  readonly pageId: string;
  readonly url: string;
  readonly path: string;
  readonly type: "video";
  readonly mimeType: "video/webm";
  readonly bytes: number;
}

export interface BrowserCloseResult {
  closed: number;
  videos: VideoArtifact[];
  errors: Array<{ name: string; message: string }>;
}

export interface RecordedPage {
  readonly pageId: string;
  readonly video: Video | null;
  url: string;
}

export interface BrowserRecording {
  readonly directory: string;
  readonly pages: Map<Page, RecordedPage>;
  stopTracking: () => void;
}

/** Shared by all active-page wrappers for one browser lifetime. */
export interface BrowserLifecycle {
  closing: boolean;
  contextClosed: boolean;
  browserClosed: boolean;
  readonly recording?: BrowserRecording;
}

export interface BrowserTab {
  readonly name: string;
  readonly mode: BrowserMode;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly ownsBrowser: boolean;
  readonly lifecycle: BrowserLifecycle;
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
