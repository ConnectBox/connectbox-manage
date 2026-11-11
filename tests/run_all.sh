#!/bin/bash
# Runs the connectbox-manage harnesses that are safe on any machine (they change no real files).
# usage: bash tests/run_all.sh            (after "npm ci" in this repo; Node 16 or later)
# cbm_test.js and admin_login/ write /etc and /usr/local/connectbox: run those only in a
# throwaway container (see tests/README.md).
HERE=$(dirname "$(realpath "$0")"); CBM=$(realpath "$HERE/.."); FAILED=0
[ -d "$CBM/node_modules" ] || { echo "run npm ci in $CBM first"; exit 2; }
run() { local name=$1; shift; echo "== $name"; if node "$@" > /tmp/cbm_harness_out.txt 2>&1; then grep -v "^[[:space:]]*$" /tmp/cbm_harness_out.txt | tail -n 1; else cat /tmp/cbm_harness_out.txt; FAILED=1; fi
        grep -q "^FAIL\|\[FAIL\]" /tmp/cbm_harness_out.txt && FAILED=1; }
run "test_clientwifi (client SSID / passphrase)" "$HERE/test_clientwifi.js" "$CBM/src/functions.js"
run "test_setbrand (setBrand values)"            "$HERE/test_setbrand.js" "$CBM/src/functions.js"
run "bp_test (body-parser json/form/text)"       "$HERE/bp_test.js" "$CBM"
run "test_hdmi (HDMI screen: paths, playlist, visitor switch)" "$HERE/test_hdmi.js" "$CBM/src/hdmi.js"
rm -f /tmp/cbm_harness_out.txt
[ $FAILED = 0 ] && echo "ALL PASSED" || echo "SOME TESTS FAILED"; exit $FAILED
