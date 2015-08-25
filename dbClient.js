var client = require('mongodb').MongoClient,
    Logger = require('./logger'),
    logger = new Logger('DB'),
    Gitter = require('node-gitter'),
    Q = require('q'),
    _ = require('lodash'),
    util = require('util'),
    upsert,retrieve,remove,collection;

var url = process.env['MONGO_URL'] || 'mongodb://localhost:27017/gsms';


function getCollection() {
    if(collection) {
        return Q.resolve(collection);
    }

    logger.info('connecting to db');
    return Q.ninvoke(client, 'connect', url)
        .then(function(db) {
            logger.info('connected to db!');
            collection = db.collection('users');
            return collection;
        },logger.error);
}

function serializeToDbObject(userData) {
    var data = userData || {};
    var activeRoom = data.activeRoom && _.pick(data.activeRoom, ['id','name']);
    return {
        version: data.version,
        activeRoom: activeRoom,
        token: data.token,
        phone: data.phone,
        username: data.username,
        keywords: (data.keywords || []).join(','),
        signature: data.signature,
        smsFormat: data.smsFormat
    };
}
function processDbObj(dbObj) {
    switch (dbObj.version) {
        case 1:
            dbObj.smsFormat = '{from}: {text}';
            dbObj.signature = '';
            dbObj.version = 2;
        default:
            break;
    }

    dbObj.gitter = new Gitter(dbObj.token);
    dbObj.keywords = (dbObj.keywords || '').split(',');
    return {
        version: dbObj.version,
        phone: dbObj.phone,
        token: dbObj.token,
        username: dbObj.username,
        gitter: dbObj.gitter,
        keywords: dbObj.keywords,
        activeRoom: dbObj.activeRoom,
        signature: dbObj.signature,
        smsFormat: dbObj.smsFormat
    };
}
function deserializeToUserObject(dbObj) {
    if(!dbObj) {
        return null;
    }

    var user = processDbObj(dbObj);
    return user;
}

function persistUserData(phone, userData) {
    logger.info('trying to persist user data');
    var data = serializeToDbObject(userData);

    return getCollection()
        .then(function(c) {
            return Q.ninvoke(c, 'update',
                    {phone: phone}, data, {upsert: true});
        })
        .then(function() {
            logger.info('persisted user record.');
        });
}

function retrieveUserData(phone) {
    logger.info('getting user data');

    return getCollection()
        .then(function(c) {
            return Q.ninvoke(c.find({phone: phone}), 'toArray');
        })
        .then(function(data) {
            var user = data && data[0];
            var deserializedUser = deserializeToUserObject(user);
            logger.info('got user record: ' + util.inspect(deserializedUser));
            return deserializedUser;
        });
}

function retrieveAllUserData() {
    logger.info('getting all user data');

    return getCollection()
        .then(function(c) {
            return Q.ninvoke(c.find(), 'toArray');
        })
        .then(function(data) {
            logger.info('found ' + data.length + ' user records');
            return data.map(deserializeToUserObject);
        });
}

function removeUserRecord(phone) {
    return getCollection()
        .then(function(c) {
            return Q.ninvoke(c, 'remove', {phone: phone});
        })
        .then(function(data) {
            logger.info('removed user record: ' + util.inspect(data));
            return data && data[0];
        });
}

module.exports = {
    persist: persistUserData,
    retrieve: retrieveUserData,
    retrieveAll: retrieveAllUserData,
    remove: removeUserRecord
};

