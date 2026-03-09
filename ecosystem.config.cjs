module.exports = {
  apps: [
    {
      name: "market-maker",
      script: "dist/market-maker.mjs",
      cwd: __dirname,
      env_file: ".env",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      max_memory_restart: "200M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      merge_logs: true,
    },
  ],
};
