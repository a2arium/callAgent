export default {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
        '^@a2arium/callagent-core/(.*)\\.js$': '<rootDir>/../core/src/$1',
        '^@a2arium/callagent-core/(.*)$': '<rootDir>/../core/src/$1',
        '^@a2arium/callagent-core$': '<rootDir>/../core/src/index.ts',
        '^@a2arium/callagent-memory-engine/(.*)$': '<rootDir>/../memory-engine/src/$1',
        '^@a2arium/callagent-memory-engine$': '<rootDir>/../memory-engine/src/index.ts',
        '^@a2arium/callagent-memory-sql/generated$': '<rootDir>/../memory-sql/src/generated/prisma/index.js',
        '^@a2arium/callagent-memory-sql/(.*)$': '<rootDir>/../memory-sql/src/$1',
        '^@a2arium/callagent-memory-sql$': '<rootDir>/../memory-sql/src/index.ts',
        '^@a2arium/callagent-eventbus-nats/(.*)$': '<rootDir>/../eventbus-nats/src/$1',
        '^@a2arium/callagent-eventbus-nats$': '<rootDir>/../eventbus-nats/src/index.ts',
        '^@a2arium/callagent-types/(.*)$': '<rootDir>/../types/src/$1',
        '^@a2arium/callagent-types$': '<rootDir>/../types/src/index.ts',
        '^@a2arium/callagent-utils/(.*)$': '<rootDir>/../utils/src/$1',
        '^@a2arium/callagent-utils$': '<rootDir>/../utils/src/index.ts',
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                useESM: true,
                tsconfig: 'tsconfig.test.json',
            },
        ],
    },
    testMatch: ['<rootDir>/tests/**/*.test.ts'],
};
