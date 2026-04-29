/** @type {import('jest').Config} */
// Coverage is expensive on the full monorepo; enable with COVERAGE=true (see package.json test:coverage).
//
// Heap: a single Jest worker can retain several GB (ts-jest transforms + imported graphs + Jest buffers).
// package.json sets NODE_OPTIONS=--max-old-space-size=8192 so workers stay under V8's limit on large runs.
const collectCoverage = process.env.COVERAGE === 'true';

const config = {
    // Use proper ts-jest preset for ESM
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',

    // Test discovery
    roots: ['<rootDir>/packages', '<rootDir>/apps/examples'],
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
        '^.+\\.[jt]sx?$': [
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
        '^@a2arium/callagent-core/(.*)\\.js$': '<rootDir>/packages/core/src/$1',
        '^@a2arium/callagent-core/(.*)$': '<rootDir>/packages/core/src/$1',
        '^@a2arium/callagent-core$': '<rootDir>/packages/core/src/index.ts',
        '^@a2arium/types/(.*)$': '<rootDir>/packages/types/src/$1',
        '^@a2arium/callagent-memory-sql/generated$': '<rootDir>/packages/memory-sql/src/generated/prisma/index.js',
        '^@a2arium/callagent-memory-sql/(.*)$': '<rootDir>/packages/memory-sql/src/$1',
        '^@a2arium/callagent-memory-sql$': '<rootDir>/packages/memory-sql/src/index.ts',
        '^@a2arium/memory-sql/(.*)$': '<rootDir>/packages/memory-sql/src/$1',
        '^@a2arium/callagent-memory-engine$': '<rootDir>/packages/memory-engine/src/index.ts',
        '^@a2arium/callagent-memory-engine/(.*)$': '<rootDir>/packages/memory-engine/src/$1',
        '^@a2arium/callagent-utils/(.*)$': '<rootDir>/packages/utils/src/$1',
        '^@a2arium/callagent-eventbus-nats$': '<rootDir>/packages/eventbus-nats/src/index.ts',
        '^@a2arium/callagent-eventbus-nats/(.*)$': '<rootDir>/packages/eventbus-nats/src/$1',
        '^@a2arium/callagent-utils$': '<rootDir>/packages/utils/src/index.ts',
        '^@a2arium/callagent-types/(.*)$': '<rootDir>/packages/types/src/$1',
        '^@a2arium/callagent-types$': '<rootDir>/packages/types/src/index.ts',
        '^@chat-prisma/(.*)$': '<rootDir>/packages/chat-bridge/src/generated/prisma/$1',
        '^\\.\\./generated/prisma/index\\.js$': '<rootDir>/packages/chat-bridge/src/generated/prisma/index.js',
        // Keep explicit .js extension for generated Prisma runtime modules.
        '^(.*/generated/prisma/.*)\\.js$': '$1.js',
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
        'node_modules/(?!(jest-mock-extended|ts-essentials|@a2arium|@openrouter)/)',
        // Transform workspace packages
        '!packages/',
        '!apps/',
    ],

    // Coverage settings (opt-in: COVERAGE=true)
    collectCoverage,
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
    setupFilesAfterEnv: ['<rootDir>/jest.setup.mjs'],
    // Global teardown runs ONCE after all tests
    globalTeardown: '<rootDir>/jest.teardown.js',
    verbose: process.env.JEST_VERBOSE === '1',

    // Stability tweaks
    maxWorkers: '50%',
    detectOpenHandles: true,
};

module.exports = config; 
