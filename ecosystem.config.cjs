// PM2 config — for running the server persistently on your own machine or VPS.
//
// Local (laptop stays on):
//   npm install -g pm2
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup        # auto-launch on boot
//
// Prevents your Mac from sleeping while plugged in:
//   caffeinate -dims &
//
// Logs: pm2 logs hedge-fund-os
// Restart: pm2 restart hedge-fund-os

module.exports = {
  apps: [
    {
      name: 'hedge-fund-os',
      script: 'server/dist/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '.claude/logs/pm2-error.log',
      out_file: '.claude/logs/pm2-out.log',
      time: true,
    },
  ],
}
