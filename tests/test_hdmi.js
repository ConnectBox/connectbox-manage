// Tests src/hdmi.js (HDMI screen control, 2026-11-11) against temporary folders and a fake player.
// Run: node tests/test_hdmi.js src/hdmi.js        (needs npm ci for express; changes no real files)
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), http = require('http');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cbhdmi-'));
const WEB = path.join(T, 'www'), MEDIA = path.join(WEB, 'assets/content/eng/media'), USB = path.join(T, 'usb');
fs.mkdirSync(MEDIA, {recursive: true}); fs.mkdirSync(path.join(WEB, 'assets/content/mya/media'), {recursive: true}); fs.mkdirSync(USB);
for (const f of ['film.mp4', 'song.mp3', 'photo.jpg', 'book.pdf']) { fs.writeFileSync(path.join(USB, f), 'x'); fs.symlinkSync(path.join(USB, f), path.join(MEDIA, f)); }
fs.symlinkSync(path.join(USB, 'gone.mp4'), path.join(MEDIA, 'gone.mp4'));          // dead link (key pulled out)
fs.writeFileSync(path.join(T, 'brand.j2'), JSON.stringify({Brand: 'Connectbox', hdmi_visitor_play: 0}));
Object.assign(process.env, {CB_HDMI_WEB_ROOT: WEB, CB_HDMI_PLAYLIST: path.join(T, 'hdmi/playlist.json'),
	CB_HDMI_SOCKET: path.join(T, 'hdmi.sock'), CB_HDMI_BRAND: path.join(T, 'brand.j2')});
const H = require(path.resolve(process.argv[2]));
let pass = 0, fail = 0;
const check = (n, ok, d) => { if (ok) { pass++; console.log('  [PASS] ' + n); } else { fail++; console.log('  [FAIL] ' + n + (d === undefined ? '' : ': ' + JSON.stringify(d))); } };

(async () => {
	// web path checks
	check('web path to media link', H.webToFile('assets/content/eng/media/film.mp4') === path.join(MEDIA, 'film.mp4'));
	check('full address from the app accepted', H.webToFile('http://connectbox/assets/content/eng/media/film.mp4?x=1') === path.join(MEDIA, 'film.mp4'));
	check('leading / and URL encoding accepted', H.webToFile('/assets/content/eng/media/film%2Emp4') === path.join(MEDIA, 'film.mp4'));
	for (const bad of ['assets/content/eng/media/../../../../etc/passwd', 'assets/content/../media/film.mp4', '/etc/passwd',
		'assets/content/eng/media/book.pdf', 'assets/content/eng/data/x.json', 'assets/content/eng/media/sub/film.mp4',
		'assets/content/eng/media/%2e%2e', null, 42, 'assets/content/eng/media/a\0.mp4'])
		check('refused: ' + JSON.stringify(bad), H.webToFile(bad) === null);
	// media list
	const list = H.listMedia();
	check('media list: video, audio, picture; no PDF, no dead link', JSON.stringify(list.map(i => i.name)) === JSON.stringify(['film.mp4', 'photo.jpg', 'song.mp3']), list);
	check('media list has web paths and kinds', list[0].path === 'assets/content/eng/media/film.mp4' && list[0].kind === 'video' && list[0].lang === 'eng', list[0]);
	// playlist
	check('no playlist file: empty', JSON.stringify(H.readPlaylist()) === JSON.stringify({items: [], image_seconds: 10}));
	let r = H.writePlaylist({items: ['assets/content/eng/media/film.mp4', {path: 'assets/content/eng/media/photo.jpg'}], image_seconds: 7});
	check('playlist saved and read back', r.items.length === 2 && r.items[1].path === 'assets/content/eng/media/photo.jpg' && r.image_seconds === 7, r);
	const onDisk = JSON.parse(fs.readFileSync(process.env.CB_HDMI_PLAYLIST));
	check('file holds box paths for the player', onDisk.items[0].path === path.join(MEDIA, 'film.mp4'), onDisk);
	r = H.writePlaylist({items: ['/etc/passwd']});
	check('playlist with a bad path refused (400), old one kept', r.status === 400 && H.readPlaylist().items.length === 2, r);
	check('image seconds kept in 2..600', H.writePlaylist({items: [], image_seconds: 9999}).image_seconds === 600 && H.writePlaylist({items: [], image_seconds: 0}).image_seconds === 2);
	check('too many items refused', H.writePlaylist({items: new Array(201).fill('assets/content/eng/media/film.mp4')}).status === 400);
	// player socket
	check('player not running: clean error', (await H.player({cmd: 'status'}, 1000)).ok === false);
	const got = [];
	const fake = net.createServer(c => c.on('data', d => { const q = JSON.parse(String(d)); got.push(q);
		c.write(JSON.stringify(q.cmd === 'status' ? {ok: true, mode: 'splash', monitor: true} : {ok: true}) + '\n'); }));
	await new Promise(res => fake.listen(process.env.CB_HDMI_SOCKET, res));
	check('player status through the socket', (await H.player({cmd: 'status'})).mode === 'splash');
	// HTTP: public router with the visitor switch off / on, admin session
	const express = require(require.resolve('express', {paths: [path.dirname(path.resolve(process.argv[2]))]}));
	const app = express(); app.use(express.json());
	let admin = false;
	app.use('/admin/api/hdmi/public', H.publicRouter(() => admin));
	app.use('/admin/api/hdmi', H.adminRouter());
	const srv = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
	const call = (method, url, body) => new Promise(res => { const req = http.request({host: '127.0.0.1', port: srv.address().port, path: url, method,
		headers: {'Content-Type': 'application/json'}}, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({status: r.statusCode, body: b ? JSON.parse(b) : null})); });
		if (body) req.write(JSON.stringify(body)); req.end(); });
	let s = await call('GET', '/admin/api/hdmi/public/status');
	check('public status: screen available, visitor play off', s.body.available === true && s.body.visitor_play === false, s.body);
	s = await call('PUT', '/admin/api/hdmi/public/play', {path: 'assets/content/eng/media/film.mp4'});
	check('visitor play refused while off (403)', s.status === 403, s);
	admin = true;
	s = await call('PUT', '/admin/api/hdmi/public/play', {path: 'assets/content/eng/media/film.mp4'});
	check('admin may play while visitor play is off', s.status === 200 && got.some(q => q.cmd === 'play' && q.path === path.join(MEDIA, 'film.mp4')), s);
	admin = false;
	fs.writeFileSync(process.env.CB_HDMI_BRAND, JSON.stringify({hdmi_visitor_play: 1}));
	s = await call('PUT', '/admin/api/hdmi/public/play', {path: 'assets/content/eng/media/song.mp3'});
	check('visitor play allowed when switched on', s.status === 200, s);
	s = await call('PUT', '/admin/api/hdmi/public/play', {path: '/etc/shadow'});
	check('visitor: bad path refused (400), not sent to the player', s.status === 400 && !got.some(q => String(q.path).includes('shadow')), s);
	s = await call('PUT', '/admin/api/hdmi/playlist', {items: ['assets/content/eng/media/song.mp3'], image_seconds: 5});
	check('admin playlist save tells the player to reload', s.status === 200 && got.some(q => q.cmd === 'reload'), s.body);
	s = await call('GET', '/admin/api/hdmi/media');
	check('admin media list over HTTP', s.status === 200 && s.body.length === 3);
	srv.close(); fake.close();
	fs.rmSync(T, {recursive: true, force: true});
	console.log(`${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();
