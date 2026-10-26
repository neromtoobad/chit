#!/bin/sh
# Lists a burn on the public Burn Book wall: checks it is mined and pays the Burn Book
# address, adds the txid to web/public/burns/index.json, commits, and redeploys.
#   ./scripts/add-burn.sh <txid> [<txid>…]
set -eu
cd "$(dirname "$0")/.."
for txid in "$@"; do
  txid=$(echo "$txid" | tr 'A-F' 'a-f')
  ./target/release/chit check-burn "$txid"
  node -e '
    const fs = require("fs"); const f = "web/public/burns/index.json";
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.txids = [...new Set([process.argv[1], ...j.txids])];
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");' "$txid"
  echo "listed $txid"
done
git add web/public/burns/index.json
git commit -q -m "Burn Book: list $*"
./scripts/deploy.sh
