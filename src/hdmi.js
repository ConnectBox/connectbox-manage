/**
 * @fileoverview HDMI screen control for a Raspberry Pi ConnectBox (2026-11-11).
 *
 * The HDMI player (/usr/local/connectbox/bin/hdmi_player.py, service
 * connectbox-hdmi) loops the admin's playlist on the HDMI screen, plays a
 * single item chosen with "Play on HDMI", and shows a splash picture when
 * there is nothing to play.  This module is the web side of it:
 *
 *   Public (mounted before the admin login check):
 *     GET  /admin/api/hdmi/public/status  -> {available, visitor_play}
 *     PUT  /admin/api/hdmi/public/play    {path} -> play one item now; allowed
 *          for anyone only while brand.j2 hdmi_visitor_play is 1, otherwise
 *          only for a logged-in admin
 *   Admin (mounted after the login check):
 *     GET  /admin/api/hdmi/status          -> player status
 *     GET  /admin/api/hdmi/media           -> playable files on the box
 *     GET  /admin/api/hdmi/playlist        -> {items, image_seconds}
 *     PUT  /admin/api/hdmi/playlist        {items: [path...], image_seconds}
 *     GET  /admin/api/hdmi/stop            -> stop a chosen item and the playlist; the
 *          splash stays until the playlist is saved again (PUT playlist -> reload)
 *
 * Paths given by the app or the admin page are web paths
 * ("assets/content/<lang>/media/<file>") under the enhanced interface's root.
 * They are checked here (only files in a language's media folder, with a
 * video, audio or picture extension) and again by the player.  The visitor
 * switch itself is brand.j2 hdmi_visitor_play, set through PUT /admin/api/brand.
 */
const fs = require('fs'),
	net = require('net'),
	path = require('path'),
	express = require('express');

// The CB_HDMI_* environment variables are for the tests only.
const WEB_ROOT = process.env.CB_HDMI_WEB_ROOT || '/var/www/enhanced/content/www';
const CONTENT_DIR = path.join(WEB_ROOT, 'assets/content');
const PLAYLIST_FILE = process.env.CB_HDMI_PLAYLIST || '/usr/local/connectbox/hdmi/playlist.json';
const CONTROL_SOCKET = process.env.CB_HDMI_SOCKET || '/run/connectbox/hdmi.sock';
const BRAND_FILE = process.env.CB_HDMI_BRAND || '/usr/local/connectbox/brand.j2';
const KINDS = {
	video: ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.3gp', '.3g2'],
	audio: ['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac'],
	image: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']
};
const MAX_ITEMS = 200;

/**
 * Return 'video', 'audio' or 'image' for a file name by its extension, else null.
 * @param {string} name
 * @returns {?string}
 */
function mediaKind(name) {
	const ext = path.extname(String(name)).toLowerCase();
	for (const kind of Object.keys(KINDS)) {
		if (KINDS[kind].includes(ext)) {
			return kind;
		}
	}
	return null;
}

/**
 * Turn a web path from the app or admin page into the file's path on the box.
 *
 * Accepts "assets/content/<lang>/media/<file>" (with or without a leading
 * "/" or "./" or the box's address in front, URL-encoded or not).  Returns null for anything else: other
 * folders, "..", sub-folders of media/, or a name that is not video, audio
 * or a picture.
 * @param {string} webPath
 * @returns {?string} Absolute path under CONTENT_DIR (the media link itself).
 */
function webToFile(webPath) {
	if (typeof webPath !== 'string' || webPath.length > 1024 || webPath.includes('\0')) {
		return null;
	}
	// A full address from the app (http://<box>/assets/...) is reduced to its path
	let p = webPath.trim().replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/^\.?\/+/, '');
	try {
		p = decodeURIComponent(p);
	}
	catch (e) {
		return null;
	}
	const m = /^assets\/content\/([^/]+)\/media\/([^/]+)$/.exec(p);
	if (!m || m[1] === '..' || m[1] === '.' || m[2] === '..' || m[2] === '.' || !mediaKind(m[2])) {
		return null;
	}
	return path.join(CONTENT_DIR, m[1], 'media', m[2]);
}

/**
 * The web path for a file in a language's media folder (inverse of webToFile).
 * @param {string} file - Absolute path under CONTENT_DIR.
 * @returns {string}
 */
function fileToWeb(file) {
	return path.relative(WEB_ROOT, file).split(path.sep).join('/');
}

/**
 * List the playable files on the box: every language's media/ folder entry
 * (the menus' links to the USB or the box's own content) that is video,
 * audio or a picture and still points at a file.
 * @returns {Array<{path: string, name: string, lang: string, kind: string}>}
 */
function listMedia() {
	const out = [];
	let langs = [];
	try {
		langs = fs.readdirSync(CONTENT_DIR, {withFileTypes: true}).filter(d => d.isDirectory()).map(d => d.name).sort();
	}
	catch (e) {
		return out;
	}
	for (const lang of langs) {
		let names = [];
		try {
			names = fs.readdirSync(path.join(CONTENT_DIR, lang, 'media')).sort();
		}
		catch (e) {
			continue;
		}
		for (const name of names) {
			const kind = mediaKind(name), file = path.join(CONTENT_DIR, lang, 'media', name);
			if (!kind) {
				continue;
			}
			try {
				if (!fs.statSync(file).isFile()) {	// follows the link; a dead link throws
					continue;
				}
			}
			catch (e) {
				continue;
			}
			out.push({path: fileToWeb(file), name: name, lang: lang, kind: kind});
		}
	}
	return out;
}

/**
 * Read the playlist file as the admin page sees it (web paths).
 * @returns {{items: Array<{path: string, name: string}>, image_seconds: number}}
 */
function readPlaylist() {
	try {
		const data = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));
		const items = (Array.isArray(data.items) ? data.items : []).map(i => ({
			path: fileToWeb(String(i.path || '')), name: String(i.name || path.basename(String(i.path || '')))
		})).filter(i => webToFile(i.path));
		return {items: items, image_seconds: Number(data.image_seconds) || 10};
	}
	catch (e) {
		return {items: [], image_seconds: 10};
	}
}

/**
 * Check and save a playlist from the admin page; returns the saved playlist
 * or {status: 400, message} when it contains something that is not allowed.
 * Written to a temporary file and renamed, so the player never reads half a file.
 * @param {{items: Array<string|{path: string}>, image_seconds: number}} body
 */
function writePlaylist(body) {
	const raw = body && Array.isArray(body.items) ? body.items : null;
	if (!raw || raw.length > MAX_ITEMS) {
		return {status: 400, message: `items must be a list of at most ${MAX_ITEMS} files`};
	}
	const items = [];
	for (const it of raw) {
		const web = typeof it === 'string' ? it : (it && it.path);
		const file = webToFile(web);
		if (!file) {
			return {status: 400, message: `not a playable file: ${String(web).slice(0, 200)}`};
		}
		items.push({path: file, name: path.basename(file)});
	}
	let secs = parseInt(body.image_seconds, 10);
	secs = isNaN(secs) ? 10 : Math.max(2, Math.min(600, secs));
	fs.mkdirSync(path.dirname(PLAYLIST_FILE), {recursive: true});
	const tmp = PLAYLIST_FILE + '.tmp.' + process.pid;
	fs.writeFileSync(tmp, JSON.stringify({items: items, image_seconds: secs}, null, 1));
	fs.renameSync(tmp, PLAYLIST_FILE);
	return readPlaylist();
}

/**
 * Send one command to the HDMI player and resolve with its reply; resolves
 * {ok: false, error} if the player is not running (no service, no socket).
 * @param {object} req - e.g. {cmd: 'play', path: '/var/www/...'}
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<object>}
 */
function player(req, timeoutMs) {
	return new Promise(resolve => {
		let buf = '', done = false;
		const finish = (reply) => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve(reply); } };
		const sock = net.createConnection(CONTROL_SOCKET);
		sock.setTimeout(timeoutMs || 5000, () => finish({ok: false, error: 'HDMI player did not answer'}));
		sock.on('error', () => finish({ok: false, error: 'HDMI player is not running'}));
		sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
		sock.on('data', d => {
			buf += d;
			const nl = buf.indexOf('\n');
			if (nl >= 0) {
				try { finish(JSON.parse(buf.slice(0, nl))); }
				catch (e) { finish({ok: false, error: 'bad reply from the HDMI player'}); }
			}
		});
		sock.on('end', () => finish({ok: false, error: 'HDMI player closed the connection'}));
	});
}

/**
 * True when brand.j2 allows visitors to use "Play on HDMI" (hdmi_visitor_play 1).
 * @returns {boolean}
 */
function visitorPlayAllowed() {
	try {
		const v = JSON.parse(fs.readFileSync(BRAND_FILE, 'utf8')).hdmi_visitor_play;
		return v === 1 || v === '1' || v === true;
	}
	catch (e) {
		return false;
	}
}

/**
 * Router for the visitor-facing endpoints; mount before the admin login check.
 * @param {function(object): boolean} isAdmin - true for a request from a logged-in admin.
 * @returns {express.Router}
 */
function publicRouter(isAdmin) {
	const r = express.Router();
	// What the media page needs to decide whether to show "Play on HDMI"
	r.get('/status', async function (req, res) {
		const st = await player({cmd: 'status'});
		res.set('Cache-Control', 'no-store');
		res.send({available: !!(st.ok && st.monitor), visitor_play: visitorPlayAllowed() || isAdmin(req)});
	});
	// Play one item now (visitors only while the admin allows it)
	r.put('/play', async function (req, res) {
		if (!visitorPlayAllowed() && !isAdmin(req)) {
			return res.status(403).send({ok: false, error: 'Play on HDMI is turned off'});
		}
		const file = webToFile(req.body && req.body.path);
		if (!file) {
			return res.status(400).send({ok: false, error: 'not a playable file'});
		}
		const reply = await player({cmd: 'play', path: file});
		res.status(reply.ok ? 200 : 503).send({ok: !!reply.ok, error: reply.error});
	});
	return r;
}

/**
 * Router for the admin endpoints; mount after the admin login check.
 * @returns {express.Router}
 */
function adminRouter() {
	const r = express.Router();
	r.get('/status', async (req, res) => res.send(Object.assign(await player({cmd: 'status'}), {visitor_play: visitorPlayAllowed()})));
	r.get('/media', (req, res) => res.send(listMedia()));
	r.get('/playlist', (req, res) => res.send(readPlaylist()));
	r.put('/playlist', async function (req, res) {
		let saved;
		try {
			saved = writePlaylist(req.body);
		}
		catch (e) {
			return res.status(500).send({ok: false, error: e.message});
		}
		if (saved.status) {
			return res.status(saved.status).send({ok: false, error: saved.message});
		}
		const reply = await player({cmd: 'reload'});
		res.send(Object.assign(saved, {player: reply}));
	});
	r.get('/stop', async (req, res) => res.send(await player({cmd: 'stop'})));
	return r;
}

module.exports = {publicRouter, adminRouter, webToFile, fileToWeb, listMedia, readPlaylist, writePlaylist,
	mediaKind, player, visitorPlayAllowed, CONTENT_DIR, PLAYLIST_FILE, CONTROL_SOCKET};
