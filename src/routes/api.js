/**
 * @fileoverview Express router for the /admin/api REST endpoints.
 *
 * All routes are protected by the auth middleware mounted in index.js before
 * this router is attached.  Each handler delegates to the corresponding entry
 * in functions.js (functions.get, functions.set, functions.doCommand, etc.)
 * and wraps the result in a {code, result} envelope so the admin UI always
 * receives a consistent response shape.
 *
 * Responses that carry a .status field (set by functions that detect errors)
 * are forwarded as HTTP error responses so the browser receives the correct
 * status code.  All other responses are sent as JSON with HTTP 200.
 */

const express = require('express'),
    router = express.Router()
    configs = require('../configs.js'),
    fs = require('fs'),
    Logger = require('../logger.js'),
    logger = new Logger(configs.logging),
    functions = require('../functions.js');

/**
 * Execute a named do-command (e.g. sync, shutdown, reboot).
 *
 * Maps GET /admin/api/do/:command to functions.doCommand[command]().
 * Commands are fire-and-forget actions that don't take a request body.
 */
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

/**
 * Read a single key from brand.j2 device configuration.
 *
 * Maps GET /admin/api/brand/:key to functions.getBrand(key).
 */
router.get('/brand/:key', function get(req, res) {
	var data = {code:0,result: [functions.getBrand(req.params.key)]};
	logger.log('debug', `${req.method} ${req.originalUrl}: ${data.result[0]}`);
	res.send(data);
});

/**
 * Retrieve a named log source (e.g. wifistatus, webserver).
 *
 * Maps GET /admin/api/logs/:log to functions.getLogs(log).
 * Valid log names are defined in the logSources map in functions.js.
 */
router.get('/logs/:log', function get(req, res) {
	var data = {code:0,result: [functions.getLogs(req.params.log)]};
	logger.log('debug', `${req.method} ${req.originalUrl}: ${data.result[0]}`);
	res.send(data);
});

/**
 * Read a device setting by key (e.g. apssid, apchannel, hostname).
 *
 * Maps GET /admin/api/:key to functions.get[key]().
 * Key names correspond to DICT:GET entries in functions.js.
 */
router.get('/:key', function get(req, res) {
	var data = {code:0,result: [functions.get[req.params.key]()]};
	logger.log('debug', `${req.method} ${req.originalUrl}: ${data.result[0]}`);
	res.send(data);
});

/**
 * Write a key=value pair to brand.j2 device configuration.
 *
 * Maps PUT /admin/api/brand to functions.setBrand(body).
 * Request body must be {value: 'Key=NewValue'}.
 */
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

/**
 * Update a device setting by key (e.g. apssid, apchannel, hostname).
 *
 * Maps PUT /admin/api/:key to functions.set[key](body).
 * Key names correspond to DICT:SET entries in functions.js.
 * Request body must be {value: <newValue>}.
 */
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
