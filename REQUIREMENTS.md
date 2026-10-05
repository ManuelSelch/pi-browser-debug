# Browser video recording plan

- Status: implemented and verified with typechecking, 20 passing tests (including real Chromium recordings), and visual inspection of decoded action/popup frames.
- Goal: support `browser_open({ name: "evidence", recordVideo: true })` and return usable video evidence when that browser is closed.

## Architecture at planning time

- `extensions/index.ts` registers sequential tools and closes the manager on `session_shutdown`.
- `extensions/browser/manager.ts` launches a separate browser/context per managed name; CDP names attach to existing contexts.
- Reopening a live name returns its existing tab. Selecting another page replaces the active tab wrapper.
- `close()` currently returns a count, removes tracking, and calls browser disposal, which suppresses close errors. Video finalization needs an explicit context-close step and visible errors.
- Existing tests cover registration and helpers, not a real browser lifecycle.

## Scope and API behavior

- Add optional boolean `recordVideo` to `browser_open`; new browsers default to recording off.
- Support recording only in managed mode. Reject CDP plus `recordVideo: true` before connecting, with a clear explanation that recording requires a newly created managed context.
- Configure Playwright `recordVideo` when creating the context, before creating any page. Recording includes navigation, actions, and idle periods until closure.
- Use native silent WebM video (`video/webm`). Preserve current viewport settings and use Playwright's default video dimensions initially.
- No new tool is required for the first increment. Workflow: open with recording, interact, close, then attach a returned path using an artifact tool such as `verify_attach`.
- `browser_open` and `browser_tabs` expose whether recording is enabled and its output directory. Clearly distinguish an active recording from a finalized artifact.
- For a live name, omitted `recordVideo` preserves its current configuration. An explicit value matching the existing configuration is idempotent; an explicit conflicting value errors with instructions to close and reopen. Never silently pretend recording was enabled or disabled.
- Preserve existing mode-conflict behavior. A stale/externally closed active page must have its old context finalized before reopening the name.

## Storage and artifact contract

- Create a unique directory per recorded browser lifetime under the OS temporary directory, for example `pi-browser-debug/videos/<unique-id>/`. Do not derive filesystem paths directly from user-provided tab names.
- Return absolute file paths for artifact consumers. Do not inline video bytes or claim that tool content embeds playable video.
- Native recording is per page, not one stitched video per named browser. Track every page created in the recording context, including popups and pages already closed before `browser_close`.
- Keep recording state context-owned and shared across active-page replacements, so `browser_select` cannot lose video handles or artifacts.
- After finalization, each artifact contains `name`, `path`, `type: "video"`, `mimeType: "video/webm"`, and `bytes`; include a per-page identifier and last known URL for multi-page attribution.
- Preserve successful close counts and extend `browser_close` text and `details` with finalized `videos` and any close/finalization errors. An unrecorded close retains the existing count text and has no video artifacts.
- Keep completed video files after close and orderly shutdown. Temporary files are not permanent evidence; consumers must copy them to durable storage. No automatic deletion or retention policy in this increment.

## Lifecycle and failure requirements

- Capture video handles as pages appear, including the initial page; do not enumerate only live pages at close time.
- Finalization order for managed browsers: stop accepting new work for the closing name, await context closure, resolve and validate recorded files, then dispose the owned browser. Always attempt browser disposal even if context closure or artifact inspection fails.
- Never await `video.saveAs()` while the page is still open as part of an operation that must return immediately; it waits for closure. Native `video.path()` is sufficient after context finalization for local managed browsers.
- A finalized artifact must exist and be non-empty before it is advertised as ready. Missing files and write/encoder errors must be surfaced rather than swallowed by `disposeBrowser()`.
- Closing all names attempts cleanup for every name even if one fails; retain successful artifacts alongside failures and mark the tool result as an error if any requested cleanup failed.
- Cleanup remains idempotent, including repeated close, shutdown, and partially failed opens. Coalesce overlapping close/shutdown work; retain enough state to retry incomplete cleanup rather than deleting all state before finalization succeeds.
- CDP close continues to disconnect only; never close an attached user's context/pages to implement this feature.
- On failed launch/context/page creation, dispose resources and remove empty staging directories when safe; preserve any successfully finalized recordings.
- Orderly `session_shutdown` follows the same finalization path. Persist a small artifact manifest beside the videos so recordings are discoverable without a tool response. Unexpected process termination cannot guarantee a complete video.
- Warn in documentation that recorded screens may contain sensitive data and that long-running idle browsers consume disk space.

## Small implementation steps

1. **Define recording contracts** — `extensions/browser/types.ts`, tool schemas in `extensions/index.ts`, and schema tests in `test/extension.test.ts`. Add optional recording configuration, context-owned state, artifact metadata, and close-result types; specify reopen conflicts before wiring recording.
2. **Start managed recordings** — `extensions/browser/manager.ts`. Create unique output directories, configure context recording, register page/video tracking, and ensure page selection preserves state. Add tests for defaults, CDP rejection before connection, and explicit/omitted reopen behavior.
3. **Finalize and report artifacts** — `extensions/browser/manager.ts` and `extensions/index.ts`. Explicitly close managed contexts, inspect files, produce the artifact manifest and close results, and expose recording status. Cover failure cleanup, close-all partial success, and idempotency with deterministic lifecycle tests.
4. **Prove real recording** — add `test/video.test.ts` with a real managed Chromium test and a local fixture. Navigate, perform a visible action, close, and assert a non-empty WebM exists at the returned path. Add popup/closed-page coverage and a recording-off case. Inspect one captured video manually to confirm the action is visible; file existence alone does not prove meaningful visual content.
5. **Document the workflow** — `README.md`. Explain opt-in recording, close-before-attach, per-page videos, managed-only support, temporary storage, privacy, and shutdown limitations. Run `npm run check` plus the real-browser suite with Playwright Chromium installed.

## Acceptance criteria

- The requested `browser_open` invocation starts recording before the first navigation.
- Recording remains disabled for existing callers that omit the option on a new name.
- CDP recording requests fail without connecting or changing the user's browser.
- Reopening cannot silently change recording configuration; omitted configuration preserves it.
- Closing a recorded browser returns at least one verified, non-empty WebM artifact; it is immediately copyable by verification tooling.
- Page switching, popup creation, and early page closure do not lose recordings.
- Close-all and shutdown finalize managed recordings without breaking CDP disconnect behavior.
- Failures are observable, successful artifacts survive partial failures, and cleanup is idempotent.
- Existing tests pass; real-browser tests do not silently skip absent browser binaries and report success.

## Deferred decisions / non-goals

- Mid-session start/stop, save-without-closing, custom output paths, resolution/FPS controls, audio, MP4 conversion, live streaming, stitched multi-page video, and UI playback are out of scope.
- Confirm whether evidence requires full viewport resolution rather than Playwright's scaled default before adding video-size controls.
- If users need to keep interacting after exporting a clip, plan a separate recording lifecycle rather than overloading `browser_close`.

## Source constraints

- [Playwright videos](https://playwright.dev/docs/videos): manually created contexts must be explicitly closed and awaited to save video; default recording dimensions fit within 800×800.
- [Playwright Video API](https://playwright.dev/docs/api/class-video): videos are per page; `path()` is guaranteed written after context closure, and `saveAs()` waits for page closure and video completion.
