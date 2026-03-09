const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const configPath = join(__dirname, "accounts.json");

if (!existsSync(configPath)) {
  console.error("❌ accounts.json not found. Copy from accounts.json.example");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(configPath, "utf8"));

// Deduplicate: if same name appears multiple times, keep the latest (by updatedAt)
const map = new Map();

for (const acc of raw) {
  const existing = map.get(acc.name);

  if (!existing || (acc.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
    map.set(acc.name, acc);
  }
}

const accounts = Array.from(map.values());

module.exports = {
  apps: accounts.map((acc) => ({
    name: acc.name,
    script: "dist/market-maker.mjs",
    args: `--account-name=${acc.name}`,
    cwd: __dirname,
    env_file: ".env",
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    watch: false,
    max_memory_restart: "200M",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: `logs/${acc.name}-error.log`,
    out_file: `logs/${acc.name}-out.log`,
    merge_logs: true,
  })),
};
