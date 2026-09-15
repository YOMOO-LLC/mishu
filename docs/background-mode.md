# Background mode

Mishu keeps its Electron renderer alive when the main window is closed, because Twilio Voice and GPT Live WebRTC media tracks are owned by that renderer. With the default `minimizeToTray: true`, closing the window hides the existing `BrowserWindow` instead of destroying it, so authenticated HTTP/MCP tasks and incoming calls continue to work.

The tray menu provides:

- **Show window** — restores and focuses the existing window.
- **Current status** — shows Idle, On a call, or Pending approval N.
- **Pause tasks** — toggles the autonomous calling budget `killSwitch`; pause and resume actions are written to `audit_log` with actor `tray`.
- **Quit** — performs the real application shutdown and disposes background services.

Pending local approvals reuse the existing approval flow, which calls `show()` and `focus()` before delivering the request to the renderer. This means a hidden window is surfaced when user approval is required.

General settings are stored at `<userData>/general-settings.json` and are available through IPC, MCP (`settings_general_get`, `settings_general_update`), and HTTP (`GET|PUT /v1/settings/general`). `launchAtLogin` uses Electron login-item settings on macOS and Windows; Linux is currently unsupported. `startHidden` keeps the window hidden after launch while leaving its renderer running.

## Exit semantics

Closing the main window is only a hide operation while `minimizeToTray` is enabled. A real quit—from the tray menu, the operating system, automation, or `app.quit()`—marks shutdown before Electron closes any window, so the close handler cannot hide it again. The first `before-quit` is prevented while cleanup starts, then the exit is committed after a short delay on the next event-loop turns. This matters for inspector-driven automation such as Playwright: the initiating `app.quit()` evaluation can return and its debugger can disconnect before Electron enters final process exit. The committed exit path explicitly destroys the renderer before that delay, preventing a hidden window or active media renderer from holding Electron's native close handshake open. Normal launches commit with `app.exit(0)`; inspector-enabled launches terminate their own process after cleanup because both Node's `process.exit()` and Electron's `app.exit()` can enter an inspector/native teardown wait after their JavaScript exit events have fired. Background modules, schedulers, the tray, local stores, and the Codex child process are disposed in reverse registration order, and individual cleanup failures do not skip later resources. The MCP HTTP server first stops accepting requests and force-closes idle and active connections, including abandoned keep-alive streams. Scheduler timers are cleared and unreferenced, while the 2.5-second shutdown deadline intentionally remains referenced and uses the same immediate exit path if committing the exit is delayed. Timestamped `[shutdown]` lines on stderr record every phase without request, campaign, or phone data.

## Manual check

1. Run `pnpm dev`.
2. Close the main window and confirm the tray icon remains visible.
3. Submit a mock task or incoming call and confirm the app remains responsive.
4. Choose **Show window** from the tray menu and confirm the original window returns.
