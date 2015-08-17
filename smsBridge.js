var express = require('express'),
    json = require('express-json'),
    util = require('util'),
    bodyParser = require('body-parser'),
    session = require('express-session'),
    server = express(),
    Gitter = require('node-gitter'),
    passport = require('passport'),
    OAuth2Strategy = require('passport-oauth2'),
    auth = require('./creds'),
    _ = require('lodash'),
    Logger = require('./logger'),
    logger = new Logger('api'),
    Q = require('q'),
    db = require('./dbClient'),
    twilio = require('twilio')(auth.sid, auth.token);
 
var smsNumber = process.env['SMS_NUMBER'] || '4252506802';
var sessionSecret = process.env['SESSION_SECRET'] || 'keyboard cat';

server.use(json());
server.use(bodyParser.urlencoded({extended: true}));
server.use(bodyParser.json());
server.use(session({saveUninitialized: false, resave: false, secret: sessionSecret}));

server.use(passport.initialize());
server.use(passport.session());

function unsubscribe(gitter, roomId) {
    return gitter.rooms
        .find(roomId)
        .then(function(room) {
            room.unsubscribe();
        });
}

function persistUserData(phone, userData, session) {
    db.persist(phone, userData);
}

function getUserData(phone, session) {
    return db.retrieve(phone)
        .then(function(userData) {
            return userData;
        });
}

function deleteUserData(phone, session) {
    if(session && session.user) {
        session.user = null;
    }
    db.remove(phone);
}

function shouldSendSms(phone, roomMessage) {
    var userData = getUserData(phone);
    var keywords = userData.keywords;
    var fromSelf = roomMessage.model.fromUser.username === userData.username;
    var containsKeyword = _.any(keywords, function(kw) {
        return _.includes(roomMessage.model.text, kw);
    });
    return !fromSelf && (keywords.length === 0 || containsKeyword);
}

function sendChatToPhone(phone, msg) {
    logger.info('sending msg to phone: ' + phone);
    logger.info('msg: ' + msg);
    twilio.messages.create({ 
        to: '+1' + phone, 
        from: '+1' + smsNumber,
        body: msg,
    }, function(err, message) { 
        console.log(err);
        console.dir(message);
    });
}

passport.use(new OAuth2Strategy({
    authorizationURL: 'https://gitter.im/login/oauth/authorize',
    tokenURL: 'https://gitter.im/login/oauth/token',
    clientID: auth.gitter_cid,
    clientSecret: auth.gitter_secret,
    callbackURL: 'http://gsms.theotherjim.com/gitter/auth/finish',
    passReqToCallback: true
}, function(req, accessToken, refreshToken, profile, done) {

    var phone = req.session.phone;
    var gitter = new Gitter(accessToken);
    gitter.currentUser().then(function(u) {
        var user = {
            version: 1,
            gitter: gitter,
            phone: phone,
            token: accessToken,
            username: u.username,
            keywords: []
        };
        gitter.rooms.findAll().then(function(r) {
            logger.log('verify: room => ' + util.inspect(r));
        });
        persistUserData(phone, user, req.session);
    })
    .then(function() {
        done(null, {phone: phone, token: accessToken});
    });
}));

passport.serializeUser(function(user, done) {
    done(null, JSON.stringify(user));
});
passport.deserializeUser(function(user, done) {
    done(null, JSON.parse(user));
});

server.post('/sms', function(req,res){
    logger.info('/sms');
    logger.info('from: ' + req.body.From);
    logger.info('body: ' + req.body.Body);
    logger.info('NumSegments: ' + req.body.NumSegments);
    
    var phone = req.body.From.substr(2); // remove '+1' from phone
    var msg = req.body.Body;
    getUserData(phone)
        .then(function(userData) {
            if(!userData) {
                sendChatToPhone(phone, 'Please register at gsms.theotherjim.com/gitter');
            }
            else {
                userData.gitter
                    .rooms
                    .find(userData.activeRoom.id)
                    .then(function(r) {
                        r.send(msg);
                    });
            }
        });
    res.end('<Response></Response>');
});

server.get('/', function (req, res) {
    res.redirect('/gitter');
});

function createRoomFilter(activeRoom) {
    return function(room) {
        return room.githubType !== 'ONETOONE'
            && room.githubType !== 'ORG'
            && (!activeRoom || room.id !== activeRoom.id);
    };
}
function gitterRoomToUiRoom(room) {
    return { 
        id: room.id,
            name: room.name
    };
}
server.get('/gitter/home', function (req, res, done) {
    var phone = req.session.phone;
    logger.info('home: going home for phone - ' + phone);
    getUserData(phone, req.session)
        .then(function(data) {
            if(!data) {
                logger.info('home: redirecting to /gitter');
                res.redirect('/gitter');
                done();
                return;
            }
            logger.info('home: doing gitter stuff');
            data.gitter.rooms.findAll()
                .then(function(gitterRooms) {
                    var rooms = _(gitterRooms)
                        .filter(createRoomFilter(data.activeRoom))
                        .map(gitterRoomToUiRoom)
                        .value();
                    var kw = data.keywords || [];

                    res.render('roomlist.jade', {
                        keywords: kw.join(', '),
                        activeRoom: data.activeRoom,
                        rooms: rooms
                    });
                })
                .catch(function(err) {
                    logger.error('home: ' + err);
                })
                .then(done);
        }).catch(function(err) {
            logger.error('home: caught => ' + err);
        });
});

server.post('/gitter/keywords', function(req,res) {
    var phone = req.body.phone;
    getUserData(phone, req.session).then(function(data) {
        if(!data) {
            res.status(401).send('log in before setting keywords');
            return;
        }

        var keywords = req.body.keywords;
        if(!keywords) {
            res.status(400).send('Missing keywords');
            return;
        }

        data.keywords = _.map(keywords.split(','), function(k) { return k.trim(); });
        persistUserData(data.phone, data, req.session);

        res.redirect('/gitter/home');
    });
});


server.get('/gitter/rooms/:roomId/subscribe', function(req, res, done) {
    var phone = req.session.phone;
    getUserData(phone).then(function(data) {
        var roomId = req.params.roomId
        console.log('sub - room: ' + roomId);
        if(!data) {
            res.redirect('/gitter');
            return;
        }
        return data.gitter.rooms
            .find(roomId)
            .then(function(room) {
                // same as room.subscribe() but only for chatMessages
                var resourcePath = '/api/v1/rooms/' + roomId + '/chatMessages';
                var events = room.faye.subscribeTo(resourcePath, resourcePath);
                events.on(resourcePath, function(msg) {
                    if(msg.operation !== 'create') {
                        return;
                    }

                    console.log(util.inspect(msg));
                    var message = msg.model.fromUser.username + ': ' + msg.model.text;

                    if(shouldSendSms(data.phone, msg)) {
                        sendChatToPhone(data.phone, message);
                    }
                });
                return {id: room.id, name: room.name, mentionOnly: true};
            })
            .then(function(activeRoom) {
                var oldActive = data.activeRoom;
                data.activeRoom = activeRoom;
                data.keywords = ['@' + data.username];
                persistUserData(data.phone, data, req.session);
                return oldActive;
            })
            .then(function(oldActive) {
                if(oldActive) {
                    return unsubscribe(data.gitter, oldActive.id);
                }
            })
            .then(function() {
                res.redirect('/gitter/home');
            });
    })
    .then(done, done);
});

server.get('/gitter/rooms/:roomId/unsubscribe', function(req, res, done) {
    var phone = req.session.phone;
    getUserData(phone).then(function(data) {
        var roomId = req.params.roomId
        console.log('unsub - room: ' + roomId);
        if(!data) {
            res.redirect('/gitter');
            return;
        }
        return unsubscribe(data.gitter, roomId)
            .then(function() {
                data.activeRoom = null;
                persistUserData(data.phone, data, req.session);
                res.redirect('/gitter/home');
            });
    })
    .then(done,done);
});

server.get('/gitter', function(req, res) {
    res.render('login.jade', {smsNumber: smsNumber});
});

server.post('/gitter/login', function(req, res) {
    var phone = req.body.phone;

    if(!phone) {
        res.status(400).send('Missing phone number');
        res.end();
        return;
    }
    var regex = new RegExp('\\d{10}');
    if (!regex.test(phone)) {
        res.status(400).send('Phone number must be 10 digits, no seperators. Ex: 1110001234');
        res.end();
        return;
    }

    getUserData(phone, req.session).then(function(data) {
        logger.info('login: back from getting data!');
        if(!data) {
            logger.error('login: user data is null...');
            res.status(401).send('Phone not registered, please register to log in.');
            res.end();
            return;
        }

        logger.info('login: found user data');
        req.session.phone = phone;
        res.status(200).redirect('/gitter/home');
    }).catch(function(err){
        logger.error('login: get user data threw!');
    });
});

server.post('/gitter/register', function(req, res, done) {
    var phone = req.body.phone;
    if(!phone) {
        res.status(400).send('missing phone number');
        res.end();
        return;
    }
    getUserData(phone, req.session).then(function(data) {
        if(data) {
            res.send('Phone is already registered, please log in.');
            res.end();
            return;
        }
        var regex = new RegExp('\\d{10}');
        if (!regex.test(phone)) {
            res.status(400).send('Phone number must be 10 digits, no seperators. Ex: 1110001234');
            res.end();
            return;
        }
        res.redirect('/gitter/phone/' + phone + '/auth');
        done();
    });
});

server.get('/gitter/phone/:phone/auth', function (req, res, done) {
    var phone = req.params.phone;
    req.session.phone = phone;
    logger.info('auth: ' + phone);
    getUserData(phone, req.session).then(function(userData) {
        if(!userData) {
            passport.authenticate('oauth2')(req,res,done);
        } else {
            res.redirect('/gitter/home');
            done();
        }
    });
});

server.delete('/gitter/phone/:phone', function(req,res) {
    console.log('deleting user content for ' + req.params.phone);
    deleteUserData(req.params.phone, req.session);
    res.status(200).send('OK');
    res.end();
});


server.get('/gitter/auth/finish',
    passport.authenticate('oauth2', {
        failureRedirect: '/gitter'
    }),
    function (req, res) {
        res.redirect('/gitter/home');
    }
);

var port = process.env['PORT'] || 8121;

server.listen(port, function() {
    console.log('server listening on port ' + port);
});
