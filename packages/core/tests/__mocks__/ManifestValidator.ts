import { jest } from '@jest/globals';

// Manual mock for ManifestValidator
export const ManifestValidator = {
    validate: jest.fn(),
    validateManifest: jest.fn(),
    validateDependencies: jest.fn(),
    validateAgentStructure: jest.fn()
}; 