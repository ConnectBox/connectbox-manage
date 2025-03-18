const express = require('express'),
    router = express.Router()
    configs = require('../configs.js'),
    fs = require('fs'),
    Logger = require('../logger.js'),
    logger = new Logger(configs.logging),
    functions = require('../functions.js');



router.get('/do/:command', function doCommand(req,res) {
	var data = {code:0,result: [functions.doCommand[req.params.command]()]};
	logger.log('debug', `${req.method} ${req.originalUrl}: ${data.result[0]}`);
	if (data.result[0].status) {
		res.status(data.result[0].status).send(data.result[0].message);
	}
	else {
		res.send(data);
	}
});

router.get('/brand/:key', function get(req, res) {
	var data = {code:0,result: [functions.getBrand(req.params.key)]};
	logger.log('debug', `${req.method} ${req.originalUrl}: ${data.result[0]}`);
	res.send(data);
});

router.get('/logs/:log', function get(req, res) {
	var data = {code:0,result: [functions.getLogs(req.params.log)]};
	logger.log('debug', `${req.method} ${req.originalUrl}: ${data.result[0]}`);
	res.send(data);
});

router.get('/:key', function get(req, res) {
	var data = {code:0,result: [functions.get[req.params.key]()]};
	logger.log('debug', `${req.method} ${req.originalUrl}: ${data.result[0]}`);
	res.send(data);
});

router.put('/brand', function set(req,res) {
	var data = {code:0,result: [functions.setBrand(req.body)]};
	logger.log('debug', `${req.method} ${req.originalUrl}: ${JSON.stringify(data.result[0])}`);
	if (data.result[0].status) {
		res.status(data.result[0].status).send(data.result[0].message);
	}
	else {
		res.send(data);
	}
});

router.put('/:key', function set(req,res) {
	var data = {code:0,result: [functions.set[req.params.key](req.body)]};
	logger.log('debug', `${req.method} ${req.originalUrl}: ${JSON.stringify(data.result[0])}`);
	if (data.result[0].status) {
		res.status(data.result[0].status).send(data.result[0].message);
	}
	else {
		res.send(data);
	}
});

module.exports = router;
