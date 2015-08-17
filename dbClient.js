var client = require('mongodb').MongoClient,
    Logger = require('./logger'),
    logger = new Logger('DB'),
    Gitter = require('node-gitter'),
    Q = require('q'),
    _ = require('lodash'),
    util = require('util'),
    upsert,retrieve,remove,collection;

var url = process.env['MONGO_URL'] || 'mongodb://localhost:27017/gsms';

logger.info('connecting to db');
client.connect(url, function(err, db) {

    if(err) {
        logger.error(err);
    }
    logger.info('connected to db!');
    collection = db.collection('users');
    //upsert = Promise.denodeify(collection.update);
    //retrieve = Promise.denodeify(collection.find);
    //remove = Promise.denodeify(collection.remove);
});


function serializeToDbObject(userData) {
    var data = userData || {};
    var activeRoom = data.activeRoom && _.pick(data.activeRoom, ['id','name']);
    return {
        version: data.version,
        activeRoom: activeRoom,
        token: data.token,
        phone: data.phone,
        username: data.username,
        keywords: (data.keywords || []).join(',')
    };
}

function deserializeToUserObject(dbObj) {
    if(!dbObj) {
        return null;
    }

    var keywords = dbObj.keywords || '';
    return {
        version: dbObj.version,
        token: dbObj.token,
        activeRoom: dbObj.activeRoom,
        gitter: new Gitter(dbObj.token),
        phone: dbObj.phone,
        username: dbObj.username,
        keywords: keywords.split(',')
    };
}

function persistUserData(phone, userData) {
    logger.info('trying to persist user data');
    if(!collection) {
        logger.error('not connected to db');
        return Q.reject('not connected');
    }


    var data = serializeToDbObject(userData);
    //return upsert({phone: userData.phone}, data, {upsert: true})
    return Q.ninvoke(collection,'update', {phone: phone}, data, {upsert: true})
        .then(function(data) {
            logger.info('got user record: ' + util.inspect(data));
            return data && data[0];
        });
}

function retrieveUserData(phone) {
    logger.info('getting user data');

    if(!collection) {
        logger.error('not connected to db!');
        return Q.reject('not connected');
    }

    return Q.ninvoke(collection.find({phone: phone}), 'toArray')
        .then(function(data) {
            var user = data && data[0];
            logger.info('got user record: ' + util.inspect(user));
            return deserializeToUserObject(user);
        });
}

function removeUserRecord(phone) {
    if(!collection) {
        logger.error('not connected to db!');
        return Q.reject('not connected');
    }
    return Q.ninvoke(collection, 'remove', {phone: phone})
        .then(function(data) {
            logger.info('removed user record: ' + util.inspect(data));
            return data && data[0];
        });
}

module.exports = {
    persist: persistUserData,
    retrieve: retrieveUserData,
    remove: removeUserRecord
};

