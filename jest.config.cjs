/** @type {import('jest').Config} */
const config = {
    // Use proper ts-jest preset for ESM
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    
    // Test discovery
    roots: ['<rootDir>/packages'],
    testMatch: [
        '**/__tests__/**/*.[jt]s?(x)',
        '**/?(*.)+(spec|test).[jt]s?(x)'
    ],
    testPathIgnorePatterns: [
        '/node_modules/',
        '/dist/',
        '<rootDir>/packages/.*/dist/'
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
        '^@a2arium/core/(.*)$': '<rootDir>/packages/core/src/$1',
        '^@a2arium/types/(.*)$': '<rootDir>/packages/types/src/$1',
        '^@a2arium/memory-sql/(.*)$': '<rootDir>/packages/memory-sql/src/$1',
        // Handle .js imports that should resolve to .ts files
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    
    // Critical: Tell Jest to treat .ts files as ESM
    // Note: .mjs files are always treated as ESM by Jest
    extensionsToTreatAsEsm: ['.ts'],
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'json', 'node'],
    
    // Transform settings
    // Don't ignore workspace packages - they need to be transformed
    transformIgnorePatterns: [
        'node_modules/(?!(jest-mock-extended|ts-essentials|@a2arium)/)',
        // Transform workspace packages
        '!packages/',
        '!apps/',
    ],
    
    // Coverage settings
    // Collect coverage and emit a summary table after the run
    collectCoverage: true,
    coverageProvider: 'v8',
    // text -> table + summary at end; lcov -> CI/HTML consumption
    coverageReporters: ['text', 'lcov'],
    collectCoverageFrom: [
        'packages/**/src/**/*.{ts,tsx}',
        '!packages/**/src/tests/**',
        '!packages/**/src/**/*.d.ts',
        '!packages/**/src/index.ts',
    ],
    // We care about stability over hard thresholds right now
    coverageThreshold: undefined,
    
    // Setup
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    // Global teardown runs ONCE after all tests
    globalTeardown: '<rootDir>/jest.teardown.js',
    verbose: true,

    // Stability tweaks
    maxWorkers: '50%',
    detectOpenHandles: true,
};

module.exports = config; 
