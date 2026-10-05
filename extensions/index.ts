import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BrowserManager } from "./browser/manager.js";
import { observe, selectorForAction } from "./browser/observe.js";
import { formatError, requireNotAborted, textResult, timeout, waitForDuration } from "./browser/result.js";

const tabName = Type.Optional(Type.String({ default: "main", description: "Named browser tab (default: main)" }));
const timeoutParam = Type.Optional(Type.Number({ default: 30_000, description: "Timeout in milliseconds (1,000–300,000)" }));

function screenshotPath(savePath?: string): string {
  if (!savePath) return path.join(os.tmpdir(), "pi-browser-debug", `screenshot-${randomUUID()}.png`);
  const resolved = path.resolve(process.cwd(), savePath);
  const relativeToCwd = path.relative(process.cwd(), resolved);
  const relativeToTemp = path.relative(os.tmpdir(), resolved);
  const insideCwd = relativeToCwd === "" || (!relativeToCwd.startsWith(`..${path.sep}`) && relativeToCwd !== "..");
  const insideTemp = relativeToTemp === "" || (!relativeToTemp.startsWith(`..${path.sep}`) && relativeToTemp !== "..");
  if (!insideCwd && !insideTemp) throw new Error("Screenshot path must be inside the current working directory or the OS temporary directory.");
  return resolved;
}

export default function browserAutomation(pi: ExtensionAPI, manager = new BrowserManager()): void {
  pi.registerTool({
    name: "browser_open", label: "Open Browser", description: "Launch managed Chromium or attach to loopback CDP. Optionally record managed pages as WebM videos; browser_close finalizes and returns their paths.",
    executionMode: "sequential",
    parameters: Type.Object({ name: tabName, mode: Type.Optional(Type.Union([Type.Literal("managed"), Type.Literal("cdp")], { default: "managed" })), cdpUrl: Type.Optional(Type.String({ description: "Loopback CDP URL, e.g. http://localhost:9222" })), target: Type.Optional(Type.String({ description: "URL substring when attaching to CDP" })), headless: Type.Optional(Type.Boolean({ default: true })), recordVideo: Type.Optional(Type.Boolean({ description: "Record managed pages as silent WebM videos until browser_close. Defaults to false for new browsers; omitted on reopen preserves the existing setting." })) }),
    async execute(_id, params, signal) {
      try {
        requireNotAborted(signal);
        const tab = await manager.open({ name: params.name ?? "main", mode: params.mode ?? "managed", cdpUrl: params.cdpUrl, target: params.target, headless: params.headless, recordVideo: params.recordVideo });
        const recording = tab.lifecycle.recording;
        const details = { name: tab.name, mode: tab.mode, url: tab.page.url(), recordVideo: Boolean(recording), ...(recording ? { recordingDirectory: recording.directory, recordingStatus: "active" } : {}) };
        return textResult(`Opened ${tab.mode} tab ${JSON.stringify(tab.name)}\n${tab.page.url()}${recording ? `\nRecording active in ${recording.directory}; call browser_close to finalize videos.` : ""}`, details);
      } catch (error) { return formatError(error); }
    },
  });

  pi.registerTool({
    name: "browser_navigate", label: "Navigate Browser", description: "Navigate a named browser tab and invalidate old element refs.",
    executionMode: "sequential",
    parameters: Type.Object({ name: tabName, url: Type.String(), waitUntil: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle"), Type.Literal("commit")], { default: "load" })), timeout: timeoutParam }),
    async execute(_id, params, signal) {
      try { requireNotAborted(signal); const tab = manager.get(params.name ?? "main"); const response = await tab.page.goto(params.url, { waitUntil: params.waitUntil ?? "load", timeout: timeout(params.timeout) }); requireNotAborted(signal); return textResult(`Navigated to ${tab.page.url()}\nHTTP ${response?.status() ?? "no response"}\n${await tab.page.title()}`); } catch (error) { return formatError(error); }
    },
  });

  pi.registerTool({
    name: "browser_observe", label: "Observe Page", description: "Return current interactive elements with stable refs. Use those refs with browser_act.",
    executionMode: "sequential",
    parameters: Type.Object({ name: tabName, includeAll: Type.Optional(Type.Boolean({ default: false })) }),
    async execute(_id, params, signal) {
      try { requireNotAborted(signal); const tab = manager.get(params.name ?? "main"); const elements = await observe(tab, params.includeAll ?? false); return textResult(JSON.stringify({ url: tab.page.url(), title: await tab.page.title(), elements }, null, 2), { elements }); } catch (error) { return formatError(error); }
    },
  });

  pi.registerTool({
    name: "browser_act", label: "Act in Browser", description: "Click, fill, press, hover, select, scroll, wait, screenshot, or upload using a selector or browser_observe ref.",
    executionMode: "sequential",
    parameters: Type.Object({ name: tabName, action: Type.Union([Type.Literal("click"), Type.Literal("fill"), Type.Literal("press"), Type.Literal("hover"), Type.Literal("select"), Type.Literal("scroll"), Type.Literal("wait"), Type.Literal("screenshot"), Type.Literal("upload")]), ref: Type.Optional(Type.String()), selector: Type.Optional(Type.String()), value: Type.Optional(Type.String()), timeout: timeoutParam, fullPage: Type.Optional(Type.Boolean({ default: false })) }),
    async execute(_id, params, signal) {
      try {
        requireNotAborted(signal); const tab = manager.get(params.name ?? "main"); const ms = timeout(params.timeout); const selector = selectorForAction(tab, params.action, params.ref, params.selector);
        if (params.action === "click") await tab.page.locator(selector!).click({ timeout: ms });
        else if (params.action === "fill") { if (params.value === undefined) throw new Error("fill requires value."); await tab.page.locator(selector!).fill(params.value, { timeout: ms }); }
        else if (params.action === "press") { if (!params.value) throw new Error("press requires value, e.g. Enter."); await tab.page.locator(selector!).press(params.value, { timeout: ms }); }
        else if (params.action === "hover") await tab.page.locator(selector!).hover({ timeout: ms });
        else if (params.action === "select") { if (params.value === undefined) throw new Error("select requires value."); await tab.page.locator(selector!).selectOption(params.value, { timeout: ms }); }
        else if (params.action === "scroll") await tab.page.mouse.wheel(0, Number(params.value ?? 600));
        else if (params.action === "wait") { if (selector) await tab.page.locator(selector).waitFor({ timeout: ms }); else await waitForDuration(params.value, ms, signal); }
        else if (params.action === "upload") { if (!params.value) throw new Error("upload requires a local file path in value."); await tab.page.locator(selector!).setInputFiles(params.value, { timeout: ms }); }
        else { const buffer = selector ? await tab.page.locator(selector).screenshot({ timeout: ms }) : await tab.page.screenshot({ fullPage: params.fullPage ?? false, timeout: ms }); return { content: [{ type: "image", data: buffer.toString("base64"), mimeType: "image/png" }, { type: "text", text: "Screenshot captured." }], details: {} }; }
        requireNotAborted(signal); return textResult(`${params.action} completed on ${tab.page.url()}`);
      } catch (error) { return formatError(error); }
    },
  });

  pi.registerTool({
    name: "browser_save_screenshot", label: "Save Browser Screenshot", description: "Capture the current browser page and save a PNG screenshot to disk. Returns the path for use with verification artifact tools.",
    executionMode: "sequential",
    parameters: Type.Object({ name: tabName, savePath: Type.Optional(Type.String({ description: "Output PNG path, relative to the current working directory or inside the OS temporary directory" })), fullPage: Type.Optional(Type.Boolean({ default: true })), timeout: timeoutParam }),
    async execute(_id, params, signal) {
      try {
        requireNotAborted(signal);
        const tab = manager.get(params.name ?? "main");
        const outputPath = screenshotPath(params.savePath);
        await mkdir(path.dirname(outputPath), { recursive: true });
        const buffer = await tab.page.screenshot({ path: outputPath, fullPage: params.fullPage ?? true, timeout: timeout(params.timeout) });
        requireNotAborted(signal);
        const result = { path: outputPath, type: "screenshot", mimeType: "image/png", bytes: buffer.length, url: tab.page.url() };
        return { content: [{ type: "image", data: buffer.toString("base64"), mimeType: "image/png" }, { type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      } catch (error) { return formatError(error); }
    },
  });

  pi.registerTool({
    name: "browser_run", label: "Run Browser JavaScript", description: "Evaluate JavaScript in the active page. Use browser_observe and browser_act for normal automation.",
    executionMode: "sequential",
    parameters: Type.Object({ name: tabName, code: Type.String() }),
    async execute(_id, params, signal) { try { requireNotAborted(signal); const result = await manager.get(params.name ?? "main").page.evaluate(params.code); return textResult(typeof result === "string" ? result : JSON.stringify(result, null, 2)); } catch (error) { return formatError(error); } },
  });

  pi.registerTool({
    name: "browser_events", label: "Browser Events", description: "Read persistent console, failed-request, and HTTP-error events for a tab.",
    executionMode: "sequential",
    parameters: Type.Object({ name: tabName, level: Type.Optional(Type.String({ default: "all" })), clear: Type.Optional(Type.Boolean({ default: false })) }),
    async execute(_id, params) { try { const tab = manager.get(params.name ?? "main"); const events = tab.events.filter((event) => params.level === undefined || params.level === "all" || event.level === params.level); if (params.clear) tab.events.splice(0); return textResult(events.length ? JSON.stringify(events, null, 2) : "No recorded browser events.", { events }); } catch (error) { return formatError(error); } },
  });

  pi.registerTool({
    name: "browser_tabs", label: "Browser Tabs", description: "List named automation tabs.", executionMode: "sequential",
    parameters: Type.Object({}),
    async execute() { const tabs = await Promise.all(manager.list().map(async (tab) => ({ name: tab.name, mode: tab.mode, url: tab.page.url(), title: await tab.page.title(), recordVideo: Boolean(tab.lifecycle.recording), ...(tab.lifecycle.recording ? { recordingDirectory: tab.lifecycle.recording.directory, recordingStatus: "active" } : {}) }))); return textResult(JSON.stringify(tabs, null, 2), { tabs }); },
  });

  pi.registerTool({
    name: "browser_select", label: "Select Attached Page", description: "Select a page in a CDP-attached browser by URL substring.", executionMode: "sequential",
    parameters: Type.Object({ name: tabName, target: Type.String() }),
    async execute(_id, params) { try { const tab = await manager.selectPage(params.name ?? "main", params.target); return textResult(`Selected ${tab.page.url()}`); } catch (error) { return formatError(error); } },
  });

  pi.registerTool({
    name: "browser_close", label: "Close Browser", description: "Close named or all automation tabs and return finalized WebM video paths. CDP disconnects without closing the user browser. Copy temporary videos to durable artifact storage.", executionMode: "sequential",
    parameters: Type.Object({ name: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      try {
        const result = await manager.close(params.name);
        const summary = `Closed ${result.closed} browser tab(s).`;
        return { ...textResult(result.videos.length || result.errors.length ? `${summary}\n${JSON.stringify(result, null, 2)}` : summary, result), ...(result.errors.length ? { isError: true } : {}) };
      } catch (error) { return formatError(error); }
    },
  });

  pi.on("session_shutdown", async () => {
    const result = await manager.close();
    if (result.errors.length) throw new Error(result.errors.map((error) => `${error.name}: ${error.message}`).join("\n"));
  });
}
