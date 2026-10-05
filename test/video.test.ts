import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import browserAutomation from "../extensions/index.js";
import { BrowserManager } from "../extensions/browser/manager.js";
import type { BrowserCloseResult, VideoArtifact } from "../extensions/browser/types.js";

interface ToolResponse { content: Array<{ type: string; text?: string }>; details: any; isError?: boolean }
function toolHarness(manager: BrowserManager) {
  const tools = new Map<string, { execute: (...args: any[]) => Promise<ToolResponse> }>();
  let shutdown: (() => Promise<void>) | undefined;
  browserAutomation({
    registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<ToolResponse> }) => { tools.set(tool.name, tool); },
    on: (_event: string, handler: () => Promise<void>) => { shutdown = handler; },
  } as never, manager);
  return {
    async call(name: string, params: Record<string, unknown>) {
      const result = await tools.get(name)!.execute("test", params);
      assert.notEqual(result.isError, true, result.content[0]?.text);
      return result;
    },
    shutdown: () => shutdown!(),
  };
}

async function assertWebM(video: VideoArtifact) {
  assert.equal(path.isAbsolute(video.path), true);
  assert.equal(video.mimeType, "video/webm");
  assert.equal(video.type, "video");
  assert.ok(video.bytes > 0);
  assert.equal((await stat(video.path)).size, video.bytes);
  // EBML header: proves the artifact is an actual media container, not just a named file.
  assert.deepEqual((await readFile(video.path)).subarray(0, 4), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

test("real tools record actions and popups, preserve selected/closed page videos, and return attachable artifacts", { timeout: 30_000 }, async (t) => {
  const fixture = await readFile(path.join(process.cwd(), "test/fixtures/video.html"));
  const server = createServer((_req, response) => { response.setHeader("Content-Type", "text/html"); response.end(fixture); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const manager = new BrowserManager();
  const tools = toolHarness(manager);
  t.after(() => tools.shutdown());
  const opened = await tools.call("browser_open", { name: "evidence", recordVideo: true });
  assert.equal(opened.details.recordVideo, true);
  assert.equal(opened.details.recordingStatus, "active");
  const directory: string = opened.details.recordingDirectory;
  t.after(() => rm(directory, { recursive: true, force: true }));
  await tools.call("browser_navigate", { name: "evidence", url });
  await tools.call("browser_act", { name: "evidence", action: "wait", value: "700" });
  await tools.call("browser_act", { name: "evidence", action: "click", selector: "#complete" });
  assert.equal(await manager.get("evidence").page.locator("#status").textContent(), "ACTION COMPLETE");
  await tools.call("browser_act", { name: "evidence", action: "wait", value: "700" });
  const popupPromise = manager.get("evidence").context.waitForEvent("page");
  await tools.call("browser_act", { name: "evidence", action: "click", selector: "a" });
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await tools.call("browser_select", { name: "evidence", target: "/popup" });
  await tools.call("browser_act", { name: "evidence", action: "wait", value: "400" });
  const listed = await tools.call("browser_tabs", {});
  assert.equal(listed.details.tabs[0].recordVideo, true);
  assert.equal(listed.details.tabs[0].recordingDirectory, directory);
  await popup.close(); // Selected page is now closed; close must still find all context videos.
  const closed = await tools.call("browser_close", { name: "evidence" });
  const result = closed.details as BrowserCloseResult;
  assert.equal(result.closed, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(result.videos.length, 2);
  await Promise.all(result.videos.map(assertWebM));
  assert.match(result.videos[1]!.url, /\/popup$/);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")).videos, result.videos);
  assert.equal((await tools.call("browser_close", { name: "evidence" })).details.closed, 0);
  if (process.env.VIDEO_EVIDENCE_DIR) {
    const output = path.resolve(process.env.VIDEO_EVIDENCE_DIR);
    await mkdir(output, { recursive: true });
    for (const video of result.videos) await copyFile(video.path, path.join(output, `${video.pageId}.webm`));
    await writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  }
});

test("real recording-off callers have no video handle or artifacts", { timeout: 30_000 }, async (t) => {
  const manager = new BrowserManager();
  t.after(() => manager.close());
  const tab = await manager.open({ name: "plain", mode: "managed" });
  assert.equal(tab.page.video(), null);
  assert.equal(tab.lifecycle.recording, undefined);
  assert.deepEqual(await manager.close(), { closed: 1, videos: [], errors: [] });
});

test("orderly session shutdown finalizes real videos and leaves a discoverable manifest", { timeout: 30_000 }, async (t) => {
  const manager = new BrowserManager();
  const tools = toolHarness(manager);
  t.after(() => tools.shutdown());
  const opened = await tools.call("browser_open", { name: "shutdown", recordVideo: true });
  const directory: string = opened.details.recordingDirectory;
  t.after(() => rm(directory, { recursive: true, force: true }));
  await manager.get("shutdown").page.setContent("<h1>Shutdown evidence</h1>");
  await tools.call("browser_act", { name: "shutdown", action: "wait", value: "400" });
  await tools.shutdown();
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.videos.length, 1);
  assert.deepEqual(manifest.errors, []);
  await assertWebM(manifest.videos[0]);
  assert.deepEqual(manager.list(), []);
});
