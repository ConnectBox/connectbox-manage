// Tests set/get clientssid and clientpassphrase on sample wpa_supplicant.conf files.
// Run on a box: node test_clientwifi.js /path/to/functions.js
const fs = require('fs'), cp = require('child_process');
const WPA = '/etc/wpa_supplicant/wpa_supplicant.conf';
let file = '';
const rf = fs.readFileSync, wf = fs.writeFileSync, es = cp.execSync;
// functions.js reads brand.j2 when it loads; use a sample when this machine has none
const BRAND = '/usr/local/connectbox/brand.j2', SAMPLE = '{"Brand":"Connectbox","Font":27,"pos_x":6,"pos_y":0}';
fs.readFileSync = function (p, ...a) {
  if (p === BRAND && !fs.existsSync(BRAND)) return a.length ? SAMPLE : Buffer.from(SAMPLE);
  return p === WPA ? (a.length ? file : Buffer.from(file)) : rf.call(fs, p, ...a); };
fs.writeFileSync = function (p, d, ...a) { if (p === WPA) { file = String(d); return; } return wf.call(fs, p, d, ...a); };
cp.execSync = function (c, ...a) { if (c.includes(WPA)) { wf('/tmp/wpa_test.conf', file); c = c.split(WPA).join('/tmp/wpa_test.conf'); } return es.call(cp, c, ...a); };
const f = require(process.argv[2]);
const get = f.get, set = f.set;
let pass = 0, fail = 0;
function check(name, got, want) { if (got === want) { pass++; } else { fail++; console.log('FAIL ' + name + '\n got:  ' + JSON.stringify(got) + '\n want: ' + JSON.stringify(want)); } }
const base = 'country=US\nctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev\nupdate_config=1\n\n# This can be updated by ConnectBoxManage.sh\nnetwork={\nssid="Default"\npsk="secret1"\n}';
// 1. as built
file = base;
check('get ssid built', String(get.clientssid()).trim(), 'Default');
check('get psk built', String(get.clientpassphrase()).trim(), 'secret1');
set.clientssid({value: 'MyNet'}); set.clientpassphrase({value: 'pw2'});
check('set built', file, base.replace('"Default"', '"MyNet"').replace('"secret1"', '"pw2"'));
// 2. scan_ssid and key_mgmt added by hand, indented
const hidden = 'country=US\nnetwork={\n\tssid="Default"\n\tscan_ssid=1\n\tkey_mgmt=WPA-PSK\n\tpsk="secret1"\n}';
file = hidden;
check('get ssid hidden', String(get.clientssid()).trim(), 'Default');
set.clientssid({value: 'Hidden Net'});
check('set hidden keeps scan_ssid=1', file, hidden.replace('"Default"', '"Hidden Net"'));
// 3. two network blocks: only the first changes
const two = 'network={\nssid="One"\npsk="p1"\n}\nnetwork={\nssid="Two"\npsk="p2"\n}';
file = two;
check('get ssid two', String(get.clientssid()).trim(), 'One');
check('get psk two', String(get.clientpassphrase()).trim(), 'p1');
set.clientssid({value: 'New'}); set.clientpassphrase({value: 'np'});
check('set two: first block only', file, two.replace('"One"', '"New"').replace('"p1"', '"np"'));
// 4. refused values leave the file alone
file = base;
const r = set.clientssid({value: 'bad"name'});
check('refused quote status', r && r.status, 400);
check('refused leaves file', file, base);
console.log(pass + ' passed, ' + fail + ' failed');
try { fs.unlinkSync('/tmp/wpa_test.conf'); } catch (e) {}
process.exit(fail ? 1 : 0);
