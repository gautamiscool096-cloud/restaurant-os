#!/usr/bin/env bash
# Rebuild a throwaway plain-Postgres database with the Supabase shim,
# all migrations and the seed. Used by `npm test`.
# DATABASE_URL must point at the *server* (any db); TEST_DB names the db to recreate.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL, e.g. postgres://postgres@localhost:5432/postgres}"
TEST_DB="${TEST_DB:-restaurant_os_test}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "drop database if exists $TEST_DB with (force)" -c "create database $TEST_DB"
TARGET="$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/"+process.argv[1];console.log(u.toString())' "$TEST_DB")"
psql "$TARGET" -v ON_ERROR_STOP=1 -q -f tests/support/supabase-shim.sql
for f in supabase/migrations/*.sql; do
  psql "$TARGET" -v ON_ERROR_STOP=1 -q -f "$f"
done
psql "$TARGET" -v ON_ERROR_STOP=1 -q -f supabase/seed.sql
echo "$TARGET"
