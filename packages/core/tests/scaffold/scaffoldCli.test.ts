import { describe, expect, test } from '@jest/globals';
import { parseScaffoldCliArgs } from '../../src/scaffold/scaffoldCliArgs.js';

describe('parseScaffoldCliArgs', () => {
    test('maps flags', () => {
        const p = parseScaffoldCliArgs([
            '--name',
            'demo-agent',
            '--preset',
            'minimal',
            '-o',
            'apps/examples/demo',
            '--description',
            'hi',
            '--uses-llm',
            '--uses-tools',
            '--uses-children',
            '--uses-plans',
            '--force',
            '--no-monorepo',
        ]);
        expect(p.name).toBe('demo-agent');
        expect(p.preset).toBe('minimal');
        expect(p.outputDir).toBe('apps/examples/demo');
        expect(p.description).toBe('hi');
        expect(p.usesLlm).toBe(true);
        expect(p.usesTools).toBe(true);
        expect(p.usesChildren).toBe(true);
        expect(p.usesPlans).toBe(true);
        expect(p.force).toBe(true);
        expect(p.monorepo).toBe(false);
    });

    test('sets help on unknown flag', () => {
        const p = parseScaffoldCliArgs(['--nope']);
        expect(p.help).toBe(true);
    });
});
