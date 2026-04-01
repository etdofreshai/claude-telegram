import { spawn } from "child_process";
import { appendFileSync } from "fs";

const LOG = "C:\Users\etgarcia\code\background\claude-telegram\plugin-test.log";
const log = (msg) => {
  const ts = new Date().toISOString();
  appendFileSync(LOG, `${ts} ${msg}\n`);
  console.error(msg);
};

log("Starting plugin test...");

const child = spawn("bun", ["server.ts"], {
  cwd: "C:\Users\etgarcia\.claude\plugins\cache\claude-plugins-official\telegram\0.0.4",
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    TELEGRAM_BOT_TOKEN: "8381250203:AAELZi2EGyJe54_pZjaj_w5CdpIt_FSyWZM",
  },
});

child.stdout.on("data", (d) => log(`STDOUT: ${d.toString().substring(0, 200)}`));
child.stderr.on("data", (d) => log(`STDERR: ${d.toString().substring(0, 200)}`));
child.on("exit", (code) => log(`EXIT: ${code}`));
child.on("error", (err) => log(`ERROR: ${err.message}`));

// Send MCP initialize request
setTimeout(() => {
  const init = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    },
  });
  log(`Sending: ${init}`);
  child.stdin.write(init + "\n");
}, 2000);

// Keep alive for 15 seconds
setTimeout(() => {
  log("Test complete, killing child");
  child.kill();
  process.exit(0);
}, 15000);
