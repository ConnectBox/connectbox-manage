// set.wipe starts scripts/wipe.sh by its full path, detached, only for the admin password;
// a wrong password (or the old word wipethebox) starts nothing and gets a 403.
// No program is run (child_process.spawn is replaced).  Run: node test_wipe_start.js /path/to/functions.js
const fs = require('fs'), cp = require('child_process'), path = require('path');
const BRAND = '/usr/local/connectbox/brand.j2';
const rf = fs.readFileSync;
// Admin password "secret 1" (hash made with the real openssl before spawn is replaced)
const HASH = require('child_process').execFileSync('openssl', ['passwd', '-apr1', '-salt', 'CBOX2018', '-stdin'], {input: 'secret 1\n'}).toString().trim();
const AUTH = '/usr/local/connectbox/etc/basicauth';
fs.readFileSync = (p, ...a) => p === BRAND ? (a.length ? '{"Brand":"Connectbox"}' : Buffer.from('{"Brand":"Connectbox"}'))
  : p === AUTH ? 'admin:' + HASH + '\n' : rf.call(fs, p, ...a);
const started = [];
for (const f of ['spawn', 'exec', 'execFile']) cp[f] = function (cmd, args, opts) { started.push({ f, cmd, args, opts }); return { on() {}, unref() { this.unrefd = true; } }; };
const F = require(process.argv[2]);
let pass = 0, fail = 0;
const check = (n, ok, d) => { if (ok) pass++; else { fail++; console.log('FAIL', n, JSON.stringify(d)); } };
const no = (v) => { const r = F.set.wipe({ value: v }); return r && r.status === 403 && started.length === 0; };
check('wrong password refused with 403, nothing started', no('nope'), started);
check('the old word wipethebox no longer wipes', no('wipethebox'), started);
check('empty / multi-line / missing refused', no('') && no('secret 1\nx') && F.set.wipe(undefined).status === 403 && started.length === 0, started);
check('admin password accepted', F.set.wipe({ value: 'secret 1' }) === true, started);
const s = started[0] || {};
const script = path.join(path.dirname(process.argv[2]), 'scripts', 'wipe.sh');
check('started with spawn (no shell)', s.f === 'spawn', s);
check('in its own session: setsid bash <full path of wipe.sh>', s.cmd === '/usr/bin/setsid' && s.args && s.args[0] === '/bin/bash' && s.args[1] === script && path.isAbsolute(s.args[1]), s);
check('the script exists there', fs.existsSync(script), script);
check('detached, no output kept', s.opts && s.opts.detached === true && s.opts.stdio === 'ignore', s.opts);
console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
