import assert from "node:assert/strict";
import test from "node:test";
import browserAutomation from "../extensions/index.js";
import { BrowserManager } from "../extensions/browser/manager.js";
import type { BrowserCloseResult } from "../extensions/browser/types.js";

test("registers the browser automation toolset", () => {
  const tools: Array<{ name: string; executionMode?: string; parameters?: { properties?: Record<string, unknown> } }> = [];
  const events: string[] = [];
  browserAutomation({
    registerTool: (tool: { name: string; executionMode?: string }) => { tools.push(tool); },
    on: (event: string) => { events.push(event); },
  } as never);

  assert.deepEqual(tools.map((tool) => tool.name), [
    "browser_open",
    "browser_navigate",
    "browser_observe",
    "browser_act",
    "browser_save_screenshot",
    "browser_run",
    "browser_events",
    "browser_tabs",
    "browser_select",
    "browser_close",
  ]);
  assert.ok(tools.every((tool) => tool.executionMode === "sequential"));
  assert.ok(tools[0]?.parameters?.properties?.recordVideo);
  assert.deepEqual(events, ["session_shutdown"]);
});

test("close reports successful videos alongside errors and shutdown surfaces cleanup failures", async () => {
  const result: BrowserCloseResult = {
    closed: 1,
    videos: [{ name: "good", pageId: "page-1", path: "/tmp/good.webm", url: "http://fixture", bytes: 123, type: "video", mimeType: "video/webm" }],
    errors: [{ name: "bad", message: "encoder failed" }],
  };
  class FailingManager extends BrowserManager {
    override async close() { return result; }
  }
  let closeTool: { execute: (...args: any[]) => Promise<any> } | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  browserAutomation({
    registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => { if (tool.name === "browser_close") closeTool = tool; },
    on: (_event: string, handler: () => Promise<void>) => { shutdown = handler; },
  } as never, new FailingManager());
  const response = await closeTool!.execute("test", {});
  assert.equal(response.isError, true);
  assert.deepEqual(response.details, result);
  assert.match(response.content[0].text, /good.webm/);
  await assert.rejects(shutdown!(), /bad: encoder failed/);
});
