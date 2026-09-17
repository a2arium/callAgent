import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { dumpPgEnvironment } from '../src/pgEnvValidator.js';

describe('dumpPgEnvironment', () => {
    const original = process.env.MEMORY_DATABASE_URL;

    afterEach(() => {
        if (original === undefined) delete process.env.MEMORY_DATABASE_URL;
        else process.env.MEMORY_DATABASE_URL = original;
        jest.restoreAllMocks();
    });

    it('reports configuration without logging connection-string content', () => {
        process.env.MEMORY_DATABASE_URL = 'postgresql://secret-user:secret-password@db/private';
        const output: string[] = [];
        jest.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)));

        dumpPgEnvironment('test');

        expect(output.join('\n')).toContain('MEMORY_DATABASE_URL: type=string, configured=true');
        expect(output.join('\n')).not.toContain('secret-user');
        expect(output.join('\n')).not.toContain('secret-password');
        expect(output.join('\n')).not.toContain('postgresql://');
    });
});
