#!/usr/bin/env bash
# The backend can't import from ../core at runtime on Netlify, so it carries
# copies. This keeps them identical. CI fails if they drift.
set -e
cd "$(dirname "$0")/.."
cp core/trade_defaults.json backend/lib/trade_defaults.json
cp core/acp-schema.js backend/lib/acp-schema.cjs
cp core/roc-active.js backend/lib/roc-active.cjs
# The licence gate needs its data as well as its code: intake.js refuses every
# contractor without it. Rebuild it with scripts/build_roc_index.py after
# refreshing data/roc-active.csv.gz.
cp core/roc-index.json.gz backend/lib/roc-index.json.gz
echo "backend/lib synced from core/"
