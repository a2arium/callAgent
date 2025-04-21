import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'], // Changed from src to tests
    testMatch: [
        '**/__tests__/**/*.+(ts|tsx|js)',
        '**/?(*.)+(spec|test).+(ts|tsx|js)'
    ],
    transform: {
        '^.+\.(ts|tsx)$': 'ts-jest'
    },
    // Removed setupFilesAfterEnv for simplicity
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1'
    },
    collectCoverage: true,
    collectCoverageFrom: [
        'src/**/*.{ts,tsx}',
        '!src/tests/**', // Keep this if tests might be nested under src later
        '!src/**/*.d.ts',
        '!src/index.ts',
        // '!src/config/config.ts' // Removed specific config exclusion
    ],
    // Simplified coverage threshold
    coverageThreshold: {
        global: {
            branches: 80,
            functions: 80,
            lines: 80,
            statements: 80
        }
    },
    verbose: true,
    globals: {
        'ts-jest': {
            isolatedModules: true,
        },
    },
};

export default config; 