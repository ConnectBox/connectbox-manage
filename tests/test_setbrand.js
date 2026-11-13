// Tests setBrand / set.securitykey (fix 66) on a copy of brand.j2; no real file or program is touched.
// Run on a box: node test_setbrand.js /path/to/functions.js
const fs = require('fs'), cp = require('child_process');
const BRAND = '/usr/local/connectbox/brand.j2';
// The box's brand.j2 when there is one; otherwise a sample with the keys the checks use
const SAMPLE = JSON.stringify({Brand: 'Connectbox', Font: 27, pos_x: 6, pos_y: 0, usb0NoMount: 0, lcd_pages_main: 1,
  lcd_pages_stats_hour_one: 1, lcd_pages_stats_day_one: 1, lcd_pages_admin: 1, server_url: '', server_authorization: '',
  server_sitename: '', server_siteadmin_phone: ''});
let file = fs.existsSync(BRAND) ? fs.readFileSync(BRAND, 'utf8') : SAMPLE, launched = [];
const rf = fs.readFileSync, wf = fs.writeFileSync, rn = fs.renameSync, ch = fs.chmodSync, co = fs.chownSync, st = fs.statSync;
fs.readFileSync = (p, ...a) => p === BRAND ? (a.length ? file : Buffer.from(file)) : rf.call(fs, p, ...a);
fs.writeFileSync = (p, d, ...a) => String(p).startsWith(BRAND + '.tmp') ? (file = String(d)) : wf.call(fs, p, d, ...a);
fs.renameSync = (a, b) => String(a).startsWith(BRAND + '.tmp') ? undefined : rn.call(fs, a, b);
fs.chmodSync = (p, ...a) => String(p).startsWith(BRAND + '.tmp') ? undefined : ch.call(fs, p, ...a);
fs.chownSync = (p, ...a) => String(p).startsWith(BRAND + '.tmp') ? undefined : co.call(fs, p, ...a);
for (const f of ['spawn', 'execFile', 'exec']) { const o = cp[f]; cp[f] = function (cmd, args) { launched.push(cmd + ' ' + JSON.stringify(args || '')); return { on() {}, unref() {}, stdout: { on() {} }, stderr: { on() {} } }; }; }
const F = require(process.argv[2]);
const b = () => JSON.parse(file);
let pass = 0, fail = 0;
const check = (n, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log('FAIL', n, 'got', JSON.stringify(got), 'want', JSON.stringify(want)); } };
F.set.securitykey({ value: '405b2056-8b5d-40c6-b64e-a4275e0c4a1d' });
check('securitykey stored as text', b().server_authorization, '405b2056-8b5d-40c6-b64e-a4275e0c4a1d');
check('securitykey launches nothing (no wget)', launched.filter(x => x.includes('wget')), []);
F.setBrand({ value: 'server_authorization=abc==' });  check('value with = kept whole', b().server_authorization, 'abc==');
F.setBrand({ value: 'Font=27' });                     check('Font number', b().Font, 27);
F.setBrand({ value: 'lcd_pages_main=0' });            check('lcd_pages_main 0 number', b().lcd_pages_main, 0);
F.setBrand({ value: 'pos_x=-3' });                    check('negative number', b().pos_x, -3);
F.setBrand({ value: 'Brand=12 Stones Library' });     check('text starting with digits stays text', b().Brand, '12 Stones Library');
F.setBrand({ value: 'brand=ConnectBox Test' });       check('case-insensitive key', b().Brand, 'ConnectBox Test');
F.setBrand({ value: 'lcd_pages_stats=0' });
check('lcd_pages_stats fan-out', Object.keys(b()).filter(k => k.startsWith('lcd_pages_stats_')).every(k => b()[k] === 0), true);
check('no lcd_pages_stats alias kept', 'lcd_pages_stats' in b(), false);
F.setBrand({ value: 'server_siteadmin_phone=0123 456' }); check('phone stays text', b().server_siteadmin_phone, '0123 456');
// IP addresses page switch (2026-11-13): on when brand.j2 lacks it, then as saved
{ const o = b(); delete o.lcd_pages_network; delete o.lcd_pages_internet; delete o.lcd_pages_internet_auto; o.internet_sharing = 0; file = JSON.stringify(o); }
check('lcd_pages_network missing reads 1', F.getBrand('lcd_pages_network'), 1);
check('other missing key still reads 0', F.getBrand('lcd_pages_no_such_page'), 0);
F.setBrand({ value: 'lcd_pages_network=0' });  check('lcd_pages_network off saved as number', b().lcd_pages_network, 0);
check('lcd_pages_network off reads 0', F.getBrand('lcd_pages_network'), 0);
// Internet Data page switch follows internet sharing (Kirk, 2026-11-13)
check('lcd_pages_internet missing, sharing off: reads 0', F.getBrand('lcd_pages_internet'), 0);
{ const o = b(); o.internet_sharing = 1; file = JSON.stringify(o); }
check('lcd_pages_internet missing, sharing on: reads 1', F.getBrand('lcd_pages_internet'), 1);
{ const o = b(); o.internet_sharing = 0; o.lcd_pages_internet = 0; file = JSON.stringify(o); }
F.setBrand({ value: 'internet_sharing=1' });
check('sharing on turns the page switch on', b().lcd_pages_internet, 1);
check('... marked as turned on by sharing', b().lcd_pages_internet_auto, 1);
F.setBrand({ value: 'internet_sharing=0' });
check('sharing off turns it off again', b().lcd_pages_internet, 0);
check('... and clears the mark', b().lcd_pages_internet_auto, 0);
F.setBrand({ value: 'lcd_pages_internet=1' });
check('admin turns the page on by hand', [b().lcd_pages_internet, b().lcd_pages_internet_auto], [1, 0]);
F.setBrand({ value: 'internet_sharing=1' }); F.setBrand({ value: 'internet_sharing=0' });
check('sharing on and off leaves a page the admin turned on', b().lcd_pages_internet, 1);
F.setBrand({ value: 'lcd_pages_internet=0' }); F.setBrand({ value: 'internet_sharing=1' });
check('sharing on again turns it on', b().lcd_pages_internet, 1);
F.setBrand({ value: 'lcd_pages_internet=0' });
check('admin turns it off while sharing is on: stays off', [b().lcd_pages_internet, b().lcd_pages_internet_auto], [0, 0]);
F.setBrand({ value: 'internet_sharing=0' });
check('... and sharing off then changes nothing', b().lcd_pages_internet, 0);
F.setBrand({ value: 'lcd_pages_internet=1' }); F.setBrand({ value: 'internet_sharing=1' });
check('sharing on while the admin has it on: no mark', [b().lcd_pages_internet, b().lcd_pages_internet_auto], [1, 0]);
F.setBrand({ value: 'internet_sharing=0' });
check('... so sharing off keeps it on', b().lcd_pages_internet, 1);
console.log(pass + ' passed, ' + fail + ' failed' + (fs.existsSync(BRAND) ? '; real brand.j2 untouched' : ' (sample brand.j2)'));
process.exit(fail ? 1 : 0);
