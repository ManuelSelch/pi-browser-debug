import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { Browser } from "playwright";
import { BrowserManager } from "../extensions/browser/manager.js";

class FakePage extends EventEmitter {
  closed = false;
  currentUrl = "about:blank";
  constructor(readonly owner: FakeContext, readonly file?: string) { super(); }
  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  context() { return this.owner; }
  video() { return this.file ? { path: async () => this.file } : null; }
  navigate(url: string) { this.currentUrl = url; this.emit("framenavigated", this); }
  async close() { this.closed = true; this.emit("close"); }
}

class FakeContext extends EventEmitter {
  allPages: FakePage[] = [];
  directory?: string;
  closeCalls = 0;
  failClose = false;
  failPage = false;
  constructor(readonly calls: string[]) { super(); }
  pages() { return this.allPages.filter((page) => !page.closed); }
  async newPage() {
    if (this.failPage) throw new Error("page creation failed");
    const page = new FakePage(this, this.directory ? path.join(this.directory, `${this.allPages.length}.webm`) : undefined);
    this.allPages.push(page);
    this.emit("page", page);
    return page;
  }
  async close() {
    this.closeCalls++;
    this.calls.push("context.close");
    if (this.failClose) throw new Error("context close failed");
    for (const page of this.allPages) {
      await page.close();
      if (page.file) await writeFile(page.file, "fake webm");
    }
  }
}

class FakeBrowser {
  closeCalls = 0;
  failClose = false;
  constructor(readonly context: FakeContext, readonly calls: string[]) {}
  contexts() { return [this.context]; }
  async newContext(options: { recordVideo?: { dir: string } } = {}) {
    this.context.directory = options.recordVideo?.dir;
    return this.context;
  }
  async close() {
    this.closeCalls++;
    this.calls.push("browser.close");
    if (this.failClose) throw new Error("browser close failed");
  }
}

function fixture() {
  const calls: string[] = [];
  const browsers: FakeBrowser[] = [];
  let connections = 0;
  const driver = {
    launch: async () => {
      const browser = new FakeBrowser(new FakeContext(calls), calls);
      browsers.push(browser);
      return browser as unknown as Browser;
    },
    connectOverCDP: async () => {
      connections++;
      const browser = new FakeBrowser(new FakeContext(calls), calls);
      await browser.context.newPage();
      browsers.push(browser);
      return browser as unknown as Browser;
    },
  };
  return { manager: new BrowserManager(driver), calls, browsers, get connections() { return connections; } };
}

const managed = { name: "evidence", mode: "managed" as const };

test("recording is off by default; omitted reopen preserves configuration and conflicts reject", async () => {
  const { manager, browsers } = fixture();
  const tab = await manager.open(managed);
  assert.equal(tab.lifecycle.recording, undefined);
  assert.equal(await manager.open(managed), tab);
  await assert.rejects(manager.open({ ...managed, recordVideo: true }), /close.*reopen/i);
  assert.equal(browsers.length, 1);
  assert.deepEqual(await manager.close(), { closed: 1, videos: [], errors: [] });
  assert.deepEqual(await manager.close(), { closed: 0, videos: [], errors: [] });
});

test("rejects CDP recording before connecting, and CDP cleanup never closes context", async () => {
  const f = fixture();
  await assert.rejects(f.manager.open({ name: "cdp", mode: "cdp", recordVideo: true }), /managed/);
  assert.equal(f.connections, 0);
  await f.manager.open({ name: "cdp", mode: "cdp" });
  assert.equal((await f.manager.close()).closed, 1);
  assert.deepEqual(f.calls, ["browser.close"]);
});

test("finalizes all pages before disposing browser and preserves recording across page selection", async (t) => {
  const { manager, browsers, calls } = fixture();
  const tab = await manager.open({ ...managed, name: "../unsafe/name", recordVideo: true });
  const recording = tab.lifecycle.recording!;
  t.after(() => rm(recording.directory, { recursive: true, force: true }));
  assert.equal(path.isAbsolute(recording.directory), true);
  assert.equal(recording.directory.includes("unsafe"), false);
  assert.equal(await manager.open({ ...managed, name: tab.name }), tab);
  await assert.rejects(manager.open({ ...managed, name: tab.name, recordVideo: false }), /close.*reopen/i);
  const context = browsers[0]!.context;
  const popup = await context.newPage();
  popup.navigate("http://fixture/popup");
  const selected = await manager.selectPage(tab.name, "popup");
  assert.equal(selected.lifecycle, tab.lifecycle);
  await (tab.page as unknown as FakePage).close();
  const result = await manager.close(tab.name);
  assert.deepEqual(calls, ["context.close", "browser.close"]);
  assert.equal(result.closed, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(result.videos.length, 2);
  assert.equal(context.listenerCount("page"), 0);
  assert.equal(popup.listenerCount("framenavigated"), 0);
  assert.equal(result.videos[1]!.url, "http://fixture/popup");
  for (const video of result.videos) {
    assert.equal(video.type, "video");
    assert.equal(video.mimeType, "video/webm");
    assert.ok(video.bytes > 0);
    assert.ok(await readFile(video.path));
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(recording.directory, "manifest.json"), "utf8")).videos, result.videos);
});

test("coalesces overlapping close calls and finalizes stale pages before reopening", async (t) => {
  const { manager, browsers } = fixture();
  const tab = await manager.open({ ...managed, recordVideo: true });
  t.after(() => rm(tab.lifecycle.recording!.directory, { recursive: true, force: true }));
  await tab.page.close();
  const replacement = await manager.open(managed);
  assert.notEqual(replacement, tab);
  assert.equal(browsers[0]!.context.closeCalls, 1);
  const [first, second] = await Promise.all([manager.close(), manager.close()]);
  assert.deepEqual(first, second);
  assert.equal(browsers[1]!.closeCalls, 1);
});

test("close-all retains successful artifacts and retries failed cleanup without allowing new work", async (t) => {
  const { manager, browsers } = fixture();
  const good = await manager.open({ ...managed, recordVideo: true });
  const bad = await manager.open({ ...managed, name: "broken", recordVideo: true });
  t.after(async () => {
    await rm(good.lifecycle.recording!.directory, { recursive: true, force: true });
    await rm(bad.lifecycle.recording!.directory, { recursive: true, force: true });
  });
  browsers[1]!.context.failClose = true;
  browsers[1]!.failClose = true;
  const result = await manager.close();
  assert.equal(result.closed, 1);
  assert.equal(result.videos.length, 1);
  assert.match(result.errors.map((error) => error.message).join(" "), /context close failed.*browser close failed/);
  assert.throws(() => manager.get("broken"), /closing/);
  assert.deepEqual(manager.list(), []);
  browsers[1]!.context.failClose = false;
  browsers[1]!.failClose = false;
  const retry = await manager.close("broken");
  assert.deepEqual(retry.errors, []);
  assert.equal(retry.videos.length, 1);
  assert.equal(browsers[1]!.closeCalls, 2);
});

test("reports missing videos and can retry artifact finalization", async (t) => {
  const { manager, browsers } = fixture();
  const tab = await manager.open({ ...managed, recordVideo: true });
  t.after(() => rm(tab.lifecycle.recording!.directory, { recursive: true, force: true }));
  const context = browsers[0]!.context;
  context.close = async () => { context.closeCalls++; await context.allPages[0]!.close(); };
  const result = await manager.close();
  assert.equal(result.videos.length, 0);
  assert.equal(result.errors.length, 1);
  await writeFile(context.allPages[0]!.file!, "recovered");
  assert.equal((await manager.close()).videos.length, 1);
  assert.equal(context.closeCalls, 1);
  assert.equal(browsers[0]!.closeCalls, 1);
});

test("empty files are not advertised and successful videos survive an artifact failure", async (t) => {
  const { manager, browsers } = fixture();
  const tab = await manager.open({ ...managed, recordVideo: true });
  t.after(() => rm(tab.lifecycle.recording!.directory, { recursive: true, force: true }));
  const context = browsers[0]!.context;
  await context.newPage();
  const normalClose = context.close.bind(context);
  context.close = async () => { await normalClose(); await writeFile(context.allPages[1]!.file!, ""); };
  const result = await manager.close();
  assert.equal(result.videos.length, 1);
  assert.match(result.errors[0]!.message, /empty/);
  assert.equal(browsers[0]!.closeCalls, 1);
  await writeFile(context.allPages[1]!.file!, "recovered");
  assert.equal((await manager.close()).videos.length, 2);
});

test("manifest write failures remain retryable and do not prevent browser disposal", async (t) => {
  const { manager, browsers } = fixture();
  const tab = await manager.open({ ...managed, recordVideo: true });
  const directory = tab.lifecycle.recording!.directory;
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, "manifest.json");
  await mkdir(manifestPath);
  const result = await manager.close();
  assert.equal(result.videos.length, 1);
  assert.match(result.errors[0]!.message, /Video manifest/);
  assert.equal(browsers[0]!.closeCalls, 1);
  await rm(manifestPath, { recursive: true });
  assert.deepEqual((await manager.close()).errors, []);
});

test("failed opens retain resources for retry when cleanup fails", async () => {
  const calls: string[] = [];
  const context = new FakeContext(calls);
  context.failPage = true;
  context.failClose = true;
  const browser = new FakeBrowser(context, calls);
  browser.failClose = true;
  const manager = new BrowserManager({ launch: async () => browser as unknown as Browser, connectOverCDP: async () => browser as unknown as Browser });
  await assert.rejects(manager.open(managed), /page creation failed.*\n.*context close failed.*\n.*browser close failed/);
  context.failClose = false;
  browser.failClose = false;
  assert.deepEqual(await manager.close(), { closed: 1, videos: [], errors: [] });
  assert.equal(browser.closeCalls, 2);
});

test("failed page creation explicitly closes context and removes an empty recording directory", async () => {
  const calls: string[] = [];
  const context = new FakeContext(calls);
  context.failPage = true;
  const browser = new FakeBrowser(context, calls);
  const manager = new BrowserManager({ launch: async () => browser as unknown as Browser, connectOverCDP: async () => browser as unknown as Browser });
  await assert.rejects(manager.open({ ...managed, recordVideo: true }), /page creation failed/);
  assert.deepEqual(calls, ["context.close", "browser.close"]);
  await assert.rejects(readdir(context.directory!), /ENOENT/);
  assert.deepEqual(manager.list(), []);
});
