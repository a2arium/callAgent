/**
 * Safe pg.Pool config factory for memory-sql.
 *
 * ROOT CAUSE OF PREVIOUS ERR_INVALID_ARG_TYPE:
 *   In this monorepo, multiple versions of 'pg' exist. When a pg.Pool instance
 *   is passed to PrismaPg, the internal `instanceof Pool` check fails.
 *   Prisma then treats the Pool instance as a config object and spreads it,
 *   causing internal pool options to leak into the startup parameters.
 *
 * SOLUTION:
 *   Avoid passing pg.Pool instances to PrismaPg. Instead, use getSafePgConfig()
 *   to generate a plain configuration object and pass that directly.
 *   Prisma will then create and manage its own internal pool correctly.
 */
import pg from 'pg';
import pgConnectionString from 'pg-connection-string';

const { parse } = pgConnectionString;

/**
 * Parses a connection string and returns a clean pg.PoolConfig object.
 * Passing this object to PrismaPg (instead of a Pool instance) avoids
 * instanceof-related configuration leakage in monorepos.
 */
export function getSafePgConfig(
    connectionString: string,
    poolOptions?: { max?: number; min?: number; idleTimeoutMillis?: number }
): pg.PoolConfig {
    const parsed = parse(connectionString);

    const config: pg.PoolConfig = {
        host: parsed.host || 'localhost',
        port: parsed.port ? parseInt(parsed.port, 10) : 5432,
        user: parsed.user || undefined,
        password: parsed.password || undefined,
        database: parsed.database || undefined,
        ...(poolOptions || {}),
    };

    if (parsed.ssl !== undefined && parsed.ssl !== false) {
        config.ssl = typeof parsed.ssl === 'object' ? parsed.ssl as any : { rejectUnauthorized: false };
    }

    return config;
}

/**
 * @deprecated Use getSafePgConfig instead and pass the config object to PrismaPg.
 */
export function createSafePool(
    connectionString: string,
    poolOptions?: { max?: number; min?: number; idleTimeoutMillis?: number }
): pg.Pool {
    return new pg.Pool(getSafePgConfig(connectionString, poolOptions));
}

/**
 * Placeholder for global startup guard (deprecated).
 */
export function installPgGuard(): void {
    // No-op: The guard is no longer necessary with the direct config approach.
}
