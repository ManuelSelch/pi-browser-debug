import assert from "node:assert/strict";
import test from "node:test";
import { assertLoopbackCdpUrl } from "../extensions/browser/manager.js";
import { selectorForAction } from "../extensions/browser/observe.js";
import { waitForDuration } from "../extensions/browser/result.js";

test("allows loopback CDP endpoints", () => {
  assert.equal(assertLoopbackCdpUrl("http://localhost:9222/").hostname, "localhost");
  assert.equal(assertLoopbackCdpUrl("http://127.0.0.1:9222").hostname, "127.0.0.1");
});

test("rejects remote and non-HTTP CDP endpoints", () => {
  assert.throws(() => assertLoopbackCdpUrl("http://example.com:9222"), /Remote CDP endpoints/);
  assert.throws(() => assertLoopbackCdpUrl("ws://localhost:9222"), /Remote CDP endpoints/);
});


test("allows duration-only waits and element screenshots", () => {
  const tab = { refs: new Map([["e1", "[data-pi-browser-ref=\"e1\"]"]]) } as never;
  assert.equal(selectorForAction(tab, "wait"), undefined);
  assert.equal(selectorForAction(tab, "screenshot", "e1"), "[data-pi-browser-ref=\"e1\"]");
  assert.equal(selectorForAction(tab, "screenshot", undefined, "#hero"), "#hero");
});

test("allows full-page screenshots without an element target", () => {
  const tab = { refs: new Map() } as never;
  assert.equal(selectorForAction(tab, "screenshot"), undefined);
});


test("cancels and bounds duration-only waits", async () => {
  const controller = new AbortController();
  const waiting = waitForDuration("1000", 1_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, /cancelled/);
  await assert.rejects(waitForDuration("1001", 1_000), /between 0 and 1000/);
});
