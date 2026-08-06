/**
 * pm2 process definition. Used by deploy/deploy-backend.sh.
 *
 * Single instance on purpose: `pg` pools per process, and one node process
 * handles contact-form traffic for far more than 10 static sites. Cluster mode
 * would multiply idle DB connections for no benefit.
 */
module.exports = {
    apps: [{
        name: 'commonmailer',
        script: 'app.js',
        cwd: __dirname,
        instances: 1,
        exec_mode: 'fork',

        // The app reads .env itself via dotenv, so pm2 does not duplicate it —
        // there is one place the config lives.
        env: { NODE_ENV: 'production' },

        max_memory_restart: '400M',
        autorestart: true,

        // A crash loop means a real problem (bad .env, database unreachable).
        // Backing off stops pm2 hammering a dead Postgres, and min_uptime makes
        // "started then died" count as a failure rather than a success.
        min_uptime: '20s',
        max_restarts: 10,
        restart_delay: 4000,

        error_file: 'logs/pm2-error.log',
        out_file: 'logs/pm2-out.log',
        merge_logs: true,
        time: true
    }]
};
