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
5. `browser_events` reports persistent console, failed-request, and HTTP-error events.
6. `browser_close` shuts down managed browsers or disconnects CDP sessions.

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_open` | Launch managed Chromium or attach to local CDP |
| `browser_navigate` | Navigate a named tab |
| `browser_observe` | Inspect interactive page elements and create refs |
| `browser_act` | Perform actions by ref or CSS selector |
| `browser_run` | Evaluate page JavaScript |
| `browser_events` | Read persistent browser diagnostics |
| `browser_tabs` | List named tabs |
| `browser_select` | Select an attached page by URL substring |
| `browser_close` | Close named or all automation tabs |

Run checks with `npm run check`.
