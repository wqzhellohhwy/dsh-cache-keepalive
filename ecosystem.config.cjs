const path = require('path');

module.exports = {
  apps: [
    {
      name: 'keepalive',
      script: path.join(__dirname, 'cli', 'keepalive.mjs'),
      cwd: __dirname,
      interpreter: 'node',
      args: ['--serve', '--open'],
      autorestart: true,
      max_restarts: 10,
    },
  ],
};