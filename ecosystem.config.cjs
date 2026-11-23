module.exports = {
  apps: [
    {
      name: 'autoviewer',
      script: '/home/ubuntu/autoviewbot/autoviewer.js',
      cwd: '/home/ubuntu/autoviewbot',
      node_args: '--max-old-space-size=300',
      max_memory_restart: '450M',
      env: {
        PORT: '3000',
        NODE_ENV: 'production',
        DOTENV_QUIET: 'true',
      },
    },
    {
      name: 'halcyon-worker',
      script: '/home/ubuntu/autoviewbot/halcyon-worker/server.mjs',
      cwd: '/home/ubuntu/autoviewbot/halcyon-worker',
      node_args: '--disable-warning=ExperimentalWarning --env-file=.env',
      autorestart: true,
      max_memory_restart: '200M',
    },
  ],
};
