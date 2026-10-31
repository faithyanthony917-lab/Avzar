-- EF's initial schema has these PostgreSQL primitive collections; the Node baseline omitted them.
-- Add only when absent so databases adopted from EF remain unchanged.
ALTER TABLE "Invitations"
  ADD COLUMN IF NOT EXISTS "RoleIds" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  ADD COLUMN IF NOT EXISTS "LocationIds" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[];

ALTER TABLE "Stages"
  ADD COLUMN IF NOT EXISTS "CompletionChecks" text[] NOT NULL DEFAULT ARRAY[]::text[];