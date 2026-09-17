import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scaffoldAgent } from '../../src/scaffold/scaffoldAgent.js';

describe('scaffoldAgent non-trivial', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aplret-nt-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('includes flow.md, selectors, reducers, normalizers, extra tests', async () => {
        const result = await scaffoldAgent({
            name: 'nt-agent',
            preset: 'non-trivial',
            outputDir: dir,
            monorepo: false,
        });
        expect(result.filesCreated).toEqual(
            expect.arrayContaining([
                'flow.md',
                'selectors.ts',
                'reducers.ts',
                'normalizers/user.ts',
                'normalizers/internal.ts',
                'tests/resume.test.ts',
                'tests/failure.test.ts',
                'tests/invariant.test.ts',
            ])
        );
    });

    test('adds tool and child normalizers when flags set', async () => {
        const result = await scaffoldAgent({
            name: 'nt-agent',
            preset: 'non-trivial',
            outputDir: dir,
            monorepo: false,
            usesTools: true,
            usesChildren: true,
        });
        expect(result.filesCreated).toEqual(expect.arrayContaining(['normalizers/tool.ts', 'normalizers/child.ts']));
        const perceptionSrc = fs.readFileSync(path.join(dir, 'perception.ts'), 'utf8');
        expect(perceptionSrc).toContain("normalizeToolObservation");
        expect(perceptionSrc).toContain("normalizeChildObservation");
    });

    test('adds effects, prompts, and contracts placeholders based on flags', async () => {
        const result = await scaffoldAgent({
            name: 'nt-agent',
            preset: 'non-trivial',
            outputDir: dir,
            monorepo: false,
            usesLlm: true,
            usesTools: true,
        });
        expect(result.filesCreated).toEqual(
            expect.arrayContaining([
                'effects/llm/placeholder.ts',
                'prompts/placeholder.ts',
                'contracts/llm/placeholder.schema.ts',
                'effects/tools/placeholder.ts',
                'contracts/tools/placeholder.schema.ts',
            ])
        );
        const executionSrc = fs.readFileSync(path.join(dir, 'execution.ts'), 'utf8');
        const transitionSrc = fs.readFileSync(path.join(dir, 'transition.ts'), 'utf8');
        expect(executionSrc).toContain("kind: 'prompt_user'");
        expect(transitionSrc).toContain("kind: 'await_input'");
    });
});
