// pm2 config for the WhatsApp Connector API.
// IMPORTANT: exactly ONE instance per INSTANCE_ID, fork mode (never cluster mode).
// Each WhatsApp number is a live socket leased to one process; cluster mode would make
// several processes fight over the same numbers and get them logged out ("replaced").
module.exports = {
  apps: [
    {
      name: 'whatsapp-connector-api',
      cwd: __dirname + '/../backend',
      script: 'src/main.js',
      exec_mode: 'fork',
      instances: 1,
      node_args: '--max-old-space-size=3072',
      env: { NODE_ENV: 'production', INSTANCE_ID: 'wa-api-1' },
      // Graceful stop: main.js closes sockets (keeps links) and releases leases on SIGTERM.
      kill_timeout: 15000,
      max_memory_restart: '3500M',
      time: true,
    },
  ],
};
