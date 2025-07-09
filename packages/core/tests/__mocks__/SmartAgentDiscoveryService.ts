// Manual mock for SmartAgentDiscoveryService
export const SmartAgentDiscoveryService = {
    findAgent: jest.fn(),
    findManifest: jest.fn(),
    validateAgentStructure: jest.fn(),
    listAvailableAgents: jest.fn(),
    registerAgent: jest.fn(),
    hasRegisteredAgent: jest.fn(),
    clearCache: jest.fn(),
    generateFilenamePatterns: jest.fn(),
    findInWorkspaces: jest.fn(),
    smartFilesystemScan: jest.fn()
}; 