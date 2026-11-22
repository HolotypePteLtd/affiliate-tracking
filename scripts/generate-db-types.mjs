// Writes src/db-types.ts from the SQL migrations, so the row types always
// match the schema. Run after adding a migration:  pnpm db:types
// tests/unit/db-types.test.js fails if the file is out of date.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

export function generate() {
    const sql = new DatabaseSync(':memory:');
    const dir = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(name, dir), 'utf8'));
    const tables = sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const pascal = name => name.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
    const tsType = declared => {
        const t = String(declared).toUpperCase();
        if (t.includes('INT') || t.includes('REAL') || t.includes('NUM')) return 'number';
        return 'string';
    };
    let out = '// Generated from migrations/*.sql by scripts/generate-db-types.mjs. Do not edit.\n';
    for (const { name } of tables) {
        out += `\nexport interface ${pascal(name)}Row {\n`;
        for (const col of sql.prepare(`PRAGMA table_info(${name})`).all()) {
            const nullable = !col.notnull && !col.pk;
            out += `    ${col.name}: ${tsType(col.type)}${nullable ? ' | null' : ''};\n`;
        }
        out += '}\n';
    }
    sql.close();
    return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    writeFileSync(new URL('../src/db-types.ts', import.meta.url), generate());
}
