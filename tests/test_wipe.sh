#!/bin/bash
# Dry run of src/scripts/wipe.sh against a fake /sys, /media and SD card tree:
# checks what it destroys and in what order.  Nothing is written or deleted
# (WIPE_DRY_RUN=1 prints the commands instead of running them).
# usage: bash tests/test_wipe.sh [path/to/wipe.sh]
W=${1:-$(dirname "$0")/../src/scripts/wipe.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
S=$T/sys; M=$T/media; R=$T/root
# SD card mmcblk0 (holds /: 2 partitions, eMMC boot/rpmb areas), USB key sda
#  (1 partition), USB disk sdb (no partition table), loop0, zram0, sr0, dm-0
mkdir -p $S/block/mmcblk0/mmcblk0p1 $S/block/mmcblk0/mmcblk0p2 $S/block/mmcblk0boot0 $S/block/mmcblk0rpmb \
         $S/block/sda/sda1 $S/block/sdb $S/block/loop0 $S/block/zram0 $S/block/sr0 $S/block/dm-0 $M/usb0 $M/usb11 \
         $R/var/www/enhanced/content/www/assets/content $R/var/lib/connectbox/kiwix $R/tmp $R/var/tmp $R/root/.pm2/logs $R/var/log
# swap: zram0 with a loop writeback device backed by /var/swap; a swap file /extra.swap; a swap partition
mkdir -p $S/block/zram0 $S/block/loop0/loop $T/proc; echo /dev/loop0 > $S/block/zram0/backing_dev; touch $S/block/zram0/reset
echo /var/swap > $S/block/loop0/loop/backing_file
printf 'Filename\tType\tSize\tUsed\tPriority\n/dev/zram0 partition 2097148 0 100\n/extra.swap file 1024 0 -2\n/var/swap file 2048 0 -3\n' > $T/proc/swaps
head -c 3000000 /dev/zero > $R/var/swap; head -c 100 /dev/zero > $R/extra.swap
touch $S/block/mmcblk0/mmcblk0p1/partition $S/block/mmcblk0/mmcblk0p2/partition $S/block/sda/sda1/partition
echo 125042688 > $S/block/mmcblk0/size; echo 60062500 > $S/block/sda/size; echo 8 > $S/block/sdb/size
OUT=$(WIPE_DRY_RUN=1 WIPE_PROC=$T/proc WIPE_SYS=$S WIPE_DEV=/dev WIPE_MEDIA=$M WIPE_ROOTFS=$R WIPE_ROOT_DISK=mmcblk0 WIPE_PASSES=2 bash "$W")
P=0; F=0
check() { if eval "$2"; then P=$((P+1)); else F=$((F+1)); echo "FAIL $1"; fi; }
line() { echo "$OUT" | grep -n -m1 -F -- "$1" | cut -d: -f1; }
has() { echo "$OUT" | grep -q -F -- "$1"; }
check "script syntax" "bash -n '$W'"
check "services stopped before anything is touched" "[ \$(line 'systemctl stop nginx') -lt \$(line 'wipefs') ]"
check "cron, access point, chat server and pm2 stopped" "has 'systemctl stop cron' && has 'systemctl stop hostapd' && has 'systemctl stop gunicorn' && has '/usr/bin/pm2 kill'"
check "Wi-Fi not started again" "! has 'start hostapd' && ! has 'restart hostapd'"
check "USB keys unmounted (usb0 and usb11)" "has \"umount -l $M/usb0\" && has \"umount -l $M/usb11\""
check "USB key partition: signatures and first 32 MiB" "has 'wipefs -a -f /dev/sda1' && has 'of=/dev/sda1 bs=1M count=32'"
check "USB key: start and end of the disk" "has 'of=/dev/sda bs=1M count=8 conv' && has 'of=/dev/sda bs=1M count=8 seek=29319'"
check "disk without partitions destroyed too" "has 'wipefs -a -f /dev/sdb' && has 'blkdiscard -f /dev/sdb'"
check "the SD card's disk and partitions are never written" "! echo \"\$OUT\" | grep -q '/dev/mmcblk0'"
check "SD media deleted: usb0 folder, menus, Kiwix list, temp folders, pm2 logs" "has \"DELETE $M/usb0/*\" && has \"DELETE $R/var/www/enhanced/content/www/assets/content/*\" && has \"DELETE $R/var/lib/connectbox/kiwix/*\" && has \"DELETE $R/tmp/*\" && has \"DELETE $R/root/.pm2/logs/*\""
check "chat database and HDMI playlist removed" "has \"rm -f $R/usr/local/connectbox/var/cbchat.db\" && has \"rm -f $R/usr/local/connectbox/hdmi/playlist.json\""
check "every log file deleted" "has \"DELETE $R/var/log files\""
check "USB keys done before the SD media" "[ \$(line 'blkdiscard -f /dev/sdb') -lt \$(line \"DELETE $M/usb0\") ]"
check "freed blocks trimmed right after the delete" "[ \$(line \"fstrim $R/\") -gt \$(line \"DELETE $R/var/log files\") ] && [ \$(line \"fstrim $R/\") -lt \$(line 'BG ') ]"
check "full passes: USB keys overwritten, card free space filled then freed and trimmed" "[ \$(echo \"\$OUT\" | grep -c 'BG nice -n 19 ionice -c 3 dd if=/dev/urandom of=/dev/sd') = 4 ] && [ \$(echo \"\$OUT\" | grep -c \"of=$R/var/.cbwipe-fill\") = 2 ] && [ \$(echo \"\$OUT\" | grep -c \"rm -f $R/var/.cbwipe-fill\") = 2 ] && has 'WAIT pass 2'"
check "full passes at idle priority, fast step not" "[ \$(echo \"\$OUT\" | grep -c 'nice -n 19 ionice -c 3 dd') = 6 ] && ! echo \"\$OUT\" | grep 'count=32' | grep -q nice"
check "swap off and zram reset before the swap files are overwritten" "[ \$(line 'swapoff -a') -lt \$(line \"of=$R/var/swap\") ] && has \"echo 1 > $S/block/zram0/reset\""
check "swap files overwritten in place, whole, once each (/var/swap from zram's loop and /proc/swaps)" "has \"of=$R/var/swap bs=1M count=3 conv=notrunc,fsync\" && has \"of=$R/extra.swap bs=1M count=1 conv=notrunc,fsync\" && [ \$(echo \"\$OUT\" | grep -c \"of=$R/var/swap \") = 1 ]"
check "swap partition (zram) itself not written as a file" "! has 'of=/dev/zram0'"
check "swap done after the USB keys, before the media is deleted" "[ \$(line 'swapoff -a') -gt \$(line 'blkdiscard -f /dev/sdb') ] && [ \$(line 'swapoff -a') -lt \$(line \"DELETE $M/usb0\") ]"
check "loop, zram, optical, device-mapper, eMMC boot/rpmb untouched" "! echo \"\$OUT\" | grep -Eq '/dev/(loop0|zram0|sr0|dm-0|mmcblk0boot0|mmcblk0rpmb)'"
check "nothing logged by the script" "! grep -Eq 'logger |>> *[^&]*\\.log' '$W'"
check "whole script is one function, run after it is read" "grep -q '^main() {' '$W' && tail -2 '$W' | grep -q 'main \"\$@\"'"
echo "$P passed, $F failed"; [ $F = 0 ]
