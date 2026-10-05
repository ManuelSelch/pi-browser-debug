import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type Page, type Request, type Response } from "playwright";
import type { BrowserCloseResult, BrowserEvent, BrowserMode, BrowserRecording, BrowserTab } from "./types.js";
import { createRecording, errorMessage, finalizeRecording, removeEmptyRecording, trackRecording } from "./recording.js";

const MAX_EVENTS = 250;

export function assertLoopbackCdpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("CDP URL must be a valid http://localhost:<port> URL.");
  }

  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!/^https?:$/.test(url.protocol) || !loopbackHosts.has(url.hostname)) {
    throw new Error("Remote CDP endpoints are blocked. Use localhost, 127.0.0.1, or ::1.");
  }
  return url;
}

function addEvent(tab: BrowserTab, event: BrowserEvent): void {
  tab.events.push(event);
  if (tab.events.length > MAX_EVENTS) tab.events.splice(0, tab.events.length - MAX_EVENTS);
}

function trackPage(tab: BrowserTab): () => void {
  const { page } = tab;
  const onConsole = (message: ConsoleMessage): void => addEvent(tab, {
    at: new Date().toISOString(), kind: "console", level: message.type(), text: message.text(),
  });
  const onPageError = (error: Error): void => addEvent(tab, { at: new Date().toISOString(), kind: "pageerror", level: "error", text: error.message });
  const onRequestFailed = (request: Request): void => addEvent(tab, {
    at: new Date().toISOString(), kind: "requestfailed", level: "error", text: request.failure()?.errorText ?? "request failed", url: request.url(),
  });
  const onResponse = (response: Response): void => {
    if (response.status() >= 400) addEvent(tab, {
      at: new Date().toISOString(), kind: "response", level: "error", text: `${response.status()} ${response.statusText()}`, url: response.url(), status: response.status(),
    });
  };
  const invalidateRefs = (): void => tab.refs.clear();

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  page.on("framenavigated", invalidateRefs);
  page.on("close", invalidateRefs);

  return () => {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed);
    page.off("response", onResponse);
    page.off("framenavigated", invalidateRefs);
    page.off("close", invalidateRefs);
  };
}

function pickPage(pages: readonly Page[], target?: string): Page {
  const candidates = pages.filter((page) => !/^(devtools:\/\/|chrome-extension:\/\/)/.test(page.url()));
  const selected = target ? candidates.find((page) => page.url().includes(target)) : candidates.at(-1);
  if (!selected) throw new Error(target ? `No page URL contains ${JSON.stringify(target)}.` : "No usable pages found.");
  return selected;
}

export interface BrowserDriver {
  launch: (options: { headless: boolean }) => Promise<Browser>;
  connectOverCDP: (url: string) => Promise<Browser>;
}

type BrowserResource = Pick<BrowserTab, "name" | "browser" | "ownsBrowser" | "lifecycle" | "stopTracking"> & { context?: BrowserContext };

export class BrowserManager {
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly failedOpens = new Map<string, BrowserResource>();
  private readonly closing = new Map<string, Promise<BrowserCloseResult>>();

  constructor(private readonly driver: BrowserDriver = chromium) {}

  async open(options: { name: string; mode: BrowserMode; cdpUrl?: string; target?: string; headless?: boolean; recordVideo?: boolean }): Promise<BrowserTab> {
    if (options.mode === "cdp" && options.recordVideo) throw new Error("Video recording requires a new managed browser context; CDP recording is not supported.");
    if (this.failedOpens.has(options.name)) {
      const result = await this.close(options.name);
      if (result.errors.length) throw new Error(result.errors.map((error) => error.message).join("\n"));
    }
    const existing = this.tabs.get(options.name);
    if (existing) {
      if (existing.mode !== options.mode) throw new Error(`Tab ${JSON.stringify(options.name)} is already ${existing.mode}; close it before changing modes.`);
      if (existing.page.isClosed() || existing.lifecycle.closing) {
        const result = await this.close(options.name);
        if (result.errors.length) throw new Error(result.errors.map((error) => error.message).join("\n"));
      } else {
        if (options.recordVideo !== undefined && options.recordVideo !== Boolean(existing.lifecycle.recording)) {
          throw new Error(`Tab ${JSON.stringify(options.name)} has a different recording setting; close and reopen it to change recordVideo.`);
        }
        return existing;
      }
    }

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let recording: BrowserRecording | undefined;
    try {
      let page: Page;
      const ownsBrowser = options.mode === "managed";
      if (!ownsBrowser) {
        const cdpUrl = assertLoopbackCdpUrl(options.cdpUrl ?? "http://localhost:9222");
        browser = await this.driver.connectOverCDP(cdpUrl.toString());
        context = browser.contexts()[0];
        if (!context) throw new Error("The CDP browser has no contexts.");
        page = pickPage(context.pages(), options.target);
      } else {
        browser = await this.driver.launch({ headless: options.headless ?? true });
        if (options.recordVideo) recording = await createRecording();
        context = await browser.newContext(recording ? { recordVideo: { dir: recording.directory } } : {});
        if (recording) trackRecording(context, recording);
        page = await context.newPage();
      }

      const tab: BrowserTab = {
        name: options.name, mode: options.mode, browser, context, page, ownsBrowser,
        lifecycle: { closing: false, contextClosed: false, browserClosed: false, recording },
        refs: new Map(), events: [], stopTracking: () => undefined,
      };
      tab.stopTracking = trackPage(tab);
      this.tabs.set(options.name, tab);
      return tab;
    } catch (error) {
      const failures = [errorMessage(error)];
      if (browser) {
        this.failedOpens.set(options.name, {
          name: options.name, browser, context, ownsBrowser: options.mode === "managed", stopTracking: () => undefined,
          lifecycle: { closing: true, contextClosed: !context, browserClosed: false, recording },
        });
        const result = await this.close(options.name);
        failures.push(...result.errors.map((failure) => failure.message));
      }
      throw new Error(failures.join("\n"));
    }
  }

  get(name: string): BrowserTab {
    const tab = this.tabs.get(name);
    if (tab?.lifecycle.closing || this.failedOpens.has(name)) throw new Error(`Browser tab ${JSON.stringify(name)} is closing; retry browser_close first.`);
    if (!tab || tab.page.isClosed()) throw new Error(`Browser tab ${JSON.stringify(name)} is not open. Call browser_open first.`);
    return tab;
  }

  list(): BrowserTab[] { return [...this.tabs.values()].filter((tab) => !tab.lifecycle.closing && !tab.page.isClosed()); }

  async selectPage(name: string, target: string): Promise<BrowserTab> {
    const tab = this.get(name);
    const page = pickPage(tab.context.pages(), target);
    if (page === tab.page) return tab;
    tab.stopTracking();
    const replacement: BrowserTab = { ...tab, page, refs: new Map(), events: [], stopTracking: () => undefined };
    replacement.stopTracking = trackPage(replacement);
    this.tabs.set(name, replacement);
    return replacement;
  }

  private closeTab(tab: BrowserResource): Promise<BrowserCloseResult> {
    const active = this.closing.get(tab.name);
    if (active) return active;
    tab.lifecycle.closing = true;
    tab.stopTracking();
    const operation = this.finalizeTab(tab).finally(() => { this.closing.delete(tab.name); });
    this.closing.set(tab.name, operation);
    return operation;
  }

  private async finalizeTab(tab: BrowserResource): Promise<BrowserCloseResult> {
    const result: BrowserCloseResult = { closed: 0, videos: [], errors: [] };
    const state = tab.lifecycle;
    if (tab.ownsBrowser && !state.contextClosed && tab.context) {
      try { await tab.context.close(); state.contextClosed = true; }
      catch (error) { result.errors.push({ name: tab.name, message: `Context close: ${errorMessage(error)}` }); }
    }
    if (state.contextClosed && state.recording) {
      state.recording.stopTracking();
      try {
        if (state.recording.pages.size) {
          const recording = await finalizeRecording(tab.name, state.recording);
          result.videos.push(...recording.videos);
          result.errors.push(...recording.errors);
        } else {
          await removeEmptyRecording(state.recording);
        }
      } catch (error) { result.errors.push({ name: tab.name, message: `Recording cleanup: ${errorMessage(error)}` }); }
    }
    if (!state.browserClosed) {
      try { await tab.browser.close(); state.browserClosed = true; result.closed = 1; }
      catch (error) { result.errors.push({ name: tab.name, message: `Browser close: ${errorMessage(error)}` }); }
    }
    if (!result.errors.length) {
      this.tabs.delete(tab.name);
      this.failedOpens.delete(tab.name);
    }
    return result;
  }

  async close(name?: string): Promise<BrowserCloseResult> {
    const tabs = name !== undefined
      ? [this.tabs.get(name) ?? this.failedOpens.get(name)].filter((tab): tab is BrowserResource => Boolean(tab))
      : [...this.tabs.values(), ...this.failedOpens.values()];
    const results = await Promise.all(tabs.map((tab) => this.closeTab(tab)));
    return {
      closed: results.reduce((sum, result) => sum + result.closed, 0),
      videos: results.flatMap((result) => result.videos),
      errors: results.flatMap((result) => result.errors),
    };
  }
}
