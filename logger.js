
module.exports = function(prefix) {
    function _log(level, msg) {
        console.log([prefix, level, msg].join(': '));
    };
    this.log = _log;

    function _error(msg) {
        _log('error', msg);
    }
    this.error = _error;

    function _info(msg) {
        _log('info', msg);
    }
    this.info = _info;
};

