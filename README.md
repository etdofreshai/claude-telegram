# claude-telegram

Small Node runner that keeps a Claude Code Telegram channel session alive with `node-pty`.

It does three main things:

- launches Claude Code with the official Telegram channel plugin
- restarts Claude if the child process exits
- checks Claude usage when a new Telegram message arrives and warns if the 5-hour or 7-day budget is exhausted

## Setup

1. Install dependencies:

```powershell
npm install
```

2. Copy [`.env.example`](./.env.example) to `.env` and fill in the values you want to override.

3. Make sure your Telegram plugin state exists under `channels/telegram/`.

4. Make sure Claude is installed and available at `CLAUDE_EXE` or on your `PATH`.
   The runner will try common Windows, macOS, and Linux install locations first, then fall back to `where.exe` or `which`.

5. Make sure Claude Code is logged in locally so `~/.claude/.credentials.json` exists if you want usage monitoring.

## Environment

Supported settings:

- `CLAUDE_EXE`: Optional Claude executable path override.
- `CLAUDE_TELEGRAM_CWD`: Working directory Claude should run in.
- `CLAUDE_RESUME_SESSION_ID`: Optional session to resume before forking.
- `TELEGRAM_BOT_TOKEN`: Telegram bot token used for plugin access and alerts.
- `TELEGRAM_ALERT_CHAT_ID`: Chat that receives rate-limit and out-of-credit warnings.
- `TELEGRAM_STATE_DIR`: Telegram plugin state directory.
- `CLAUDE_TELEGRAM_DEBUG_LOG`: Debug log path.

If `CLAUDE_EXE` is not set, the runner tries common locations such as:

- Windows: `~/.local/bin/claude.exe`, Scoop shims, and command lookup via `where.exe`
- macOS/Linux: `~/.local/bin/claude`, `/usr/local/bin/claude`, `/usr/bin/claude`, `/opt/homebrew/bin/claude`, and command lookup via `which`

The app reads config from:

- `channels/telegram/.env`
- `.env`
- process environment variables

Later sources override earlier ones.

## Usage

Run the bot:

```powershell
npm start
```

Run the usage monitor in the console:

```powershell
npm run monitor
```

You can also run it directly:

```powershell
node index.mjs
node index.mjs monitor
```

## PM2

Example PM2 start:

```powershell
pm2 start index.mjs --name claude-telegram
```

Restart:

```powershell
pm2 restart claude-telegram
```

Logs:

```powershell
pm2 logs claude-telegram
```

## Credit Warnings

On each new incoming Telegram message, the runner reads your Claude OAuth credentials from `~/.claude/.credentials.json`, calls the Anthropic OAuth usage API, and caches the result for 5 minutes in `~/.claude/.usage_cache.json`.

If either usage is at `100%`, it sends a Telegram warning message to `TELEGRAM_ALERT_CHAT_ID`. This happens per incoming message, not on a background timer.

## Notes

- `.env`, `channels/`, logs, and `node_modules/` are ignored by git.
- Usage monitoring no longer depends on `statusline.ps1`.
