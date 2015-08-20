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
    twilio = require('twilio')(auth.sid, auth.token),
    mustache = require('mustache-express'),
    path = require('path');
 
var smsNumber = process.env['SMS_NUMBER'] || '4252506802';
var sessionSecret = process.env['SESSION_SECRET'] || 'keyboard cat';

server.use(express.static(path.join(__dirname, 'public')));
server.engine('mustache', mustache());
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

function shouldSendSms(userData, roomMessage) {
    var keywords = userData.keywords;
    var fromSelf = roomMessage.model.fromUser.username === userData.username;
    var containsKeyword = _.any(keywords, function(kw) {
        return _.includes(roomMessage.model.text, kw);
    });
    return !fromSelf && (keywords.length === 0 || containsKeyword);
}

function buildMessageFromGitterToSms(userData, roomMessage) {
    var fromUsername = roomMessage.model.fromUser.username;
    var message = fromUsername + ': ' + roomMessage.model.text;
    return message;
}

function sendChatOnKeywordMatch(phone, roomMessage) {
    getUserData(phone)
        .then(function(data) {
            if(shouldSendSms(data, roomMessage)) {
                var message = buildMessageFromGitterToSms(data, roomMessage);
                sendChatToPhone(phone, message);
            }
        });
}
function subscribe(room, phone) {
    logger.info('subscribe: ' + room.name + ' <=> ' + phone);
    // same as room.subscribe() but only for chatMessages
    var resourcePath = '/api/v1/rooms/' + room.id + '/chatMessages';
    var events = room.faye.subscribeTo(resourcePath, resourcePath);
    events.on(resourcePath, function(msg) {
        if(msg.operation !== 'create') {
            return;
        }

        var fromUsername = msg.model.fromUser.username;
        var message = fromUsername + ': ' + msg.model.text;
        logger.info('onchat: user = ' + phone + ', msg = ' + message);

        sendChatOnKeywordMatch(phone, msg);
    });
    return {id: room.id, name: room.name};
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
server.get('/gitter/home', function (req, res) {
    var phone = req.session.phone;
    logger.info('home: going home for phone - ' + phone);
    getUserData(phone, req.session)
        .then(function(data) {
            if(!data) {
                logger.info('home: redirecting to /gitter');
                res.redirect('/gitter');
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

                    res.render('roomlist.mustache', {
                        keywords: kw.join(', '),
                        activeRoom: data.activeRoom,
                        rooms: rooms
                    });
                })
                .catch(function(err) {
                    logger.error('home: ' + err);
                });
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
                return subscribe(room, phone);
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
    res.render('login.mustache', {phone: smsNumber});
});

server.get('/test/:page', function(req, res) {
    var page = req.params.page;
    switch(page) {
    case 'login':
        res.render('login.mustache', {phone: '1231231234'});
        break;
    case 'nohome':
        res.render('roomlist.mustache', {
            rooms: [
                {name:'test/room1', id: 'testing1'},
                {name:'test/room2', id: 'testing2'},
                {name:'test/room3', id: 'testing3'},
                {name:'test/room4', id: 'testing4'},
                {name:'test/room5', id: 'testing5'},
                {name:'test/room6', id: 'testing6'},
                {name:'test/room7', id: 'testing7'},
                {name:'test/room8', id: 'testing8'},
                {name:'test/room9', id: 'testing9'},
                {name:'test/room10', id: 'testing10'}
            ],
            keywords: '@user, alert, ping'
        });
        break;
    case 'home':
        res.render('roomlist.mustache', {
            rooms: [
                {name:'test/room1', id: 'testing1'},
                {name:'test/room2', id: 'testing2'},
                {name:'test/room3', id: 'testing3'},
                {name:'test/room4', id: 'testing4'},
                {name:'test/room5', id: 'testing5'},
                {name:'test/room6', id: 'testing6'},
                {name:'test/room7', id: 'testing7'},
                {name:'test/room8', id: 'testing8'},
                {name:'test/room9', id: 'testing9'},
                {name:'test/room10', id: 'testing10'}
            ],
            activeRoom: { name: 'test/active'},
            keywords: '@user, alert, ping'
        });
        break;
    }
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
    logger.info('deleting user content for ' + req.params.phone);
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

function reconnectRoomSubscriptions() {
    logger.info('reconnect: start');
    db.retrieveAll()
        .then(function(users) {
            _.filter(users, function(u) {
                return !!u.activeRoom;
            }).forEach(function(u) {
                u.gitter
                    .rooms
                    .find(u.activeRoom.id)
                    .then(function(r){
                        subscribe(r, u.phone);
                    });
            });
        });
}
var port = process.env['PORT'] || 8121;

server.listen(port, function() {
    logger.info('server listening on port ' + port);
    reconnectRoomSubscriptions();
});
