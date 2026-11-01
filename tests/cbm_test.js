// Fix 48c: connectbox-manage setters - old (shell + sed) vs new (Node edits).
// usage: node cbm_test.js <old repo dir> <new repo dir>      (run as root in a throwaway test container)
// It writes /etc/hostapd, /etc/wpa_supplicant, /etc/nginx, /usr/local/connectbox/brand.j2 and /var/www/enhanced.
// The last section needs the fake sudo from fake_sudo.sh first in PATH (see README).
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [OLD, NEW] = process.argv.slice(2);
let P = 0, F = 0;
const check = (name, ok, detail) => { ok ? P++ : F++; console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + (ok ? '' : ': ' + detail)); };
const FILES = {
  '/etc/hostapd/hostapd.conf': 'interface=wlan1\ndriver=nl80211\nssid=ConnectBox - Free Media\nhw_mode=g\nchannel=7\ncountry_code=US\n#bssid=00:11\n',
  '/etc/wpa_supplicant/wpa_supplicant.conf': 'ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev\nupdate_config=1\ncountry=US\n\nnetwork={\n\tssid="Old"\n\tpsk="oldpass1"\n}\n',  // no scan_ssid line: the old sed renamed it (fixed later, see test_clientwifi.js)
  '/etc/nginx/sites-enabled/connectbox_enhanced.conf': 'server {\n    listen 80;\n    server_name connectbox .local connectbox;\n    root /var/www;\n}\n',
};
const reset = (extra) => { for (const [f, c] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(f, c); }
  if (extra) extra(); try { fs.unlinkSync('/tmp/pwned'); } catch (e) {} try { fs.unlinkSync('/tmp/cbm_sudo_calls.log'); } catch (e) {} };
const snap = () => Object.keys(FILES).map(f => fs.readFileSync(f, 'utf8')).join('\n=====\n');
const load = (dir) => { delete require.cache[require.resolve(dir + '/src/functions.js')]; return require(dir + '/src/functions.js'); };
// functions.js reads brand.j2 when it loads; give the test container a sample one
if (!fs.existsSync('/usr/local/connectbox/brand.j2')) { fs.mkdirSync('/usr/local/connectbox', {recursive: true});
  fs.writeFileSync('/usr/local/connectbox/brand.j2', '{"Brand":"Connectbox","Font":27,"pos_x":6,"pos_y":0}'); }
fs.mkdirSync('/var/www/enhanced/content/www/assets/content', {recursive: true});  // subscription.json lives here
const oldF = load(OLD), newF = load(NEW);
const run = (fns, key, value, extra) => { reset(extra); let r; try { r = fns.set[key]({value}); } catch (e) { r = 'THROW ' + e.message; } return {r, files: snap(), pwned: fs.existsSync('/tmp/pwned')}; };

console.log('== ordinary values: files identical to the old sed commands');
const normal = [['apssid', 'MyBox 2'], ['appassphrase', 'secret123'], ['appassphrase', 'short'], ['apchannel', '6'],
  ['clientssid', 'Home WiFi'], ['clientpassphrase', 'pass word!'], ['clientcountry', 'GB'], ['clientcountry', '']];
for (const [k, v] of normal) {
  const a = run(oldF, k, v), b = run(newF, k, v);
  check(`${k}=${JSON.stringify(v)}: same files`, a.files === b.files, '\nOLD:\n' + a.files + '\nNEW:\n' + b.files);
  check(`${k}=${JSON.stringify(v)}: same result`, JSON.stringify(a.r) === JSON.stringify(b.r), JSON.stringify([a.r, b.r]));
}
// passphrase added when the network was open (no wpa_passphrase line yet)
{ const a = run(oldF, 'appassphrase', 'newsecret9'), b = run(newF, 'appassphrase', 'newsecret9');
  check('appassphrase on an open network: same files (line added)', a.files === b.files && b.files.includes('wpa_passphrase=newsecret9\n'), '\n' + a.files + '\n---\n' + b.files);
  const withLine = () => fs.appendFileSync('/etc/hostapd/hostapd.conf', 'wpa_passphrase=oldsecret1\n');
  const c = run(oldF, 'appassphrase', 'changed99', withLine), d = run(newF, 'appassphrase', 'changed99', withLine);
  check('appassphrase changing an existing one: same files', c.files === d.files, '\n' + c.files + '\n---\n' + d.files);
  const e = run(oldF, 'appassphrase', 'x', withLine), g = run(newF, 'appassphrase', 'x', withLine);
  check('appassphrase under 8 characters removes it: same files', e.files === g.files, '\n' + e.files + '\n---\n' + g.files); }
// hostname (also writes /etc/hostname and brand; compare nginx + hostname file)
{ const h = () => fs.readFileSync('/etc/hostname', 'utf8');
  const a = run(oldF, 'hostname', 'connectbox2'); const ah = h(); const b = run(newF, 'hostname', 'connectbox2'); const bh = h();
  check('hostname: same nginx file and /etc/hostname', a.files === b.files && ah === bh && bh === 'connectbox2', '\n' + a.files + '\n---\n' + b.files); }

console.log('== injection attempts: old runs them, new does not');
const inj = 'x"; touch /tmp/pwned; echo "';
for (const k of ['apssid', 'appassphrase', 'apchannel', 'clientssid', 'clientpassphrase', 'clientcountry', 'hostname']) {
  const v = k === 'appassphrase' ? "abcdefgh'; touch /tmp/pwned; echo '" : (k === 'apchannel' || k === 'clientcountry') ? '6$(touch /tmp/pwned)' : inj;
  const a = run(oldF, k, v), b = run(newF, k, v);
  check(`${k}: old code ran the command (shows the hole)`, a.pwned || k === 'hostname', 'old did not run it');
  check(`${k}: new code runs nothing`, !b.pwned, 'pwned');
}
for (const k of ['apssid', 'clientssid', 'clientpassphrase']) {
  const v = 'a$(touch /tmp/pwned)b';
  const b = run(newF, k, v); check(`${k} $(...): nothing run`, !b.pwned, 'pwned');
}
console.log('== values the old sed could not write');
{ const b = run(newF, 'apssid', 'Café/Shop & Co');
  check('apssid with / and &: written as typed', b.files.includes('\nssid=Café/Shop & Co\n'), b.files); }
{ const b = run(newF, 'appassphrase', 'p&ss/w\\ord1', () => fs.appendFileSync('/etc/hostapd/hostapd.conf', 'wpa_passphrase=oldsecret1\n'));
  check('appassphrase with & / \\: written as typed', b.files.includes('\nwpa_passphrase=p&ss/w\\ord1\n'), b.files); }
console.log('== refused values (HTTP 400), files unchanged');
const refusedCases = [['apssid', 'a\nchannel=1'], ['apssid', ''], ['apssid', 'x'.repeat(33)], ['appassphrase', 'abcdefgh\nssid=evil'],
  ['appassphrase', 'x'.repeat(64)], ['apchannel', '6; reboot'], ['apchannel', 'abc'], ['clientssid', 'a"b'], ['clientpassphrase', 'p"q'],
  ['clientcountry', 'USA'], ['clientcountry', 'U1'], ['hostname', 'bad host'], ['hostname', '-box'], ['hostname', 'a.b'],
  ['openwelldownload', 'http://x\nevil'], ['coursedownload', '-O/etc/passwd'], ['courseusb', '../../etc/x'], ['courseusb', 'a/b.mbz']];
for (const [k, v] of refusedCases) {
  reset(); const before = snap(); let r; try { r = newF.set[k]({value: v}); } catch (e) { r = 'THROW ' + e.message; }
  check(`${k}=${JSON.stringify(v).slice(0, 30)}: refused`, r && r.status === 400 && snap() === before, JSON.stringify(r));
}
console.log('== programs started without a shell, exact arguments');
const calls = () => { try { return fs.readFileSync('/tmp/cbm_sudo_calls.log', 'utf8'); } catch (e) { return ''; } };
const wait = (ms) => cp.execSync('sleep ' + ms / 1000);
{ reset(); const url = 'http://srv/pkg?a=1&b=$(touch /tmp/pwned)'; newF.set.openwelldownload({value: url}); wait(1500);
  check('openwelldownload: lazyLoader gets the URL as one argument, nothing run', calls().includes('/usr/local/connectbox/bin/lazyLoader.py ' + url) && !fs.existsSync('/tmp/pwned'), calls());
  check('openwelldownload: output in /tmp/loadContent.log', fs.readFileSync('/tmp/loadContent.log', 'utf8').includes('[' + url + ']'), fs.readFileSync('/tmp/loadContent.log', 'utf8')); }
(async () => {
{ reset(); const url = "http://srv/c.mbz';touch /tmp/pwned;'"; newF.set.coursedownload({value: url}); await new Promise(ok => setTimeout(ok, 1500));
  check('coursedownload: wget gets the URL as one argument after --, then php restore', calls().includes('wget -nv -O /tmp/download.mbz -o /tmp/loadContent.log -- ' + url) &&
    calls().includes('-u www-data /usr/bin/php /var/www/moodle/admin/cli/restore_backup.php --file=/tmp/download.mbz --categoryid=1') && !fs.existsSync('/tmp/pwned'), calls()); }
{ reset(); newF.set.courseusb({value: 'My Course (1).mbz'}); wait(1500);
  check('courseusb: php gets -f=/media/usb0/courses/<name> as one argument', calls().includes('-u www-data php /var/www/moodle/admin/cli/restore_backup.php -f=/media/usb0/courses/My Course (1).mbz -c=1'), calls()); }
{ reset(); newF.set.securitykey({value: 'abc$(touch /tmp/pwned)'}); wait(1500);   // fix 66: saved only, no wget
  const b = JSON.parse(fs.readFileSync('/usr/local/connectbox/brand.j2', 'utf8'));
  check('securitykey: saved as typed, nothing run (fix 66: no wget)', b.server_authorization === 'abc$(touch /tmp/pwned)' && !calls().includes('wget') && !fs.existsSync('/tmp/pwned'), JSON.stringify(b) + ' ' + calls()); }
console.log(`\nResults: ${P} passed, ${F} failed`); process.exit(F ? 1 : 0);
})();
