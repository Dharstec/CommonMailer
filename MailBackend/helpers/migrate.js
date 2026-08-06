/**
 * Automatic DB migrations, applied at server boot (called from app.js).
 *
 * Every schema/data change lives as a numbered .sql file in migrations/ and is
 * applied exactly once per database, in filename order, inside a transaction.
 * Applied files are recorded in schema_migrations, so any server that receives
 * new code brings its own database up to date on restart — code and schema can
 * no longer drift apart across environments.
 *
 * Rules for new migrations:
 *  - never edit an applied file; add a new numbered file instead
 *  - write idempotent SQL (IF NOT EXISTS / WHERE-guarded UPDATEs) so a database
 *    that was already fixed manually records the migration as a no-op
 */
const fs = require('fs');
const path = require('path');
const pool = require('../middleware/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function runMigrations() {
    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    if (files.length === 0) return;

    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            name text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
        )`);
        // Serialize concurrent boots (e.g. pm2 cluster) on an advisory lock.
        await client.query(`SELECT pg_advisory_lock(918273)`);

        const done = new Set(
            (await client.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name)
        );

        for (const file of files) {
            if (done.has(file)) continue;
            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
            console.log(`⏳ migration ${file} ...`);
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
                await client.query('COMMIT');
                console.log(`✅ migration ${file} applied`);
            } catch (err) {
                await client.query('ROLLBACK');
                throw new Error(`migration ${file} failed: ${err.message}`);
            }
        }
    } finally {
        await client.query(`SELECT pg_advisory_unlock(918273)`).catch(() => {});
        client.release();
    }
}

module.exports = { runMigrations };
