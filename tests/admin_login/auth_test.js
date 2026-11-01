// set.password from the real functions.js, run on its own
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const m = src.match(/set\.password = function \(json\)\{[\s\S]*?\n\}/); if (!m) throw 'set.password not found';
const set = {}; eval(m[0]);
const BASE = 'http://127.0.0.1:8766/admin/api/auth';
const login = pw => fetch(BASE, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: pw})}).then(r => r.status);
const res = []; const ok = (n, c) => res.push((c ? 'PASS ' : 'FAIL ') + n);
(async () => {
  const proofs = ['/tmp/cbp1', '/tmp/cbp2', '/tmp/cbp3', '/tmp/cbp4'];
  proofs.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
  ok('set.password("connectbox") ok', set.password({value: 'connectbox'}) === true);
  ok('same hash as the old "echo" way for a normal password',
     fs.readFileSync('/usr/local/connectbox/etc/basicauth', 'utf8') ===
     'admin:' + require('child_process').execSync('echo connectbox | openssl passwd -apr1 -salt CBOX2018 -stdin').toString().trim());
  ok('right password accepted', await login('connectbox') === 200);
  ok('wrong password refused', await login('connectbo') === 401);
  for (const [pw, p] of [['x; touch /tmp/cbp1 #', '/tmp/cbp1'], ['$(touch /tmp/cbp2)', '/tmp/cbp2'], ['`touch /tmp/cbp3`', '/tmp/cbp3']]) {
    const st = await login(pw);
    ok('login form command ' + JSON.stringify(pw) + ' refused and not run', st === 401 && !fs.existsSync(p));
  }
  ok('password with a line break refused', await login('connectbox\nanything') === 401);
  ok('empty password refused', await login('') === 401);
  ok('non-text password refused', await login(12345) === 401);
  const odd = "a  b*;$(touch /tmp/cbp4) 'q' \\n";
  ok('set.password with shell characters stores it', set.password({value: odd}) === true && !fs.existsSync('/tmp/cbp4'));
  ok('that exact password then logs in', await login(odd) === 200);
  ok('a shell-mangled version does not', await login('a b*;') === 401);
  ok('set.password refuses a line break', set.password({value: 'x\ny'}).status === 400);
  ok('set.password refuses empty', set.password({value: ''}).status === 400 && set.password({}).status === 400);
  fs.writeFileSync('/tmp/cb_odd_pw', odd);
  console.log(res.join('\n'));
})();
