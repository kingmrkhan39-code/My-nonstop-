module.exports = {
  apps: [
    {
      name: "mister-khan-suite",
      script: "./Fetch.js",
      cwd: __dirname,

      // 🔥 KEEP ALIVE SETTINGS
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "600M",
      min_uptime: "20s",
      max_restarts: 999999,
      restart_delay: 3000,
      exp_backoff_restart_delay: 200,

      // 🔥 CRASH RECOVERY
      kill_timeout: 10000,
      listen_timeout: 10000,
      shutdown_with_message: true,
      wait_ready: false,

      // 🔥 ENVIRONMENT
      env: {
        NODE_ENV: "production",
        PORT: 30118,
        UV_THREADPOOL_SIZE: 8
      },
      env_development: {
        NODE_ENV: "development",
        PORT: 30118
      },

      // 🔥 LOGS
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      log_file: "./logs/pm2-combined.log",
      time: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,

      // 🔥 NODE ARGS (memory optimization)
      node_args: [
        "--max-old-space-size=512",
        "--max-semi-space-size=64",
        "--optimize-for-size"
      ],

      // 🔥 GRACEFUL RELOAD
      instance_var: "INSTANCE_ID",

      // 🔥 WATCH IGNORE
      ignore_watch: [
        "node_modules",
        "logs",
        "temp",
        "tasks",
        "data",
        "uploads",
        "sessions_backup",
        "*.log",
        "public"
      ],

      // 🔥 DAILY FRESH RESTART (4 AM) — memory leak avoid
      cron_restart: "0 4 * * *",

      combine_logs: true,
      source_map_support: false
    }
  ]
};
