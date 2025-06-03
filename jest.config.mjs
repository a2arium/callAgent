/** @type {import('jest').Config} */
const config = {
    // Use proper ts-jest preset for ESM
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    
    // Test discovery
    roots: ['<rootDir>/packages'],
    testMatch: [
        '**/__tests__/**/*.+(ts|tsx|js)',
        '**/?(*.)+(spec|test).+(ts|tsx|js)'
    ],
    
    // Force TypeScript transformation with ts-jest only
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                useESM: true,
                tsconfig: {
                    target: 'ES2020',
                    module: 'ESNext',
                    moduleResolution: 'node',
                    strict: true,
                    esModuleInterop: true,
                    allowSyntheticDefaultImports: true,
                    skipLibCheck: true,
                },
            },
        ],
    },
    
    // Module resolution
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^@callagent/core/(.*)$': '<rootDir>/packages/core/src/$1',
        '^@callagent/types/(.*)$': '<rootDir>/packages/types/src/$1',
        '^@callagent/memory-sql/(.*)$': '<rootDir>/packages/memory-sql/src/$1',
        // Handle .js imports that should resolve to .ts files
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    
    // Critical: Tell Jest to treat .ts files as ESM
    extensionsToTreatAsEsm: ['.ts'],
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    
    // Transform settings
    transformIgnorePatterns: [
        'node_modules/(?!(jest-mock-extended|ts-essentials)/)',
    ],
    
    // Coverage settings
    collectCoverage: true,
    coverageProvider: 'v8',
    collectCoverageFrom: [
        'packages/**/src/**/*.{ts,tsx}',
        '!packages/**/src/tests/**',
        '!packages/**/src/**/*.d.ts',
        '!packages/**/src/index.ts',
    ],
    coverageThreshold: {
        global: {
            branches: 50,
            functions: 50,
            lines: 50,
            statements: 50
        }
    },
    
    // Setup
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    verbose: true,
};

export default config; 