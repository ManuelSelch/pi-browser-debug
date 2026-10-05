# pi-browser-debug

Reliable Playwright browser automation for Pi. It can launch an isolated Chromium browser or attach to an existing **loopback-only** Chrome DevTools Protocol (CDP) browser.

## Install

```sh
pi install npm:pi-browser-debug
# development
pi install /path/to/pi-browser-debug
```

For managed mode, install Playwright's Chromium binary once:

```sh
npx playwright install chromium
```

## Secure CDP attachment

CDP grants full access to tabs, cookies, and authenticated browser sessions. This extension intentionally accepts only `localhost`, `127.0.0.1`, and `::1` CDP endpoints.

```sh
# Linux example: use a separate profile; do not expose port 9222 on your network.
google-chrome-stable --remote-debugging-port=9222 --user-data-dir=/tmp/pi-browser-debug
```

## Model workflow

1. `browser_open` opens managed Chromium by default, or attaches with `mode: "cdp"`.
2. `browser_navigate` opens a page.
3. `browser_observe` returns interactive elements with refs such as `e1`.
4. `browser_act` uses a ref for click, fill, press, hover, select, scrolling, waits, screenshots, or uploads.
5. `browser_save_screenshot` captures the current page as a PNG and returns its saved path for verification artifacts.
6. `browser_events` reports persistent console, failed-request, and HTTP-error events.
7. `browser_close` finalizes recorded videos and shuts down managed browsers, or disconnects CDP sessions.

## Video evidence

Recording is opt-in and supported only for **managed** browsers:

```js
browser_open({ name: "evidence", recordVideo: true })
browser_navigate({ name: "evidence", url: "http://localhost:3000" })
// Interact with the page using browser_act, then finalize the recording:
browser_close({ name: "evidence" })
```

- `browser_open` and `browser_tabs` report the active recording directory. Videos are **not ready** until the pages/context close.
- `browser_close` returns `closed`, `videos`, and `errors` in its text and structured details. Each video includes an absolute `path`, `type: "video"`, `mimeType: "video/webm"`, `bytes`, `name`, `pageId`, and last known `url`.
- Copy returned paths into durable evidence storage, for example with `verify_attach({ path: "<returned path>", type: "video", label: "Browser workflow" })` when that tool is available.
- Recording produces **silent WebM, one file per page**, including popups and pages closed before `browser_close`; it does not stitch pages together. Playwright's default size scales the viewport to fit within 800×800.
- New browsers default to recording off. Reopening a live name without `recordVideo` preserves its setting; explicitly changing the setting requires closing and reopening.
- Files and `manifest.json` remain under the OS temporary directory (`pi-browser-debug/videos/recording-*`) after close. Orderly session shutdown also finalizes videos and writes the manifest; abrupt process termination cannot guarantee a complete recording. Temporary files may be removed by the OS: copy important evidence promptly.
- CDP recording is rejected before connecting; closing CDP still only disconnects and never closes user-owned pages.
- Close errors are reported alongside any successfully finalized videos. Retry `browser_close` for incomplete cleanup; recordings are not advertised as ready unless the file exists and is non-empty.
- Recordings can contain sensitive on-screen data. Recording continues during idle time and consumes disk space; close browsers when finished. No automatic file deletion is performed.

Mid-session start/stop, saving a clip while keeping the browser open, audio, custom dimensions, MP4 conversion, and inline video playback are not supported.

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_open` | Launch managed Chromium with optional video recording, or attach to local CDP |
| `browser_navigate` | Navigate a named tab |
| `browser_observe` | Inspect interactive page elements and create refs |
| `browser_act` | Perform actions by ref or CSS selector |
| `browser_save_screenshot` | Save the current page as a PNG and return its path |
| `browser_run` | Evaluate page JavaScript |
| `browser_events` | Read persistent browser diagnostics |
| `browser_tabs` | List named tabs |
| `browser_select` | Select an attached page by URL substring |
| `browser_close` | Close named or all automation tabs and return finalized video paths |

Run checks with `npm run check` after `npx playwright install chromium`. Tests include real Chromium video recording; missing browser/encoder binaries fail rather than silently skip.

To retain test videos for visual inspection, run `VIDEO_EVIDENCE_DIR=./test-results/video npm test` (then remove the generated directory when finished).
