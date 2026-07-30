import { chromium, type Browser, type ConsoleMessage, type Page, type Request, type Response } from "playwright";
import type { BrowserEvent, BrowserMode, BrowserTab } from "./types.js";

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

async function disposeBrowser(browser: Browser): Promise<void> {
  // Playwright's close disconnects a CDP connection; it does not own the attached browser process.
  await browser.close().catch(() => undefined);
}

export class BrowserManager {
  private readonly tabs = new Map<string, BrowserTab>();

  async open(options: { name: string; mode: BrowserMode; cdpUrl?: string; target?: string; headless?: boolean }): Promise<BrowserTab> {
    const existing = this.tabs.get(options.name);
    if (existing) {
      if (existing.mode !== options.mode) throw new Error(`Tab ${JSON.stringify(options.name)} is already ${existing.mode}; close it before changing modes.`);
      if (existing.page.isClosed()) await this.close(options.name);
      else return existing;
    }

    let browser: Browser | undefined;
    try {
      let ownsBrowser: boolean;
      let page: Page;
      if (options.mode === "cdp") {
        const cdpUrl = assertLoopbackCdpUrl(options.cdpUrl ?? "http://localhost:9222");
        browser = await chromium.connectOverCDP(cdpUrl.toString());
        ownsBrowser = false;
        const context = browser.contexts()[0];
        if (!context) throw new Error("The CDP browser has no contexts.");
        page = pickPage(context.pages(), options.target);
      } else {
        browser = await chromium.launch({ headless: options.headless ?? true });
        ownsBrowser = true;
        const context = await browser.newContext();
        page = await context.newPage();
      }

      const tab: BrowserTab = { name: options.name, mode: options.mode, browser, context: page.context(), page, ownsBrowser, refs: new Map(), events: [], stopTracking: () => undefined };
      tab.stopTracking = trackPage(tab);
      this.tabs.set(options.name, tab);
      return tab;
    } catch (error) {
      if (browser) await disposeBrowser(browser);
      throw error;
    }
  }

  get(name: string): BrowserTab {
    const tab = this.tabs.get(name);
    if (!tab || tab.page.isClosed()) throw new Error(`Browser tab ${JSON.stringify(name)} is not open. Call browser_open first.`);
    return tab;
  }

  list(): BrowserTab[] { return [...this.tabs.values()].filter((tab) => !tab.page.isClosed()); }

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

  async close(name?: string): Promise<number> {
    const tabs = name ? [this.tabs.get(name)].filter((tab): tab is BrowserTab => Boolean(tab)) : [...this.tabs.values()];
    await Promise.all(tabs.map(async (tab) => {
      this.tabs.delete(tab.name);
      tab.stopTracking();
      await disposeBrowser(tab.browser);
    }));
    return tabs.length;
  }
}
