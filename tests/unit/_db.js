import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Execute the handlers' actual SQL, including transactional D1 batches.
export function database() {
    const sql = new DatabaseSync(':memory:');
    sql.exec(readFileSync(new URL('../../migrations/0001_affiliates.sql', import.meta.url), 'utf8'));
    const DB = {
        prepare(query) {
            const stmt = sql.prepare(query);
            let args = [];
            const execute = () => {
                const results = stmt.all(...args);
                const meta = sql.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get();
                return { results, meta, success: true };
            };
            const wrapper = {
                bind(...values) { args = values; return wrapper; },
                async first() { return stmt.get(...args) || null; },
                async all() { return execute(); },
                async run() { return execute(); },
                execute,
            };
            return wrapper;
        },
        async batch(statements) {
            sql.exec('BEGIN');
            try {
                const results = statements.map((stmt) => stmt.execute());
                sql.exec('COMMIT');
                return results;
            } catch (err) {
                sql.exec('ROLLBACK');
                throw err;
            }
        },
    };
    return { sql, DB };
}

export function context(env, path, body) {
    return { env, request: new Request(`https://shop.example${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) };
}
