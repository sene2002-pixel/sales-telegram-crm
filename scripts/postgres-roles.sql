-- Run with psql as the database administrator for a dedicated CRM database.
-- Role memberships and credentials for the two deployment logins are set by the operator.
\set ON_ERROR_STOP on
BEGIN;
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_runtime') THEN
    CREATE ROLE crm_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_schema_owner') THEN
    CREATE ROLE crm_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$roles$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO crm_schema_owner;
GRANT USAGE ON SCHEMA public TO crm_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_schema_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_schema_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO crm_runtime;
COMMIT;
