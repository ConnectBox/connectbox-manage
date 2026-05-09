/**
 * @fileoverview Unified logging wrapper for connectbox-manage.
 *
 * Abstracts over two backends: plain console.log (used in development and
 * when configs.logging === 'console') and winston with a timestamped JSON
 * format (used in production).  All other modules obtain a Logger instance
 * via `new Logger(configs.logging)` so the backend can be swapped at
 * deploy time without touching call sites.
 */

const moment = require('moment-timezone');
const winston = require('winston');

/**
 * Thin logging wrapper that unifies console and winston under one interface.
 *
 * Choosing the backend at construction time (rather than per call) means
 * callers never need to branch on the environment themselves.
 */
class Logger {
    /**
     * Create a Logger instance.
     *
     * @param {string} output - 'console' for plain console.log output;
     *   any other value creates a winston logger with timestamped JSON
     *   entries written to stdout.
     */
    constructor(output) {
        this.consoleLogger = output === 'console';
        this.logger = this.consoleLogger
            ? console
            : winston.createLogger({
                  transports: [new winston.transports.Console()]
              });
    }

    /**
     * Emit a log entry.
     *
     * For console mode the message is prefixed with the level string so log
     * lines are grep-friendly.  For winston mode the entry is a structured
     * object with date, level, and message fields so log aggregators can
     * parse and filter it without regex.
     *
     * @param {string} type - Log level string, e.g. 'info', 'debug', 'error'.
     * @param {string} message - Human-readable log message.
     */
    log(type, message) {
        if (this.consoleLogger) {
            this.logger.log(`${type}: ${message}`);
        } else {
            this.logger.log({
                date: moment().format(),
                level: type,
                message: message
            });
        }
    }
}

module.exports = Logger;
