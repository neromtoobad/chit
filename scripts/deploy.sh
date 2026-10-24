#!/bin/sh
# Builds the site and publishes it to Vercel project "chit" at chit.nerom.site.
# The site is static: Vercel serves files and runs no code for it.
#
#   ./scripts/deploy.sh           production deploy
#   ./scripts/deploy.sh preview   preview deploy only
set -eu
cd "$(dirname "$0")/.."
./scripts/build.sh

# vite empties web/dist on every build, so deploy from a copy that keeps Vercel's link.
mkdir -p deploy/site
rsync -a --delete --exclude .vercel web/dist/ deploy/site/
cd deploy/site
if [ ! -f .vercel/project.json ]; then
  npx -y vercel@latest link --yes --project chit
fi
if [ "${1:-}" = "preview" ]; then
  npx -y vercel@latest deploy --yes
else
  npx -y vercel@latest deploy --prod --yes
  npx -y vercel@latest domains add chit.nerom.site chit 2>/dev/null || true
fi
