#!/bin/bash
#
# Emergency wipe: "Wipe All Storage" on the admin page (connectbox-manage
# set.wipe, confirmed with the admin password).  Used when the box is found
# and its content could put people in danger (Kirk, 2026-11-13):
#  - every USB key is destroyed whole;
#  - on the SD card only the media and everything that names or shows it is
#    destroyed; the system stays, so the box keeps running;
#  - the Wi-Fi stays off, and free space on the card and the USB keys keep
#    being overwritten for as long as the box has power.
#
# Until 2026-11-13 this script did nothing at all (set.wipe ran it by a
# relative path that did not resolve, line 1 had a stray backquote, "rm -rf /"
# is refused by GNU rm, and USB keys were never touched).
#
# Order:
#  1. pause 2 s so the admin page gets its answer, then stop the services that
#     would mount, recover, serve or log anything: cron (it restarts PxUSBm),
#     PxUSBm, the content loader, Kiwix, the HDMI player, the access point
#     (hostapd) and DHCP/DNS, nginx, the chat and captive-portal servers, and
#     pm2 (connectbox-manage keeps recent chat in memory);
#  2. unmount the USB keys (lazily; stacked mounts too);
#  3. FAST, USB keys (every disk except the one holding /): wipefs on each
#     partition and the disk, random data over the first 32 MiB of each
#     partition (superblocks, FAT tables, NTFS MFT start) and the first and
#     last 8 MiB of the disk (MBR/GPT and the backup GPT), then blkdiscard (the
#     key's own erase where it has one);
#  3b. FAST, swap: swapoff (pages back into RAM), reset zram (it lets go of
#     its writeback file), overwrite every swap file and zram backing file
#     (/var/swap on Raspberry Pi OS) in place with random data;
#  4. FAST, SD card: delete the media and its traces (see MEDIA below), then
#     fstrim, so a card that honours discard erases the freed blocks at once;
#  5. FULL, until the power goes, at idle priority: random data over every
#     USB key, and on the
#     SD card a file of random data that fills all free space, which is then
#     deleted and trimmed; pass after pass (the media folders are emptied again
#     each pass).  Disks are re-listed from /sys/block each pass, so a key
#     plugged in later is destroyed too.
# Deleting files does not erase their blocks on a card that ignores discard,
# and wear levelling can keep old copies of blocks; the fill passes are what
# overwrite those.  Skipped devices: loop, ram, zram, optical, device-mapper,
# md, nbd, the eMMC boot/rpmb areas, and the disk holding /.
# Nothing is logged (a log would be evidence); /var/log is emptied.
#
# The whole script is one function, read completely before it runs.
#
# Test hooks (tests/test_wipe.sh): WIPE_DRY_RUN=1 prints the commands instead
# of running them; WIPE_SYS / WIPE_DEV point at a fake /sys and /dev;
# WIPE_ROOT_DISK names the disk holding /; WIPE_PASSES limits the full
# passes; WIPE_MEDIA replaces /media; WIPE_ROOTFS is put in front of every
# path on the SD card; WIPE_PROC replaces /proc (for /proc/swaps).

main() {
  local DRY="${WIPE_DRY_RUN:-0}" SYS="${WIPE_SYS:-/sys}" DEV="${WIPE_DEV:-/dev}"
  local PASSES="${WIPE_PASSES:-0}"      # 0 = until the power goes
  local MEDIA_DIR="${WIPE_MEDIA:-/media}" R="${WIPE_ROOTFS:-}"
  local FILL="$R/var/.cbwipe-fill"
  local PROC="${WIPE_PROC:-/proc}"

  # What is destroyed on the SD card (the contents, not the folders):
  #  the box's own content and anything under the USB mount points (once the
  #  keys are unmounted these are the card's own folders), the menus,
  #  thumbnails and converted pages, the Kiwix library list, the HDMI
  #  playlist, the visitors' chat, every log (usage stats are
  #  /var/log/connectbox), pm2's logs and the temporary folders.
  local MEDIA=("$MEDIA_DIR"/usb*
               "$R/var/www/enhanced/content/www/assets/content"
               "$R/var/lib/connectbox/kiwix"
               "$R/tmp" "$R/var/tmp" "$R/root/.pm2/logs")
  local FILES=("$R/usr/local/connectbox/var/cbchat.db" "$R/usr/local/connectbox/var/cbchat.db-journal"
               "$R/usr/local/connectbox/hdmi/playlist.json")

  # Run a command (dry run: print it).  Output and errors are dropped: a
  #  failing step (no discard support, device gone) must not stop the rest.
  run() { if [ "$DRY" = 1 ]; then echo "RUN $*"; else "$@" >/dev/null 2>&1; fi; }
  # Start a command in the background (dry run: print it)
  bgrun() { if [ "$DRY" = 1 ]; then echo "BG $*"; else "$@" >/dev/null 2>&1 & fi; }

  # Whole disks, from /sys/block
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
  # Empty the media folders and remove the single files (folders stay)
  delete_media() {
    local d f
    for d in "${MEDIA[@]}"; do
      [ -d "$d" ] || continue
      if [ "$DRY" = 1 ]; then echo "DELETE $d/*"; else
        find "$d" -mindepth 1 -xdev -delete >/dev/null 2>&1
      fi
    done
    for f in "${FILES[@]}"; do run rm -f "$f"; done
    # every log file, including the journal's
    if [ "$DRY" = 1 ]; then echo "DELETE $R/var/log files"; else
      find "$R/var/log" -xdev -type f -delete >/dev/null 2>&1
    fi
  }

  # -- 1. answer the admin page, then stop services ---------------------------
  run sleep 2
  run systemctl stop cron
  run pkill -f PxUSBm.py
  local svc
  for svc in PxUSBm connectbox-loader kiwix-serve connectbox-hdmi hostapd dnsmasq nginx gunicorn captiveportal; do
    run systemctl stop "$svc"
  done
  run pkill -f PxUSBm.py
  run pkill -f mmiLoader.py
  run /usr/bin/pm2 kill
  run systemctl stop pm2-root

  # The disk holding / (the SD card) is kept; every other disk is destroyed
  local root="${WIPE_ROOT_DISK:-}"
  if [ -z "$root" ]; then
    local src
    src=$(findmnt -no SOURCE / 2>/dev/null)
    src=${src##*/}
    [ -n "$src" ] && root=$(basename "$(readlink -f "$SYS/class/block/$src/..")" 2>/dev/null)
  fi

  # -- 2. unmount the USB keys (stacked mounts: a few rounds) ------------------
  local m i
  for i in 1 2 3; do
    for m in "$MEDIA_DIR"/usb*; do
      [ -d "$m" ] && run umount -l "$m"
    done
  done

  # -- 3. fast: USB keys -------------------------------------------------------
  fast_disk() {
    local disk=$1 p mib
    for p in $(parts "$disk"); do
      run wipefs -a -f "$DEV/$p"
      run dd if=/dev/urandom of="$DEV/$p" bs=1M count=32 conv=fsync
    done
    run wipefs -a -f "$DEV/$disk"
    run dd if=/dev/urandom of="$DEV/$disk" bs=1M count=8 conv=fsync
    mib=$(size_mib "$disk")
    [ "$mib" -gt 16 ] && run dd if=/dev/urandom of="$DEV/$disk" bs=1M count=8 seek=$(( mib - 8 )) conv=fsync
    run blkdiscard -f "$DEV/$disk"
  }
  local d
  for d in $(disks); do
    [ "$d" = "$root" ] || fast_disk "$d"
  done

  # -- 3b. fast: swap ------------------------------------------------------------
  # Swapped-out memory can hold pieces of what the box showed or the chat.
  #  swapoff brings every page back into RAM (zram too), the zram devices are
  #  reset (that also lets go of their writeback file, /var/swap on Raspberry
  #  Pi OS), then every swap file and backing file is overwritten in place
  #  with random data (kept: the system uses it again after a reboot).
  local swapfiles=("$R/var/swap") line f z bd
  while read -r line; do
    set -- $line
    [ "${2:-}" = "file" ] && swapfiles+=("$R$1")
  done < "$PROC/swaps"
  for z in "$SYS"/block/zram*; do
    [ -e "$z/backing_dev" ] || continue
    read -r bd < "$z/backing_dev" 2>/dev/null || bd=none
    case "$bd" in
      none|"") ;;
      /dev/loop*) [ -e "$SYS/block/${bd##*/}/loop/backing_file" ] && read -r f < "$SYS/block/${bd##*/}/loop/backing_file" && swapfiles+=("$R$f") ;;
      *) swapfiles+=("$R$bd") ;;
    esac
  done
  run swapoff -a
  for z in "$SYS"/block/zram*; do
    [ -e "$z/reset" ] && run sh -c "echo 1 > $z/reset"
  done
  local done_files=" "
  for f in "${swapfiles[@]}"; do
    case "$done_files" in *" $f "*) continue ;; esac     # each file once
    done_files="$done_files$f "
    [ -f "$f" ] || continue
    local mib=$(( ($(stat -c %s "$f" 2>/dev/null || echo 0) + 1048575) / 1048576 ))
    [ "$mib" -gt 0 ] && run dd if=/dev/urandom of="$f" bs=1M count="$mib" conv=notrunc,fsync
  done

  # -- 4. fast: SD card media and traces ---------------------------------------
  delete_media
  run systemctl restart systemd-journald      # let go of the deleted journal files
  run sync
  run fstrim "$R/"

  # -- 5. full: overwrite, pass after pass -------------------------------------
  # At idle CPU and disk priority: with nothing else running it goes just as
  #  fast, but the front panel and SSH stay usable (2026-11-13 test on .36:
  #  at normal priority the card was so busy that SSH and the panel stalled).
  local LOW="nice -n 19 ionice -c 3"
  local pass=0
  while [ "$PASSES" = 0 ] || [ "$pass" -lt "$PASSES" ]; do
    pass=$(( pass + 1 ))
    for d in $(disks); do
      [ "$d" = "$root" ] || bgrun $LOW dd if=/dev/urandom of="$DEV/$d" bs=4M
    done
    # fill the card's free space with random data, then free and trim it
    run $LOW dd if=/dev/urandom of="$FILL" bs=4M conv=fsync
    run sync
    run rm -f "$FILL"
    delete_media
    run fstrim "$R/"
    if [ "$DRY" = 1 ]; then echo "WAIT pass $pass"; else wait; sleep 5; fi
  done
}

main "$@"
exit 0
