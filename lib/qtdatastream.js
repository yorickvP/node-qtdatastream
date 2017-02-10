/*
 * node-qtdatastream
 * https://github.com/magne4000/node-qtdatastream
 *
 * Copyright (c) 2016 Joël Charles
 * Licensed under the MIT license.
 */

var EventEmitter = require('events').EventEmitter,
    NetSocket = require('net').Socket,
    debuglib = require('debug'),
    logger = debuglib('qtdatastream:main'),
    loggerw = debuglib('qtdatastream:main-write'),
    util = require('util'),
    Transform = require('stream').Transform,
    debug = !!process.env.QTDSDEBUG || debuglib.enabled("qtdatastream:*");

/** @module qtdatastream */

/**
 * Qt types list
 * @readonly
 * @enum {number}
 */
exports.Types = {
    INVALID: 0,
    BOOL: 1,
    INT: 2,
    UINT: 3,
    INT64: 4,
    UINT64: 5,
    DOUBLE: 6,
    CHAR: 7,
    MAP: 8,
    LIST: 9,
    STRING: 10,
    STRINGLIST: 11,
    BYTEARRAY: 12,
    TIME: 15,
    DATETIME: 16,
    USERTYPE: 127,
    SHORT: 133
};

if (debug && !debuglib.enabled("qtdatastream:*")) {
    debuglib.enable("qtdatastream:*");
}

exports.QTDATASTREAMCLASS = "__QTDATASTREAMCLASS__";

exports.userTypes = {};

exports.toggleEndianness = function(buffer) {
    buffer.swap16();
    return buffer;
};

class ReadTransform extends Transform {
    getsize(bufferlist) {
        var Reader = require('./reader');
        // get 4 bytes
        let final_buffer;
        if (bufferlist[0] && bufferlist[0].length >= 4) {
            final_buffer = bufferlist[0];
        } else {
            let totallength = 0, i = 0;
            while(totallength < 4 && i < bufferlist.length) {
                totallength += bufferlist[i++].length;
            }
            if (totallength < 4) return Infinity;
            final_buffer = Buffer.concat(bufferlist.slice(0,i), totallength);
        }
        return final_buffer.readUInt32BE();
    }
    constructor(options, type) {
        super(Object.assign({readableObjectMode: true, writableObjectMode: false}))
        this.Reader = require('./reader');
        this.type = type
        this.packet_no = 0
        this.data_state = {size: Infinity, data: [], recvd: 0};
    }
    chunkify() {
        const out = []
        while (true) {
            const ds = this.data_state;
            if (ds.size == Infinity && ds.recvd >= 4) {
                ds.size = this.getsize(ds.data);
            }
            if (ds.size < Infinity && ds.size > 64 * 1024 * 1024) {
                console.error("that's a bug", ds.size)
                throw new Error('oversized packet detected')
            }
            this.emit('progress', ds.recvd, ds.size);
            if (ds.size + 4 > ds.recvd) {
                if (debug) {
                    logger("(%d/%d) Waiting for end of buffer", ds.recvd, ds.size + 4);
                }
                return out
            } else {
                const reader = new (this.Reader)(Buffer.concat(ds.data, ds.recvd), this.type);
                if (debug) {
                    logger("(%d/%d) Received full buffer", ds.recvd, ds.size + 4);
                }
                reader.parse();
                if (debug) {
                    logger('Received result');
                    logger(reader.parsed);
                }
                if (reader.remaining && reader.remaining.length > 0) {
                    this.data_state = {
                        data: [reader.remaining],
                        recvd: reader.remaining.length,
                        size: Infinity
                    };
                    out.push(reader.parsed)
                } else {
                    this.data_state = {size: Infinity, data: [], recvd: 0};
                    out.push(reader.parsed)
                    return out
                }
            }
        }
    }
    _transform(data, encoding, callback) {
        if (data !== null) {
            this.data_state.data.push(data);
            this.data_state.recvd += data.length;
        }
        let out
        try {
            out = this.chunkify()
        } catch(e) {
            callback(e)
            return
        }
        for(let i = 0; i < out.length; i++) {
            this.push(out[i])
        }
        callback()

    }
    _flush(cb) {
        if (this.data_state && this.data_state.recvd > 0) {
            cb("stream ended in the middle of a packet")
        }
    }
}
class WriteTransform extends Transform {
    constructor(options, raw) {
        super(Object.assign({readableObjectMode: false, writableObjectMode: true}))
        this.raw = raw
    }
    _transform(data, encoding, callback) {
        const Writer = require('./writer');
        let buffer
        if (this.raw) {
            const writer = new Writer(data);
            buffer = writer.getRawBuffer();
            const size = Buffer(4)
            size.writeUInt32BE(buffer.length)
            this.push(size)
        } else {
            const writer = new Writer(data);
            buffer = writer.getBuffer()
        }
        if (debug) {
            loggerw(buffer)
        }
        callback(null, buffer);
    }
}

Object.assign(module.exports, {ReadTransform, WriteTransform})

/**
 * Qt compliant Socket overload.
 * 'data' event is triggered only when full buffer is received.
 * 'error', 'close' and 'end' event are not altered.
 * @class
 * @param {net.Socket} socket
 */
exports.Socket = function Socket(socket, type) {
    // if (!(socket instanceof NetSocket)) {
    //     throw "Socket must be an instance of net.Socket";
    // }
    var self = this;
    self.socket = socket;
    self.data_state = null;
    self.write_stream = new WriteTransform({}, !!type);
    self.read_stream = new ReadTransform({}, type);
    this.read_stream.on('data', (data) => {
        process.nextTick(()=> this.emit('data', data))
    })

    if (socket) self.setSocket(socket);


};
util.inherits(exports.Socket, EventEmitter);

/**
 * Write data to the socket
 * @param {*} data Data that will be written using Writer
 */
exports.Socket.prototype.write = function(data) {
    this.write_stream.write(data);
};

exports.Socket.prototype.removeSocket = function() {
    console.log("removing socket")
    const socket = this.socket
    this.write_stream.unpipe(socket);
    socket.unpipe(this.read_stream);
    socket.removeAllListeners();
    this.socket = null
    return socket
}

/**
 * Update the socket (for example to promote it to SSL stream)
 * @param {Stream} socket object implementing Stream interface
 */
exports.Socket.prototype.setSocket = function(socket) {
    var Reader = require('./reader');
    logger("updating socket")
    var self = this;

    // if (this.read_stream._writableState.writing) {
    //     // should not happen
    // }


    this.socket = socket;
    this.write_stream.pipe(this.socket).pipe(this.read_stream);
    
    this.socket.on('error', function(e) {
        if (debug) {
            logger('ERROR');
        }
        self.emit('error', e);
    });
    
    this.socket.on('close', function() {
        if (debug) {
            logger('Connection closed');
        }
        self.emit('close');
    });
    
    this.socket.on('end', function() {
        if (debug) {
            logger('END');
        }
        self.emit('end');
    });
};

/**
 * Register a new QUserType.
 * @param {string} key
 * @param {number} type
 */
exports.registerUserType = function(key, type) {
    exports.userTypes[key] = type;
    if (Array.isArray(type)) {
        const reads = type.map(t => {
            const key = Object.keys(t), val = t[key];
            if (typeof val == 'string') {
                return `this.${key} = reader.getQVariantByType(exports.Types.USERTYPE, "${val}");`;
            } else {
                return `this.${key} = reader.getQVariantByType(${val});`;
            }
        });
        exports.userTypes[key].constr = eval(`(function UserType(reader) { ${reads.join("\n")} })`);
    }
};

/**
 * Get the QUserType definition
 * @param {string} key
 * @returns {*}
 */
exports.getUserType = function(key) {
    return exports.userTypes[key];
};

/**
 * Return true if the QUserType specified by key contains multiple fields
 * @param {string} key
 * @returns {*}
 */
exports.isUserTypeComplex = function(key) {
    return Object.prototype.toString.call(exports.getUserType(key)) === '[object Array]';
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QVariant for the Writer
 * @class
 * @name QVariant
 * @param {*} obj
 * @example
 * new Writer("a string"); // will be written as QString
 * new Writer(new QVariant("a string")); // will be written as QVariant<QString>
 */
exports.QVariant = function QVariant(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
    if (typeof obj === 'object') {
        var jstype = Object.prototype.toString.call(obj);
        if (obj instanceof exports.QString) {
            this.type = exports.Types.STRING;
        } else if (obj instanceof exports.QChar) {
            this.type = exports.Types.CHAR;
        } else if (obj instanceof exports.QMap) {
            this.type = exports.Types.MAP;
        } else if (obj instanceof exports.QList) {
            this.type = exports.Types.LIST;
        } else if (jstype === '[object Array]') {
            this.type = exports.Types.LIST;
        } else if (obj instanceof exports.QUInt) {
            this.type = exports.Types.UINT;
        } else if (obj instanceof exports.QBool) {
            this.type = exports.Types.BOOL;
        } else if (obj instanceof exports.QShort) {
            this.type = exports.Types.SHORT;
        } else if (obj instanceof exports.QInt) {
            this.type = exports.Types.INT;
        } else if (obj instanceof exports.QInt64) {
            this.type = exports.Types.INT64;
        } else if (obj instanceof exports.QUInt64) {
            this.type = exports.Types.UINT64;
        } else if (obj instanceof exports.QDouble) {
            this.type = exports.Types.DOUBLE;
        } else if (obj instanceof exports.QStringList) {
            this.type = exports.Types.STRINGLIST;
        } else if (obj instanceof exports.QTime) {
            this.type = exports.Types.TIME;
        } else if (obj instanceof exports.QDateTime) {
            this.type = exports.Types.DATETIME;
        } else if (jstype === '[object Date]') {
            this.type = exports.Types.DATETIME;
        } else if (obj instanceof exports.QUserType) {
            this.type = exports.Types.USERTYPE;
        } else if (obj instanceof exports.QByteArray) {
            this.type = exports.Types.BYTEARRAY;
        } else if (obj instanceof exports.QInvalid) {
            this.type = exports.Types.INVALID;
        } else {
            this.type = exports.Types.MAP;
        }
    } else if (typeof obj === 'string') {
        this.type = exports.Types.STRING;
    } else if (typeof obj === 'number') {
        this.type = exports.Types.UINT;
    } else if (typeof obj === 'boolean') {
        this.type = exports.Types.BOOL;
    }
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QTime for the Writer.
 * @class
 * @name QTime
 * @param {*} obj
 */
exports.QTime = function QTime(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QDateTime for the Writer.
 * @class
 * @name QDateTime
 * @param {*} obj
 */
exports.QDateTime = function QDateTime(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QString for the Writer.
 * Javascript string are converted to QString objects internally.
 * When parsed from reader, QString objects are converted back to Javascript string
 * @class
 * @name QString
 * @param {*} obj
 * @example
 * new Writer(new QString(null)); // will be written as a null QString
 */
exports.QString = function QString(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QChar for the Writer.
 * @class
 * @name QChar
 * @param {*} obj
 */
exports.QChar = function QChar(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QMap for the Writer.
 * @class
 * @name QMap
 * @param {*} obj
 */
exports.QMap = function QMap(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QList for the Writer.
 * Javascript Array are converted to QList objects internally.
 * When parsed from reader, QList objects are converted back to Javascript Array
 * @class
 * @name QList
 * @param {*} obj
 */
exports.QList = function QList(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QStringList for the Writer.
 * @class
 * @name QStringList
 * @param {*} obj
 */
exports.QStringList = function QStringList(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QUInt for the Writer.
 * Javascript number are converted to QUInt objects internally.
 * When parsed from reader, QUInt objects are converted back to Javascript number
 * @class
 * @name QUInt
 * @param {*} obj
 */
exports.QUInt = function QUInt(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QBool for the Writer.
 * Javascript boolean are converted to QBool objects internally.
 * When parsed from reader, QBool objects are converted to Javascript number
 * @class
 * @name QBool
 * @param {*} obj
 */
exports.QBool = function QBool(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QInt for the Writer.
 * @class
 * @name QInt
 * @param {*} obj
 */
exports.QInt = function QInt(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QInt64 for the Writer.
 * @class
 * @name QInt64
 * @param {*} obj
 */
exports.QInt64 = function QInt64(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QUInt64 for the Writer.
 * @class
 * @name QUInt64
 * @param {*} obj
 */
exports.QUInt64 = function QUInt64(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QShort for the Writer.
 * @class
 * @name QShort
 * @param {*} obj
 */
exports.QShort = function QShort(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QDouble for the Writer.
 * @class
 * @name QDouble
 * @param {*} obj
 */
exports.QDouble = function QDouble(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};


/**
 * This class allow users to force a specific object to be recognized as
 * a QByteArray for the Writer.
 * @class
 * @name QByteArray
 * @param {*} obj
 */
exports.QByteArray = function QByteArray(obj){
    this.obj = obj;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QInvalid for the Writer.
 * @class
 * @name QInvalid
 * @param {*} obj
 */
exports.QInvalid = function QInvalid(){
    this.obj = undefined;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * This class allow users to force a specific object to be recognized as
 * a QUserType for the Writer.
 * @class
 * @name QUserType
 * @param {string} name
 * @param {*} obj
 */
exports.QUserType = function QUserType(name, obj){
    this.obj = obj;
    this._qusertype_name = name;
    this._qclass = exports.QTDATASTREAMCLASS;
};

/**
 * Get user defined type name
 */
exports.QUserType.prototype.getName = function() {
    return this._qusertype_name;
};

exports.Writer = require('./writer');

exports.Reader = require('./reader');

exports.util = require('./util');

exports.Class = function(type, value) {
    switch(type) {
        case exports.Types.INVALID:
            return new exports.QInvalid(value);
        case exports.Types.BOOL:
            return new exports.QBool(value);
        case exports.Types.INT:
            return new exports.QInt(value);
        case exports.Types.UINT:
            return new exports.QUInt(value);
        case exports.Types.INT64:
            return new exports.QInt64(value);
        case exports.Types.UINT64:
            return new exports.QUInt64(value);
        case exports.Types.DOUBLE:
            return new exports.QDouble(value);
        case exports.Types.MAP:
            return new exports.QMap(value);
        case exports.Types.LIST:
            return new exports.QList(value);
        case exports.Types.STRING:
            return new exports.QString(value);
        case exports.Types.CHAR:
            return new exports.QChar(value);
        case exports.Types.STRINGLIST:
            return new exports.QStringList(value);
        case exports.Types.BYTEARRAY:
            return new exports.QByteArray(value);
        case exports.Types.TIME:
            return new exports.QTime(value);
        case exports.Types.DATETIME:
            return new exports.QDateTime(value);
        case exports.Types.USERTYPE:
            return new exports.QUserType(value);
        case exports.Types.SHORT:
            return new exports.QShort(value);
    }
};

