#!/usr/bin/env bash
# Rebuild the test database from migrations + seed, then run the RLS / leak suite.
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_DATABASE_URL="$(./scripts/db-reset-local.sh | tail -1)"
export TEST_DATABASE_URL
node --test 'tests/unit/*.test.mjs'
node --test --test-concurrency=1 'tests/rls/*.test.mjs'
