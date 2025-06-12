import { ManifestValidator, ValidationResult } from '../src/core/plugin/ManifestValidator.js';
import { AgentManifest } from '@callagent/types';

describe('ManifestValidator', () => {
    describe('validate', () => {
        it('should validate a minimal valid manifest', () => {
            const manifest: AgentManifest = {
                name: 'test-agent',
                version: '1.0.0'
            };

            const result = ManifestValidator.validate(manifest);

            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
            // Should warn about missing description
            expect(result.warnings).toContain('Agent description is recommended for better discoverability');
        });

        it('should validate a complete manifest with dependencies', () => {
            const manifest: AgentManifest = {
                name: 'coordinator-agent',
                version: '1.0.0',
                description: 'Test coordinator agent',
                dependencies: {
                    agents: ['data-analysis-agent', 'reporting-agent']
                },
                memory: {
                    profile: 'conversational'
                },
                a2a: {
                    maxConcurrentCalls: 5,
                    defaultTimeout: 30000,
                    allowedTargets: ['*'],
                    memoryInheritance: {
                        working: true,
                        semantic: false,
                        episodic: true
                    }
                }
            };

            const result = ManifestValidator.validate(manifest);

            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(result.warnings).toHaveLength(0);
        });

        it('should reject invalid manifest structure', () => {
            const invalidManifest = null;

            const result = ManifestValidator.validate(invalidManifest);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Invalid manifest structure: must be an object with name and version fields');
        });

        it('should reject manifest missing required fields', () => {
            const manifest = {
                name: 'test-agent'
                // missing version
            };

            const result = ManifestValidator.validate(manifest);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Invalid manifest structure: must be an object with name and version fields');
        });
    });

    describe('validateBasicFields', () => {
        it('should validate proper name and version', () => {
            const manifest: AgentManifest = {
                name: 'my-agent',
                version: '1.2.3',
                description: 'Test agent'
            };

            const result = ManifestValidator.validateBasicFields(manifest);

            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(result.warnings).toHaveLength(0);
        });

        it('should warn about uppercase names', () => {
            const manifest: AgentManifest = {
                name: 'MyAgent',
                version: '1.0.0'
            };

            const result = ManifestValidator.validateBasicFields(manifest);

            expect(result.isValid).toBe(true);
            expect(result.warnings).toContain('Agent name should be lowercase for consistency');
        });

        it('should warn about invalid name characters', () => {
            const manifest: AgentManifest = {
                name: 'my@agent',
                version: '1.0.0'
            };

            const result = ManifestValidator.validateBasicFields(manifest);

            expect(result.isValid).toBe(true);
            expect(result.warnings).toContain('Agent name should only contain lowercase letters, numbers, hyphens, and underscores');
        });

        it('should warn about non-semver versions', () => {
            const manifest: AgentManifest = {
                name: 'my-agent',
                version: '1.0'
            };

            const result = ManifestValidator.validateBasicFields(manifest);

            expect(result.isValid).toBe(true);
            expect(result.warnings).toContain('Agent version should follow semver format (e.g., "1.0.0")');
        });

        it('should error on empty required fields', () => {
            const manifest: AgentManifest = {
                name: '',
                version: '1.0.0'
            };

            const result = ManifestValidator.validateBasicFields(manifest);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Agent name is required and cannot be empty');
        });
    });

    describe('validateMemoryProfile', () => {
        it('should accept valid memory profiles', () => {
            const validProfiles = ['basic', 'conversational', 'analytical', 'advanced', 'custom'];

            for (const profile of validProfiles) {
                const result = ManifestValidator.validateMemoryProfile(profile);
                expect(result.isValid).toBe(true);
                expect(result.errors).toHaveLength(0);
                expect(result.warnings).toHaveLength(0);
            }
        });

        it('should warn about unknown memory profiles', () => {
            const result = ManifestValidator.validateMemoryProfile('unknown-profile');

            expect(result.isValid).toBe(true);
            expect(result.warnings).toContain("Unknown memory profile 'unknown-profile'. Known profiles: basic, conversational, analytical, advanced, custom");
        });

        it('should error on non-string profiles', () => {
            const result = ManifestValidator.validateMemoryProfile(123);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Memory profile must be a string');
        });
    });

    describe('validateDependencies', () => {
        it('should validate valid dependencies', () => {
            const dependencies = ['agent-one', 'agent-two', 'data-processor'];

            const result = ManifestValidator.validateDependencies(dependencies);

            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(result.warnings).toHaveLength(0);
        });

        it('should warn about empty dependencies array', () => {
            const result = ManifestValidator.validateDependencies([]);

            expect(result.isValid).toBe(true);
            expect(result.warnings).toContain('Dependencies array is empty, consider removing the dependencies field');
        });

        it('should error on non-array dependencies', () => {
            const result = ManifestValidator.validateDependencies('not-an-array');

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Dependencies must be an array of agent names');
        });

        it('should error on non-string dependencies', () => {
            const dependencies = ['valid-agent', 123, 'another-agent'];

            const result = ManifestValidator.validateDependencies(dependencies);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Dependency at index 1 must be a string (agent name)');
        });

        it('should error on empty dependency names', () => {
            const dependencies = ['valid-agent', '', 'another-agent'];

            const result = ManifestValidator.validateDependencies(dependencies);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Dependency at index 1 cannot be empty');
        });

        it('should warn about duplicate dependencies', () => {
            const dependencies = ['agent-one', 'agent-two', 'agent-one'];

            const result = ManifestValidator.validateDependencies(dependencies);

            expect(result.isValid).toBe(true);
            expect(result.warnings).toContain('Duplicate dependencies found, consider removing duplicates');
        });

        it('should error on self-reference', () => {
            const dependencies = ['agent-one', 'self'];

            const result = ManifestValidator.validateDependencies(dependencies);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Agent cannot depend on itself');
        });

        it('should error on camelCase dependency names', () => {
            const dependencies = ['agent-one', 'imageSummary', 'another-agent'];

            const result = ManifestValidator.validateDependencies(dependencies);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain("Dependency 'imageSummary' must be lowercase for consistency. Use 'imagesummary' instead.");
        });

        it('should error on dependency names with invalid characters', () => {
            const dependencies = ['agent-one', 'image@summary', 'another-agent'];

            const result = ManifestValidator.validateDependencies(dependencies);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain("Dependency 'image@summary' must only contain lowercase letters, numbers, hyphens, and underscores");
        });

        it('should validate category-based dependency names', () => {
            const dependencies = ['data-processing/csv-parser', 'business-logic/data-analyzer', 'utils/logger'];

            const result = ManifestValidator.validateDependencies(dependencies);

            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(result.warnings).toHaveLength(0);
        });

        it('should error on invalid category-based dependency names', () => {
            const dependencies = ['data-processing/csv@parser', 'business-logic/', '/data-analyzer'];

            const result = ManifestValidator.validateDependencies(dependencies);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain("Dependency 'data-processing/csv@parser': Agent name should only contain lowercase letters, numbers, hyphens, and underscores");
            expect(result.errors).toContain("Dependency 'business-logic/': Agent name cannot be empty");
            expect(result.errors).toContain("Dependency '/data-analyzer': Category name cannot be empty");
        });
    });

    describe('validateA2AConfig', () => {
        it('should validate valid A2A configuration', () => {
            const a2aConfig = {
                maxConcurrentCalls: 5,
                defaultTimeout: 30000,
                allowedTargets: ['agent-one', 'agent-two'],
                memoryInheritance: {
                    working: true,
                    semantic: false,
                    episodic: true
                }
            };

            const result = ManifestValidator.validateA2AConfig(a2aConfig);

            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(result.warnings).toHaveLength(0);
        });

        it('should error on invalid maxConcurrentCalls', () => {
            const a2aConfig = { maxConcurrentCalls: -1 };

            const result = ManifestValidator.validateA2AConfig(a2aConfig);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('maxConcurrentCalls must be a positive number');
        });

        it('should warn about very high maxConcurrentCalls', () => {
            const a2aConfig = { maxConcurrentCalls: 150 };

            const result = ManifestValidator.validateA2AConfig(a2aConfig);

            expect(result.isValid).toBe(true);
            expect(result.warnings).toContain('maxConcurrentCalls is very high, consider if this is intentional');
        });

        it('should error on invalid defaultTimeout', () => {
            const a2aConfig = { defaultTimeout: 500 };

            const result = ManifestValidator.validateA2AConfig(a2aConfig);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('defaultTimeout must be a number >= 1000 (milliseconds)');
        });

        it('should error on invalid allowedTargets', () => {
            const a2aConfig = { allowedTargets: 'not-an-array' };

            const result = ManifestValidator.validateA2AConfig(a2aConfig);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('allowedTargets must be an array of strings');
        });

        it('should error on invalid memoryInheritance values', () => {
            const a2aConfig = {
                memoryInheritance: {
                    working: 'not-boolean',
                    semantic: true
                }
            };

            const result = ManifestValidator.validateA2AConfig(a2aConfig);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain("Memory inheritance 'working' must be a boolean");
        });
    });
}); 