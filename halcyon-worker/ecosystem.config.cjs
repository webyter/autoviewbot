module.exports = { apps: [{ name: 'halcyon-worker', cwd: __dirname, script: 'server.mjs', node_args: '--disable-warning=ExperimentalWarning --env-file=.env', autorestart: true }] };
