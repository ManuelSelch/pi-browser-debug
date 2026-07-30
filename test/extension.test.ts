import assert from "node:assert/strict";
import test from "node:test";
import browserAutomation from "../extensions/index.js";

test("registers the browser automation toolset", () => {
  const tools: Array<{ name: string; executionMode?: string }> = [];
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
    "browser_run",
    "browser_events",
    "browser_tabs",
    "browser_select",
    "browser_close",
  ]);
  assert.ok(tools.every((tool) => tool.executionMode === "sequential"));
  assert.deepEqual(events, ["session_shutdown"]);
});
