/**
 * @fileoverview Runtime configuration for connectbox-manage.
 *
 * Starts from a set of hard-coded defaults and then overlays any environment
 * variables whose names start with 'CHATHOST_'.  The suffix after the prefix
 * (lower-cased) becomes the config key, so CHATHOST_PORT=5003 overrides the
 * default port.  This lets systemd unit files or Docker environments inject
 * settings without touching source code.
 */

// Hard-coded defaults — safe values that allow the server to start with no
// environment configuration at all.
var configs = {
	"logging":"console",
	"port":5002
};

const
    Logger = require('./logger.js'),
    logger = new Logger(configs.logging);

// Overlay any CHATHOST_* environment variables onto the defaults.
// Each variable name is stripped of the prefix and lower-cased to form the
// config key so that environment variable naming conventions (UPPER_SNAKE_CASE)
// map cleanly to JavaScript property names (lowerCamelCase or lower_snake).
for (var env of Object.keys(process.env)) {
	if (env.includes('CHATHOST_')) {
		console.log(env);
		var key = env.replace('CHATHOST_','').toLowerCase();
		configs[key] = process.env[env];
	}
}

module.exports = configs;
