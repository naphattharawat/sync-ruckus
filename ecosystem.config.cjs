module.exports = {
  apps: [{
    name: 'ruckus-wifi-location',
    cwd: __dirname,
    script: './src/cli.mjs',
    args: 'worker',
    interpreter: 'node',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    min_uptime: '10s',
    max_restarts: 10,
  }],
};
