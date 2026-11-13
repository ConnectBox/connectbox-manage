#!/bin/bash
# Dry run of src/scripts/wipe.sh against a fake /sys and /media: checks which
# disks it destroys and in what order.  Nothing is written to any disk
# (WIPE_DRY_RUN=1 prints the commands instead of running them).
# usage: bash tests/test_wipe.sh [path/to/wipe.sh]
W=${1:-$(dirname "$0")/../src/scripts/wipe.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
S=$T/sys; M=$T/media
# SD card mmcblk0 (boot disk: 2 partitions, eMMC boot/rpmb areas), USB key sda
#  (1 partition), USB disk sdb (no partition table), loop0, zram0, sr0, dm-0
mkdir -p $S/block/mmcblk0/mmcblk0p1 $S/block/mmcblk0/mmcblk0p2 $S/block/mmcblk0boot0 $S/block/mmcblk0rpmb \
         $S/block/sda/sda1 $S/block/sdb $S/block/loop0 $S/block/zram0 $S/block/sr0 $S/block/dm-0 $M/usb0 $M/usb11
touch $S/block/mmcblk0/mmcblk0p1/partition $S/block/mmcblk0/mmcblk0p2/partition $S/block/sda/sda1/partition
echo 125042688 > $S/block/mmcblk0/size; echo 60062500 > $S/block/sda/size; echo 8 > $S/block/sdb/size
OUT=$(WIPE_DRY_RUN=1 WIPE_SYS=$S WIPE_DEV=/dev WIPE_MEDIA=$M WIPE_ROOT_DISK=mmcblk0 WIPE_PASSES=2 bash "$W")
P=0; F=0
check() { if eval "$2"; then P=$((P+1)); else F=$((F+1)); echo "FAIL $1"; fi; }
line() { echo "$OUT" | grep -n -m1 -F -- "$1" | cut -d: -f1; }
check "script syntax" "bash -n '$W'"
check "services stopped before any disk is touched" "[ \$(line 'systemctl stop nginx') -lt \$(line 'wipefs') ]"
check "cron stopped (it restarts PxUSBm)" "echo \"\$OUT\" | grep -q 'systemctl stop cron'"
check "AP stopped" "echo \"\$OUT\" | grep -q 'systemctl stop hostapd'"
check "USB keys unmounted (usb0 and usb11)" "echo \"\$OUT\" | grep -q \"umount -l $M/usb0\" && echo \"\$OUT\" | grep -q \"umount -l $M/usb11\""
check "USB key partition: signatures and first 32 MiB" "echo \"\$OUT\" | grep -q 'wipefs -a -f /dev/sda1' && echo \"\$OUT\" | grep -q 'of=/dev/sda1 bs=1M count=32'"
check "USB key: start and end of the disk (MBR/GPT and backup GPT)" "echo \"\$OUT\" | grep -q 'of=/dev/sda bs=1M count=8 conv' && echo \"\$OUT\" | grep -q 'of=/dev/sda bs=1M count=8 seek=29319'"
check "disk without partitions done too" "echo \"\$OUT\" | grep -q 'wipefs -a -f /dev/sdb' && echo \"\$OUT\" | grep -q 'blkdiscard -f /dev/sdb'"
check "boot card done after the USB disks" "[ \$(line 'wipefs -a -f /dev/mmcblk0p1') -gt \$(line 'blkdiscard -f /dev/sdb') ]"
check "boot card discarded last in the fast step" "[ \$(line 'blkdiscard -f /dev/mmcblk0') -gt \$(line 'of=/dev/mmcblk0 bs=1M count=8 seek') ] && [ \$(line 'blkdiscard -f /dev/mmcblk0') -lt \$(line 'BG ') ]"
check "full passes over every disk, repeated" "[ \$(echo \"\$OUT\" | grep -c 'BG dd if=/dev/urandom of=/dev/') = 6 ] && echo \"\$OUT\" | grep -q 'WAIT pass 2'"
check "loop, zram, optical, device-mapper, eMMC boot/rpmb untouched" "! echo \"\$OUT\" | grep -Eq '/dev/(loop0|zram0|sr0|dm-0|mmcblk0boot0|mmcblk0rpmb)'"
check "nothing logged (no logger / log file)" "! grep -Eq 'logger|>> *[^&]*\\.log' '$W'"
check "whole script is one function, run after it is read" "grep -q '^main() {' '$W' && tail -2 '$W' | grep -q 'main \"\$@\"'"
echo "$P passed, $F failed"; [ $F = 0 ]
