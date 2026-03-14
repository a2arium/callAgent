import { AgentRuntimeManifestSchema } from '@a2arium/callagent-types';

describe('AgentRuntimeManifestSchema', () => {
    it('should validate a minimal valid runtime manifest', () => {
        const runtime = {
            name: 'test-agent',
            version: '1.0.0',
            runMode: 'loop'
        };

        const result = AgentRuntimeManifestSchema.safeParse(runtime);
        expect(result.success).toBe(true);
    });

    it('should fail if required fields are missing', () => {
        const runtime = {
            name: 'test-agent'
        };

        const result = AgentRuntimeManifestSchema.safeParse(runtime);
        expect(result.success).toBe(false);
    });

    it('should be strict (disallow extensions)', () => {
        const runtime = {
            name: 'test-agent',
            version: '1.0.0',
            runMode: 'loop',
            customField: 'disallowed'
        };

        const result = AgentRuntimeManifestSchema.safeParse(runtime);
        expect(result.success).toBe(false);
    });

    it('should validate budgets', () => {
        const runtime = {
            name: 'test-agent',
            version: '1.0.0',
            runMode: 'loop',
            budgets: {
                maxTurns: 10,
                latencyMs: 5000
            }
        };

        const result = AgentRuntimeManifestSchema.safeParse(runtime);
        expect(result.success).toBe(true);
    });
});
