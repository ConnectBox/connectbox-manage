/**
 * @fileoverview Express application entry point for connectbox-manage (port 5002).
 *
 * Mounts all HTTP endpoints and starts the server.  Responsibilities:
 *
 * - Session and CORS middleware setup
 * - Auth endpoints (PUT /admin/api/auth, GET /admin/api/logout)
 * - In-process chat store (GET/PUT /chat) — messages expire after 3 hours
 * - Content access log endpoints (downloadweblog, weblog append)
 * - Auth guard middleware that protects all /admin/api/* routes
 * - Delegates the full admin API surface to routes/api.js
 *
 * The auth guard distinguishes two authorised callers:
 *   1. CLI calls from localhost with a known Bearer token (connectboxmanage CLI)
 *   2. Browser sessions that have a valid cookie-session username
 */

const express = require('express'),
    bodyParser = require('body-parser'),
    app = express(),
	cookieParser = require('cookie-parser'),
	session = require('express-session'),
	cookieSession = require('cookie-session'),
    nocache = require('nocache'),
    cors = require('cors'),
   	{execSync, execFileSync}= require("child_process"),
	moment = require('moment-timezone'),
    configs = require('./configs.js'),
	functions = require('./functions.js');
    Logger = require('./logger.js'),
    logger = new Logger(configs.logging);

// In-memory chat store: keyed by millisecond timestamp so messages are
// naturally ordered and can be expired by comparing keys to the current time.
var chats = {};
var boxid = functions.get['hostname'];

// ---------------------------------------------------------------------------
// Admin session-signing key
// ---------------------------------------------------------------------------
// Each box signs its admin login cookies with its own random key, kept in
// SESSION_KEY_FILE (root-only).  It is created on the box the first time this
// server starts, so it is never in the source code (the key used to be a
// fixed string here, letting anyone who read it forge an admin login) and
// never shared between boxes: image preparation deletes the file, so every
// box made from a release image creates its own on first boot.
const SESSION_KEY_FILE = '/usr/local/connectbox/admin_session.key';

/**
 * Return this box's session-signing key, creating and saving a new random
 * one if the file is missing or unusable.  If it cannot be saved, the new key
 * is still used for this run (admins just sign in again after a restart).
 */
function loadSessionKey() {
	const fs = require('fs');
	try {
		const key = fs.readFileSync(SESSION_KEY_FILE, 'utf8').trim();
		if (key.length >= 32) {
			return key;
		}
	}
	catch (err) {
		// No key yet - create one below
	}
	const key = require('crypto').randomBytes(32).toString('hex');
	try {
		fs.writeFileSync(SESSION_KEY_FILE, key + '\n', {mode: 0o600});
		logger.log('info', `Created a new admin session key in ${SESSION_KEY_FILE}`);
	}
	catch (err) {
		logger.log('error', `Could not save the admin session key (${err.message}); admins will need to sign in again after a restart`);
	}
	return key;
}

// ---------------------------------------------------------------------------
// Server startup and middleware stack
// ---------------------------------------------------------------------------
console.log(`Listening on port ${configs.port}`);
app.listen(configs.port);
app.use(cors());
app.options('*', cors());
app.use(bodyParser.json({ type: 'application/json', limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(bodyParser.text({ type: 'text/html' , limit: '50mb'}));
app.use(cookieParser());
// Cookie session — the session contains only the username after login, signed
// with this box's own key (see loadSessionKey).
//
// An admin login must not outlive its use (in some countries a phone found
// still signed in to the box is dangerous).  The session ends when the admin
// page is left (the page calls /admin/api/logout), and in any case after
// ADMIN_IDLE_MS without an admin request: the cookie expires then, and the box
// also refuses a session whose last request is older than that, whatever the
// browser sends.  While the admin page is open it calls /admin/api/keepalive
// once a minute.
const ADMIN_IDLE_MS = 5 * 60 * 1000;
app.use(cookieSession({name: 'connectbox',keys: [loadSessionKey()],maxAge: ADMIN_IDLE_MS}));

// ---------------------------------------------------------------------------
// Auth endpoints — registered before the auth guard so they are accessible
// without a session (otherwise login itself would return 401).
// ---------------------------------------------------------------------------

/**
 * Authenticate and start a session.
 *
 * Validates the provided password against the apr1-hashed value in
 * /usr/local/connectbox/etc/basicauth.  On success sets session.username
 * so subsequent requests pass the auth guard middleware.
 */
app.put('/admin/api/auth', function(req,res) {
	// (The request body - the typed password - is not logged: it used to be,
	// so admin passwords ended up in the pm2 logs.)
	if (req.body && req.body.password && auth(req.body.password)) {
		logger.log('debug', `${req.method} ${req.originalUrl}: Authorized`);
		req.session.username = "admin";
		req.session.seen = Date.now();
		response = {username:"admin"};
		res.send(response)
	}
	else {
		logger.log('debug', `${req.method} ${req.originalUrl}: FAILED`);
		res.sendStatus(401);
	}
})

/**
 * Destroy the current session and log the user out.
 *
 * Setting req.session to null invalidates the cookie-session so the next
 * request from this browser will fail the auth guard.
 */
function logout(req,res) {
	logger.log('debug', `${req.method} ${req.originalUrl}: Logged Out`);
	req.session = null;
	res.sendStatus(200);
}
app.get('/admin/api/logout', logout);
// POST: sent by navigator.sendBeacon when the admin page is left
app.post('/admin/api/logout', logout);

/**
 * Return whether Moodle LMS is installed on this device.
 *
 * Used by the admin UI to show or hide Moodle-specific controls.
 */
app.get('/admin/api/ismoodle', function(req,res) {
	var data = {code:0,result: [functions.get["ismoodle"]()]};
	logger.log('debug', `${req.method} ${req.originalUrl}: ${data.result[0]}`);
	res.send(data);
})

/**
 * Stream all content access log entries as a CSV file download.
 *
 * Fetches all weblog entries via functions.get.weblog(), formats each row
 * with a human-readable date, and emits them as quoted CSV with a header row.
 * It is sent with Content-Disposition: attachment, so the browser saves it as a
 * file instead of showing it (iOS Safari showed it in place, which left the
 * admin page and so ended the admin session).
 */
app.get('/admin/api/downloadweblog', function(req,res) {
	logger.log('debug', `${req.method} ${req.originalUrl}`);
	var columns = ['boxid', 'mediaIdentifier', 'interactionType', 'mediaType', 'mediaLanguage', 'mediaProvider', 'date'];
	var data = [];
	data.push(columns);
	var getData = functions.get.weblog();
	// Build each data row by iterating the fixed column list so column order
	// is always consistent regardless of object key insertion order.
	for (var item of getData) {
		var fitem = [];
		item.date = moment(item.timestamp * 1000).format('LLL');
		item.boxid = boxid();
		for (var col of columns) {
			fitem.push(item[col] || '');
		}
		data.push(fitem);
	}
	// Quote every field so commas inside values don't break CSV parsers, and
	// double any quote inside a value (CSV's escape).
	var rows = [];
	for (var item of data) {
		rows.push(item.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','));
	}
	res.attachment('connectbox-access-log.csv');   // also sets Content-Type text/csv
	res.send (rows.join('\n'))
});

/**
 * Stub endpoint — web log deletion is handled via doCommand.deleteweblog.
 *
 * Returns an empty array so admin UI callers don't error on 404.
 */
app.get('/admin/api/deleteweblog', function(req,res) {
	logger.log('debug', `${req.method} ${req.originalUrl}`);
	res.send ([])
});

/**
 * Append a single content access event to the JSON access log.
 *
 * Called by the mediainterface UI each time a user opens a piece of content.
 * Enriches the incoming event with device metadata (country, location, boxid)
 * from brand.j2 before appending to the log file.  If the mariadbWebLogInsert
 * helper is installed, also writes the event to MariaDB for dashboard sync.
 */
app.put('/admin/api/weblog', function(req,res) {
	logger.log('debug', `${req.method} ${req.originalUrl}: ${req.body.value.mediaIdentifier}`);
	try {
		req.body.value.timestamp = Math.round(Date.now() / 1000);
		req.body.value.country = functions.brand['server_siteadmin_country'].toLowerCase();
		req.body.value.locationName = functions.brand['server_sitename'];
		req.body.value.deviceProvider = 'connectbox';
		req.body.value.deviceIdentifier = boxid;
		fs.appendFileSync('/var/log/connectbox/connectbox_enhanced.json',JSON.stringify(req.body.value) + '\n');
		if (fs.existsSync('/usr/local/connectbox/bin/mariadbWebLogInsert.py')) {
			execSync(`/usr/local/connectbox/bin/mariadbWebLogInsert.py '${JSON.stringify(req.body.value)}'`);
		}
		res.sendStatus(200);
 	}
 	catch (err) {
 		console.log(err);
 		res.sendStatus(500);
 	}
});

// ---------------------------------------------------------------------------
// In-process chat store endpoints
// Chat messages are stored in the chats object keyed by millisecond timestamp.
// Messages older than 3 hours are purged on every GET so the store stays
// bounded without a background cleanup timer.
// ---------------------------------------------------------------------------

/**
 * Retrieve chat messages newer than lastMessage unix timestamp.
 *
 * Purges messages older than 3 hours on each call, then returns all surviving
 * messages newer than req.params.lastMessage.  Returns 204 when no new messages
 * exist so the client can distinguish "empty" from "error".
 */
app.get(['/chat','/chat/:lastMessage'], function(req,res) {
	if (!req.params || !req.params.lastMessage) {
		req.params={lastMessage:0};
	}
	var deleteTime = moment().valueOf() - (3 * 60 * 60 * 1000);  // Messages older than 3 hours are expired
	var deleteCount = 0;
	var chatArray = [];
	// Walk all stored messages: delete expired ones, collect messages newer than
	// the client's last-seen timestamp.
	for (var id of Object.keys(chats)) {
		if (id < deleteTime) {
			delete chats[id];
			deleteCount++;
		}
		else {
			if (id / 1000 > req.params.lastMessage) {
				chatArray.push(chats[id]);
			}
		}
	}
	logger.log('debug', `${req.method} ${req.originalUrl}: Sending ${chatArray.length} messages (Deleted ${deleteCount} messages prior to ${deleteTime})`);
	if (chatArray.length > 0) {
		res.send(chatArray);
	}
	else {
		res.sendStatus(204);
	}
})

/**
 * Post a new chat message to the in-memory store.
 *
 * Attaches a unix timestamp and stores the message keyed by its millisecond
 * timestamp so GET /chat can filter by recency.  Returns 500 if the body
 * cannot be serialised (guards against malformed JSON from the client).
 */
app.put('/chat', function (req,res) {
	try {
		var test = JSON.stringify(req.body);
		req.body.timestamp = moment().unix();
		chats[moment().valueOf()] = req.body;
		res.sendStatus(200);
	}
	catch (err) {
		logger.log('debug', `${req.method} ${req.originalUrl}: invalid chat json`);
		res.sendStatus(500);
	}
})

// ---------------------------------------------------------------------------
// Auth guard middleware — applied to all routes mounted after this point.
// Must come after the /admin/api/auth and /chat endpoints so those remain
// accessible without a session.
// ---------------------------------------------------------------------------

/**
 * Enforce authentication for all remaining routes.
 *
 * Two authorised identities:
 * - Local CLI: requests from 127.0.0.1 with the known Bearer token bypass
 *   cookie-session so the connectboxmanage CLI can call the API without a browser.
 * - Browser sessions: any request with a session.username set by /admin/api/auth.
 */
app.use(async function (req, res, next) {
	if (req.socket.remoteAddress === '::ffff:127.0.0.1' && req.headers.authorization && req.headers.authorization === 'Bearer 9bfa3ed8-8609-4e78-af68-7013aa2b720a') {
		// CLI is authorized
		next();
	}
	else if (!req.session.username) {
		res.sendStatus(401);
	}
	else if (!req.session.seen || Date.now() - req.session.seen > ADMIN_IDLE_MS) {
		// Idle too long (or a cookie from before the idle limit): sign out
		logger.log('debug', `${req.method} ${req.originalUrl}: admin session expired`);
		req.session = null;
		res.sendStatus(401);
	}
	else {
		req.session.seen = Date.now();	// also renews the cookie's expiry
		next();
	}
});

/**
 * Keep the admin session alive while the admin page is open (called once a
 * minute by the page; the auth guard above renews the session).
 */
app.get('/admin/api/keepalive', function(req,res) {
	res.send({code: 0, result: ['ok']});
});

// Delegate the full admin API surface to the routes module.
app.use('/admin/api', require('./routes/api.js'));

/**
 * Verify a plaintext password against the stored apr1-hashed credential.
 *
 * Reads /usr/local/connectbox/etc/basicauth (format: 'admin:<hash>'), hashes
 * the supplied password with the same salt via openssl, and compares.  Returns
 * false on any read or exec error so the auth endpoint always gets a boolean.
 *
 * @param {string} password - Plaintext password submitted by the admin UI.
 * @returns {boolean} True if the password matches the stored hash.
 */
function auth(password) {
	try {
		// The password goes to openssl on its standard input, never through a
		// shell (it used to be "echo ${password} | openssl ..." - anyone on the
		// Wi-Fi could run commands as root from the login form).  openssl -stdin
		// reads one line, so a password with a line break is refused (otherwise
		// only its first line would be checked).
		if (typeof password !== 'string' || password === '' || /[\r\n\0]/.test(password)) {
			return false;
		}
		var authString = require('fs').readFileSync('/usr/local/connectbox/etc/basicauth','utf-8').trim();
		var checkPassword = execFileSync('openssl', ['passwd', '-apr1', '-salt', 'CBOX2018', '-stdin'],
			{input: password + '\n'}).toString().trim();
		var a = Buffer.from('admin:' + checkPassword), b = Buffer.from(authString);
		return a.length === b.length && require('crypto').timingSafeEqual(a, b);
	}
	catch(e) {
		console.log(`ERROR: auth: ${e.message}`);
		return false;
	}
}