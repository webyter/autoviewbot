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
  ],
};
