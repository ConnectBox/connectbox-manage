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

var chats = {};
var boxid = functions.get['hostname'];

console.log(`Listening on port ${configs.port}`);
app.listen(configs.port);
app.use(cors());
app.options('*', cors());
app.use(bodyParser.json({ type: 'application/json', limit: '50mb' }));

app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(bodyParser.text({ type: 'text/html' , limit: '50mb'}));
app.use(cookieParser());
app.use(cookieSession({name: 'relaytrust',keys: ['81143184-d876-11eb-b8bc-0242ac130003'],maxAge: 24 * 60 * 60 * 1000}));

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

app.get('/admin/api/logout', function(req,res) {
	logger.log('debug', `${req.method} ${req.originalUrl}: Logged Out`);
	req.session = null;
	res.sendStatus(200);
})

app.get('/admin/api/ismoodle', function(req,res) {
	var data = {code:0,result: [functions.get["ismoodle"]()]};
	logger.log('debug', `${req.method} ${req.originalUrl}: ${data.result[0]}`);
	res.send(data);
})

app.get('/admin/api/downloadweblog', function(req,res) {
	logger.log('debug', `${req.method} ${req.originalUrl}`);
	var columns = ['boxid', 'mediaIdentifier', 'interactionType', 'mediaType', 'mediaLanguage', 'mediaProvider', 'date'];
	var data = [];
	data.push(columns);
	var getData = functions.get.weblog();
	for (var item of getData) {
		var fitem = [];
		item.date = moment(item.timestamp * 1000).format('LLL');
		item.boxid = boxid();
		for (var col of columns) {
			fitem.push(item[col] || '');
		}
		data.push(fitem);
	}
	var rows = [];
	for (var item of data) {
		rows.push('"' + item.join('","') + '"');
	}
	res.type('text/csv');
	res.send (rows.join('\n'))
});

app.get('/admin/api/deleteweblog', function(req,res) {
	logger.log('debug', `${req.method} ${req.originalUrl}`);
	res.send ([])
});


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

app.get(['/chat','/chat/:lastMessage'], function(req,res) {
	// Check for lastMessage value, otherwise, get all non expired messages
	if (!req.params || !req.params.lastMessage) {
		req.params={lastMessage:0};
	}
	var deleteTime = moment().valueOf() - (3 * 60 * 60 * 1000);  //Delete messages older than 3 hours
	var deleteCount = 0; // Count the number of messages deleted just for logging
	var chatArray = []; // Build this array for the response
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


app.use('/admin/api', require('./routes/api.js'));



function auth(password) {
	try {
		var authString = fs.readFileSync('/usr/local/connectbox/etc/basicauth','utf-8');
		var checkPassword = execSync(`echo ${password} | openssl passwd -apr1 -salt CBOX2018 -stdin`).toString().replace('\n','');
		//console.log(`--${authString}--${'admin:' + checkPassword}--`);
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