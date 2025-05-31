/** @type {import('jest').Config} */
const config = {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    roots: ['<rootDir>/packages'],
    testMatch: [
        '**/__tests__/**/*.+(ts|tsx|js)',
        '**/?(*.)+(spec|test).+(ts|tsx|js)'
    ],
    transform: {
        '^.+\\.(ts|tsx)$': [
            'ts-jest',
            {
                useESM: true,
                tsconfig: 'tsconfig.json',
            },
        ],
    },
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        // This is to handle ESM imports with extensions
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    collectCoverage: true,
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
    verbose: true,
    extensionsToTreatAsEsm: ['.ts'],
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    transformIgnorePatterns: [
        'node_modules/(?!(jest-mock-extended|ts-essentials)/)',
    ],
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
};

export default config; 