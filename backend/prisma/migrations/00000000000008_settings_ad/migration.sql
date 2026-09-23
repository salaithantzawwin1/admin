-- =============================================================
-- Phase: Settings module + AD/LDAP-ready user accounts
--
-- system_settings: key/value store for module configuration. The
-- AD/LDAP settings live here (server URL, bind DN, bind password,
-- base DN, default role, enabled flag) so sysadmin can configure
-- directory login from the UI without a redeploy.
--
-- users.auth_source: tracks where a login identity comes from so
-- LOCAL users keep password login while AD users authenticate
-- against the directory.
-- =============================================================

CREATE TABLE "system_settings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

ALTER TABLE "users" ADD COLUMN "authSource" TEXT NOT NULL DEFAULT 'LOCAL';
