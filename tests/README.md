# connectbox-manage test harnesses

Tests written for the October–November 2026 fixes (26, 48, 61–66). Run `npm ci` in this repo first.

## Safe anywhere

```
bash tests/run_all.sh
```

| File | Covers |
|---|---|
| `test_clientwifi.js` | client SSID / passphrase change only the first network block; `scan_ssid` kept; refused values. Writes are kept in memory. |
| `test_setbrand.js` | setBrand number rule, `=` in values, phone kept as text, security key saved without wget. Uses the box's brand.j2 when there is one (writes intercepted), otherwise a sample. |
| `bp_test.js` | body-parser json / form / text set up as in index.js; bad JSON gives 400 |
| `test_hdmi.js` | HDMI screen control (`src/hdmi.js`, 2026-11-11): web paths checked (only video/audio/pictures in a language's media folder; `..`, other folders and `/etc/...` refused), media list skips dead links, playlist saved atomically with box paths, visitor play refused while `hdmi_visitor_play` is 0 but allowed for an admin, player reload after a playlist save. Temporary folders and a fake player socket. |
| `test_hostname.js` | `hostsWithName` (2026-11-11): the /etc/hosts text written when the host name changes - own name and `learn.<name>` renamed in any case, 127.0.1.1 line set or added, localhost / IPv6 / comments kept, running twice changes nothing. Text only: `node test_hostname.js <functions.js>`. |

Each takes the file or folder under test: `node test_clientwifi.js <functions.js>`,
`node test_setbrand.js <functions.js>`, `node bp_test.js <connectbox-manage folder>`, `node test_hdmi.js <hdmi.js>`.

## Only in a throwaway Linux container, as root

These write `/etc/hostapd`, `/etc/wpa_supplicant`, `/etc/nginx`, `/usr/local/connectbox` and `/var/www/enhanced`.

`cbm_test.js` (fix 48c): the setters, old shell + sed code against the new Node code. Ordinary values must
give byte-identical files; injection attempts run on the old code and not on the new; refused values leave
files unchanged; programs get exact argument lists. It needs the old code (commit 44a66bf) and the fake sudo:

```
git archive 44a66bf | (mkdir /tmp/cbm_old && tar -x -C /tmp/cbm_old) && (cd /tmp/cbm_old && npm install)
mkdir -p /tmp/fakebin && cp tests/fake_sudo.sh /tmp/fakebin/sudo
PATH=/tmp/fakebin:$PATH node tests/cbm_test.js /tmp/cbm_old .
```

`admin_login/` (fixes 26, 61, 62): admin password checks and the login session in a real browser
(Playwright Chromium): wrong password, 5-minute cookie, CSV download keeps the session, leaving the page /
Back / reload / Exit / closing the tab ends it, idle limit, old-style cookie refused, no command injection
through the password.

```
bash tests/admin_login/setup.sh . <admin-ui build folder> /tmp/altest   # the folder with index.html, login.html, admin.bundle.js, login.bundle.js
bash tests/admin_login/run.sh /tmp/altest
```

`setup.sh` copies `src` into the work folder with stand-ins for configs.js, logger.js and routes/api.js,
and two test hooks in index.js (serve the test pages; idle limit from `CB_IDLE_MS`).

Results on 2026-11-01 (ae78b05, Node 22): test_clientwifi 10/10 (ee1b02a: 5/10), test_setbrand 11/11
(44a66bf: 7/11), bp_test 4/4, cbm_test 62/62, admin_login 30/30 (with the admin-page build from 26 Oct).

See connectbox-pi `docs/testing.md` for all tests and when to run them.
