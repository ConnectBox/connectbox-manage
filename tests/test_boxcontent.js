// Box Content endpoints (2026-11-13): set.boxcontent writes the hat service's
// request file and a "queued" status; get.boxcontent reads the status back.
// The files go to a temporary folder (CB_RUN_DIR).  Run: node test_boxcontent.js /path/to/functions.js
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbrun-'));
process.env.CB_RUN_DIR = dir;
const BRAND = '/usr/local/connectbox/brand.j2', rf = fs.readFileSync;
fs.readFileSync = (p, ...a) => p === BRAND ? (a.length ? '{"Brand":"Connectbox"}' : Buffer.from('{"Brand":"Connectbox"}')) : rf.call(fs, p, ...a);
const F = require(process.argv[2]);
const REQ = path.join(dir, 'boxcontent_request.json'), ST = path.join(dir, 'boxcontent_status.json');
const read = (p) => JSON.parse(rf.call(fs, p, 'utf8'));
let pass = 0, fail = 0;
const check = (n, ok, d) => { if (ok) pass++; else { fail++; console.log('FAIL', n, JSON.stringify(d)); } };
check('no status yet: idle', F.get.boxcontent().state === 'idle', F.get.boxcontent());
check('unknown command refused (400), nothing written', F.set.boxcontent({ value: 'erase_folder' }).status === 400 && !fs.existsSync(REQ));
check('missing value refused', F.set.boxcontent(undefined).status === 400);
const r = F.set.boxcontent({ value: 'copy_to_usb' });
check('copy_to_usb accepted: an id, no error status', r && r.id && !r.status, r);
const q = read(REQ);
check('request file: command, id, time', q.command === 'copy_to_usb' && q.id === r.id && Math.abs(q.time - Date.now() / 1000) < 5, q);
const s = F.get.boxcontent();
check('status at once: queued / Starting, source web, same id, age 0', s.state === 'queued' && s.text === 'Starting' && s.source === 'web' && s.id === r.id && s.age <= 1, s);
check('second request while queued: 409 Busy', F.set.boxcontent({ value: 'copy_from_usb' }).status === 409);
fs.writeFileSync(ST, JSON.stringify({ state: 'running', text: 'Copying 45%', time: Date.now() / 1000 - 30 }));
const b = F.set.boxcontent({ value: 'copy_from_usb' });
check('while a copy runs (panel or web): 409 with its step', b.status === 409 && b.message === 'Busy: Copying 45%', b);
fs.writeFileSync(ST, JSON.stringify({ state: 'running', text: 'Insert USB key', time: Date.now() / 1000 - 400 }));
check('a "running" status older than 6 min (hat service gone) no longer blocks', F.set.boxcontent({ value: 'copy_from_usb' }).id !== undefined);
fs.writeFileSync(ST, JSON.stringify({ state: 'done', text: 'Done', time: Date.now() / 1000 - 2 }));
check('after done: a new copy can start', F.set.boxcontent({ value: 'copy_to_usb' }).id !== undefined);
fs.writeFileSync(ST, '{broken');
check('unreadable status: idle', F.get.boxcontent().state === 'idle');
check('no temporary files left', fs.readdirSync(dir).every(f => !f.includes('.tmp')), fs.readdirSync(dir));
check('status answer has no "status" field (the API would send it as an HTTP error)', !('status' in F.get.boxcontent()));
console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
