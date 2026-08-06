const { Pool } = require('pg');

/**
 * The connection pool.
 *
 * Deliberately does NOT connect on require. helpers/bootstrap.js has to create
 * the database before anything opens a connection to it, and requiring this file
 * used to fire a connection test immediately — which fails on a fresh machine
 * where the database does not exist yet. `pg` connects lazily on first query,
 * so building the Pool object here is free.
 */
const pool = new Pool({
    host: process.env.POSTGRESQL_HOST,
    user: process.env.POSTGRESQL_USER,
    database: process.env.POSTGRESQL_DATABASE,
    password: process.env.POSTGRESQL_PASSWORD,
    port: parseInt(process.env.POSTGRESQL_PORT, 10),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

// A pooled client can die between queries (network blip, Postgres restart).
// Without a listener, `pg` emits an unhandled 'error' and takes the process
// down; pm2 would restart it, but a dropped idle connection is not worth a
// restart.
pool.on('error', (err) => {
    console.error('⚠️  Idle database client error:', err.message);
});

module.exports = pool;
