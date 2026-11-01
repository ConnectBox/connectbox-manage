#!/bin/bash
# Builds a test copy of the connectbox-manage server for the admin-login tests (fixes 26, 61, 62).
# usage: bash setup.sh <connectbox-manage checkout, after npm ci> <admin-ui build folder> <work folder>
#   admin-ui build folder: the built admin pages (index.html, login.html, admin.bundle.js, login.bundle.js)
# Run as root in a throwaway container: the server writes /usr/local/connectbox/etc/basicauth
# and /usr/local/connectbox/admin_session.key.
set -e
CBM=$(realpath "$1"); AUI=$(realpath "$2"); W=$3; HERE=$(dirname "$(realpath "$0")")
rm -rf "$W"; mkdir -p "$W/site/admin"; W=$(realpath "$W")
cp -r "$CBM/src" "$W/src"; ln -s "$CBM/node_modules" "$W/node_modules"
# stand-ins: fixed port 8766, quiet logger, a stub admin API (CSV download + empty answers)
echo "module.exports = {port: 8766};" > "$W/src/configs.js"
echo "module.exports = class { constructor(){} log(l,m){ if (process.env.CB_LOG) console.log('LOG', m); } };" > "$W/src/logger.js"
cat > "$W/src/routes/api.js" <<'JS'
const r = require('express').Router();
r.get('/downloadweblog', (req,res) => { res.attachment('weblog.csv'); res.send('a,b\n'); });
r.all('*', (req,res) => res.send({code:0, result:[""]}));
module.exports = r;
JS
# two test hooks in index.js: serve the test pages, and a short idle limit from CB_IDLE_MS
grep -q "^const ADMIN_IDLE_MS = 5 \* 60 \* 1000;" "$W/src/index.js" || { echo "index.js: ADMIN_IDLE_MS line not found"; exit 1; }
sed -i "s|^const ADMIN_IDLE_MS = 5 \* 60 \* 1000;|app.use(require('express').static(process.env.CB_SITE));\nconst ADMIN_IDLE_MS = Number(process.env.CB_IDLE_MS \|\| 5 * 60 * 1000);|" "$W/src/index.js"
cp "$AUI"/* "$W/site/admin/"
echo '<html><body><h1>ConnectBox main</h1><a id="cfg" href="/admin">Configuration</a></body></html>' > "$W/site/index.html"
mkdir -p /usr/local/connectbox/etc
# functions.js reads brand.j2 when it loads
[ -f /usr/local/connectbox/brand.j2 ] || echo '{"Brand":"Connectbox","Font":27,"pos_x":6,"pos_y":0}' > /usr/local/connectbox/brand.j2
# the access-log download reads /var/log/connectbox/connectbox_enhanced*: give it one sample line
mkdir -p /var/log/connectbox
[ -n "$(ls /var/log/connectbox/connectbox_enhanced* 2>/dev/null)" ] || echo '{"mediaIdentifier":"test.mp4","interactionType":"view","mediaType":"video","mediaLanguage":"English","mediaProvider":"test","timestamp":1761900000}' > /var/log/connectbox/connectbox_enhanced.log
echo "test server ready in $W"
