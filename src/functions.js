const
  configs = require('./configs.js'),
	{execSync}= require("child_process"),
	{ exec } = require('child_process'),
	fs = require('fs'),
	moment = require('moment'),
  lms = require('./lms-api'),
	request = require('request'),
  Logger = require('./logger.js'),
  logger = new Logger(configs.logging);

var brand = JSON.parse(fs.readFileSync('/usr/local/connectbox/brand.txt'));

var get = {};
var post = {};
var put = {};
var del = {};
var set = {};
var doCommand = {};

var isConnected = execute ("curl --connect-timeout 2 -sI google.com |head -n 1|cut -d$' ' -f2 ") || false;

var logSources = {
	"wifistatus":'connectboxmanage get wifistatus',
	"connectboxmanage":'sudo pm2 logs --lines 100 --nostream',
	"webserver": 'cat /var/log/connectbox/connectbox-access.log',
	"loadContent": 'cat /tmp/loadContent.log',
	"sync": 'cat /tmp/push_messages.log'
}

function auth (password) {
	console.log(auth);
}

//DICT:SET:password (string): Set Web Access password
set.password = function (json){
	var hash = execute(`echo ${json.value} | openssl passwd -apr1 -salt CBOX2018 -stdin`)
	fs.writeFileSync('/usr/local/connectbox/etc/basicauth',`admin:${hash.toString()}`);
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
	return (execute(`sudo sed -i -e "/^ssid=/ s/=.*/=${json.value}/" /etc/hostapd/hostapd.conf`))
}

//DICT:GET:appassphrase: Access Point WPA passphrase
get.appassphrase = function (){
	return (execute(`grep '^wpa_passphrase=' /etc/hostapd/hostapd.conf | cut -d"=" -f2`))
}
//DICT:SET:appassphrase (string): Access Point WPA passphrase
set.appassphrase = function (json){
	if (json.value.length >= 8) {
		// Check to see if the line is in hostapd.conf before writing
		if (execute(`cat /etc/hostapd/hostapd.conf |grep wpa_passphrase= |wc -l`) == 0) {
			// Write new value (previous state was no WPA)
			return(execute(`echo 'wpa_passphrase=${json.value}' | sudo tee -a /etc/hostapd/hostapd.conf >/dev/null`));
		}
		else {
			// Modify existing passphrase
			return (execute(`sudo sed -i -e "/wpa_passphrase=/ s/=.*/=\"${json.value}\"/" /etc/hostapd/hostapd.conf`))
		}
	}
	else {
		// Remove existing passphrase
		return (execute(`sudo sed -i -e "/wpa_passphrase=/ s/wpa_passphrase=.*//" /etc/hostapd/hostapd.conf`))
	}
}

//DICT:GET:apchannel: Access Point Wi-Fi Channel
get.apchannel = function (){
	return (execute(`grep '^channel=' /etc/hostapd/hostapd.conf | cut -d"=" -f2`))
}
//DICT:SET:apchannel (integer): Access Point Wi-Fi Channel
set.apchannel = function (json){
	return (execute(`sudo sed -i -e "/channel=/ s/=.*/=\"${json.value}\"/" /etc/hostapd/hostapd.conf`))
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
	return (execute(`grep 'ssid' /etc/wpa_supplicant/wpa_supplicant.conf | cut -d'"' -f2`))
}
//DICT:SET:clientssid (string): Client Wi-Fi SSID
set.clientssid = function (json){
	return (execute(`sudo sed -i -e "/ssid=/ s/=.*/=\\\"${json.value}\\\"/" /etc/wpa_supplicant/wpa_supplicant.conf`))
}

//DICT:GET:clientpassphrase: Client Wi-Fi WPA Passphrase
get.clientpassphrase = function (){
	return (execute(`grep 'psk' /etc/wpa_supplicant/wpa_supplicant.conf | cut -d'"' -f2`))
}
//DICT:SET:clientpassphrase (string): Client Wi-Fi WPA Passphrase
set.clientpassphrase = function (json){
	return (execute(`sudo sed -i -e "/psk=/ s/=.*/=\\\"${json.value}\\\"/" /etc/wpa_supplicant/wpa_supplicant.conf`))
}

//DICT:GET:clientcountry: Client Wi-Fi Wi-Fi Country Support
get.clientcountry = function (){
	return (execute(`grep 'country=' /etc/wpa_supplicant/wpa_supplicant.conf | cut -d"=" -f2`))
}
//DICT:SET:clientcountry(2 letter country code): Client Wi-Fi Wi-Fi Country Support
set.clientcountry = function (json){
	if (json.value == "") { json.value = "US"}
	execute(`sudo sed -i -e "/country_code=/ s/=.*/=${json.value}/" /etc/hostapd/hostapd.conf`)
	return (execute(`sudo sed -i -e "/country=/ s/=.*/=\"${json.value}\"/" /etc/wpa_supplicant/wpa_supplicant.conf`))
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
	fs.writeFileSync('/etc/hostname',`${json.value}`);  // set hostname
	setBrand({value:`Brand=${json.value}`}); // set in brands.txt
	execute(`sudo sed -i -e "/server_name / s/server_name .*/server_name learn.${json.value} learn.thewell learn.connectbox;/" /etc/nginx/sites-enabled/connectbox_moodle.conf`)
	execute(`sudo sed -i -e "/server_name / s/server_name .*/server_name ${json.value} thewell connectbox;/" /etc/nginx/sites-enabled/connectbox_enhanced.conf`)
	// The http://  value must be handled with \\\/\\\/ because it has to double escape the slashes due to regexp
	execute(`sudo sed -i -e "/wwwroot / s/=.*/= 'http:\\\/\\\/${json.value.toLowerCase()}';/" /var/www/moodle/config.php`)
	execute('nginx -s reload') // Restart nginx now
	return (true)
}

//DICT:GET:isconnected: Returns true if box has ping to Google
get.isconnected = function() {
	var response = execute ("curl --connect-timeout 2 -sI google.com |head -n 1|cut -d$' ' -f2 ") || false;
	if (response) {
		return (true);
	}
	else {
		return (false);
	}
}

//DICT:GET:ismoodle: Returns 1 if Moodle is present
get.ismoodle = function() {
	if (fs.existsSync('/var/www/moodle/index.php')) {
		return(true);
	}
	else {
		return(false);
	}
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
	set.subscribe({});  // Zero out the subscription
	execute('sudo rm /tmp/loadContent.log >/dev/null 2>&1');
	exec(`sudo /usr/local/connectbox/bin/lazyLoader.py ${json.value} >/tmp/loadContent.log 2>&1 &`);
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
	exec(`(sudo wget -nv -O /tmp/download.mbz -o /tmp/loadContent.log '${json.value}' && sudo -u www-data /usr/bin/php /var/www/moodle/admin/cli/restore_backup.php --file=/tmp/download.mbz --categoryid=1) &`)
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
	exec(`sudo -u www-data php /var/www/moodle/admin/cli/restore_backup.php -f="/media/usb0/courses/${json.value}" -c=1 >/tmp/loadContent.log 2>&1`);
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
	setBrand({value:'server_authorization='+json.value});
	execute(`sudo wget -O /tmp/download.mbz ${json.value} >/tmp/course-download.log 2>&1`);
}

//DICT:GET:logsources: Returns an array of logs that can be viewed
get.logsources = function() {
	return(Object.keys(logSources))
}

//DICT:GET:logs: (log name) Retrieves log and formats for Admin log viewer
function getLogs(logName) {
	var response = {
	};
	response[logName] = execute(logSources[logName]);
	return(response);
}

//DICT:GET:brand: Get value from brand.txt.  Must include a value such as Image
function getBrand(key) {
	var brand = JSON.parse(fs.readFileSync('/usr/local/connectbox/brand.txt'));
	if (key === 'lcd_pages_stats') {
		// Special case where lcd_page_stats is a rollup of several settings
		key = 'lcd_pages_stats_day_one';
	}
	return(brand[key] || 0);
}

//DICT:SET:brand (key=value): Set value in brand.txt where value is like Image=connectbox_logo.png
function setBrand(body) {
	brand = JSON.parse(fs.readFileSync('/usr/local/connectbox/brand.txt'));
	var key = body.value.split('=')[0];
	var val = body.value.split('=')[1];
	for (var brandKey of Object.keys(brand)) {
		if (key === 'lcd_pages_stats') {
			break; // Take this key if present
		}
		else if (brandKey.toLowerCase() === key) {
			key = brandKey;
			break;  // Take the first match in the list
		}
	}
	if (key) {
		try {
			brand[key] = parseInt(val);
			if (isNaN(brand[key])) {
				brand[key] = val;
			}
		}
		catch {
			brand[key] = val;
		}
		// One key sets a few lcd_pages_stats values so loop through and update all of them
		if (key === 'lcd_pages_stats') {
			delete brand[key];  // Don't keep lcd_pages_stats
			for (var pagekey of Object.keys(brand))	 {
				if (pagekey.startsWith(key)) {
					brand[pagekey] = val; // Example: lcd_pages_stats_hour_one = 1
				}
			}
		}
		fs.writeFileSync('/usr/local/connectbox/brand.txt',JSON.stringify(brand));
	}
	return(body.value);
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
 * Moodle functions
 */
//NODICT:GET:lms_courses (id?): Get a list of courses from the LMS. If id is supplied, get the specific course.
get.lms_courses = function (id) {
  if (id) {
    return lms.get_course(id).then((response) =>  response);
  }
  return lms.get_courses().then((response) =>  response);
}
//NODICT:DEL:lms_courses (id?): Delete the given course.
del.lms_courses = function (id) {
  return lms.delete_course(id).then((response) =>  response);
}
//NODICT:PUT:lms_courses (json): Update an existing course for the LMS. JSON must have an id set.
put.lms_courses = function (json) {
  let data = json;
  try {
    data = JSON.parse(json);
  } catch (e) {
  }
  if (!('id' in data)) {
    return 'You must provide a valid id!';
  }
  const id = data.id;
  return lms.put_course(id, data).then((response) =>  response);
}
//NODICT:GET:lms_courses_roster (course_id): Get a list of users in the given course.
get.lms_courses_roster = function (id) {
  return lms.get_course_roster(id).then((response) =>  response);
}
//NODICT:PUT:lms_enroll_user (course_id, user_id, json): Enroll a user into a course. By default enrolls as student.  In JSON body set roleid to change role.
put.lms_enroll_user = function (courseid, userid, json) {
  let data = json;
  try {
    data = JSON.parse(json);
  } catch (e) {
  }
  return lms.enroll_course_roster_user(courseid, userid, data).then((response) =>  response);
}
//NODICT:DEL:lms_unenroll_user (course_id, user_id): Unenroll a user from a course.
del.lms_unenroll_user = function (courseid, userid) {
  return lms.unenroll_course_roster_user(courseid, userid).then((response) =>  response);
}
//NODICT:GET:lms_users (id?): Get a list of users from the LMS. If id is supplied, get the specific user.
get.lms_users = function (id) {
  if (id) {
    return lms.get_user(id).then((response) =>  response);
  }
  return lms.get_users().then((response) =>  response);
}
//NODICT:POST:lms_users (json): Create a new user for the LMS
post.lms_users = function (json) {
  let data = json;
  try {
    data = JSON.parse(json);
  } catch (e) {
  }
  return lms.post_user(data).then((response) =>  response);
}
//NODICT:PUT:lms_users (json): Update an existing user for the LMS. JSON must have an id set.
put.lms_users = function (json) {
  let data = json;
  try {
    data = JSON.parse(json);
  } catch (e) {
  }
  if (!('id' in data)) {
    return 'You must provide a valid id!';
  }
  const id = data.id;
  return lms.put_user(id, data).then((response) =>  response);
}
//NODICT:DEL:lms_users (id): Delete a user from the LMS
del.lms_users = function (id) {
  return lms.delete_user(id).then((response) =>  response);
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

function boolify(value) {
	if (value == "1" || value === 1 || (typeof value === 'string' && value.toLowerCase() === 'true')) {
		return 1;
	}
	else {
		return 0;
	}
}

function topKFrequent(arrayOfStrings, k) {
	// Takes in arrayOfStrings (titles of content) and returns top k most frequent items in the list
    let hash = {}
    for (let key of arrayOfStrings) {
        if (!hash[key]) hash[key] = 0
        hash[key]+= 1 || 1;
    }
    const hashToArray = Object.entries(hash)
    const sortedArray = hashToArray.sort((a,b) => b[1] - a[1])
    const sortedElements = sortedArray.map(val => val[0])
    var response = [];
    for (var data of sortedArray.slice(0, k)) {
    	response.push({resource:data[0],count:data[1]})
    }
    return response;
}

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
