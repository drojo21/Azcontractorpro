#!/usr/bin/env bash
# The backend can't import from ../core at runtime on Netlify, so it carries
# copies. This keeps them identical. CI fails if they drift.
set -e
cd "$(dirname "$0")/.."
cp core/trade_defaults.json backend/lib/trade_defaults.json
cp core/acp-schema.js backend/lib/acp-schema.cjs
echo "backend/lib synced from core/"
