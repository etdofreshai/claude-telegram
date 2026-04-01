import { appendFileSync, existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import pty from "node-pty";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const env = {};
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[match[1]] = value;
  }

  return env;
}

const fileEnv = {
  ...parseEnvFile(join(SCRIPT_DIR, "channels", "telegram", ".env")),
  ...parseEnvFile(join(SCRIPT_DIR, ".env")),
};

const env = {
  ...fileEnv,
  ...process.env,
};

const CLAUDE_EXE = env.CLAUDE_EXE || "claude";
const CWD = env.CLAUDE_TELEGRAM_CWD || "C:\\Users\\etgarcia\\code\\workspace";
const CLAUDE_RESUME_SESSION_ID = env.CLAUDE_RESUME_SESSION_ID || "";
const DEBUG_LOG = env.CLAUDE_TELEGRAM_DEBUG_LOG || join(SCRIPT_DIR, "debug.log");
const STATUSLINE_PS1 = env.STATUSLINE_PS1 || join(homedir(), ".claude", "statusline.ps1");
const TELEGRAM_ALERT_CHAT_ID = env.TELEGRAM_ALERT_CHAT_ID || "";
const TELEGRAM_STATE_DIR = env.TELEGRAM_STATE_DIR || join(SCRIPT_DIR, "channels", "telegram");
const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN || "";

const CLAUDE_MONITOR_INTERVAL_MS = 10000;
const RATE_LIMIT_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const RESTART_DELAY_MS = 10000;

const childEnv = {
  ...process.env,
  ...fileEnv,
  TELEGRAM_STATE_DIR,
  TELEGRAM_BOT_TOKEN,
};

let claude = null;
let restartTimer = null;
let recentOutput = "";
let recentPlainOutput = "";
let lastRateLimitAlertAt = 0;
let claudeMonitorTimer = null;
let monitorTimer = null;
let lastInboundSignature = "";

function logDebug(data) {
  try {
    appendFileSync(DEBUG_LOG, data);
  } catch {
    // Debug logging is best-effort only.
  }
}

function stripAnsi(text) {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function looksLikeRateLimit(text) {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("retry after") ||
    normalized.includes("request limit") ||
    normalized.includes("rate-limited")
  );
}

async function sendTelegramAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ALERT_CHAT_ID) {
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_ALERT_CHAT_ID,
        text,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Telegram alert failed (${res.status}): ${body}`);
    }
  } catch (err) {
    console.error(`Telegram alert error: ${err}`);
  }
}

function trackOutputForRateLimit(data) {
  recentOutput = (recentOutput + stripAnsi(data)).slice(-4000);
  if (!looksLikeRateLimit(recentOutput)) {
    return;
  }

  const now = Date.now();
  if (now - lastRateLimitAlertAt < RATE_LIMIT_ALERT_COOLDOWN_MS) {
    return;
  }

  lastRateLimitAlertAt = now;
  const excerpt = recentOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6)
    .join("\n")
    .slice(0, 1200);

  void sendTelegramAlert(
    `claude-telegram detected a Claude rate-limit issue and may be delayed.\n\n${excerpt}`
  );
}

function scheduleRestart(reason) {
  if (restartTimer) {
    return;
  }

  console.log(`${reason}, restarting in ${RESTART_DELAY_MS / 1000}s...`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startClaude();
  }, RESTART_DELAY_MS);
}

function startClaude() {
  if (claude) {
    return;
  }

  console.log("Starting Claude in node-pty");
  const args = ["--dangerously-skip-permissions"];

  if (CLAUDE_RESUME_SESSION_ID) {
    args.push("--resume", CLAUDE_RESUME_SESSION_ID, "--fork-session");
  }

  args.push("--channels", "plugin:telegram@claude-plugins-official");

  claude = pty.spawn(CLAUDE_EXE, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: CWD,
    env: childEnv,
    useConpty: true,
  });

  claude.onData((data) => {
    logDebug(data);
    trackOutputForRateLimit(data);
    trackIncomingTelegramRequests(data);
  });

  claude.onExit(({ exitCode, signal }) => {
    claude = null;
    scheduleRestart(`Claude exited (code=${exitCode}, signal=${signal})`);
  });
}

function monitorClaude() {
  if (!claude) {
    scheduleRestart("Claude PTY is not running");
  }
}

function getUsageStatus() {
  const payload = JSON.stringify({
    model: { id: "claude-telegram" },
    context_window: { used_percentage: 0 },
  });

  const output = execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      STATUSLINE_PS1,
    ],
    {
      input: payload,
      encoding: "utf8",
      env: childEnv,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }
  ).trim();

  const plain = stripAnsi(output);
  const fiveHourMatch = plain.match(/(\d+)%\s+5h/);
  const sevenDayMatch = plain.match(/(\d+)%\s+7d/);

  return {
    raw: output,
    plain,
    fiveHour: fiveHourMatch ? Number(fiveHourMatch[1]) : null,
    sevenDay: sevenDayMatch ? Number(sevenDayMatch[1]) : null,
  };
}

function maybeAlertCredit(percent, label) {
  if (percent === null || percent < 100) {
    return;
  }

  const message = `claude-telegram is out of Claude tokens for the ${label} period.`;
  console.error(message);
  void sendTelegramAlert(message);
}

function checkUsage({ print = false, sendAlerts = false } = {}) {
  try {
    const status = getUsageStatus();

    if (print) {
      console.log(status.raw);
    }

    if (sendAlerts) {
      maybeAlertCredit(status.fiveHour, "5-hour");
      maybeAlertCredit(status.sevenDay, "7-day");
    }

    return status;
  } catch (err) {
    const message = `Usage monitor failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(message);
    return null;
  }
}

function trackIncomingTelegramRequests(data) {
  recentPlainOutput = (recentPlainOutput + stripAnsi(data)).slice(-8000);
  const matches = [
    ...recentPlainOutput.matchAll(/telegram\s+(?:·|Â·)\s+([^:\r\n]+):\s*([^\r\n]+)/g),
  ];
  if (matches.length === 0) {
    return;
  }

  const lastMatch = matches[matches.length - 1];
  const sender = lastMatch[1].trim();
  const message = lastMatch[2].trim();
  if (!sender || !message) {
    return;
  }

  const signature = `${sender}:${message}`;
  if (signature === lastInboundSignature) {
    return;
  }

  lastInboundSignature = signature;
  checkUsage({ sendAlerts: true });
}

function shutdown() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  if (claudeMonitorTimer) {
    clearInterval(claudeMonitorTimer);
    claudeMonitorTimer = null;
  }

  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }

  if (claude) {
    try {
      claude.kill();
    } catch {
      // Ignore shutdown races.
    }
    claude = null;
  }

  process.exit(0);
}

function runMonitorMode() {
  console.log("Monitoring Claude usage via statusline.ps1...");
  checkUsage({ print: true });
  monitorTimer = setInterval(() => {
    checkUsage({ print: true });
  }, 60000);
}

function runBotMode() {
  startClaude();
  claudeMonitorTimer = setInterval(monitorClaude, CLAUDE_MONITOR_INTERVAL_MS);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (process.argv[2] === "monitor") {
  runMonitorMode();
} else {
  runBotMode();
}
