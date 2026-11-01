#!/bin/sh
# Fake sudo for cbm_test.js, in the test container only: install it as "sudo" in a folder put first in PATH.
# Logs each call's arguments to /tmp/cbm_sudo_calls.log. Downloads and restores are not run
# (wget and php succeed silently, lazyLoader.py prints its argument in [ ]); anything else
# (the old code's sed/touch/chmod) runs as the current user. "-u <user>" is logged and dropped.
echo "$*" >> /tmp/cbm_sudo_calls.log
[ "$1" = "-u" ] && shift 2
case "$1" in
  */lazyLoader.py) echo "[$2]"; exit 0 ;;
  wget|php|*/php) exit 0 ;;
esac
exec "$@"
