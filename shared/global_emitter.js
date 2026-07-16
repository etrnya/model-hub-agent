const EventEmitter = require('events');
class GlobalEmitter extends EventEmitter {}
const globalEmitter = new GlobalEmitter();
module.exports = globalEmitter;
