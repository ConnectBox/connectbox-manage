// set.wipe starts scripts/wipe.sh by its full path, detached; a wrong word starts nothing.
// No program is run (child_process.spawn is replaced).  Run: node test_wipe_start.js /path/to/functions.js
const fs = require('fs'), cp = require('child_process'), path = require('path');
const BRAND = '/usr/local/connectbox/brand.j2';
const rf = fs.readFileSync;
fs.readFileSync = (p, ...a) => p === BRAND ? (a.length ? '{"Brand":"Connectbox"}' : Buffer.from('{"Brand":"Connectbox"}')) : rf.call(fs, p, ...a);
const started = [];
for (const f of ['spawn', 'exec', 'execFile']) cp[f] = function (cmd, args, opts) { started.push({ f, cmd, args, opts }); return { on() {}, unref() { this.unrefd = true; } }; };
const F = require(process.argv[2]);
let pass = 0, fail = 0;
const check = (n, ok, d) => { if (ok) pass++; else { fail++; console.log('FAIL', n, JSON.stringify(d)); } };
check('wrong word refused', F.set.wipe({ value: 'nope' }) === false && started.length === 0, started);
check('right word accepted', F.set.wipe({ value: 'wipethebox' }) === true, started);
const s = started[0] || {};
const script = path.join(path.dirname(process.argv[2]), 'scripts', 'wipe.sh');
check('started with spawn (no shell)', s.f === 'spawn', s);
check('in its own session: setsid bash <full path of wipe.sh>', s.cmd === '/usr/bin/setsid' && s.args && s.args[0] === '/bin/bash' && s.args[1] === script && path.isAbsolute(s.args[1]), s);
check('the script exists there', fs.existsSync(script), script);
check('detached, no output kept', s.opts && s.opts.detached === true && s.opts.stdio === 'ignore', s.opts);
console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
