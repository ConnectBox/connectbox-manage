#!/bin/bash
#
# Emergency wipe: "Wipe All Storage" on the admin page (connectbox-manage
# set.wipe) and ConnectBoxManage.sh "wipe".  Used when the box is found and
# its content could put people in danger, so it must make the SD card and
# every USB key unreadable as fast as possible, then keep destroying them for
# as long as the box has power (Kirk, 2026-11-13).
#
# Until 2026-11-13 this script did nothing at all: set.wipe ran it by a
# relative path that did not resolve (pm2 runs connectbox-manage in /root),
# the first line had a stray backquote (a syntax error, so nothing ran even
# when it was found), and "rm -rf /" is refused by GNU rm.  It also never
# touched USB keys.
#
# Order (each step is started while the system can still run programs):
#  1. pause 2 s so the admin page gets its answer, then stop the services that
#     would mount, recover or serve anything (cron restarts PxUSBm);
#  2. copy dd and sleep and their libraries into RAM (/dev/shm): once the
#     card is destroyed, programs on it can no longer be started;
#  3. FAST, USB keys and other disks first, the boot disk last:
#     every partition and the disk itself - wipefs (file-system and
#     partition-table signatures), random data over the first 32 MiB of each
#     partition (superblocks, FAT tables, NTFS MFT start) and the first and
#     last 8 MiB of the disk (MBR/GPT and the backup GPT), then blkdiscard
#     (the card's own erase; instant where supported, ignored where not);
#  4. FULL: random data over every whole disk, all disks at once, pass after
#     pass until the power goes.  Disks are re-listed before each pass from
#     /sys/block (bash only, no programs from the card), so a key plugged in
#     later is destroyed too.
# Skipped: loop, ram, zram, optical, device-mapper, md, nbd devices and the
# eMMC boot/rpmb areas.  Nothing is logged (a log would be evidence).
#
# The whole script is one function, read completely before it runs: bash
# reads a script file as it goes, and the file itself is on the card.
#
# Test hooks (tests/test_wipe.sh): WIPE_DRY_RUN=1 prints the commands instead
# of running them; WIPE_SYS / WIPE_DEV point at a fake /sys and /dev;
# WIPE_ROOT_DISK names the boot disk; WIPE_PASSES limits the full passes;
# WIPE_MEDIA replaces /media (where the USB keys are mounted).

main() {
  local DRY="${WIPE_DRY_RUN:-0}" SYS="${WIPE_SYS:-/sys}" DEV="${WIPE_DEV:-/dev}"
  local PASSES="${WIPE_PASSES:-0}"      # 0 = until the power goes

  # Run a command (dry run: print it).  Output and errors are dropped: a
  # failing step (no discard support, device gone) must not stop the rest.
  run() { if [ "$DRY" = 1 ]; then echo "RUN $*"; else "$@" >/dev/null 2>&1; fi; }
  # Start a command in the background (dry run: print it)
  bgrun() { if [ "$DRY" = 1 ]; then echo "BG $*"; else "$@" >/dev/null 2>&1 & fi; }

  # Whole disks to destroy, from /sys/block (bash globbing only)
  disks() {
    local d n
    for d in "$SYS"/block/*; do
      n=${d##*/}
      case "$n" in
        loop*|ram*|zram*|sr*|dm-*|md*|nbd*|*boot[0-9]|*rpmb) continue ;;
      esac
      [ -e "$d" ] && echo "$n"
    done
  }
  # Partitions of disk $1
  parts() {
    local p
    for p in "$SYS"/block/"$1"/"$1"*; do
      [ -e "$p/partition" ] && echo "${p##*/}"
    done
  }
  # Size of disk $1 in MiB (from 512-byte sectors), 0 if unknown
  size_mib() {
    local s=0
    read -r s < "$SYS/block/$1/size" 2>/dev/null || s=0
    echo $(( s / 2048 ))
  }

  # -- 1. answer the admin page, then stop services ---------------------------
  run sleep 2
  run systemctl stop cron
  run pkill -f PxUSBm.py
  local svc
  for svc in PxUSBm connectbox-loader kiwix-serve connectbox-hdmi hostapd dnsmasq nginx; do
    run systemctl stop "$svc"
  done
  run pkill -f PxUSBm.py
  run pkill -f mmiLoader.py

  # -- 2. dd, sleep and their libraries into RAM -------------------------------
  local W DD SLEEP
  if [ "$DRY" = 1 ]; then
    W=/tmp/wipe-dry
    DD=dd
    SLEEP=sleep
  else
    W=/dev/shm/.cbw
    mkdir -p "$W"
    local ddbin sleepbin lib ld=""
    ddbin=$(command -v dd)
    sleepbin=$(command -v sleep)
    cp "$ddbin" "$W/dd" 2>/dev/null
    cp "$sleepbin" "$W/sleep" 2>/dev/null
    # (ldd's own "/usr/bin/dd:" headings are not libraries: no ':' in a path)
    for lib in $(ldd "$ddbin" "$sleepbin" 2>/dev/null | grep -o '/[^ :]*' | sort -u); do
      cp "$lib" "$W/" 2>/dev/null
      case "${lib##*/}" in ld-linux*|ld-*.so*) ld="$W/${lib##*/}" ;; esac
    done
    if [ -n "$ld" ] && [ -x "$W/dd" ]; then
      DD="$ld --library-path $W $W/dd"
      SLEEP="$ld --library-path $W $W/sleep"
    else
      DD="$ddbin"                      # not copied: works until the card is gone
      SLEEP="$sleepbin"
    fi
  fi

  # The boot disk is done last in the fast step
  local root="${WIPE_ROOT_DISK:-}"
  if [ -z "$root" ]; then
    local src
    src=$(findmnt -no SOURCE / 2>/dev/null)
    src=${src##*/}
    [ -n "$src" ] && root=$(basename "$(readlink -f "$SYS/class/block/$src/..")" 2>/dev/null)
  fi

  # Unmount the USB keys (lazily) so nothing is written back over the wipe
  local m
  for m in "${WIPE_MEDIA:-/media}"/usb*; do
    [ -d "$m" ] && run umount -l "$m"
  done

  # -- 3. fast: make everything unreadable -------------------------------------
  # One disk: signatures, the first 32 MiB of each partition, the first and
  #  last 8 MiB of the disk, then the device's own erase
  fast() {
    local disk=$1 p mib
    for p in $(parts "$disk"); do
      run wipefs -a -f "$DEV/$p"
      run $DD if=/dev/urandom of="$DEV/$p" bs=1M count=32 conv=fsync
    done
    run wipefs -a -f "$DEV/$disk"
    run $DD if=/dev/urandom of="$DEV/$disk" bs=1M count=8 conv=fsync
    mib=$(size_mib "$disk")
    [ "$mib" -gt 16 ] && run $DD if=/dev/urandom of="$DEV/$disk" bs=1M count=8 seek=$(( mib - 8 )) conv=fsync
    run blkdiscard -f "$DEV/$disk"
  }
  local d
  for d in $(disks); do
    [ "$d" = "$root" ] || fast "$d"
  done
  [ -n "$root" ] && [ -e "$SYS/block/$root" ] && fast "$root"

  # -- 4. full: overwrite every disk, pass after pass -------------------------
  local pass=0
  while [ "$PASSES" = 0 ] || [ "$pass" -lt "$PASSES" ]; do
    pass=$(( pass + 1 ))
    for d in $(disks); do
      bgrun $DD if=/dev/urandom of="$DEV/$d" bs=4M
    done
    # wait for this pass; the pause keeps the loop from spinning when no disk
    #  is left or every dd fails at once
    if [ "$DRY" = 1 ]; then echo "WAIT pass $pass"; else wait; $SLEEP 5 2>/dev/null; fi
  done
}

main "$@"
exit 0
