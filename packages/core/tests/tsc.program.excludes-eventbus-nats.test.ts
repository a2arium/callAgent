import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

describe('callagent-core TypeScript program graph', () => {
    it('does not pull @a2arium/callagent-eventbus-nats sources into the core compilation', () => {
        const tscBin = require.resolve('typescript/bin/tsc');
        const out = execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.json', '--listFilesOnly'], {
            cwd: coreDir,
            encoding: 'utf8',
        });
        const lines = out.split(/\r?\n/).filter(Boolean);
        const fromNats = lines.filter((f) => f.includes(`${path.sep}eventbus-nats${path.sep}`));
        expect(fromNats).toEqual([]);
    });
});
