// The checked-in generated files must match what the generators produce now,
// so the row types and published declarations can't drift from the source.
import { it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '../../scripts/generate-db-types.mjs';

const root = new URL('../../', import.meta.url).pathname;

it('src/db-types.ts matches the migrations (run pnpm db:types)', () => {
    assert.equal(readFileSync(join(root, 'src/db-types.ts'), 'utf8'), generate());
});

function files(dir, base = dir) {
    return readdirSync(dir).flatMap(name => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path, base) : [path.slice(base.length + 1)];
    }).sort();
}

it('types/ matches the source (run pnpm build:types)', () => {
    const out = mkdtempSync(join(tmpdir(), 'cf-affiliate-types-'));
    try {
        execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', join(root, 'tsconfig.build.json'), '--outDir', out], { cwd: root });
        assert.deepEqual(files(out), files(join(root, 'types')));
        for (const file of files(out)) {
            assert.equal(readFileSync(join(out, file), 'utf8'), readFileSync(join(root, 'types', file), 'utf8'), file);
        }
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
}, 60000);
