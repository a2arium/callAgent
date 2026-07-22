# callAgent Observer authentication

Observer uses Better Auth for email/password identities and database sessions.
callAgent owns tenant memberships, `viewer`/`operator`/`admin` roles,
invitations, and the installation-owner recovery capability.

## Required production configuration

```dotenv
MEMORY_DATABASE_URL=postgresql://...
CALLAGENT_PUBLIC_URL=https://callagent.example.com
BETTER_AUTH_SECRET=<at-least-32-random-characters>
```

Optional first-owner settings:

```dotenv
CALLAGENT_OPERATOR_BOOTSTRAP_EMAIL=admin@callagent.local
CALLAGENT_OPERATOR_BOOTSTRAP_TENANT_ID=default
# Optional. If omitted, startup prints a random temporary password once.
CALLAGENT_OPERATOR_BOOTSTRAP_PASSWORD=<temporary-password>
```

Apply `packages/memory-sql/prisma/migrations` before starting the runtime. The
first owner must replace the temporary password within one hour. Public signup
and self-service password-reset requests are disabled.

If the first-owner credential expires or the owner loses their password, run:

```sh
yarn workspace @a2arium/callagent-operator-auth recover-owner
```

The command prints a one-time, one-hour reset link. Invitation and reset links
are displayed once; only their hashes are stored in PostgreSQL. Never put these
links, passwords, cookies, or `BETTER_AUTH_SECRET` in application logs.
