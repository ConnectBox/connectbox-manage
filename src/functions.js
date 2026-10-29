/**
 * @fileoverview Device management function library for connectbox-manage.
 *
 * Exposes four namespaced objects (get, set, doCommand, del) whose keys map
 * directly to the CLI surface exposed by the connectboxmanage CLI and the
 * /admin/api REST endpoints in routes/api.js.
 *
 * Each key on these objects is a function that reads or mutates device state.
 * The DICT: comment above each function is the canonical API description used
 * by the CLI's help output and by the admin UI — do not remove them.
 *
 * Helper functions at the bottom of the file (execute, boolify, topKFrequent,
 * sortArrayByTimestamp, getBrand, setBrand) are exported so index.js can call
 * them directly for routes that don't fit the generic get/set/doCommand pattern.
 */

const
  configs = require('./configs.js'),
	{execSync}= require("child_process"),
	{ exec, execFile, spawn } = require('child_process'),
	fs = require('fs'),
	moment = require('moment'),
	request = require('request'),
  Logger = require('./logger.js'),
  logger = new Logger(configs.logging);

// Load brand config at startup so it's available for the exports object.
// Individual get/set functions re-read the file each time to pick up changes.
var brand = JSON.parse(fs.readFileSync('/usr/local/connectbox/brand.j2'));

// Namespaced function tables.  index.js and routes/api.js index into these
// by key name derived from the request URL (e.g. GET /admin/api/apssid →
// get.apssid()).
var get = {};
var post = {};
var put = {};
var del = {};
var set = {};
var doCommand = {};

// Probe internet connectivity once at startup.  Used by get.subscriptions()
// to short-circuit before attempting a remote curl call.
var isConnected = execute ("curl --connect-timeout 2 -sI google.com |head -n 1|cut -d' ' -f2 ") || false;

// Shell commands for each named log source.  Keys are the valid values for
// GET /admin/api/logs/:log.
var logSources = {
	"wifistatus":'connectboxmanage get wifistatus',
	"connectboxmanage":'sudo pm2 logs --lines 100 --nostream',
	"webserver": 'cat /var/log/connectbox/connectbox-access.log',
	"loadContent": 'cat /tmp/loadContent.log',
	"sync": 'cat /tmp/push_messages.log'
}

// ── Safe setting changes ─────────────────────────────────────────────────────
// The setters below used to build shell commands from the typed value
// (sudo sed -i ... ${json.value} ...), so a value containing ; $( ) ` or a
// quote ran commands as root, and one containing / & or \ broke the sed
// command.  They now edit the files in Node and run programs without a shell;
// for ordinary values the files end up exactly as the old sed commands left
// them.  connectbox-manage runs as root (pm2), so no sudo is needed to write.

/** A typed value we refuse: not text, or holding a line break or NUL. */
function badText(v) {
	return typeof v !== 'string' || /[\r\n\0]/.test(v);
}

/**
 * Rewrite the lines of a file for which test(line) is true, the way the old
 * sed commands ("s" from the first "=" to the end of the line) did: everything
 * from the first "=" on the line to its end becomes "=" + rest.  The file is rewritten in place (same
 * owner and permissions).  Returns '' (what the sed commands returned).
 */
function setAfterEquals(file, test, rest) {
	var lines = fs.readFileSync(file, 'utf8').split('\n');
	var out = lines.map(function (line) {
		if (!test(line)) return line;
		var i = line.indexOf('=');
		return i < 0 ? line : line.slice(0, i) + '=' + rest;
	});
	fs.writeFileSync(file, out.join('\n'));
	return '';
}

/** Error result for a refused value (routes/api.js sends it as that HTTP status). */
function refused(what) {
	return {status: 400, message: what};
}

/**
 * Stub auth function — authentication is handled in index.js.
 * Kept here so the module exports object remains backward-compatible.
 * @param {string} password - Ignored.
 */
function auth (password) {
	console.log(auth);
}

//DICT:SET:password (string): Set Web Access password
set.password = function (json){
	// Hash exactly what was typed: the password goes to openssl on its standard
	// input, never through a shell (it used to be "echo ${json.value} | ...",
	// which ran anything in the password as a command and changed some
	// passwords before hashing them).  Must match auth() in index.js.
	var pw = json ? json.value : undefined;
	if (typeof pw !== 'string' || pw === '' || /[\r\n\0]/.test(pw)) {
		return {status: 400, message: 'Password must not be empty or contain line breaks'};
	}
	try {
		var hash = require('child_process').execFileSync('openssl',
			['passwd', '-apr1', '-salt', 'CBOX2018', '-stdin'], {input: pw + '\n'}).toString().trim();
		if (!hash.startsWith('$apr1$')) throw new Error('unexpected openssl output');
		require('fs').writeFileSync('/usr/local/connectbox/etc/basicauth', `admin:${hash}`);
	}
	catch (e) {
		console.log(`ERROR: set.password: ${e.message}`);
		return {status: 500, message: 'Could not set the password'};
	}
	return (true);
}

//DICT:GET:running: Returns true if daemon is running
get.running = function (){
	return ("running");
}

//DICT:GET:boxid: Get the boxid (MAC address) of box
get.boxid = function (){
	return (execute(`cat /sys/class/net/eth0/address`).replace(/:/g,'-').replace('\n',''));
}

//DICT:GET:apssid: Access Point SSID
get.apssid = function (){
	return (execute(`grep '^ssid=' /etc/hostapd/hostapd.conf | cut -d"=" -f2`))
}
//DICT:SET:apssid (string): Access Point SSID
set.apssid = function (json){
	var v = json ? json.value : undefined;
	if (badText(v) || v === '' || Buffer.byteLength(v) > 32) return refused('SSID must be 1-32 bytes, without line breaks');
	return setAfterEquals('/etc/hostapd/hostapd.conf', function (l) { return /^ssid=/.test(l); }, v);
}

//DICT:GET:appassphrase: Access Point WPA passphrase
get.appassphrase = function (){
	return (execute(`grep '^wpa_passphrase=' /etc/hostapd/hostapd.conf | cut -d"=" -f2`))
}
//DICT:SET:appassphrase (string): Access Point WPA passphrase
set.appassphrase = function (json){
	var v = json ? json.value : undefined;
	if (badText(v)) return refused('Passphrase must not contain line breaks');
	var conf = '/etc/hostapd/hostapd.conf';
	var has = function (l) { return l.includes('wpa_passphrase='); };
	if (v.length >= 8) {
		if (v.length > 63) return refused('Passphrase must be 8-63 characters');
		if (!fs.readFileSync(conf, 'utf8').split('\n').some(has)) {
			// No passphrase yet (open network): add one, as "echo ... | tee -a" did
			fs.appendFileSync(conf, 'wpa_passphrase=' + v + '\n');
			return '';
		}
		// Modify existing passphrase
		return setAfterEquals(conf, has, v);
	}
	else {
		// Remove existing passphrase (the line is emptied, as the sed command did)
		var lines = fs.readFileSync(conf, 'utf8').split('\n');
		fs.writeFileSync(conf, lines.map(function (l) {
			return has(l) ? l.replace(/wpa_passphrase=.*/, '') : l;
		}).join('\n'));
		return '';
	}
}

//DICT:GET:apchannel: Access Point Wi-Fi Channel
get.apchannel = function (){
	return (execute(`grep '^channel=' /etc/hostapd/hostapd.conf | cut -d"=" -f2`))
}
//DICT:SET:apchannel (integer): Access Point Wi-Fi Channel
set.apchannel = function (json){
	var v = json ? String(json.value) : '';
	if (!/^[0-9]{1,3}$/.test(v)) return refused('Channel must be a number');
	return setAfterEquals('/etc/hostapd/hostapd.conf', function (l) { return l.includes('channel='); }, v);
}

//DICT:GET:clientwifiscan: Scan for Available Networks
get.clientwifiscan = function (){
	var types = {'on':true,'off':false};
	var response = [];
	var wifi = {"accesspoint":"wlan1","client":"wlan0"};  // Defaults
	if (fs.existsSync('/usr/local/connectbox/wificonf.txt')) {
		wifi.accesspoint = execute(`grep 'AccessPointIF' /usr/local/connectbox/wificonf.txt | cut -d"=" -f2`);
		wifi.client = execute(`grep 'ClientIF' /usr/local/connectbox/wificonf.txt | cut -d"=" -f2`);
	}
	var loop = 0;  //  Run up to five loops on checking the scan
	var output = '';
	while (loop < 5) {
		console.log(`clientwifiscan: Attempt: ${loop}`);
		output = execute(`sudo iwlist ${wifi.client} scan`);
		if (output.includes("Interface doesn't support scanning")) {
			execute('sleep 1');  // Wait before trying again
			loop ++;  // Invalid output -- run again
		}
		else {
			console.log(`clientwifiscan: Success`);
			loop = 10;  // Exit from loop
		}
	}
	for (var outputRecord of output.split(' - Address:')) {
		var record = {};
		for (var line of outputRecord.split('\n')) {
			line = line.trim();
			var [key,val] = line.split(':');
			if (key === 'ESSID') {
				record.ssid = val.replace(/\"/g,"");
			}
			if (key === 'Encryption key') {
				record.encryption = types[val];
			}
		}
		if (record.ssid && record.ssid.length > 0) {
			response.push(record);
		}
	}
	return(response);
}

//DICT:GET:clientssid: Client Wi-Fi SSID
get.clientssid = function (){
	// The first line that starts with "ssid=" (not "scan_ssid=...")
	return (execute(`grep -m1 -E '^[[:space:]]*ssid=' /etc/wpa_supplicant/wpa_supplicant.conf | cut -d'"' -f2`))
}
//DICT:SET:clientssid (string): Client Wi-Fi SSID
set.clientssid = function (json){
	var v = json ? json.value : undefined;
	if (badText(v) || v.includes('"') || Buffer.byteLength(v) > 32) return refused('SSID must be at most 32 bytes, without quotes or line breaks');
	// Only the first line that starts with "ssid=" (the first network block).
	// It used to be every line containing "ssid=", which also turned a
	// hand-added "scan_ssid=1" into scan_ssid="name" (wpa_supplicant then
	// rejects the file) and renamed every other network block too.
	var first = true;
	return setAfterEquals('/etc/wpa_supplicant/wpa_supplicant.conf', function (l) {
		if (first && /^\s*ssid=/.test(l)) { first = false; return true; }
		return false;
	}, '"' + v + '"');
}

//DICT:GET:clientpassphrase: Client Wi-Fi WPA Passphrase
get.clientpassphrase = function (){
	// The first line that starts with "psk=" (same network block as clientssid)
	return (execute(`grep -m1 -E '^[[:space:]]*psk=' /etc/wpa_supplicant/wpa_supplicant.conf | cut -d'"' -f2`))
}
//DICT:SET:clientpassphrase (string): Client Wi-Fi WPA Passphrase
set.clientpassphrase = function (json){
	var v = json ? json.value : undefined;
	if (badText(v) || v.includes('"')) return refused('Passphrase must not contain quotes or line breaks');
	// Only the first line that starts with "psk=", the same (first) network
	// block that set.clientssid changes, so a name and its passphrase stay together.
	var first = true;
	return setAfterEquals('/etc/wpa_supplicant/wpa_supplicant.conf', function (l) {
		if (first && /^\s*psk=/.test(l)) { first = false; return true; }
		return false;
	}, '"' + v + '"');
}

//DICT:GET:clientcountry: Client Wi-Fi Wi-Fi Country Support
get.clientcountry = function (){
	return (execute(`grep 'country=' /etc/wpa_supplicant/wpa_supplicant.conf | cut -d"=" -f2`))
}
//DICT:SET:clientcountry(2 letter country code): Client Wi-Fi Wi-Fi Country Support
set.clientcountry = function (json){
	var v = json ? json.value : undefined;
	if (v === "" || v === undefined) { v = "US"}
	if (typeof v !== 'string' || !/^[A-Za-z]{2}$/.test(v)) return refused('Country must be a 2-letter code');
	setAfterEquals('/etc/hostapd/hostapd.conf', function (l) { return l.includes('country_code='); }, v);
	return setAfterEquals('/etc/wpa_supplicant/wpa_supplicant.conf', function (l) { return l.includes('country='); }, v);
}

//DICT:GET:connectedclients: Count of devices connected to access point
get.connectedclients = function (){
	var wifi = {"accesspoint":"wlan1","client":"wlan0"};  // Defaults
	if (fs.existsSync('/usr/local/connectbox/wificonf.txt')) {
		wifi.accesspoint = execute(`grep 'AccessPointIF' /usr/local/connectbox/wificonf.txt | cut -d"=" -f2`);
		wifi.client = execute(`grep 'ClientIF' /usr/local/connectbox/wificonf.txt | cut -d"=" -f2`);
	}
	return (execute(`iw ${wifi.accesspoint} station dump |grep Station |wc -l | awk '{$1=$1};1'`))
}

//DICT:GET:clientwificonnection: Show status of client wifi
get.clientwificonnection = function (){
	var wifi = {"accesspoint":"wlan1","client":"wlan0"};  // Defaults
	if (fs.existsSync('/usr/local/connectbox/wificonf.txt')) {
		wifi.accesspoint = execute(`grep 'AccessPointIF' /usr/local/connectbox/wificonf.txt | cut -d"=" -f2`);
		wifi.client = execute(`grep 'ClientIF' /usr/local/connectbox/wificonf.txt | cut -d"=" -f2`);
	}
	var text = ['Offline','Connected'];
	var response = text[execute(`iwconfig ${wifi.client} | grep 'Link Quality' |wc -l`)] || "Error: Device Not Found";
	return (response);
}

//DICT:SET:wifirestart(interface): Client Wi-Fi Wi-Fi Country Support
set.wifirestart = function (json){
	// This provides the interface information for each wifi interface
	var wifi = {"accesspoint":"wlan1","client":"wlan0"};  // Defaults
	if (fs.existsSync('/usr/local/connectbox/wificonf.txt')) {
		wifi.accesspoint = execute(`grep 'AccessPointIF' /usr/local/connectbox/wificonf.txt | cut -d"=" -f2`);
		wifi.client = execute(`grep 'ClientIF' /usr/local/connectbox/wificonf.txt | cut -d"=" -f2`);
	}
	// Now do the update
	var interface = wifi[json.value];
	var response = execute(`sudo ifdown ${interface} && sleep 1 && sudo ifup ${interface}`);
	if (json.value === 'accesspoint') {
		response += execute(`sudo systemctl restart hostapd`);
		response += execute(`sudo systemctl status hostapd`);
	}
	return (response);
}

//DICT:GET:wifistatus: Retrieve current wifi adaptor information
get.wifistatus = function (){
	var wifi = {"accesspoint":"wlan1","client":"wlan0"};  // Defaults
	if (fs.existsSync('/usr/local/connectbox/wificonf.txt')) {
		wifi["accesspoint"] = execute(`grep 'AccessPointIF' /usr/local/connectbox/wificonf.txt | cut -d"=" -f2`);
		wifi["client"] = execute(`grep 'ClientIF' /usr/local/connectbox/wificonf.txt | cut -d"=" -f2`);
	}
	var response = {
		accesspoint: execute(`iwconfig ${wifi.accesspoint} && ifconfig ${wifi.accesspoint}` || null),
		client: execute(`iwconfig ${wifi.client} && ifconfig ${wifi.client}` || null)
	}
	return (response);
}

//DICT:GET:hostname: Box Hostname
get.hostname = function (){
	return (execute(`cat /etc/hostname`))
}
//DICT:SET:hostname: Box Hostname
set.hostname = function (json){
	var v = json ? json.value : undefined;
	// A host name (letters, digits, hyphens): it goes into /etc/hostname and nginx's server_name
	if (typeof v !== 'string' || !/^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(v)) {
		return refused('Host name must be letters, digits and hyphens (1-63, not starting or ending with a hyphen)');
	}
	fs.writeFileSync('/etc/hostname',`${v}`);  // set hostname
	setBrand({value:`Brand=${v}`}); // set in brands.txt
	var conf = '/etc/nginx/sites-enabled/connectbox_enhanced.conf';
	var lines = fs.readFileSync(conf, 'utf8').split('\n');
	fs.writeFileSync(conf, lines.map(function (l) {
		return l.includes('server_name ') ? l.replace(/server_name .*/, 'server_name ' + v + ' .local connectbox;') : l;
	}).join('\n'));
	execute('nginx -s reload') // Restart nginx now
	return (true)
}

//DICT:GET:isconnected: Returns true if box has ping to Google
get.isconnected = function() {
	// cut -d' ' (as at the top of this file): the old cut -d$' ' is bash-only, so
	// under /bin/sh it always failed and the error text counted as "connected".
	var response = execute ("curl --connect-timeout 2 -sI google.com |head -n 1|cut -d' ' -f2 ") || false;
	if (response) {
		return (true);
	}
	else {
		return (false);
	}
}

//DICT:GET:ismoodle: Returns 1 if Moodle is present
get.ismoodle = function() {
	return(false);
}

//DICT:DO:sync: Start manual sync to Cloud Server
doCommand.sync = function() {
	execute('sudo chmod 666 /tmp/*.log');
	if (get.ismoodle()) {
		exec(`sudo -u www-data /usr/bin/php /var/www/moodle/local/chat_attachments/push_messages.php true >/tmp/push_messages.log 2>&1`);
		return('Syncing Moodle With Server');
	}
	else {
		exec(`/usr/local/connectbox/bin/phonehome.py >/tmp/push_messages.log  2>&1`);
		return('Syncing Without Moodle');
	}
}

//DICT:DO:shutdown: Halt system
doCommand.shutdown = function() {
  setTimeout(() => execute(`/usr/local/connectbox/bin/shutdownShell.sh &`), 1000);
	return(true)
}

//DICT:DO:reboot: Reboot
doCommand.reboot = function() {
  setTimeout(() => execute(`sudo shutdown -r now &`), 1000);
 	return(true);
}

//DICT:GET:subscriptions: Returns a list of subscriptions available on the server
get.subscriptions = function() {
	var current = get.subscribe();
	var server = getBrand('server_url') || '';
	if (!isConnected) {
		return({status:404,message:"Not Connected To Internet"});
	}
	else if (get.ismoodle()) {
			//server = execute (`sudo -u www-data php /var/www/moodle/local/chat_attachments/get_server_url.php`);
	}
	if (!server.includes('http')) {
		return({status:404,message:"Invalid URL"});	
	}
	else {
		try {
			var data = JSON.parse(execute(`curl -sL --connect-timeout 15 ${server}/chathost/link/openwell`));
			var response = [];
			for (var record of data) {
				var isSelected = false;
				if (current === record.package) {
					isSelected = true;
				}
				if (record['is_slim']) {
					response.push({name:record.package,value:`${server}/chathost/link/openwell?packageName=${encodeURI(record.package)}`,isSelected:isSelected});
				}
			}
			return (response);
		}
		catch(err) {
			return({status:404,message:"Server URL is not reachable"});
		}
	}
}
//DICT:GET:package: Returns the current openwell content package name
get.package = function() {
	try {
		var languages = JSON.parse(fs.readFileSync("/var/www/enhanced/content/www/assets/content/languages.json"));
		var language = languages[0].codes[0].substring(0,2).toLowerCase();
		var main = JSON.parse(fs.readFileSync(`/var/www/enhanced/content/www/assets/content/${language}/data/main.json`));
		return(main.itemName);
	}
	catch (err){
		return (204);
	}
}
//DICT:GET:packagestatus: Returns the current number of missing items in openwell content package
get.packagestatus = function() {
	return(execute(`grep 'Failed Item Count' /tmp/loadContent.log 2>/dev/null | cut -d":" -f2`) || 'Package Info Unavailable');
}

//DICT:GET:subscribe: Returns the current openwell content subscription
get.subscribe = function() {
	try {
		var subscribe = JSON.parse(fs.readFileSync("/var/www/enhanced/content/www/assets/content/subscription.json"));
		return(decodeURI(subscribe.packagesAPIFeed.split('packageName=')[1]));
	}
	catch (err){
		return (204);
	}
}
//DICT:SET:subscribe (URL): Set a new subscription: https://SERVERNAME/api/
set.subscribe = function(json) {
	var value = {packagesAPIFeed:json.value,lastUpdated:1};
	execute('sudo touch /var/www/enhanced/content/www/assets/content/subscription.json')
	execute('sudo chmod 666 /var/www/enhanced/content/www/assets/content/subscription.json')
	fs.writeFileSync('/var/www/enhanced/content/www/assets/content/subscription.json',JSON.stringify(value));
	return ('Subscribed to ' + json.value);
}

//DICT:SET:openwelldownload (URL): Download the file and install into OpenWell
set.openwelldownload = function(json) {
	var url = json ? json.value : undefined;
	if (badText(url)) return refused('Download address must not contain line breaks');
	set.subscribe({});  // Zero out the subscription
	execute('sudo rm /tmp/loadContent.log >/dev/null 2>&1');
	// Started without a shell, in the background, output to /tmp/loadContent.log
	runInBackground('sudo', ['/usr/local/connectbox/bin/lazyLoader.py', url], '/tmp/loadContent.log');
	return ('Downloading content has begun.');
}

//DICT:DO:openwellrefresh: Check for missing pieces from a openwelldownload and get those pieces
doCommand.openwellrefresh = function() {
	var processes = execute(`pgrep -af 'lazyLoader.py'`);
	if (!processes.includes('python')) {
		execute('sudo rm /tmp/loadContent.log >/dev/null 2>&1');
		exec(`sudo /usr/local/connectbox/bin/lazyLoader.py >/tmp/loadContent.log 2>&1 &`);
		return ('Downloading content has begun.');
	}
	else {
		return ('Downloading is already running.')
	}
}

//DICT:DO:openwellusb: Trigger a loading of OpenWell content from USB (/USB/package OR /USB/content semi-structured media)
doCommand.openwellusb = function() {
	if (fs.existsSync('/media/usb0/package/language.json')) {
		execute('sudo rm -rf /var/www/enhanced/content/www/assets/content/*');
		execute(`sudo ln -s /media/usb0/package/* /var/www/enhanced/content/www/assets/content/`)
		return('Loading Package Found at /USB/package.');
	}
	else if (fs.existsSync('/media/usb0/content')) {
		execute('sudo rm /media/usb0/content/saved.zip');
		exec('sudo /usr/local/connectbox/bin/mmiLoader.py >/tmp/loadContent.log 2>&1');
		return ('Loading content from /USB/content.');
	}
	else {
		return ({status:404,message:`No USB content found. Can't Load Anything.`})
	}
}

//DICT:SET:coursedownload (URL): Download the Moodle course and install
set.coursedownload = function(json) {
	var url = json ? json.value : undefined;
	if (badText(url) || url.startsWith('-')) return refused('Download address must be a URL');
	// wget then restore, without a shell (the URL used to be pasted into one)
	execFile('sudo', ['wget', '-nv', '-O', '/tmp/download.mbz', '-o', '/tmp/loadContent.log', '--', url], function (err) {
		if (err) return;
		execFile('sudo', ['-u', 'www-data', '/usr/bin/php', '/var/www/moodle/admin/cli/restore_backup.php',
			'--file=/tmp/download.mbz', '--categoryid=1'], function () {});
	});
	return (true)
}

//DICT:GET:coursesonusb: Get list of .mbz Moodle course files on /USB/courses
get.coursesonusb = function() {
	if (!get.ismoodle()) {
		return ([]);
	}
	else {
		var response = [];
		try {
			var filenames = fs.readdirSync('/media/usb0/courses');
			for (var file of filenames) {
				if (file.includes('.mbz')) {
					response.push(file)
				}
			}
		}
		catch (err){
			//console.log(err);
		}
		return (response);
	}
}

//DICT:SET:courseusb (filename): Trigger a loading of Moodle content from /USB/courses
set.courseusb = function(json) {
	var name = json ? json.value : undefined;
	// A file name in /media/usb0/courses (as listed by get.coursesonusb), nothing else
	if (badText(name) || name === '' || name.includes('/') || name === '.' || name === '..') return refused('Course must be a file name in /USB/courses');
	runInBackground('sudo', ['-u', 'www-data', 'php', '/var/www/moodle/admin/cli/restore_backup.php',
		'-f=/media/usb0/courses/' + name, '-c=1'], '/tmp/loadContent.log');
	return true;
}

//DICT:SET:wipe (password): Erase SD Card -- password is wipethebox
set.wipe = function(json) {
    if (json.value === 'wipethebox') {
    	exec(`scripts/wipe.sh &`);
	    return true;
    }
    else {
    	return false;
    }
}

//DICT:SET:securitykey (string): Update the Moodle and Phonehome security key for sync with Dashboard
set.securitykey = function(json) {
	var key = json ? json.value : undefined;
	if (badText(key)) return refused('Key must not contain line breaks');
	// Only saves the key.  (It also used to run "wget -O /tmp/download.mbz
	// <key>", a copy-paste slip from coursedownload: the key was looked up as a
	// host name, nothing was downloaded, and /tmp/download.mbz was emptied.)
	setBrand({value:'server_authorization='+key});
}

//DICT:GET:logsources: Returns an array of logs that can be viewed
get.logsources = function() {
	return(Object.keys(logSources))
}

/**
 * Retrieve the output of a named log source as a keyed object.
 *
 * Executes the shell command registered in logSources for the given name and
 * returns it as {logName: <output>} so the caller gets a consistently shaped
 * object regardless of which log was requested.
 *
 * @param {string} logName - One of the keys defined in logSources
 *   (e.g. 'webserver', 'wifistatus').
 * @returns {{[logName: string]: string}} Shell output wrapped in a keyed object.
 */
function getLogs(logName) {
	var response = {};
	response[logName] = execute(logSources[logName]);
	return(response);
}

/**
 * Read a single key from the brand.j2 device configuration file.
 *
 * Re-reads brand.j2 on every call so changes made by setBrand() are reflected
 * without restarting the server.  The special key 'lcd_pages_stats' is an
 * alias that maps to 'lcd_pages_stats_day_one' — the actual stored key —
 * because the admin UI uses the shorter alias name.
 *
 * @param {string} key - Brand config key (e.g. 'Brand', 'server_url').
 * @returns {*} The value for the key, or 0 if the key does not exist.
 */
function getBrand(key) {
	var brand = JSON.parse(fs.readFileSync('/usr/local/connectbox/brand.j2'));
	if (key === 'lcd_pages_stats') {
		// Special case where lcd_page_stats is a rollup of several settings
		key = 'lcd_pages_stats_day_one';
	}
	return(brand[key] || 0);
}

/**
 * Write a key=value pair into the brand.j2 device configuration file.
 *
 * Accepts a body object with a 'value' string in 'Key=Value' format (matching
 * the CLI convention).  Key matching is case-insensitive so 'brand' and 'Brand'
 * both resolve to the correct stored key.
 *
 * Special behaviours:
 * - 'server_siteadmin_phone' is stored as a string to prevent parseInt
 *   from mangling phone numbers with leading zeros.
 * - 'lcd_pages_stats' is a virtual key that fans out to every key in brand.j2
 *   that starts with 'lcd_pages_stats_' (e.g. lcd_pages_stats_hour_one).
 *
 * @param {{value: string}} body - Object with a 'Key=Value' value string.
 * @returns {string} The original body.value string echoed back to the caller.
 */
function setBrand(body) {
	brand = JSON.parse(fs.readFileSync('/usr/local/connectbox/brand.j2'));
	// Key before the first "=", value is everything after it (a value may
	// itself contain "=", e.g. a key ending in "==")
	var eq = body.value.indexOf('=');
	var key = eq < 0 ? body.value : body.value.slice(0, eq);
	var val = eq < 0 ? undefined : body.value.slice(eq + 1);
	// Case-insensitive key lookup — find the actual stored key name.
	for (var brandKey of Object.keys(brand)) {
		if (key === 'lcd_pages_stats') {
			break; // Take this key if present
		}
		else if (brandKey.toLowerCase() === key) {
			key = brandKey;
			break;  // Take the first match in the list
		}
	}
	if (key === 'server_siteadmin_phone') {
		// This needs to be a string so we don't run it through the logic below with parseInt
		brand[key] = val;
	}
	else if (key) {
		// Store whole numbers (e.g. "1", "27") as numbers, anything else as
		// text.  (parseInt alone turned a key like "405b2056-..." into 405.)
		try {
			brand[key] = /^-?[0-9]+$/.test(String(val).trim()) ? parseInt(val, 10) : val;
		}
		catch {
			brand[key] = val;
		}
		// lcd_pages_stats is a virtual rollup key — fan the value out to every
		// individual lcd_pages_stats_* key rather than storing the alias itself.
		// Store the parsed value (1 / 0), not the raw string: the display
		// service treats only a number 0 (or "0") as "page off".
		if (key === 'lcd_pages_stats') {
			var pageval = brand[key];  // parsed above
			delete brand[key];  // Don't keep lcd_pages_stats
			for (var pagekey of Object.keys(brand)) {
				if (pagekey.startsWith(key)) {
					brand[pagekey] = pageval; // Example: lcd_pages_stats_hour_one = 1
				}
			}
		}
	}
	if (key) {
		// Whole file to a temporary name, then renamed into place, so the hat
		// service and PxUSBm never read brand.j2 half written (the hat
		// service crashed reading an empty brand.j2).  Keeps owner and mode.
		// (Also for server_siteadmin_phone, which was set but never saved.)
		var brandPath = '/usr/local/connectbox/brand.j2', tmpPath = brandPath + '.tmp.' + process.pid;
		fs.writeFileSync(tmpPath, JSON.stringify(brand));
		try { var st = fs.statSync(brandPath); fs.chmodSync(tmpPath, st.mode & 0o7777); fs.chownSync(tmpPath, st.uid, st.gid); } catch (e) {}
		fs.renameSync(tmpPath, brandPath);
	}
	return(body.value);
}

//DICT:DO:deleteweblog: Clear all Content Viewing Logs
doCommand.deleteweblog = function (){
	execute("sudo rm -rf /var/log/connectbox/connectbox_enhanced*");
	execute("sudo rm -rf /var/log/connectbox/connectbox_summary_enhanced.txt");
	execute("sudo rm -rf /var/log/connectbox/connectbox_enhanced.json");
	return (true);
}

//DICT:GET:topten: Get top 10 Content Viewing Logs
get.topten = function (json){
	var logString = execute("cat /var/log/connectbox/connectbox_enhanced* |grep mediaIdentifier >/var/log/connectbox/connectbox_summary_enhanced.txt");
	var logArray = fs.readFileSync('/var/log/connectbox/connectbox_summary_enhanced.txt').toString().split('\n');
	var hits = {hour:[],day:[],week:[],month:[],year:[]};
	var times = {hour:60*60,day:60*60*24,week: 60*60*24*7, month: 60*60*24*30, year: 60*60*24*365};
	var now = Math.round(Date.now() / 1000);
	for (var log of logArray) {
		try {
			log = JSON.parse(log);
			for (var duration of Object.keys(hits)) {
				if (!log.sync && log.timestamp > now-times[duration]) {
					hits[duration].push(log.mediaIdentifier);
				}
			}

		}
		catch (err) {
			console.log(`get.topten: No Data Available`);
			continue;
		}
	}
	var response = {hour:topKFrequent(hits["hour"],10),day:topKFrequent(hits["day"],10),week:topKFrequent(hits["week"],10),month:topKFrequent(hits["month"],10),year:topKFrequent(hits["year"],10)};
	return (response);
}
//DICT:GET:stats: Get Detailed Content Viewing Logs By Period
get.stats = function (json){
	var logString = execute("cat /var/log/connectbox/connectbox_enhanced* |grep mediaIdentifier >/var/log/connectbox/connectbox_summary_enhanced.txt");
	var logArray = fs.readFileSync('/var/log/connectbox/connectbox_summary_enhanced.txt').toString().split('\n');
	var hits = {week:{},month:{},year:{}};
	for (var log of logArray) {
		try {
			log = JSON.parse(log);
			var logDates = {
				year:moment(log.timestamp*1000).format('YYYY'),
				month:moment(log.timestamp*1000).format('YYYYMM'),
				week:moment(log.timestamp*1000).format('YYYY') + 'W' + moment(log.timestamp*1000).isoWeek()
			};
			if (!hits.year[logDates.year]) { hits.year[logDates.year] =[] }
			if (!hits.month[logDates.month]) { hits.month[logDates.month] =[] }
			if (!hits.week[logDates.week]) { hits.week[logDates.week] =[] }
			hits.year[logDates.year].push(log.mediaIdentifier)
			hits.month[logDates.month].push(log.mediaIdentifier)
			hits.week[logDates.week].push(log.mediaIdentifier)
		}
		catch (err) {
			//console.log(log,err)
			console.log(`get.stats: No Data Available`);
			continue;
		}
	}
	//console.log(hits);
	var response = {week:[],month:[],year:[]};
	for (var dateType of Object.keys(hits)) {
		//console.log(`dateType: ${dateType}`);
		for (var period of Object.keys(hits[dateType])) {
			//console.log(`	period: ${period}`);
			var record = {date: period,stats:topKFrequent(hits[dateType][period],1000)}
			response[dateType].push(record);
		}
	}
	return (response);
}

//DICT:GET:weblog: Get all Content Viewing Logs
get.weblog = function (json){
	var logString = execute("cat /var/log/connectbox/connectbox_enhanced* |grep mediaIdentifier >/var/log/connectbox/connectbox_summary_enhanced.txt");
	var logArray = fs.readFileSync('/var/log/connectbox/connectbox_summary_enhanced.txt').toString().split('\n');
	var response = [];
	var logs = [];
	// Load the rows, parse in JSON
	for (var log of logArray) {
		try {
			log = JSON.parse(log);
			logs.push(log);
		}
		catch (err) {
			console.log(`get.weblog: No Data Available`);
			continue;
		}
	}
	logs.sort(sortArrayByTimestamp);  // Custom sort based on timestamp of the log rows so that no matter the order of the files, we get an ordered array
	return (logs);
}
//DICT:GET:syncweblog: Get Content Viewing Logs since last get
get.syncweblog = function (json){
	var logString = execute("cat /var/log/connectbox/connectbox_enhanced* |grep mediaIdentifier >/var/log/connectbox/connectbox_summary_enhanced.txt");
	var logArray = fs.readFileSync('/var/log/connectbox/connectbox_summary_enhanced.txt').toString().split('\n');
	var response = [];
	var logs = [];
	// Load the rows, parse in JSON
	for (var log of logArray) {
		try {
			log = JSON.parse(log);
			logs.push(log);
		}
		catch (err) {
			console.log(`get.syncweblog: No Data Available`);
			continue;
		}
	}
	logs.sort(sortArrayByTimestamp);  // Custom sort based on timestamp of the log rows so that no matter the order of the files, we get an ordered array
	for (var log of logs) {
		response.push(log);
		// Whenever we see a sync log that means everything in the array has already been sent.  So clear the array and continue.
		if (log.sync) {
			response = [];
		}
	}
	if (response.length > 0) {
		fs.appendFileSync('/var/log/connectbox/connectbox_enhanced.json',JSON.stringify({sync:true,timestamp:Math.round(Date.now() / 1000)}) + '\n');
	}
	return (response);
}

//DICT:GET:disable_chat: Get status of disabling chat
get.disable_chat = function (json){
	try {
		var chat = JSON.parse(fs.readFileSync('/var/www/enhanced/content/www/assets/content/config.json'));
		return (chat["disable_chat"]);
	}
	catch (err) {
		return false;
	}
}
//DICT:SET:disable_chat (json): 1 is disabled and 0 is enabled
set.disable_chat = function (json){
	try {
		var chat = JSON.parse(fs.readFileSync('/var/www/enhanced/content/www/assets/content/config.json'));
		chat["disable_chat"] = boolify(json.value);
		fs.writeFileSync('/var/www/enhanced/content/www/assets/content/config.json',JSON.stringify(chat));
		return true;
 	}
 	catch (err) {
 		return false;
 	}
}

//DICT:GET:disable_stats: Get status of disabling stats
get.disable_stats = function (json){
	try {
		var chat = JSON.parse(fs.readFileSync('/var/www/enhanced/content/www/assets/content/config.json'));
		return (chat["disable_stats"]);
	}
	catch (err) {
		return false;
	}
}
//DICT:SET:disable_stats (json): 1 is disabled and 0 is enabled
set.disable_stats = function (json){
	try {
		var chat = JSON.parse(fs.readFileSync('/var/www/enhanced/content/www/assets/content/config.json'));
		chat["disable_stats"] = boolify(json.value);
		fs.writeFileSync('/var/www/enhanced/content/www/assets/content/config.json',JSON.stringify(chat));
		return true;
 	}
 	catch (err) {
 		return false;
 	}
}

/**
 * Run a shell command synchronously and return its trimmed stdout.
 *
 * Returns the error message string instead of throwing on non-zero exit so
 * callers don't need try/catch for every shell invocation.  The trailing
 * newline is stripped so callers can compare the result directly to a string.
 *
 * @param {string} command - Shell command to execute via execSync.
 * @returns {string} stdout with trailing newline removed, or error message.
 */
/**
 * Start a program in the background without a shell, with its output (and
 * errors) written to logFile, like "cmd >logFile 2>&1 &".
 */
function runInBackground(cmd, args, logFile) {
	var fd = fs.openSync(logFile, 'w');
	try {
		var child = spawn(cmd, args, {detached: true, stdio: ['ignore', fd, fd]});
		child.on('error', function (e) { logger.log('error', `${cmd}: ${e.message}`); });
		child.unref();
	}
	finally {
		fs.closeSync(fd);
	}
}

function execute(command) {
	var response = ''
	try {
		return(execSync(command).toString().replace('\n',''));
	}
	catch (error) {
		return(error.toString());
	}
}

/**
 * Coerce a value to a 1/0 integer boolean suitable for storage in brand.j2.
 *
 * Accepts '1', 1, and 'true' (case-insensitive) as truthy; everything else
 * becomes 0.  Used by set.disable_chat and set.disable_stats so the config
 * file always stores a numeric flag rather than a mix of strings and integers.
 *
 * @param {string|number} value - Raw value from the request body.
 * @returns {0|1}
 */
function boolify(value) {
	if (value == "1" || value === 1 || (typeof value === 'string' && value.toLowerCase() === 'true')) {
		return 1;
	}
	else {
		return 0;
	}
}

/**
 * Return the top k most frequently occurring strings in an array.
 *
 * Used by get.topten() and get.stats() to rank content items by access count.
 * Builds a frequency hash, sorts entries descending by count, and returns the
 * top k as [{resource, count}] objects matching the format expected by the HAT
 * display service and the admin reporting UI.
 *
 * @param {string[]} arrayOfStrings - Array of content identifiers (may contain duplicates).
 * @param {number} k - Maximum number of results to return.
 * @returns {{resource: string, count: number}[]} Top k items ordered by frequency.
 */
function topKFrequent(arrayOfStrings, k) {
	// Build a frequency map: key → occurrence count.
    let hash = {}
    for (let key of arrayOfStrings) {
        if (!hash[key]) hash[key] = 0
        hash[key]+= 1 || 1;
    }
    // Sort entries by count descending and slice to k.
    const hashToArray = Object.entries(hash)
    const sortedArray = hashToArray.sort((a,b) => b[1] - a[1])
    const sortedElements = sortedArray.map(val => val[0])
    var response = [];
    for (var data of sortedArray.slice(0, k)) {
    	response.push({resource:data[0],count:data[1]})
    }
    return response;
}

/**
 * Comparator for Array.sort() that orders log objects by unix timestamp ascending.
 *
 * Used by get.weblog() and get.syncweblog() to produce a chronological event
 * list regardless of which log file each line came from.
 *
 * @param {{timestamp: number}} a
 * @param {{timestamp: number}} b
 * @returns {-1|0|1}
 */
function sortArrayByTimestamp( a, b ) {
  if ( a.timestamp < b.timestamp ){
    return -1;
  }
  if ( a.timestamp > b.timestamp ){
    return 1;
  }
  return 0;
}

module.exports = {
	auth,
	brand,
	get,
	post,
	put,
	del,
	set,
	doCommand,
	getLogs,
	getBrand,
	setBrand
};
