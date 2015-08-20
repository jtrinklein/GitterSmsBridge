module.exports = {
    sid: process.env['TWILIO_SID'] || 'sid',
    token: process.env['TWILIO_TOKEN'] || 'token',
    gitter_cid: process.env['GITTER_KEY'] || 'key',
    gitter_secret: process.env['GITTER_SECRET'] || 'secret'
};

