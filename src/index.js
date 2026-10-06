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
   	{execSync}= require("child_process"),
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
// Cookie session with a fixed key — the session contains only username after login.
app.use(cookieSession({name: 'connectbox',keys: ['81143184-d876-11eb-b8bc-0242ac130003'],maxAge: 24 * 60 * 60 * 1000}));

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
	console.log(req.body);
	if (req.body && req.body.password && auth(req.body.password)) {
		logger.log('debug', `${req.method} ${req.originalUrl}: Authorized`);
		req.session.username = "admin";
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
app.get('/admin/api/logout', function(req,res) {
	logger.log('debug', `${req.method} ${req.originalUrl}: Logged Out`);
	req.session = null;
	res.sendStatus(200);
})

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
 * The browser's Content-Disposition header (set implicitly by res.type) causes
 * the browser to download the response as a file.
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
	// Quote every field so commas inside values don't break CSV parsers.
	var rows = [];
	for (var item of data) {
		rows.push('"' + item.join('","') + '"');
	}
	res.type('text/csv');
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
	else {
		next();
	}
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
		var authString = fs.readFileSync('/usr/local/connectbox/etc/basicauth','utf-8');
		var checkPassword = execSync(`echo ${password} | openssl passwd -apr1 -salt CBOX2018 -stdin`).toString().replace('\n','');
		if ('admin:' + checkPassword === authString) {
			return true;
		}
		else {
			return false;
		}
	}
	catch(e) {
		console.log(`ERROR: auth: ${e}`);
		return false;
	}
}