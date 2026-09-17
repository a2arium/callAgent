-- Create callAgent + Hatchet databases on an existing local Postgres server.
-- Run as a superuser, e.g.:
--   psql -U postgres -f apps/hatchet-poc/scripts/init-host-databases.sql
--
-- Adjust passwords to match your .env / HATCHET_DATABASE_URL / MEMORY_DATABASE_URL.

CREATE USER callagent WITH PASSWORD 'callagent';
CREATE DATABASE callagent OWNER callagent;

CREATE USER hatchet WITH PASSWORD 'hatchet';
CREATE DATABASE hatchet OWNER hatchet;

GRANT ALL PRIVILEGES ON DATABASE callagent TO callagent;
GRANT ALL PRIVILEGES ON DATABASE hatchet TO hatchet;
