import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
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

const CLAUDE_DIR = join(homedir(), ".claude");
const CLAUDE_EXE = env.CLAUDE_EXE || "claude";
const CWD = env.CLAUDE_TELEGRAM_CWD || "C:\\Users\\etgarcia\\code\\workspace";
const CLAUDE_RESUME_SESSION_ID = env.CLAUDE_RESUME_SESSION_ID || "";
const DEBUG_LOG = env.CLAUDE_TELEGRAM_DEBUG_LOG || join(SCRIPT_DIR, "debug.log");
const TELEGRAM_ALERT_CHAT_ID = env.TELEGRAM_ALERT_CHAT_ID || "";
const TELEGRAM_STATE_DIR = env.TELEGRAM_STATE_DIR || join(SCRIPT_DIR, "channels", "telegram");
const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN || "";
const CLAUDE_CREDENTIALS_FILE = join(CLAUDE_DIR, ".credentials.json");
const USAGE_CACHE_FILE = join(CLAUDE_DIR, ".usage_cache.json");
const USAGE_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

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
let usageRequestPromise = null;

const ANSI = {
  bold: "\u001b[1m",
  orange: "\u001b[38;5;208m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  magenta: "\u001b[35m",
  red: "\u001b[31m",
  reset: "\u001b[0m",
};

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

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function getUsageColor(percent) {
  if (percent < 50) {
    return ANSI.green;
  }

  if (percent < 75) {
    return ANSI.yellow;
  }

  return ANSI.red;
}

function getGitBranch() {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: SCRIPT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch || "no-git";
  } catch {
    return "no-git";
  }
}

function getCachedUsage() {
  const cached = readJsonFile(USAGE_CACHE_FILE);
  if (!cached?.timestamp) {
    return null;
  }

  const cachedAt = Date.parse(cached.timestamp);
  if (Number.isNaN(cachedAt)) {
    return null;
  }

  if (Date.now() - cachedAt >= USAGE_CACHE_MAX_AGE_MS) {
    return null;
  }

  return cached;
}

function writeUsageCache(usage) {
  const cacheData = {
    timestamp: new Date().toISOString(),
    five_hour: usage?.five_hour ?? null,
    seven_day: usage?.seven_day ?? null,
  };

  try {
    writeFileSync(USAGE_CACHE_FILE, JSON.stringify(cacheData, null, 2));
  } catch {
    // Cache writes are best-effort only.
  }
}

async function fetchClaudeUsage() {
  const cached = getCachedUsage();
  if (cached) {
    return cached;
  }

  const credentials = readJsonFile(CLAUDE_CREDENTIALS_FILE);
  const token = credentials?.claudeAiOauth?.accessToken;
  if (!token || !token.startsWith("sk-ant-oat")) {
    return null;
  }

  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    if (!response.ok) {
      return null;
    }

    const usage = await response.json();
    writeUsageCache(usage);
    return getCachedUsage();
  } catch {
    return null;
  }
}

async function getClaudeUsage() {
  const cached = getCachedUsage();
  if (cached) {
    return cached;
  }

  if (!usageRequestPromise) {
    usageRequestPromise = fetchClaudeUsage().finally(() => {
      usageRequestPromise = null;
    });
  }

  return usageRequestPromise;
}

function buildStatusLine({ modelId, contextUsed = 0, usage }) {
  const contextPercent = Math.round(contextUsed);
  const fiveHourPercent =
    usage?.five_hour?.utilization != null ? Math.round(usage.five_hour.utilization) : null;
  const sevenDayPercent =
    usage?.seven_day?.utilization != null ? Math.round(usage.seven_day.utilization) : null;

  let status = `${ANSI.bold}${ANSI.orange}[${modelId}]${ANSI.reset} ${ANSI.magenta}${getGitBranch()}${ANSI.reset}`;
  status += ` | ${getUsageColor(contextPercent)}${contextPercent}% ctx${ANSI.reset}`;

  if (fiveHourPercent !== null) {
    status += ` | ${getUsageColor(fiveHourPercent)}${fiveHourPercent}% 5h${ANSI.reset}`;
  }

  if (sevenDayPercent !== null) {
    status += ` | ${getUsageColor(sevenDayPercent)}${sevenDayPercent}% 7d${ANSI.reset}`;
  }

  return status;
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

async function getUsageStatus() {
  const usage = await getClaudeUsage();
  const raw = buildStatusLine({
    modelId: "claude-telegram",
    contextUsed: 0,
    usage,
  });

  return {
    raw,
    plain: stripAnsi(raw),
    fiveHour: usage?.five_hour?.utilization != null ? Math.round(usage.five_hour.utilization) : null,
    sevenDay: usage?.seven_day?.utilization != null ? Math.round(usage.seven_day.utilization) : null,
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

async function checkUsage({ print = false, sendAlerts = false } = {}) {
  try {
    const status = await getUsageStatus();

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
  void checkUsage({ sendAlerts: true });
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
  console.log("Monitoring Claude usage via native Node API check...");
  void checkUsage({ print: true });
  monitorTimer = setInterval(() => {
    void checkUsage({ print: true });
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
