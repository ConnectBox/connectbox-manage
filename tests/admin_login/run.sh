#!/bin/bash
# usage: bash run.sh <work folder made by setup.sh>      (root, throwaway container; needs Playwright's Chromium)
W=$(realpath "$1"); HERE=$(dirname "$(realpath "$0")"); export H=$W
start() { (cd "$W/src" && CB_SITE=$W/site CB_IDLE_MS=$1 exec node index.js > "$W/server.log" 2>&1) & SP=$!; sleep 2; }
# password checks (sets the password to "connectbox", then an odd one)
start ""; node "$HERE/auth_test.js" "$W/src/functions.js"; kill $SP; sleep 1
ls /tmp/cbp* 2>/dev/null && echo "FAIL proof files above were made" || echo "PASS no proof files made"
# login flow in a browser (password "testpw")
node -e "require('$W/src/functions.js').set.password({value:'testpw'})"
start ""; timeout 150 node "$HERE/login_flow.js"; kill $SP; sleep 1
start 3000; MODE=idle timeout 60 node "$HERE/login_flow.js"; kill $SP
