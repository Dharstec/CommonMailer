const pool = require('../middleware/db');

module.exports = {
    async PostgresInsert(tableName, values) {
        const columns = Object.keys(values).join(', ');
        const placeholders = Object.keys(values).map((_, index) => `$${index + 1}`).join(', ');
        const query = `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders}) RETURNING *`;
        try {
            const result = await pool.query(query, Object.values(values));
            return result.rows[0];
        } catch (error) {
            console.error('Error during PostgresInsert:', error);
            console.error('Query:', query);
            throw error;
        }
    },

    async PostgresUpdate(tableName, values, id) {
        const setClause = Object.keys(values).map((key, index) => `${key} = $${index + 1}`).join(', ');
        const query = `UPDATE ${tableName} SET ${setClause} WHERE id = $${Object.keys(values).length + 1} RETURNING *`;
        const valuesArray = [...Object.values(values), id];
        try {
            const result = await pool.query(query, valuesArray);
            return result.rows[0];
        } catch (error) {
            console.error('Error during PostgresUpdate:', error);
            console.error('Query:', query);
            throw error;
        }
    },

    async PostgresDelete(tableName, condition, conditionValue) {
        const deleteQuery = `DELETE FROM ${tableName} WHERE ${condition} = $1`;
        try {
            await pool.query(deleteQuery, [conditionValue]);
            return true;
        } catch (error) {
            console.error('Error during delete:', error);
            throw error;
        }
    },

    async PostgresAny(query, params) {
        try {
            const result = await pool.query(query, params);
            return result.rows;
        } catch (error) {
            console.error('Query:', query);
            throw error;
        }
    },

    /**
     * Run several statements in one transaction. `work` receives a dedicated
     * client; anything it throws rolls the whole thing back. Used wherever a
     * form and its fields/templates must be saved as one unit.
     */
    async PostgresTransaction(work) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
};
