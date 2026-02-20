# Antigravity browser automation on Linux (research + WSL2 tunnel)

## Research summary: why serve-web fails on Linux

- **What happens:** `antigravity serve-web` spawns a helper binary `antigravity-tunnel` (expected at `/usr/share/antigravity/bin/antigravity-tunnel`). On Linux that binary is **not shipped**: neither the official APT package nor the official Linux tarball from [antigravity.google/download/linux](https://antigravity.google/download/linux) include it. Result: `spawn antigravity-tunnel ENOENT`.
- **What the tunnel does (from reverse-engineering):** On macOS, Antigravity’s browser automation uses Chrome with `--remote-debugging-port=9222` (Chrome DevTools Protocol). A separate process (on Mac it’s a Node MCP server, `@agentdeskai/browser-tools-mcp`) listens and talks CDP to that Chrome. On Linux, `serve-web` is designed to use `antigravity-tunnel` for the same role, but that binary is only shipped on Windows/macOS.
- **Conclusion:** On Linux you cannot use `antigravity serve-web` out of the box. Workarounds: (1) use the **Antigravity desktop app** for QA (runs still use `antigravity chat`); (2) use **Chrome on 9222 + socat** (below) so Linux can drive a browser (Windows or Linux Chrome) via CDP; (3) optionally run an MCP server (e.g. chrome-devtools-mcp) pointed at `http://127.0.0.1:9222` after the tunnel is up.

---

## WSL2 → Windows: socat tunnel for port 9222

On Linux (including WSL2), you can drive a **Windows Chrome** instance by forwarding Chrome DevTools Protocol (port 9222) from WSL2 to Windows using **socat**.

## 1. Install socat (Linux/WSL2)

```bash
sudo apt install socat
```

## 2. Windows IP from WSL2

From WSL2, your Windows host is reachable at a special IP (often in `172.x.x.x`). Get it with:

```bash
cat /etc/resolv.conf | grep nameserver | awk '{print $2}'
```

Or:

```bash
ip route show | grep -i default | awk '{print $3}'
```

Set it (e.g. in `~/.bashrc` or your env):

```bash
export WIN_IP=172.x.x.x   # use the IP you got above
```

## 3. Expose Chrome on Windows (port 9222)

On **Windows**, start Chrome with remote debugging so it listens on 9222:

```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

(Or use the path to your Chrome/Chromium and ensure nothing else uses 9222.)

## 4. Forward 9222 from WSL2 to Windows

On **Linux/WSL2**, run socat so that anything connecting to `localhost:9222` is forwarded to Windows Chrome:

```bash
socat TCP-LISTEN:9222,fork,reuseaddr TCP:$WIN_IP:9222
```

Keep this running (or run it in a terminal/screen/tmux). Now Linux-based scripts (or Antigravity when configured to use a CDP endpoint) can drive the Windows Chrome instance via `localhost:9222`.

## 5. Optional: persistent tunnel in ~/.bashrc

To start the tunnel when you log in (after `WIN_IP` is set):

```bash
# Add to ~/.bashrc (optional)
if [ -n "$WIN_IP" ]; then
  (socat TCP-LISTEN:9222,fork,reuseaddr TCP:${WIN_IP}:9222 &)
fi
```

Or run the socat command in a dedicated systemd user service / tmux session so it survives logouts.

## Summary

| Side    | Role |
|---------|------|
| Windows | Run Chrome with `--remote-debugging-port=9222`. |
| WSL2    | Set `WIN_IP`, run `socat TCP-LISTEN:9222,fork,reuseaddr TCP:$WIN_IP:9222`. |
| Linux   | Use `localhost:9222` as the browser automation endpoint. |

This gives you browser automation (e.g. for Antigravity QA) driven from Jeeves on Linux while the browser runs on Windows.

---

## Driving the browser from Linux (after tunnel is up)

Once something is listening on `localhost:9222` (either Chrome on the same Linux machine, or the socat tunnel to Windows Chrome), you can control it via CDP:

- **Chrome on Linux:** Start Chrome with `--remote-debugging-port=9222` (and a dedicated `--user-data-dir` if you want a clean profile). Then point your MCP or script at `http://127.0.0.1:9222`.
- **MCP option:** Use an MCP server that speaks CDP, e.g. [chrome-devtools-mcp](https://github.com/mcp/chrome-devtools-mcp) or similar, with `--browser-url=http://127.0.0.1:9222`. That lets MCP-compatible tools (or agents) drive the browser.
- **Scripts:** Any CDP client (e.g. Puppeteer, Playwright with `connectOverCDP`, or a small script using `chrome-remote-interface`) can connect to `http://127.0.0.1:9222` to drive the browser.

Jeeves does not currently start an MCP server for browser automation; the Orchestration tab’s “Open QA browser” link only appears when `antigravity serve-web` is available (antigravity-tunnel present). For the socat setup, open the browser manually (or via script) and use the tools above to drive it from Linux.
