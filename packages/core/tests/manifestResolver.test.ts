import { jest } from '@jest/globals';

const mockCard = {
    name: 'test-agent',
    version: '1.0.0',
    description: 'test',
    supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'http://localhost' }],
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'test-agent', name: 'Test Agent', description: 'Test agent skill' }]
};

const mockRuntime = {
    name: 'test-agent',
    version: '1.0.0',
    runMode: 'loop' as const
};

// Use unstable_mockModule for ESM mocking of built-ins
// Variables used in the factory must be prefixed with 'mock'
const mockReadFile = jest.fn<any>();
jest.unstable_mockModule('node:fs/promises', () => ({
    readFile: mockReadFile,
    default: {
        readFile: mockReadFile
    }
}));

// Import after mocking - using dynamic imports for ESM mock compatibility
const fs = await import('node:fs/promises');
const { resolveManifests } = await import('../src/plugin/manifestResolver.js');

describe('manifestResolver', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should resolve inline manifests', async () => {
        const resolved = await resolveManifests('/test', {
            agentCard: { inline: mockCard as any },
            runtimeManifest: { inline: mockRuntime as any }
        });

        expect(resolved.agentCard).toEqual(mockCard);
        expect(resolved.runtimeManifest).toEqual(mockRuntime);
        expect(resolved.agentCardSource).toBe('inline');
    });

    it('should throw error if identity mismatch', async () => {
        const mismatchedRuntime = { ...mockRuntime, name: 'other-agent' };
        
        await expect(resolveManifests('/test', {
            agentCard: { inline: mockCard as any },
            runtimeManifest: { inline: mismatchedRuntime as any }
        })).rejects.toThrow(/Manifest identity mismatch/);
    });

    it('should resolve from path', async () => {
        const readFileMock = fs.readFile as jest.MockedFunction<any>;
        readFileMock.mockResolvedValue(JSON.stringify(mockCard));
        
        const resolved = await resolveManifests('/test', {
            agentCard: { path: 'custom-card.json' },
            runtimeManifest: { inline: mockRuntime as any }
        });

        expect(readFileMock).toHaveBeenCalledWith(expect.stringContaining('custom-card.json'), 'utf8');
        expect(resolved.agentCard).toEqual(mockCard);
        expect(resolved.agentCardSource).toBe('pathOverride');
    });
});
