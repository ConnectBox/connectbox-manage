// Tests hostsWithName (2026-11-11): the /etc/hosts text set.hostname writes when the
// box's host name changes.  Pure text in, text out: no file or program is touched.
// Run: node test_hostname.js /path/to/functions.js
const F = require(process.argv[2]);
let pass = 0, fail = 0;
const check = (n, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log('FAIL', n, 'got', JSON.stringify(got), 'want', JSON.stringify(want)); } };

// /etc/hosts as found on the CM5 test box (the name had been saved as MORTON but not applied)
const BOX = ['127.0.0.1\tlocalhost', '::1\t\tlocalhost ip6-localhost ip6-loopback', 'ff02::1\t\tip6-allnodes', '',
  '# box', '127.0.1.1\tconnectbox', '', '127.0.0.1  Connectbox', '127.0.0.1  learn.Connectbox', '', '10.129.0.1 Connectbox', ''].join('\n');
const out = F.hostsWithName(BOX, ['MORTON', 'Connectbox'], 'MORTON').split('\n');
check('127.0.1.1 line gets the new name', out[5], '127.0.1.1\tMORTON');
check('own name on 127.0.0.1 renamed, spacing kept', out[7], '127.0.0.1  MORTON');
check('sub-name (learn.<old>) renamed', out[8], '127.0.0.1  learn.MORTON');
check('AP address line renamed', out[10], '10.129.0.1 MORTON');
check('localhost, IPv6 lines, comment and blank lines unchanged', [out[0], out[1], out[2], out[3], out[4], out[11]], BOX.split('\n').filter((l, i) => [0, 1, 2, 3, 4, 11].includes(i)));
check('same number of lines', out.length, BOX.split('\n').length);

check('no 127.0.1.1 line: one is added before the final newline', F.hostsWithName('127.0.0.1 localhost\n', ['old'], 'new'), '127.0.0.1 localhost\n127.0.1.1\tnew\n');
check('no final newline: line still added', F.hostsWithName('127.0.0.1 localhost', ['old'], 'new'), '127.0.0.1 localhost\n127.0.1.1\tnew');
check('old name matched in any case', F.hostsWithName('127.0.1.1 x\n10.0.0.1 MyBox mybox.lan\n', ['mybox'], 'lib'), '127.0.1.1 lib\n10.0.0.1 lib mybox.lan\n');
check('a name that only contains the old name is kept', F.hostsWithName('127.0.1.1 x\n10.0.0.1 notmybox mybox2\n', ['mybox'], 'lib'), '127.0.1.1 lib\n10.0.0.1 notmybox mybox2\n');
check('comment after the names kept', F.hostsWithName('127.0.1.1 old # own name\n', ['old'], 'new'), '127.0.1.1 new # own name\n');
check('"localhost" as the old name renames nothing', F.hostsWithName('127.0.0.1 localhost\n127.0.1.1 box\n', ['localhost'], 'new'), '127.0.0.1 localhost\n127.0.1.1 new\n');
check('running it again changes nothing', F.hostsWithName(out.join('\n'), ['MORTON', 'MORTON'], 'MORTON'), out.join('\n'));

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
