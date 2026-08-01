/**
 * Validates that all pg-related environment variables are strings (not objects).
 * The `pg` library reads PGUSER, PGDATABASE, PGPASSWORD, PGHOST, PGPORT,
 * PGAPPNAME and others from process.env as fallbacks. If ANY of these is
 * accidentally set to an Object (e.g. by dotenv pollution or programmatic
 * assignment), pg's serializer will crash with:
 *   TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type string
 *
 * Call this BEFORE creating a pg.Pool to get a clear, actionable error message.
 */

const PG_ENV_KEYS = [
    'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGHOST', 'PGPORT',
    'PGAPPNAME', 'PGCONNECT_TIMEOUT', 'PGSSLMODE',
    'MEMORY_DATABASE_URL', 'DATABASE_URL', 'CHAT_DATABASE_URL',
    'USER', // pg falls back to USER for the database user
];

export function validatePgEnvironment(context?: string): void {
    const label = context ? `[${context}]` : '[pg-env-check]';
    for (const key of PG_ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined && typeof value !== 'string') {
            throw new Error(
                `${label} Environment variable ${key} is a ${typeof value} (expected string). ` +
                `Value: ${JSON.stringify(value)}. ` +
                `This will crash pg's connection handshake. ` +
                `Check your .env files, dotenv loaders, and any code that sets process.env.${key}.`
            );
        }
    }
}

/**
 * Logs pg-related environment variable presence and runtime type without ever
 * exposing credentials or connection-string prefixes.
 */
export function dumpPgEnvironment(context?: string): void {
    const label = context ? `[${context}]` : '[pg-env-dump]';
    for (const key of PG_ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) {
            console.log(`${label} ${key}: type=${typeof value}, configured=true`);
        }
    }
}
