import { AgentCardSchema } from '@a2arium/callagent-types';

describe('AgentCardSchema', () => {
    it('should validate a minimal valid card', () => {
        const card = {
            name: 'test-agent',
            version: '1.0.0',
            description: 'A test agent',
            supportedInterfaces: [{
                protocolBinding: 'JSONRPC',
                protocolVersion: '1.0',
                url: 'http://localhost:8080'
            }],
            capabilities: {},
            defaultInputModes: ['text/plain'],
            defaultOutputModes: ['text/plain'],
            skills: [{
                id: 'test-agent',
                name: 'Test Agent',
                description: 'A test agent'
            }]
        };

        const result = AgentCardSchema.safeParse(card);
        expect(result.success).toBe(true);
    });

    it('should fail if required fields are missing', () => {
        const card = {
            name: 'test-agent'
        };

        const result = AgentCardSchema.safeParse(card);
        expect(result.success).toBe(false);
    });

    it('should allow extensions (not strict)', () => {
        const card = {
            name: 'test-agent',
            version: '1.0.0',
            description: 'A test agent',
            supportedInterfaces: [{
                protocolBinding: 'JSONRPC',
                protocolVersion: '1.0',
                url: 'http://localhost:8080'
            }],
            capabilities: {},
            defaultInputModes: ['text/plain'],
            defaultOutputModes: ['text/plain'],
            skills: [{
                id: 'test-agent',
                name: 'Test Agent',
                description: 'A test agent'
            }],
            customField: 'allowed'
        };

        const result = AgentCardSchema.safeParse(card);
        expect(result.success).toBe(true);
    });
});
