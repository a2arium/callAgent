ALTER TABLE "operator_audit_events" ALTER COLUMN "tenant_id" DROP NOT NULL;

CREATE TYPE "OperatorRole" AS ENUM ('VIEWER', 'OPERATOR', 'ADMIN');
CREATE TYPE "OperatorMembershipStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "OperatorInvitationStatus" AS ENUM ('PENDING', 'CLAIMING', 'ACCEPTED', 'REVOKED');

CREATE TABLE "operator_auth_users" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL UNIQUE,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "bootstrap_credential_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "operator_auth_sessions" (
    "id" TEXT PRIMARY KEY,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL UNIQUE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL REFERENCES "operator_auth_users"("id") ON DELETE CASCADE
);
CREATE INDEX "operator_auth_sessions_user_id_idx" ON "operator_auth_sessions"("user_id");
CREATE INDEX "operator_auth_sessions_expires_at_idx" ON "operator_auth_sessions"("expires_at");

CREATE TABLE "operator_auth_accounts" (
    "id" TEXT PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL REFERENCES "operator_auth_users"("id") ON DELETE CASCADE,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "operator_auth_accounts_provider_account_key" UNIQUE ("provider_id", "account_id")
);
CREATE INDEX "operator_auth_accounts_user_id_idx" ON "operator_auth_accounts"("user_id");

CREATE TABLE "operator_auth_verifications" (
    "id" TEXT PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "operator_auth_verifications_identifier_idx" ON "operator_auth_verifications"("identifier");
CREATE INDEX "operator_auth_verifications_expires_at_idx" ON "operator_auth_verifications"("expires_at");

CREATE TABLE "operator_tenant_memberships" (
    "id" TEXT PRIMARY KEY,
    "user_id" TEXT NOT NULL REFERENCES "operator_auth_users"("id") ON DELETE RESTRICT,
    "tenant_id" TEXT NOT NULL,
    "role" "OperatorRole" NOT NULL,
    "status" "OperatorMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_user_id" TEXT REFERENCES "operator_auth_users"("id") ON DELETE SET NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "operator_tenant_memberships_user_tenant_key" UNIQUE ("user_id", "tenant_id")
);
CREATE INDEX "operator_tenant_memberships_tenant_status_role_idx" ON "operator_tenant_memberships"("tenant_id", "status", "role");

CREATE TABLE "operator_invitations" (
    "id" TEXT PRIMARY KEY,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OperatorRole" NOT NULL,
    "token_hash" TEXT NOT NULL UNIQUE,
    "status" "OperatorInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "claim_id" TEXT,
    "claim_expires_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL REFERENCES "operator_auth_users"("id") ON DELETE RESTRICT,
    "accepted_by_user_id" TEXT REFERENCES "operator_auth_users"("id") ON DELETE SET NULL,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "operator_invitations_tenant_status_expiry_idx" ON "operator_invitations"("tenant_id", "status", "expires_at");
CREATE INDEX "operator_invitations_email_idx" ON "operator_invitations"("email");
CREATE UNIQUE INDEX "operator_invitations_one_live_per_email_tenant" ON "operator_invitations"("tenant_id", "email") WHERE "status" IN ('PENDING', 'CLAIMING');

CREATE TABLE "operator_installation_owner" (
    "id" TEXT PRIMARY KEY DEFAULT 'primary',
    "user_id" TEXT NOT NULL UNIQUE REFERENCES "operator_auth_users"("id") ON DELETE RESTRICT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "operator_bootstrap_state" (
    "id" TEXT PRIMARY KEY DEFAULT 'primary',
    "status" TEXT NOT NULL,
    "claimed_by" TEXT,
    "claim_expires_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL
);
