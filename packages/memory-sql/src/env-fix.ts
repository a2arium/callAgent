// This file is a side-effect import that MUST be loaded before any @prisma/client imports
// to prevent Prisma from automatically loading .env files from the package directory.
if (process.env.PRISMA_SKIP_DOTENV === undefined) {
    process.env.PRISMA_SKIP_DOTENV = 'true';
}
export { };
