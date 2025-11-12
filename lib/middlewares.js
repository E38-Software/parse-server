"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.addRateLimit = exports.DEFAULT_ALLOWED_HEADERS = void 0;
exports.allowCrossDomain = allowCrossDomain;
exports.allowDoubleForwardSlash = allowDoubleForwardSlash;
exports.allowMethodOverride = allowMethodOverride;
exports.checkIp = void 0;
exports.enforceMasterKeyAccess = enforceMasterKeyAccess;
exports.handleParseErrors = handleParseErrors;
exports.handleParseHeaders = handleParseHeaders;
exports.handleParseSession = void 0;
exports.promiseEnforceMasterKeyAccess = promiseEnforceMasterKeyAccess;
exports.promiseEnsureIdempotency = promiseEnsureIdempotency;
var _cache = _interopRequireDefault(require("./cache"));
var _node = _interopRequireDefault(require("parse/node"));
var _Auth = _interopRequireDefault(require("./Auth"));
var _Config = _interopRequireDefault(require("./Config"));
var _ClientSDK = _interopRequireDefault(require("./ClientSDK"));
var _logger = _interopRequireDefault(require("./logger"));
var _rest = _interopRequireDefault(require("./rest"));
var _MongoStorageAdapter = _interopRequireDefault(require("./Adapters/Storage/Mongo/MongoStorageAdapter"));
var _PostgresStorageAdapter = _interopRequireDefault(require("./Adapters/Storage/Postgres/PostgresStorageAdapter"));
var _expressRateLimit = _interopRequireDefault(require("express-rate-limit"));
var _Definitions = require("./Options/Definitions");
var _pathToRegexp = require("path-to-regexp");
var _rateLimitRedis = _interopRequireDefault(require("rate-limit-redis"));
var _redis = require("redis");
var _net = require("net");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const DEFAULT_ALLOWED_HEADERS = exports.DEFAULT_ALLOWED_HEADERS = 'X-Parse-Master-Key, X-Parse-REST-API-Key, X-Parse-Javascript-Key, X-Parse-Application-Id, X-Parse-Client-Version, X-Parse-Session-Token, X-Requested-With, X-Parse-Revocable-Session, X-Parse-Request-Id, Content-Type, Pragma, Cache-Control';
const getMountForRequest = function (req) {
  const mountPathLength = req.originalUrl.length - req.url.length;
  const mountPath = req.originalUrl.slice(0, mountPathLength);
  return req.protocol + '://' + req.get('host') + mountPath;
};
const getBlockList = (ipRangeList, store) => {
  if (store.get('blockList')) {
    return store.get('blockList');
  }
  const blockList = new _net.BlockList();
  ipRangeList.forEach(fullIp => {
    if (fullIp === '::/0' || fullIp === '::') {
      store.set('allowAllIpv6', true);
      return;
    }
    if (fullIp === '0.0.0.0/0' || fullIp === '0.0.0.0') {
      store.set('allowAllIpv4', true);
      return;
    }
    const [ip, mask] = fullIp.split('/');
    if (!mask) {
      blockList.addAddress(ip, (0, _net.isIPv4)(ip) ? 'ipv4' : 'ipv6');
    } else {
      blockList.addSubnet(ip, Number(mask), (0, _net.isIPv4)(ip) ? 'ipv4' : 'ipv6');
    }
  });
  store.set('blockList', blockList);
  return blockList;
};
const checkIp = (ip, ipRangeList, store) => {
  const incomingIpIsV4 = (0, _net.isIPv4)(ip);
  const blockList = getBlockList(ipRangeList, store);
  if (store.get(ip)) {
    return true;
  }
  if (store.get('allowAllIpv4') && incomingIpIsV4) {
    return true;
  }
  if (store.get('allowAllIpv6') && !incomingIpIsV4) {
    return true;
  }
  const result = blockList.check(ip, incomingIpIsV4 ? 'ipv4' : 'ipv6');

  // If the ip is in the list, we store the result in the store
  // so we have a optimized path for the next request
  if (ipRangeList.includes(ip) && result) {
    store.set(ip, result);
  }
  return result;
};

// Checks that the request is authorized for this app and checks user
// auth too.
// The bodyparser should run before this middleware.
// Adds info to the request:
// req.config - the Config for this app
// req.auth - the Auth for this request
exports.checkIp = checkIp;
async function handleParseHeaders(req, res, next) {
  var mount = getMountForRequest(req);
  let context = {};
  if (req.get('X-Parse-Cloud-Context') != null) {
    try {
      context = JSON.parse(req.get('X-Parse-Cloud-Context'));
      if (Object.prototype.toString.call(context) !== '[object Object]') {
        throw 'Context is not an object';
      }
    } catch (e) {
      return malformedContext(req, res);
    }
  }
  var info = {
    appId: req.get('X-Parse-Application-Id'),
    sessionToken: req.get('X-Parse-Session-Token'),
    masterKey: req.get('X-Parse-Master-Key'),
    maintenanceKey: req.get('X-Parse-Maintenance-Key'),
    installationId: req.get('X-Parse-Installation-Id'),
    clientKey: req.get('X-Parse-Client-Key'),
    javascriptKey: req.get('X-Parse-Javascript-Key'),
    dotNetKey: req.get('X-Parse-Windows-Key'),
    restAPIKey: req.get('X-Parse-REST-API-Key'),
    clientVersion: req.get('X-Parse-Client-Version'),
    context: context
  };
  var basicAuth = httpAuth(req);
  if (basicAuth) {
    var basicAuthAppId = basicAuth.appId;
    if (_cache.default.get(basicAuthAppId)) {
      info.appId = basicAuthAppId;
      info.masterKey = basicAuth.masterKey || info.masterKey;
      info.javascriptKey = basicAuth.javascriptKey || info.javascriptKey;
    }
  }
  if (req.body) {
    // Unity SDK sends a _noBody key which needs to be removed.
    // Unclear at this point if action needs to be taken.
    delete req.body._noBody;
  }
  var fileViaJSON = false;
  if (!info.appId || !_cache.default.get(info.appId)) {
    // See if we can find the app id on the body.
    if (req.body instanceof Buffer) {
      // The only chance to find the app id is if this is a file
      // upload that actually is a JSON body. So try to parse it.
      // https://github.com/parse-community/parse-server/issues/6589
      // It is also possible that the client is trying to upload a file but forgot
      // to provide x-parse-app-id in header and parse a binary file will fail
      try {
        req.body = JSON.parse(req.body);
      } catch (e) {
        return invalidRequest(req, res);
      }
      fileViaJSON = true;
    }
    if (req.body) {
      delete req.body._RevocableSession;
    }
    if (req.body && req.body._ApplicationId && _cache.default.get(req.body._ApplicationId) && (!info.masterKey || _cache.default.get(req.body._ApplicationId).masterKey === info.masterKey)) {
      info.appId = req.body._ApplicationId;
      info.javascriptKey = req.body._JavaScriptKey || '';
      delete req.body._ApplicationId;
      delete req.body._JavaScriptKey;
      // TODO: test that the REST API formats generated by the other
      // SDKs are handled ok
      if (req.body._ClientVersion) {
        info.clientVersion = req.body._ClientVersion;
        delete req.body._ClientVersion;
      }
      if (req.body._InstallationId) {
        info.installationId = req.body._InstallationId;
        delete req.body._InstallationId;
      }
      if (req.body._SessionToken) {
        info.sessionToken = req.body._SessionToken;
        delete req.body._SessionToken;
      }
      if (req.body._MasterKey) {
        info.masterKey = req.body._MasterKey;
        delete req.body._MasterKey;
      }
      if (req.body._context) {
        if (req.body._context instanceof Object) {
          info.context = req.body._context;
        } else {
          try {
            info.context = JSON.parse(req.body._context);
            if (Object.prototype.toString.call(info.context) !== '[object Object]') {
              throw 'Context is not an object';
            }
          } catch (e) {
            return malformedContext(req, res);
          }
        }
        delete req.body._context;
      }
      if (req.body._ContentType) {
        req.headers['content-type'] = req.body._ContentType;
        delete req.body._ContentType;
      }
    } else {
      return invalidRequest(req, res);
    }
  }
  if (info.sessionToken && typeof info.sessionToken !== 'string') {
    info.sessionToken = info.sessionToken.toString();
  }
  if (info.clientVersion) {
    info.clientSDK = _ClientSDK.default.fromString(info.clientVersion);
  }
  if (fileViaJSON && req.body) {
    req.fileData = req.body.fileData;
    // We need to repopulate req.body with a buffer
    var base64 = req.body.base64;
    req.body = Buffer.from(base64, 'base64');
  }
  const clientIp = getClientIp(req);
  const config = _Config.default.get(info.appId, mount);
  if (config.state && config.state !== 'ok') {
    res.status(500);
    res.json({
      code: _node.default.Error.INTERNAL_SERVER_ERROR,
      error: `Invalid server state: ${config.state}`
    });
    return;
  }
  await config.loadKeys();
  info.app = _cache.default.get(info.appId);
  req.config = config;
  req.config.headers = req.headers || {};
  req.config.ip = clientIp;
  req.info = info;
  const isMaintenance = req.config.maintenanceKey && info.maintenanceKey === req.config.maintenanceKey;
  if (isMaintenance) {
    if (checkIp(clientIp, req.config.maintenanceKeyIps || [], req.config.maintenanceKeyIpsStore)) {
      req.auth = new _Auth.default.Auth({
        config: req.config,
        installationId: info.installationId,
        isMaintenance: true
      });
      next();
      return;
    }
    const log = req.config?.loggerController || _logger.default;
    log.error(`Request using maintenance key rejected as the request IP address '${clientIp}' is not set in Parse Server option 'maintenanceKeyIps'.`);
  }
  const masterKey = await req.config.loadMasterKey();
  let isMaster = info.masterKey === masterKey;
  if (isMaster && !checkIp(clientIp, req.config.masterKeyIps || [], req.config.masterKeyIpsStore)) {
    const log = req.config?.loggerController || _logger.default;
    log.error(`Request using master key rejected as the request IP address '${clientIp}' is not set in Parse Server option 'masterKeyIps'.`);
    isMaster = false;
    const error = new Error();
    error.status = 403;
    error.message = `unauthorized`;
    throw error;
  }
  if (isMaster) {
    req.auth = new _Auth.default.Auth({
      config: req.config,
      installationId: info.installationId,
      isMaster: true
    });
    return handleRateLimit(req, res, next);
  }
  var isReadOnlyMaster = info.masterKey === req.config.readOnlyMasterKey;
  if (typeof req.config.readOnlyMasterKey != 'undefined' && req.config.readOnlyMasterKey && isReadOnlyMaster) {
    req.auth = new _Auth.default.Auth({
      config: req.config,
      installationId: info.installationId,
      isMaster: true,
      isReadOnly: true
    });
    return handleRateLimit(req, res, next);
  }

  // Client keys are not required in parse-server, but if any have been configured in the server, validate them
  //  to preserve original behavior.
  const keys = ['clientKey', 'javascriptKey', 'dotNetKey', 'restAPIKey'];
  const oneKeyConfigured = keys.some(function (key) {
    return req.config[key] !== undefined;
  });
  const oneKeyMatches = keys.some(function (key) {
    return req.config[key] !== undefined && info[key] === req.config[key];
  });
  if (oneKeyConfigured && !oneKeyMatches) {
    return invalidRequest(req, res);
  }
  if (req.url == '/login') {
    delete info.sessionToken;
  }
  if (req.userFromJWT) {
    req.auth = new _Auth.default.Auth({
      config: req.config,
      installationId: info.installationId,
      isMaster: false,
      user: req.userFromJWT
    });
    return handleRateLimit(req, res, next);
  }
  if (!info.sessionToken) {
    req.auth = new _Auth.default.Auth({
      config: req.config,
      installationId: info.installationId,
      isMaster: false
    });
  }
  handleRateLimit(req, res, next);
}
const handleRateLimit = async (req, res, next) => {
  const rateLimits = req.config.rateLimits || [];
  try {
    await Promise.all(rateLimits.map(async limit => {
      const pathExp = new RegExp(limit.path);
      if (pathExp.test(req.url)) {
        await limit.handler(req, res, err => {
          if (err) {
            if (err.code === _node.default.Error.CONNECTION_FAILED) {
              throw err;
            }
            req.config.loggerController.error('An unknown error occured when attempting to apply the rate limiter: ', err);
          }
        });
      }
    }));
  } catch (error) {
    res.status(429);
    res.json({
      code: _node.default.Error.CONNECTION_FAILED,
      error: error.message
    });
    return;
  }
  next();
};
const handleParseSession = async (req, res, next) => {
  try {
    const info = req.info;
    if (req.auth || req.url === '/sessions/me') {
      next();
      return;
    }
    let requestAuth = null;
    if (info.sessionToken && req.url === '/upgradeToRevocableSession' && info.sessionToken.indexOf('r:') != 0) {
      requestAuth = await _Auth.default.getAuthForLegacySessionToken({
        config: req.config,
        installationId: info.installationId,
        sessionToken: info.sessionToken
      });
    } else {
      requestAuth = await _Auth.default.getAuthForSessionToken({
        config: req.config,
        installationId: info.installationId,
        sessionToken: info.sessionToken
      });
    }
    req.auth = requestAuth;
    next();
  } catch (error) {
    if (error instanceof _node.default.Error) {
      next(error);
      return;
    }
    // TODO: Determine the correct error scenario.
    req.config.loggerController.error('error getting auth for sessionToken', error);
    throw new _node.default.Error(_node.default.Error.UNKNOWN_ERROR, error);
  }
};
exports.handleParseSession = handleParseSession;
function getClientIp(req) {
  return req.ip;
}
function httpAuth(req) {
  if (!(req.req || req).headers.authorization) {
    return;
  }
  var header = (req.req || req).headers.authorization;
  var appId, masterKey, javascriptKey;

  // parse header
  var authPrefix = 'basic ';
  var match = header.toLowerCase().indexOf(authPrefix);
  if (match == 0) {
    var encodedAuth = header.substring(authPrefix.length, header.length);
    var credentials = decodeBase64(encodedAuth).split(':');
    if (credentials.length == 2) {
      appId = credentials[0];
      var key = credentials[1];
      var jsKeyPrefix = 'javascript-key=';
      var matchKey = key.indexOf(jsKeyPrefix);
      if (matchKey == 0) {
        javascriptKey = key.substring(jsKeyPrefix.length, key.length);
      } else {
        masterKey = key;
      }
    }
  }
  return {
    appId: appId,
    masterKey: masterKey,
    javascriptKey: javascriptKey
  };
}
function decodeBase64(str) {
  return Buffer.from(str, 'base64').toString();
}
function allowCrossDomain(appId) {
  return (req, res, next) => {
    const config = _Config.default.get(appId, getMountForRequest(req));
    let allowHeaders = DEFAULT_ALLOWED_HEADERS;
    if (config && config.allowHeaders) {
      allowHeaders += `, ${config.allowHeaders.join(', ')}`;
    }
    const baseOrigins = typeof config?.allowOrigin === 'string' ? [config.allowOrigin] : config?.allowOrigin ?? ['*'];
    const requestOrigin = req.headers.origin;
    const allowOrigins = requestOrigin && baseOrigins.includes(requestOrigin) ? requestOrigin : baseOrigins[0];
    res.header('Access-Control-Allow-Origin', allowOrigins);
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', allowHeaders);
    res.header('Access-Control-Expose-Headers', 'X-Parse-Job-Status-Id, X-Parse-Push-Status-Id');
    // intercept OPTIONS method
    if ('OPTIONS' == req.method) {
      res.sendStatus(200);
    } else {
      next();
    }
  };
}
function allowMethodOverride(req, res, next) {
  if (req.method === 'POST' && req.body?._method) {
    req.originalMethod = req.method;
    req.method = req.body._method;
    delete req.body._method;
  }
  next();
}
function handleParseErrors(err, req, res, next) {
  const log = req.config && req.config.loggerController || _logger.default;
  if (err instanceof _node.default.Error) {
    if (req.config && req.config.enableExpressErrorHandler) {
      return next(err);
    }
    let httpStatus;
    // TODO: fill out this mapping
    switch (err.code) {
      case _node.default.Error.INTERNAL_SERVER_ERROR:
        httpStatus = 500;
        break;
      case _node.default.Error.OBJECT_NOT_FOUND:
        httpStatus = 404;
        break;
      default:
        httpStatus = 400;
    }
    res.status(httpStatus);
    res.json({
      code: err.code,
      error: err.message
    });
    log.error('Parse error: ', err);
  } else if (err.status && err.message) {
    res.status(err.status);
    res.json({
      error: err.message
    });
    if (!(process && process.env.TESTING)) {
      next(err);
    }
  } else {
    log.error('Uncaught internal server error.', err, err.stack);
    res.status(500);
    res.json({
      code: _node.default.Error.INTERNAL_SERVER_ERROR,
      message: 'Internal server error.'
    });
    if (!(process && process.env.TESTING)) {
      next(err);
    }
  }
}
function enforceMasterKeyAccess(req, res, next) {
  if (!req.auth.isMaster) {
    res.status(403);
    res.end('{"error":"unauthorized: master key is required"}');
    return;
  }
  next();
}
function promiseEnforceMasterKeyAccess(request) {
  if (!request.auth.isMaster) {
    const error = new Error();
    error.status = 403;
    error.message = 'unauthorized: master key is required';
    throw error;
  }
  return Promise.resolve();
}
const addRateLimit = (route, config, cloud) => {
  if (typeof config === 'string') {
    config = _Config.default.get(config);
  }
  for (const key in route) {
    if (!_Definitions.RateLimitOptions[key]) {
      throw `Invalid rate limit option "${key}"`;
    }
  }
  if (!config.rateLimits) {
    config.rateLimits = [];
  }
  const redisStore = {
    connectionPromise: Promise.resolve(),
    store: null
  };
  if (route.redisUrl) {
    const log = config?.loggerController || _logger.default;
    const client = (0, _redis.createClient)({
      url: route.redisUrl
    });
    client.on('error', err => {
      log.error('Middlewares addRateLimit Redis client error', {
        error: err
      });
    });
    client.on('connect', () => {});
    client.on('reconnecting', () => {});
    client.on('ready', () => {});
    redisStore.connectionPromise = async () => {
      if (client.isOpen) {
        return;
      }
      try {
        await client.connect();
      } catch (e) {
        log.error(`Could not connect to redisURL in rate limit: ${e}`);
      }
    };
    redisStore.connectionPromise();
    redisStore.store = new _rateLimitRedis.default({
      sendCommand: async (...args) => {
        await redisStore.connectionPromise();
        return client.sendCommand(args);
      }
    });
  }
  let transformPath = route.requestPath.split('/*').join('/(.*)');
  if (transformPath === '*') {
    transformPath = '(.*)';
  }
  config.rateLimits.push({
    path: (0, _pathToRegexp.pathToRegexp)(transformPath),
    handler: (0, _expressRateLimit.default)({
      windowMs: route.requestTimeWindow,
      max: route.requestCount,
      message: route.errorResponseMessage || _Definitions.RateLimitOptions.errorResponseMessage.default,
      handler: (request, response, next, options) => {
        throw {
          code: _node.default.Error.CONNECTION_FAILED,
          message: options.message
        };
      },
      skip: request => {
        if (request.ip === '127.0.0.1' && !route.includeInternalRequests) {
          return true;
        }
        if (route.includeMasterKey) {
          return false;
        }
        if (route.requestMethods) {
          if (Array.isArray(route.requestMethods)) {
            if (!route.requestMethods.includes(request.method)) {
              return true;
            }
          } else {
            const regExp = new RegExp(route.requestMethods);
            if (!regExp.test(request.method)) {
              return true;
            }
          }
        }
        return request.auth?.isMaster;
      },
      keyGenerator: async request => {
        if (route.zone === _node.default.Server.RateLimitZone.global) {
          return request.config.appId;
        }
        const token = request.info.sessionToken;
        if (route.zone === _node.default.Server.RateLimitZone.session && token) {
          return token;
        }
        if (route.zone === _node.default.Server.RateLimitZone.user && token) {
          if (!request.auth) {
            await new Promise(resolve => handleParseSession(request, null, resolve));
          }
          if (request.auth?.user?.id && request.zone === 'user') {
            return request.auth.user.id;
          }
        }
        return request.config.ip;
      },
      store: redisStore.store
    }),
    cloud
  });
  _Config.default.put(config);
};

/**
 * Deduplicates a request to ensure idempotency. Duplicates are determined by the request ID
 * in the request header. If a request has no request ID, it is executed anyway.
 * @param {*} req The request to evaluate.
 * @returns Promise<{}>
 */
exports.addRateLimit = addRateLimit;
function promiseEnsureIdempotency(req) {
  // Enable feature only for MongoDB
  if (!(req.config.database.adapter instanceof _MongoStorageAdapter.default || req.config.database.adapter instanceof _PostgresStorageAdapter.default)) {
    return Promise.resolve();
  }
  // Get parameters
  const config = req.config;
  const requestId = ((req || {}).headers || {})['x-parse-request-id'];
  const {
    paths,
    ttl
  } = config.idempotencyOptions;
  if (!requestId || !config.idempotencyOptions) {
    return Promise.resolve();
  }
  // Request path may contain trailing slashes, depending on the original request, so remove
  // leading and trailing slashes to make it easier to specify paths in the configuration
  const reqPath = req.path.replace(/^\/|\/$/, '');
  // Determine whether idempotency is enabled for current request path
  let match = false;
  for (const path of paths) {
    // Assume one wants a path to always match from the beginning to prevent any mistakes
    const regex = new RegExp(path.charAt(0) === '^' ? path : '^' + path);
    if (reqPath.match(regex)) {
      match = true;
      break;
    }
  }
  if (!match) {
    return Promise.resolve();
  }
  // Try to store request
  const expiryDate = new Date(new Date().setSeconds(new Date().getSeconds() + ttl));
  return _rest.default.create(config, _Auth.default.master(config), '_Idempotency', {
    reqId: requestId,
    expire: _node.default._encode(expiryDate)
  }).catch(e => {
    if (e.code == _node.default.Error.DUPLICATE_VALUE) {
      throw new _node.default.Error(_node.default.Error.DUPLICATE_REQUEST, 'Duplicate request');
    }
    throw e;
  });
}
function invalidRequest(req, res) {
  res.status(403);
  res.end('{"error":"unauthorized"}');
}
function malformedContext(req, res) {
  res.status(400);
  res.json({
    code: _node.default.Error.INVALID_JSON,
    error: 'Invalid object for context.'
  });
}

/**
 * Express 4 allowed a double forward slash between a route and router. Although
 * this should be considered an anti-pattern, we need to support it for backwards
 * compatibility.
 *
 * Technically valid URL with double foroward slash:
 * http://localhost:1337/parse//functions/testFunction
 */
function allowDoubleForwardSlash(req, res, next) {
  req.url = req.url.startsWith('//') ? req.url.substring(1) : req.url;
  next();
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfY2FjaGUiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwicmVxdWlyZSIsIl9ub2RlIiwiX0F1dGgiLCJfQ29uZmlnIiwiX0NsaWVudFNESyIsIl9sb2dnZXIiLCJfcmVzdCIsIl9Nb25nb1N0b3JhZ2VBZGFwdGVyIiwiX1Bvc3RncmVzU3RvcmFnZUFkYXB0ZXIiLCJfZXhwcmVzc1JhdGVMaW1pdCIsIl9EZWZpbml0aW9ucyIsIl9wYXRoVG9SZWdleHAiLCJfcmF0ZUxpbWl0UmVkaXMiLCJfcmVkaXMiLCJfbmV0IiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiREVGQVVMVF9BTExPV0VEX0hFQURFUlMiLCJleHBvcnRzIiwiZ2V0TW91bnRGb3JSZXF1ZXN0IiwicmVxIiwibW91bnRQYXRoTGVuZ3RoIiwib3JpZ2luYWxVcmwiLCJsZW5ndGgiLCJ1cmwiLCJtb3VudFBhdGgiLCJzbGljZSIsInByb3RvY29sIiwiZ2V0IiwiZ2V0QmxvY2tMaXN0IiwiaXBSYW5nZUxpc3QiLCJzdG9yZSIsImJsb2NrTGlzdCIsIkJsb2NrTGlzdCIsImZvckVhY2giLCJmdWxsSXAiLCJzZXQiLCJpcCIsIm1hc2siLCJzcGxpdCIsImFkZEFkZHJlc3MiLCJpc0lQdjQiLCJhZGRTdWJuZXQiLCJOdW1iZXIiLCJjaGVja0lwIiwiaW5jb21pbmdJcElzVjQiLCJyZXN1bHQiLCJjaGVjayIsImluY2x1ZGVzIiwiaGFuZGxlUGFyc2VIZWFkZXJzIiwicmVzIiwibmV4dCIsIm1vdW50IiwiY29udGV4dCIsIkpTT04iLCJwYXJzZSIsIk9iamVjdCIsInByb3RvdHlwZSIsInRvU3RyaW5nIiwiY2FsbCIsIm1hbGZvcm1lZENvbnRleHQiLCJpbmZvIiwiYXBwSWQiLCJzZXNzaW9uVG9rZW4iLCJtYXN0ZXJLZXkiLCJtYWludGVuYW5jZUtleSIsImluc3RhbGxhdGlvbklkIiwiY2xpZW50S2V5IiwiamF2YXNjcmlwdEtleSIsImRvdE5ldEtleSIsInJlc3RBUElLZXkiLCJjbGllbnRWZXJzaW9uIiwiYmFzaWNBdXRoIiwiaHR0cEF1dGgiLCJiYXNpY0F1dGhBcHBJZCIsIkFwcENhY2hlIiwiYm9keSIsIl9ub0JvZHkiLCJmaWxlVmlhSlNPTiIsIkJ1ZmZlciIsImludmFsaWRSZXF1ZXN0IiwiX1Jldm9jYWJsZVNlc3Npb24iLCJfQXBwbGljYXRpb25JZCIsIl9KYXZhU2NyaXB0S2V5IiwiX0NsaWVudFZlcnNpb24iLCJfSW5zdGFsbGF0aW9uSWQiLCJfU2Vzc2lvblRva2VuIiwiX01hc3RlcktleSIsIl9jb250ZXh0IiwiX0NvbnRlbnRUeXBlIiwiaGVhZGVycyIsImNsaWVudFNESyIsIkNsaWVudFNESyIsImZyb21TdHJpbmciLCJmaWxlRGF0YSIsImJhc2U2NCIsImZyb20iLCJjbGllbnRJcCIsImdldENsaWVudElwIiwiY29uZmlnIiwiQ29uZmlnIiwic3RhdGUiLCJzdGF0dXMiLCJqc29uIiwiY29kZSIsIlBhcnNlIiwiRXJyb3IiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJlcnJvciIsImxvYWRLZXlzIiwiYXBwIiwiaXNNYWludGVuYW5jZSIsIm1haW50ZW5hbmNlS2V5SXBzIiwibWFpbnRlbmFuY2VLZXlJcHNTdG9yZSIsImF1dGgiLCJBdXRoIiwibG9nIiwibG9nZ2VyQ29udHJvbGxlciIsImRlZmF1bHRMb2dnZXIiLCJsb2FkTWFzdGVyS2V5IiwiaXNNYXN0ZXIiLCJtYXN0ZXJLZXlJcHMiLCJtYXN0ZXJLZXlJcHNTdG9yZSIsIm1lc3NhZ2UiLCJoYW5kbGVSYXRlTGltaXQiLCJpc1JlYWRPbmx5TWFzdGVyIiwicmVhZE9ubHlNYXN0ZXJLZXkiLCJpc1JlYWRPbmx5Iiwia2V5cyIsIm9uZUtleUNvbmZpZ3VyZWQiLCJzb21lIiwia2V5IiwidW5kZWZpbmVkIiwib25lS2V5TWF0Y2hlcyIsInVzZXJGcm9tSldUIiwidXNlciIsInJhdGVMaW1pdHMiLCJQcm9taXNlIiwiYWxsIiwibWFwIiwibGltaXQiLCJwYXRoRXhwIiwiUmVnRXhwIiwicGF0aCIsInRlc3QiLCJoYW5kbGVyIiwiZXJyIiwiQ09OTkVDVElPTl9GQUlMRUQiLCJoYW5kbGVQYXJzZVNlc3Npb24iLCJyZXF1ZXN0QXV0aCIsImluZGV4T2YiLCJnZXRBdXRoRm9yTGVnYWN5U2Vzc2lvblRva2VuIiwiZ2V0QXV0aEZvclNlc3Npb25Ub2tlbiIsIlVOS05PV05fRVJST1IiLCJhdXRob3JpemF0aW9uIiwiaGVhZGVyIiwiYXV0aFByZWZpeCIsIm1hdGNoIiwidG9Mb3dlckNhc2UiLCJlbmNvZGVkQXV0aCIsInN1YnN0cmluZyIsImNyZWRlbnRpYWxzIiwiZGVjb2RlQmFzZTY0IiwianNLZXlQcmVmaXgiLCJtYXRjaEtleSIsInN0ciIsImFsbG93Q3Jvc3NEb21haW4iLCJhbGxvd0hlYWRlcnMiLCJqb2luIiwiYmFzZU9yaWdpbnMiLCJhbGxvd09yaWdpbiIsInJlcXVlc3RPcmlnaW4iLCJvcmlnaW4iLCJhbGxvd09yaWdpbnMiLCJtZXRob2QiLCJzZW5kU3RhdHVzIiwiYWxsb3dNZXRob2RPdmVycmlkZSIsIl9tZXRob2QiLCJvcmlnaW5hbE1ldGhvZCIsImhhbmRsZVBhcnNlRXJyb3JzIiwiZW5hYmxlRXhwcmVzc0Vycm9ySGFuZGxlciIsImh0dHBTdGF0dXMiLCJPQkpFQ1RfTk9UX0ZPVU5EIiwicHJvY2VzcyIsImVudiIsIlRFU1RJTkciLCJzdGFjayIsImVuZm9yY2VNYXN0ZXJLZXlBY2Nlc3MiLCJlbmQiLCJwcm9taXNlRW5mb3JjZU1hc3RlcktleUFjY2VzcyIsInJlcXVlc3QiLCJyZXNvbHZlIiwiYWRkUmF0ZUxpbWl0Iiwicm91dGUiLCJjbG91ZCIsIlJhdGVMaW1pdE9wdGlvbnMiLCJyZWRpc1N0b3JlIiwiY29ubmVjdGlvblByb21pc2UiLCJyZWRpc1VybCIsImNsaWVudCIsImNyZWF0ZUNsaWVudCIsIm9uIiwiaXNPcGVuIiwiY29ubmVjdCIsIlJlZGlzU3RvcmUiLCJzZW5kQ29tbWFuZCIsImFyZ3MiLCJ0cmFuc2Zvcm1QYXRoIiwicmVxdWVzdFBhdGgiLCJwdXNoIiwicGF0aFRvUmVnZXhwIiwicmF0ZUxpbWl0Iiwid2luZG93TXMiLCJyZXF1ZXN0VGltZVdpbmRvdyIsIm1heCIsInJlcXVlc3RDb3VudCIsImVycm9yUmVzcG9uc2VNZXNzYWdlIiwicmVzcG9uc2UiLCJvcHRpb25zIiwic2tpcCIsImluY2x1ZGVJbnRlcm5hbFJlcXVlc3RzIiwiaW5jbHVkZU1hc3RlcktleSIsInJlcXVlc3RNZXRob2RzIiwiQXJyYXkiLCJpc0FycmF5IiwicmVnRXhwIiwia2V5R2VuZXJhdG9yIiwiem9uZSIsIlNlcnZlciIsIlJhdGVMaW1pdFpvbmUiLCJnbG9iYWwiLCJ0b2tlbiIsInNlc3Npb24iLCJpZCIsInB1dCIsInByb21pc2VFbnN1cmVJZGVtcG90ZW5jeSIsImRhdGFiYXNlIiwiYWRhcHRlciIsIk1vbmdvU3RvcmFnZUFkYXB0ZXIiLCJQb3N0Z3Jlc1N0b3JhZ2VBZGFwdGVyIiwicmVxdWVzdElkIiwicGF0aHMiLCJ0dGwiLCJpZGVtcG90ZW5jeU9wdGlvbnMiLCJyZXFQYXRoIiwicmVwbGFjZSIsInJlZ2V4IiwiY2hhckF0IiwiZXhwaXJ5RGF0ZSIsIkRhdGUiLCJzZXRTZWNvbmRzIiwiZ2V0U2Vjb25kcyIsInJlc3QiLCJjcmVhdGUiLCJtYXN0ZXIiLCJyZXFJZCIsImV4cGlyZSIsIl9lbmNvZGUiLCJjYXRjaCIsIkRVUExJQ0FURV9WQUxVRSIsIkRVUExJQ0FURV9SRVFVRVNUIiwiSU5WQUxJRF9KU09OIiwiYWxsb3dEb3VibGVGb3J3YXJkU2xhc2giLCJzdGFydHNXaXRoIl0sInNvdXJjZXMiOlsiLi4vc3JjL21pZGRsZXdhcmVzLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBBcHBDYWNoZSBmcm9tICcuL2NhY2hlJztcbmltcG9ydCBQYXJzZSBmcm9tICdwYXJzZS9ub2RlJztcbmltcG9ydCBhdXRoIGZyb20gJy4vQXV0aCc7XG5pbXBvcnQgQ29uZmlnIGZyb20gJy4vQ29uZmlnJztcbmltcG9ydCBDbGllbnRTREsgZnJvbSAnLi9DbGllbnRTREsnO1xuaW1wb3J0IGRlZmF1bHRMb2dnZXIgZnJvbSAnLi9sb2dnZXInO1xuaW1wb3J0IHJlc3QgZnJvbSAnLi9yZXN0JztcbmltcG9ydCBNb25nb1N0b3JhZ2VBZGFwdGVyIGZyb20gJy4vQWRhcHRlcnMvU3RvcmFnZS9Nb25nby9Nb25nb1N0b3JhZ2VBZGFwdGVyJztcbmltcG9ydCBQb3N0Z3Jlc1N0b3JhZ2VBZGFwdGVyIGZyb20gJy4vQWRhcHRlcnMvU3RvcmFnZS9Qb3N0Z3Jlcy9Qb3N0Z3Jlc1N0b3JhZ2VBZGFwdGVyJztcbmltcG9ydCByYXRlTGltaXQgZnJvbSAnZXhwcmVzcy1yYXRlLWxpbWl0JztcbmltcG9ydCB7IFJhdGVMaW1pdE9wdGlvbnMgfSBmcm9tICcuL09wdGlvbnMvRGVmaW5pdGlvbnMnO1xuaW1wb3J0IHsgcGF0aFRvUmVnZXhwIH0gZnJvbSAncGF0aC10by1yZWdleHAnO1xuaW1wb3J0IFJlZGlzU3RvcmUgZnJvbSAncmF0ZS1saW1pdC1yZWRpcyc7XG5pbXBvcnQgeyBjcmVhdGVDbGllbnQgfSBmcm9tICdyZWRpcyc7XG5pbXBvcnQgeyBCbG9ja0xpc3QsIGlzSVB2NCB9IGZyb20gJ25ldCc7XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX0FMTE9XRURfSEVBREVSUyA9XG4gICdYLVBhcnNlLU1hc3Rlci1LZXksIFgtUGFyc2UtUkVTVC1BUEktS2V5LCBYLVBhcnNlLUphdmFzY3JpcHQtS2V5LCBYLVBhcnNlLUFwcGxpY2F0aW9uLUlkLCBYLVBhcnNlLUNsaWVudC1WZXJzaW9uLCBYLVBhcnNlLVNlc3Npb24tVG9rZW4sIFgtUmVxdWVzdGVkLVdpdGgsIFgtUGFyc2UtUmV2b2NhYmxlLVNlc3Npb24sIFgtUGFyc2UtUmVxdWVzdC1JZCwgQ29udGVudC1UeXBlLCBQcmFnbWEsIENhY2hlLUNvbnRyb2wnO1xuXG5jb25zdCBnZXRNb3VudEZvclJlcXVlc3QgPSBmdW5jdGlvbiAocmVxKSB7XG4gIGNvbnN0IG1vdW50UGF0aExlbmd0aCA9IHJlcS5vcmlnaW5hbFVybC5sZW5ndGggLSByZXEudXJsLmxlbmd0aDtcbiAgY29uc3QgbW91bnRQYXRoID0gcmVxLm9yaWdpbmFsVXJsLnNsaWNlKDAsIG1vdW50UGF0aExlbmd0aCk7XG4gIHJldHVybiByZXEucHJvdG9jb2wgKyAnOi8vJyArIHJlcS5nZXQoJ2hvc3QnKSArIG1vdW50UGF0aDtcbn07XG5cbmNvbnN0IGdldEJsb2NrTGlzdCA9IChpcFJhbmdlTGlzdCwgc3RvcmUpID0+IHtcbiAgaWYgKHN0b3JlLmdldCgnYmxvY2tMaXN0JykpIHsgcmV0dXJuIHN0b3JlLmdldCgnYmxvY2tMaXN0Jyk7IH1cbiAgY29uc3QgYmxvY2tMaXN0ID0gbmV3IEJsb2NrTGlzdCgpO1xuICBpcFJhbmdlTGlzdC5mb3JFYWNoKGZ1bGxJcCA9PiB7XG4gICAgaWYgKGZ1bGxJcCA9PT0gJzo6LzAnIHx8IGZ1bGxJcCA9PT0gJzo6Jykge1xuICAgICAgc3RvcmUuc2V0KCdhbGxvd0FsbElwdjYnLCB0cnVlKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGZ1bGxJcCA9PT0gJzAuMC4wLjAvMCcgfHwgZnVsbElwID09PSAnMC4wLjAuMCcpIHtcbiAgICAgIHN0b3JlLnNldCgnYWxsb3dBbGxJcHY0JywgdHJ1ZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IFtpcCwgbWFza10gPSBmdWxsSXAuc3BsaXQoJy8nKTtcbiAgICBpZiAoIW1hc2spIHtcbiAgICAgIGJsb2NrTGlzdC5hZGRBZGRyZXNzKGlwLCBpc0lQdjQoaXApID8gJ2lwdjQnIDogJ2lwdjYnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgYmxvY2tMaXN0LmFkZFN1Ym5ldChpcCwgTnVtYmVyKG1hc2spLCBpc0lQdjQoaXApID8gJ2lwdjQnIDogJ2lwdjYnKTtcbiAgICB9XG4gIH0pO1xuICBzdG9yZS5zZXQoJ2Jsb2NrTGlzdCcsIGJsb2NrTGlzdCk7XG4gIHJldHVybiBibG9ja0xpc3Q7XG59O1xuXG5leHBvcnQgY29uc3QgY2hlY2tJcCA9IChpcCwgaXBSYW5nZUxpc3QsIHN0b3JlKSA9PiB7XG4gIGNvbnN0IGluY29taW5nSXBJc1Y0ID0gaXNJUHY0KGlwKTtcbiAgY29uc3QgYmxvY2tMaXN0ID0gZ2V0QmxvY2tMaXN0KGlwUmFuZ2VMaXN0LCBzdG9yZSk7XG5cbiAgaWYgKHN0b3JlLmdldChpcCkpIHsgcmV0dXJuIHRydWU7IH1cbiAgaWYgKHN0b3JlLmdldCgnYWxsb3dBbGxJcHY0JykgJiYgaW5jb21pbmdJcElzVjQpIHsgcmV0dXJuIHRydWU7IH1cbiAgaWYgKHN0b3JlLmdldCgnYWxsb3dBbGxJcHY2JykgJiYgIWluY29taW5nSXBJc1Y0KSB7IHJldHVybiB0cnVlOyB9XG4gIGNvbnN0IHJlc3VsdCA9IGJsb2NrTGlzdC5jaGVjayhpcCwgaW5jb21pbmdJcElzVjQgPyAnaXB2NCcgOiAnaXB2NicpO1xuXG4gIC8vIElmIHRoZSBpcCBpcyBpbiB0aGUgbGlzdCwgd2Ugc3RvcmUgdGhlIHJlc3VsdCBpbiB0aGUgc3RvcmVcbiAgLy8gc28gd2UgaGF2ZSBhIG9wdGltaXplZCBwYXRoIGZvciB0aGUgbmV4dCByZXF1ZXN0XG4gIGlmIChpcFJhbmdlTGlzdC5pbmNsdWRlcyhpcCkgJiYgcmVzdWx0KSB7XG4gICAgc3RvcmUuc2V0KGlwLCByZXN1bHQpO1xuICB9XG4gIHJldHVybiByZXN1bHQ7XG59O1xuXG4vLyBDaGVja3MgdGhhdCB0aGUgcmVxdWVzdCBpcyBhdXRob3JpemVkIGZvciB0aGlzIGFwcCBhbmQgY2hlY2tzIHVzZXJcbi8vIGF1dGggdG9vLlxuLy8gVGhlIGJvZHlwYXJzZXIgc2hvdWxkIHJ1biBiZWZvcmUgdGhpcyBtaWRkbGV3YXJlLlxuLy8gQWRkcyBpbmZvIHRvIHRoZSByZXF1ZXN0OlxuLy8gcmVxLmNvbmZpZyAtIHRoZSBDb25maWcgZm9yIHRoaXMgYXBwXG4vLyByZXEuYXV0aCAtIHRoZSBBdXRoIGZvciB0aGlzIHJlcXVlc3RcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVQYXJzZUhlYWRlcnMocmVxLCByZXMsIG5leHQpIHtcbiAgdmFyIG1vdW50ID0gZ2V0TW91bnRGb3JSZXF1ZXN0KHJlcSk7XG5cbiAgbGV0IGNvbnRleHQgPSB7fTtcbiAgaWYgKHJlcS5nZXQoJ1gtUGFyc2UtQ2xvdWQtQ29udGV4dCcpICE9IG51bGwpIHtcbiAgICB0cnkge1xuICAgICAgY29udGV4dCA9IEpTT04ucGFyc2UocmVxLmdldCgnWC1QYXJzZS1DbG91ZC1Db250ZXh0JykpO1xuICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChjb250ZXh0KSAhPT0gJ1tvYmplY3QgT2JqZWN0XScpIHtcbiAgICAgICAgdGhyb3cgJ0NvbnRleHQgaXMgbm90IGFuIG9iamVjdCc7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcmV0dXJuIG1hbGZvcm1lZENvbnRleHQocmVxLCByZXMpO1xuICAgIH1cbiAgfVxuICB2YXIgaW5mbyA9IHtcbiAgICBhcHBJZDogcmVxLmdldCgnWC1QYXJzZS1BcHBsaWNhdGlvbi1JZCcpLFxuICAgIHNlc3Npb25Ub2tlbjogcmVxLmdldCgnWC1QYXJzZS1TZXNzaW9uLVRva2VuJyksXG4gICAgbWFzdGVyS2V5OiByZXEuZ2V0KCdYLVBhcnNlLU1hc3Rlci1LZXknKSxcbiAgICBtYWludGVuYW5jZUtleTogcmVxLmdldCgnWC1QYXJzZS1NYWludGVuYW5jZS1LZXknKSxcbiAgICBpbnN0YWxsYXRpb25JZDogcmVxLmdldCgnWC1QYXJzZS1JbnN0YWxsYXRpb24tSWQnKSxcbiAgICBjbGllbnRLZXk6IHJlcS5nZXQoJ1gtUGFyc2UtQ2xpZW50LUtleScpLFxuICAgIGphdmFzY3JpcHRLZXk6IHJlcS5nZXQoJ1gtUGFyc2UtSmF2YXNjcmlwdC1LZXknKSxcbiAgICBkb3ROZXRLZXk6IHJlcS5nZXQoJ1gtUGFyc2UtV2luZG93cy1LZXknKSxcbiAgICByZXN0QVBJS2V5OiByZXEuZ2V0KCdYLVBhcnNlLVJFU1QtQVBJLUtleScpLFxuICAgIGNsaWVudFZlcnNpb246IHJlcS5nZXQoJ1gtUGFyc2UtQ2xpZW50LVZlcnNpb24nKSxcbiAgICBjb250ZXh0OiBjb250ZXh0LFxuICB9O1xuXG4gIHZhciBiYXNpY0F1dGggPSBodHRwQXV0aChyZXEpO1xuXG4gIGlmIChiYXNpY0F1dGgpIHtcbiAgICB2YXIgYmFzaWNBdXRoQXBwSWQgPSBiYXNpY0F1dGguYXBwSWQ7XG4gICAgaWYgKEFwcENhY2hlLmdldChiYXNpY0F1dGhBcHBJZCkpIHtcbiAgICAgIGluZm8uYXBwSWQgPSBiYXNpY0F1dGhBcHBJZDtcbiAgICAgIGluZm8ubWFzdGVyS2V5ID0gYmFzaWNBdXRoLm1hc3RlcktleSB8fCBpbmZvLm1hc3RlcktleTtcbiAgICAgIGluZm8uamF2YXNjcmlwdEtleSA9IGJhc2ljQXV0aC5qYXZhc2NyaXB0S2V5IHx8IGluZm8uamF2YXNjcmlwdEtleTtcbiAgICB9XG4gIH1cblxuICBpZiAocmVxLmJvZHkpIHtcbiAgICAvLyBVbml0eSBTREsgc2VuZHMgYSBfbm9Cb2R5IGtleSB3aGljaCBuZWVkcyB0byBiZSByZW1vdmVkLlxuICAgIC8vIFVuY2xlYXIgYXQgdGhpcyBwb2ludCBpZiBhY3Rpb24gbmVlZHMgdG8gYmUgdGFrZW4uXG4gICAgZGVsZXRlIHJlcS5ib2R5Ll9ub0JvZHk7XG4gIH1cblxuICB2YXIgZmlsZVZpYUpTT04gPSBmYWxzZTtcblxuICBpZiAoIWluZm8uYXBwSWQgfHwgIUFwcENhY2hlLmdldChpbmZvLmFwcElkKSkge1xuICAgIC8vIFNlZSBpZiB3ZSBjYW4gZmluZCB0aGUgYXBwIGlkIG9uIHRoZSBib2R5LlxuICAgIGlmIChyZXEuYm9keSBpbnN0YW5jZW9mIEJ1ZmZlcikge1xuICAgICAgLy8gVGhlIG9ubHkgY2hhbmNlIHRvIGZpbmQgdGhlIGFwcCBpZCBpcyBpZiB0aGlzIGlzIGEgZmlsZVxuICAgICAgLy8gdXBsb2FkIHRoYXQgYWN0dWFsbHkgaXMgYSBKU09OIGJvZHkuIFNvIHRyeSB0byBwYXJzZSBpdC5cbiAgICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9wYXJzZS1jb21tdW5pdHkvcGFyc2Utc2VydmVyL2lzc3Vlcy82NTg5XG4gICAgICAvLyBJdCBpcyBhbHNvIHBvc3NpYmxlIHRoYXQgdGhlIGNsaWVudCBpcyB0cnlpbmcgdG8gdXBsb2FkIGEgZmlsZSBidXQgZm9yZ290XG4gICAgICAvLyB0byBwcm92aWRlIHgtcGFyc2UtYXBwLWlkIGluIGhlYWRlciBhbmQgcGFyc2UgYSBiaW5hcnkgZmlsZSB3aWxsIGZhaWxcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlcS5ib2R5ID0gSlNPTi5wYXJzZShyZXEuYm9keSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHJldHVybiBpbnZhbGlkUmVxdWVzdChyZXEsIHJlcyk7XG4gICAgICB9XG4gICAgICBmaWxlVmlhSlNPTiA9IHRydWU7XG4gICAgfVxuXG4gICAgaWYgKHJlcS5ib2R5KSB7XG4gICAgICBkZWxldGUgcmVxLmJvZHkuX1Jldm9jYWJsZVNlc3Npb247XG4gICAgfVxuXG4gICAgaWYgKFxuICAgICAgcmVxLmJvZHkgJiZcbiAgICAgIHJlcS5ib2R5Ll9BcHBsaWNhdGlvbklkICYmXG4gICAgICBBcHBDYWNoZS5nZXQocmVxLmJvZHkuX0FwcGxpY2F0aW9uSWQpICYmXG4gICAgICAoIWluZm8ubWFzdGVyS2V5IHx8IEFwcENhY2hlLmdldChyZXEuYm9keS5fQXBwbGljYXRpb25JZCkubWFzdGVyS2V5ID09PSBpbmZvLm1hc3RlcktleSlcbiAgICApIHtcbiAgICAgIGluZm8uYXBwSWQgPSByZXEuYm9keS5fQXBwbGljYXRpb25JZDtcbiAgICAgIGluZm8uamF2YXNjcmlwdEtleSA9IHJlcS5ib2R5Ll9KYXZhU2NyaXB0S2V5IHx8ICcnO1xuICAgICAgZGVsZXRlIHJlcS5ib2R5Ll9BcHBsaWNhdGlvbklkO1xuICAgICAgZGVsZXRlIHJlcS5ib2R5Ll9KYXZhU2NyaXB0S2V5O1xuICAgICAgLy8gVE9ETzogdGVzdCB0aGF0IHRoZSBSRVNUIEFQSSBmb3JtYXRzIGdlbmVyYXRlZCBieSB0aGUgb3RoZXJcbiAgICAgIC8vIFNES3MgYXJlIGhhbmRsZWQgb2tcbiAgICAgIGlmIChyZXEuYm9keS5fQ2xpZW50VmVyc2lvbikge1xuICAgICAgICBpbmZvLmNsaWVudFZlcnNpb24gPSByZXEuYm9keS5fQ2xpZW50VmVyc2lvbjtcbiAgICAgICAgZGVsZXRlIHJlcS5ib2R5Ll9DbGllbnRWZXJzaW9uO1xuICAgICAgfVxuICAgICAgaWYgKHJlcS5ib2R5Ll9JbnN0YWxsYXRpb25JZCkge1xuICAgICAgICBpbmZvLmluc3RhbGxhdGlvbklkID0gcmVxLmJvZHkuX0luc3RhbGxhdGlvbklkO1xuICAgICAgICBkZWxldGUgcmVxLmJvZHkuX0luc3RhbGxhdGlvbklkO1xuICAgICAgfVxuICAgICAgaWYgKHJlcS5ib2R5Ll9TZXNzaW9uVG9rZW4pIHtcbiAgICAgICAgaW5mby5zZXNzaW9uVG9rZW4gPSByZXEuYm9keS5fU2Vzc2lvblRva2VuO1xuICAgICAgICBkZWxldGUgcmVxLmJvZHkuX1Nlc3Npb25Ub2tlbjtcbiAgICAgIH1cbiAgICAgIGlmIChyZXEuYm9keS5fTWFzdGVyS2V5KSB7XG4gICAgICAgIGluZm8ubWFzdGVyS2V5ID0gcmVxLmJvZHkuX01hc3RlcktleTtcbiAgICAgICAgZGVsZXRlIHJlcS5ib2R5Ll9NYXN0ZXJLZXk7XG4gICAgICB9XG4gICAgICBpZiAocmVxLmJvZHkuX2NvbnRleHQpIHtcbiAgICAgICAgaWYgKHJlcS5ib2R5Ll9jb250ZXh0IGluc3RhbmNlb2YgT2JqZWN0KSB7XG4gICAgICAgICAgaW5mby5jb250ZXh0ID0gcmVxLmJvZHkuX2NvbnRleHQ7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGluZm8uY29udGV4dCA9IEpTT04ucGFyc2UocmVxLmJvZHkuX2NvbnRleHQpO1xuICAgICAgICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChpbmZvLmNvbnRleHQpICE9PSAnW29iamVjdCBPYmplY3RdJykge1xuICAgICAgICAgICAgICB0aHJvdyAnQ29udGV4dCBpcyBub3QgYW4gb2JqZWN0JztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICByZXR1cm4gbWFsZm9ybWVkQ29udGV4dChyZXEsIHJlcyk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGRlbGV0ZSByZXEuYm9keS5fY29udGV4dDtcbiAgICAgIH1cbiAgICAgIGlmIChyZXEuYm9keS5fQ29udGVudFR5cGUpIHtcbiAgICAgICAgcmVxLmhlYWRlcnNbJ2NvbnRlbnQtdHlwZSddID0gcmVxLmJvZHkuX0NvbnRlbnRUeXBlO1xuICAgICAgICBkZWxldGUgcmVxLmJvZHkuX0NvbnRlbnRUeXBlO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gaW52YWxpZFJlcXVlc3QocmVxLCByZXMpO1xuICAgIH1cbiAgfVxuXG4gIGlmIChpbmZvLnNlc3Npb25Ub2tlbiAmJiB0eXBlb2YgaW5mby5zZXNzaW9uVG9rZW4gIT09ICdzdHJpbmcnKSB7XG4gICAgaW5mby5zZXNzaW9uVG9rZW4gPSBpbmZvLnNlc3Npb25Ub2tlbi50b1N0cmluZygpO1xuICB9XG5cbiAgaWYgKGluZm8uY2xpZW50VmVyc2lvbikge1xuICAgIGluZm8uY2xpZW50U0RLID0gQ2xpZW50U0RLLmZyb21TdHJpbmcoaW5mby5jbGllbnRWZXJzaW9uKTtcbiAgfVxuXG4gIGlmIChmaWxlVmlhSlNPTiAmJiByZXEuYm9keSkge1xuICAgIHJlcS5maWxlRGF0YSA9IHJlcS5ib2R5LmZpbGVEYXRhO1xuICAgIC8vIFdlIG5lZWQgdG8gcmVwb3B1bGF0ZSByZXEuYm9keSB3aXRoIGEgYnVmZmVyXG4gICAgdmFyIGJhc2U2NCA9IHJlcS5ib2R5LmJhc2U2NDtcbiAgICByZXEuYm9keSA9IEJ1ZmZlci5mcm9tKGJhc2U2NCwgJ2Jhc2U2NCcpO1xuICB9XG5cbiAgY29uc3QgY2xpZW50SXAgPSBnZXRDbGllbnRJcChyZXEpO1xuICBjb25zdCBjb25maWcgPSBDb25maWcuZ2V0KGluZm8uYXBwSWQsIG1vdW50KTtcbiAgaWYgKGNvbmZpZy5zdGF0ZSAmJiBjb25maWcuc3RhdGUgIT09ICdvaycpIHtcbiAgICByZXMuc3RhdHVzKDUwMCk7XG4gICAgcmVzLmpzb24oe1xuICAgICAgY29kZTogUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLFxuICAgICAgZXJyb3I6IGBJbnZhbGlkIHNlcnZlciBzdGF0ZTogJHtjb25maWcuc3RhdGV9YCxcbiAgICB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgYXdhaXQgY29uZmlnLmxvYWRLZXlzKCk7XG5cbiAgaW5mby5hcHAgPSBBcHBDYWNoZS5nZXQoaW5mby5hcHBJZCk7XG4gIHJlcS5jb25maWcgPSBjb25maWc7XG4gIHJlcS5jb25maWcuaGVhZGVycyA9IHJlcS5oZWFkZXJzIHx8IHt9O1xuICByZXEuY29uZmlnLmlwID0gY2xpZW50SXA7XG4gIHJlcS5pbmZvID0gaW5mbztcblxuICBjb25zdCBpc01haW50ZW5hbmNlID1cbiAgICByZXEuY29uZmlnLm1haW50ZW5hbmNlS2V5ICYmIGluZm8ubWFpbnRlbmFuY2VLZXkgPT09IHJlcS5jb25maWcubWFpbnRlbmFuY2VLZXk7XG4gIGlmIChpc01haW50ZW5hbmNlKSB7XG4gICAgaWYgKGNoZWNrSXAoY2xpZW50SXAsIHJlcS5jb25maWcubWFpbnRlbmFuY2VLZXlJcHMgfHwgW10sIHJlcS5jb25maWcubWFpbnRlbmFuY2VLZXlJcHNTdG9yZSkpIHtcbiAgICAgIHJlcS5hdXRoID0gbmV3IGF1dGguQXV0aCh7XG4gICAgICAgIGNvbmZpZzogcmVxLmNvbmZpZyxcbiAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IGluZm8uaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgIGlzTWFpbnRlbmFuY2U6IHRydWUsXG4gICAgICB9KTtcbiAgICAgIG5leHQoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgbG9nID0gcmVxLmNvbmZpZz8ubG9nZ2VyQ29udHJvbGxlciB8fCBkZWZhdWx0TG9nZ2VyO1xuICAgIGxvZy5lcnJvcihcbiAgICAgIGBSZXF1ZXN0IHVzaW5nIG1haW50ZW5hbmNlIGtleSByZWplY3RlZCBhcyB0aGUgcmVxdWVzdCBJUCBhZGRyZXNzICcke2NsaWVudElwfScgaXMgbm90IHNldCBpbiBQYXJzZSBTZXJ2ZXIgb3B0aW9uICdtYWludGVuYW5jZUtleUlwcycuYFxuICAgICk7XG4gIH1cblxuICBjb25zdCBtYXN0ZXJLZXkgPSBhd2FpdCByZXEuY29uZmlnLmxvYWRNYXN0ZXJLZXkoKTtcbiAgbGV0IGlzTWFzdGVyID0gaW5mby5tYXN0ZXJLZXkgPT09IG1hc3RlcktleTtcblxuICBpZiAoaXNNYXN0ZXIgJiYgIWNoZWNrSXAoY2xpZW50SXAsIHJlcS5jb25maWcubWFzdGVyS2V5SXBzIHx8IFtdLCByZXEuY29uZmlnLm1hc3RlcktleUlwc1N0b3JlKSkge1xuICAgIGNvbnN0IGxvZyA9IHJlcS5jb25maWc/LmxvZ2dlckNvbnRyb2xsZXIgfHwgZGVmYXVsdExvZ2dlcjtcbiAgICBsb2cuZXJyb3IoXG4gICAgICBgUmVxdWVzdCB1c2luZyBtYXN0ZXIga2V5IHJlamVjdGVkIGFzIHRoZSByZXF1ZXN0IElQIGFkZHJlc3MgJyR7Y2xpZW50SXB9JyBpcyBub3Qgc2V0IGluIFBhcnNlIFNlcnZlciBvcHRpb24gJ21hc3RlcktleUlwcycuYFxuICAgICk7XG4gICAgaXNNYXN0ZXIgPSBmYWxzZTtcbiAgICBjb25zdCBlcnJvciA9IG5ldyBFcnJvcigpO1xuICAgIGVycm9yLnN0YXR1cyA9IDQwMztcbiAgICBlcnJvci5tZXNzYWdlID0gYHVuYXV0aG9yaXplZGA7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cblxuICBpZiAoaXNNYXN0ZXIpIHtcbiAgICByZXEuYXV0aCA9IG5ldyBhdXRoLkF1dGgoe1xuICAgICAgY29uZmlnOiByZXEuY29uZmlnLFxuICAgICAgaW5zdGFsbGF0aW9uSWQ6IGluZm8uaW5zdGFsbGF0aW9uSWQsXG4gICAgICBpc01hc3RlcjogdHJ1ZSxcbiAgICB9KTtcbiAgICByZXR1cm4gaGFuZGxlUmF0ZUxpbWl0KHJlcSwgcmVzLCBuZXh0KTtcbiAgfVxuXG4gIHZhciBpc1JlYWRPbmx5TWFzdGVyID0gaW5mby5tYXN0ZXJLZXkgPT09IHJlcS5jb25maWcucmVhZE9ubHlNYXN0ZXJLZXk7XG4gIGlmIChcbiAgICB0eXBlb2YgcmVxLmNvbmZpZy5yZWFkT25seU1hc3RlcktleSAhPSAndW5kZWZpbmVkJyAmJlxuICAgIHJlcS5jb25maWcucmVhZE9ubHlNYXN0ZXJLZXkgJiZcbiAgICBpc1JlYWRPbmx5TWFzdGVyXG4gICkge1xuICAgIHJlcS5hdXRoID0gbmV3IGF1dGguQXV0aCh7XG4gICAgICBjb25maWc6IHJlcS5jb25maWcsXG4gICAgICBpbnN0YWxsYXRpb25JZDogaW5mby5pbnN0YWxsYXRpb25JZCxcbiAgICAgIGlzTWFzdGVyOiB0cnVlLFxuICAgICAgaXNSZWFkT25seTogdHJ1ZSxcbiAgICB9KTtcbiAgICByZXR1cm4gaGFuZGxlUmF0ZUxpbWl0KHJlcSwgcmVzLCBuZXh0KTtcbiAgfVxuXG4gIC8vIENsaWVudCBrZXlzIGFyZSBub3QgcmVxdWlyZWQgaW4gcGFyc2Utc2VydmVyLCBidXQgaWYgYW55IGhhdmUgYmVlbiBjb25maWd1cmVkIGluIHRoZSBzZXJ2ZXIsIHZhbGlkYXRlIHRoZW1cbiAgLy8gIHRvIHByZXNlcnZlIG9yaWdpbmFsIGJlaGF2aW9yLlxuICBjb25zdCBrZXlzID0gWydjbGllbnRLZXknLCAnamF2YXNjcmlwdEtleScsICdkb3ROZXRLZXknLCAncmVzdEFQSUtleSddO1xuICBjb25zdCBvbmVLZXlDb25maWd1cmVkID0ga2V5cy5zb21lKGZ1bmN0aW9uIChrZXkpIHtcbiAgICByZXR1cm4gcmVxLmNvbmZpZ1trZXldICE9PSB1bmRlZmluZWQ7XG4gIH0pO1xuICBjb25zdCBvbmVLZXlNYXRjaGVzID0ga2V5cy5zb21lKGZ1bmN0aW9uIChrZXkpIHtcbiAgICByZXR1cm4gcmVxLmNvbmZpZ1trZXldICE9PSB1bmRlZmluZWQgJiYgaW5mb1trZXldID09PSByZXEuY29uZmlnW2tleV07XG4gIH0pO1xuXG4gIGlmIChvbmVLZXlDb25maWd1cmVkICYmICFvbmVLZXlNYXRjaGVzKSB7XG4gICAgcmV0dXJuIGludmFsaWRSZXF1ZXN0KHJlcSwgcmVzKTtcbiAgfVxuXG4gIGlmIChyZXEudXJsID09ICcvbG9naW4nKSB7XG4gICAgZGVsZXRlIGluZm8uc2Vzc2lvblRva2VuO1xuICB9XG5cbiAgaWYgKHJlcS51c2VyRnJvbUpXVCkge1xuICAgIHJlcS5hdXRoID0gbmV3IGF1dGguQXV0aCh7XG4gICAgICBjb25maWc6IHJlcS5jb25maWcsXG4gICAgICBpbnN0YWxsYXRpb25JZDogaW5mby5pbnN0YWxsYXRpb25JZCxcbiAgICAgIGlzTWFzdGVyOiBmYWxzZSxcbiAgICAgIHVzZXI6IHJlcS51c2VyRnJvbUpXVCxcbiAgICB9KTtcbiAgICByZXR1cm4gaGFuZGxlUmF0ZUxpbWl0KHJlcSwgcmVzLCBuZXh0KTtcbiAgfVxuXG4gIGlmICghaW5mby5zZXNzaW9uVG9rZW4pIHtcbiAgICByZXEuYXV0aCA9IG5ldyBhdXRoLkF1dGgoe1xuICAgICAgY29uZmlnOiByZXEuY29uZmlnLFxuICAgICAgaW5zdGFsbGF0aW9uSWQ6IGluZm8uaW5zdGFsbGF0aW9uSWQsXG4gICAgICBpc01hc3RlcjogZmFsc2UsXG4gICAgfSk7XG4gIH1cbiAgaGFuZGxlUmF0ZUxpbWl0KHJlcSwgcmVzLCBuZXh0KTtcbn1cblxuY29uc3QgaGFuZGxlUmF0ZUxpbWl0ID0gYXN5bmMgKHJlcSwgcmVzLCBuZXh0KSA9PiB7XG4gIGNvbnN0IHJhdGVMaW1pdHMgPSByZXEuY29uZmlnLnJhdGVMaW1pdHMgfHwgW107XG4gIHRyeSB7XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICByYXRlTGltaXRzLm1hcChhc3luYyBsaW1pdCA9PiB7XG4gICAgICAgIGNvbnN0IHBhdGhFeHAgPSBuZXcgUmVnRXhwKGxpbWl0LnBhdGgpO1xuICAgICAgICBpZiAocGF0aEV4cC50ZXN0KHJlcS51cmwpKSB7XG4gICAgICAgICAgYXdhaXQgbGltaXQuaGFuZGxlcihyZXEsIHJlcywgZXJyID0+IHtcbiAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgaWYgKGVyci5jb2RlID09PSBQYXJzZS5FcnJvci5DT05ORUNUSU9OX0ZBSUxFRCkge1xuICAgICAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICByZXEuY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIuZXJyb3IoXG4gICAgICAgICAgICAgICAgJ0FuIHVua25vd24gZXJyb3Igb2NjdXJlZCB3aGVuIGF0dGVtcHRpbmcgdG8gYXBwbHkgdGhlIHJhdGUgbGltaXRlcjogJyxcbiAgICAgICAgICAgICAgICBlcnJcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSlcbiAgICApO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJlcy5zdGF0dXMoNDI5KTtcbiAgICByZXMuanNvbih7IGNvZGU6IFBhcnNlLkVycm9yLkNPTk5FQ1RJT05fRkFJTEVELCBlcnJvcjogZXJyb3IubWVzc2FnZSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgbmV4dCgpO1xufTtcblxuZXhwb3J0IGNvbnN0IGhhbmRsZVBhcnNlU2Vzc2lvbiA9IGFzeW5jIChyZXEsIHJlcywgbmV4dCkgPT4ge1xuICB0cnkge1xuICAgIGNvbnN0IGluZm8gPSByZXEuaW5mbztcbiAgICBpZiAocmVxLmF1dGggfHwgcmVxLnVybCA9PT0gJy9zZXNzaW9ucy9tZScpIHtcbiAgICAgIG5leHQoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbGV0IHJlcXVlc3RBdXRoID0gbnVsbDtcbiAgICBpZiAoXG4gICAgICBpbmZvLnNlc3Npb25Ub2tlbiAmJlxuICAgICAgcmVxLnVybCA9PT0gJy91cGdyYWRlVG9SZXZvY2FibGVTZXNzaW9uJyAmJlxuICAgICAgaW5mby5zZXNzaW9uVG9rZW4uaW5kZXhPZigncjonKSAhPSAwXG4gICAgKSB7XG4gICAgICByZXF1ZXN0QXV0aCA9IGF3YWl0IGF1dGguZ2V0QXV0aEZvckxlZ2FjeVNlc3Npb25Ub2tlbih7XG4gICAgICAgIGNvbmZpZzogcmVxLmNvbmZpZyxcbiAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IGluZm8uaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgIHNlc3Npb25Ub2tlbjogaW5mby5zZXNzaW9uVG9rZW4sXG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVxdWVzdEF1dGggPSBhd2FpdCBhdXRoLmdldEF1dGhGb3JTZXNzaW9uVG9rZW4oe1xuICAgICAgICBjb25maWc6IHJlcS5jb25maWcsXG4gICAgICAgIGluc3RhbGxhdGlvbklkOiBpbmZvLmluc3RhbGxhdGlvbklkLFxuICAgICAgICBzZXNzaW9uVG9rZW46IGluZm8uc2Vzc2lvblRva2VuLFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJlcS5hdXRoID0gcmVxdWVzdEF1dGg7XG4gICAgbmV4dCgpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIFBhcnNlLkVycm9yKSB7XG4gICAgICBuZXh0KGVycm9yKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgLy8gVE9ETzogRGV0ZXJtaW5lIHRoZSBjb3JyZWN0IGVycm9yIHNjZW5hcmlvLlxuICAgIHJlcS5jb25maWcubG9nZ2VyQ29udHJvbGxlci5lcnJvcignZXJyb3IgZ2V0dGluZyBhdXRoIGZvciBzZXNzaW9uVG9rZW4nLCBlcnJvcik7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlVOS05PV05fRVJST1IsIGVycm9yKTtcbiAgfVxufTtcblxuZnVuY3Rpb24gZ2V0Q2xpZW50SXAocmVxKSB7XG4gIHJldHVybiByZXEuaXA7XG59XG5cbmZ1bmN0aW9uIGh0dHBBdXRoKHJlcSkge1xuICBpZiAoIShyZXEucmVxIHx8IHJlcSkuaGVhZGVycy5hdXRob3JpemF0aW9uKSB7IHJldHVybjsgfVxuXG4gIHZhciBoZWFkZXIgPSAocmVxLnJlcSB8fCByZXEpLmhlYWRlcnMuYXV0aG9yaXphdGlvbjtcbiAgdmFyIGFwcElkLCBtYXN0ZXJLZXksIGphdmFzY3JpcHRLZXk7XG5cbiAgLy8gcGFyc2UgaGVhZGVyXG4gIHZhciBhdXRoUHJlZml4ID0gJ2Jhc2ljICc7XG5cbiAgdmFyIG1hdGNoID0gaGVhZGVyLnRvTG93ZXJDYXNlKCkuaW5kZXhPZihhdXRoUHJlZml4KTtcblxuICBpZiAobWF0Y2ggPT0gMCkge1xuICAgIHZhciBlbmNvZGVkQXV0aCA9IGhlYWRlci5zdWJzdHJpbmcoYXV0aFByZWZpeC5sZW5ndGgsIGhlYWRlci5sZW5ndGgpO1xuICAgIHZhciBjcmVkZW50aWFscyA9IGRlY29kZUJhc2U2NChlbmNvZGVkQXV0aCkuc3BsaXQoJzonKTtcblxuICAgIGlmIChjcmVkZW50aWFscy5sZW5ndGggPT0gMikge1xuICAgICAgYXBwSWQgPSBjcmVkZW50aWFsc1swXTtcbiAgICAgIHZhciBrZXkgPSBjcmVkZW50aWFsc1sxXTtcblxuICAgICAgdmFyIGpzS2V5UHJlZml4ID0gJ2phdmFzY3JpcHQta2V5PSc7XG5cbiAgICAgIHZhciBtYXRjaEtleSA9IGtleS5pbmRleE9mKGpzS2V5UHJlZml4KTtcbiAgICAgIGlmIChtYXRjaEtleSA9PSAwKSB7XG4gICAgICAgIGphdmFzY3JpcHRLZXkgPSBrZXkuc3Vic3RyaW5nKGpzS2V5UHJlZml4Lmxlbmd0aCwga2V5Lmxlbmd0aCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBtYXN0ZXJLZXkgPSBrZXk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgYXBwSWQ6IGFwcElkLCBtYXN0ZXJLZXk6IG1hc3RlcktleSwgamF2YXNjcmlwdEtleTogamF2YXNjcmlwdEtleSB9O1xufVxuXG5mdW5jdGlvbiBkZWNvZGVCYXNlNjQoc3RyKSB7XG4gIHJldHVybiBCdWZmZXIuZnJvbShzdHIsICdiYXNlNjQnKS50b1N0cmluZygpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWxsb3dDcm9zc0RvbWFpbihhcHBJZCkge1xuICByZXR1cm4gKHJlcSwgcmVzLCBuZXh0KSA9PiB7XG4gICAgY29uc3QgY29uZmlnID0gQ29uZmlnLmdldChhcHBJZCwgZ2V0TW91bnRGb3JSZXF1ZXN0KHJlcSkpO1xuICAgIGxldCBhbGxvd0hlYWRlcnMgPSBERUZBVUxUX0FMTE9XRURfSEVBREVSUztcbiAgICBpZiAoY29uZmlnICYmIGNvbmZpZy5hbGxvd0hlYWRlcnMpIHtcbiAgICAgIGFsbG93SGVhZGVycyArPSBgLCAke2NvbmZpZy5hbGxvd0hlYWRlcnMuam9pbignLCAnKX1gO1xuICAgIH1cblxuICAgIGNvbnN0IGJhc2VPcmlnaW5zID1cbiAgICAgIHR5cGVvZiBjb25maWc/LmFsbG93T3JpZ2luID09PSAnc3RyaW5nJyA/IFtjb25maWcuYWxsb3dPcmlnaW5dIDogY29uZmlnPy5hbGxvd09yaWdpbiA/PyBbJyonXTtcbiAgICBjb25zdCByZXF1ZXN0T3JpZ2luID0gcmVxLmhlYWRlcnMub3JpZ2luO1xuICAgIGNvbnN0IGFsbG93T3JpZ2lucyA9XG4gICAgICByZXF1ZXN0T3JpZ2luICYmIGJhc2VPcmlnaW5zLmluY2x1ZGVzKHJlcXVlc3RPcmlnaW4pID8gcmVxdWVzdE9yaWdpbiA6IGJhc2VPcmlnaW5zWzBdO1xuICAgIHJlcy5oZWFkZXIoJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbicsIGFsbG93T3JpZ2lucyk7XG4gICAgcmVzLmhlYWRlcignQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kcycsICdHRVQsUFVULFBPU1QsREVMRVRFLE9QVElPTlMnKTtcbiAgICByZXMuaGVhZGVyKCdBY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzJywgYWxsb3dIZWFkZXJzKTtcbiAgICByZXMuaGVhZGVyKCdBY2Nlc3MtQ29udHJvbC1FeHBvc2UtSGVhZGVycycsICdYLVBhcnNlLUpvYi1TdGF0dXMtSWQsIFgtUGFyc2UtUHVzaC1TdGF0dXMtSWQnKTtcbiAgICAvLyBpbnRlcmNlcHQgT1BUSU9OUyBtZXRob2RcbiAgICBpZiAoJ09QVElPTlMnID09IHJlcS5tZXRob2QpIHtcbiAgICAgIHJlcy5zZW5kU3RhdHVzKDIwMCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG5leHQoKTtcbiAgICB9XG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhbGxvd01ldGhvZE92ZXJyaWRlKHJlcSwgcmVzLCBuZXh0KSB7XG4gIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgcmVxLmJvZHk/Ll9tZXRob2QpIHtcbiAgICByZXEub3JpZ2luYWxNZXRob2QgPSByZXEubWV0aG9kO1xuICAgIHJlcS5tZXRob2QgPSByZXEuYm9keS5fbWV0aG9kO1xuICAgIGRlbGV0ZSByZXEuYm9keS5fbWV0aG9kO1xuICB9XG4gIG5leHQoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGhhbmRsZVBhcnNlRXJyb3JzKGVyciwgcmVxLCByZXMsIG5leHQpIHtcbiAgY29uc3QgbG9nID0gKHJlcS5jb25maWcgJiYgcmVxLmNvbmZpZy5sb2dnZXJDb250cm9sbGVyKSB8fCBkZWZhdWx0TG9nZ2VyO1xuICBpZiAoZXJyIGluc3RhbmNlb2YgUGFyc2UuRXJyb3IpIHtcbiAgICBpZiAocmVxLmNvbmZpZyAmJiByZXEuY29uZmlnLmVuYWJsZUV4cHJlc3NFcnJvckhhbmRsZXIpIHtcbiAgICAgIHJldHVybiBuZXh0KGVycik7XG4gICAgfVxuICAgIGxldCBodHRwU3RhdHVzO1xuICAgIC8vIFRPRE86IGZpbGwgb3V0IHRoaXMgbWFwcGluZ1xuICAgIHN3aXRjaCAoZXJyLmNvZGUpIHtcbiAgICAgIGNhc2UgUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SOlxuICAgICAgICBodHRwU3RhdHVzID0gNTAwO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORDpcbiAgICAgICAgaHR0cFN0YXR1cyA9IDQwNDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICBodHRwU3RhdHVzID0gNDAwO1xuICAgIH1cbiAgICByZXMuc3RhdHVzKGh0dHBTdGF0dXMpO1xuICAgIHJlcy5qc29uKHsgY29kZTogZXJyLmNvZGUsIGVycm9yOiBlcnIubWVzc2FnZSB9KTtcbiAgICBsb2cuZXJyb3IoJ1BhcnNlIGVycm9yOiAnLCBlcnIpO1xuICB9IGVsc2UgaWYgKGVyci5zdGF0dXMgJiYgZXJyLm1lc3NhZ2UpIHtcbiAgICByZXMuc3RhdHVzKGVyci5zdGF0dXMpO1xuICAgIHJlcy5qc29uKHsgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgIGlmICghKHByb2Nlc3MgJiYgcHJvY2Vzcy5lbnYuVEVTVElORykpIHtcbiAgICAgIG5leHQoZXJyKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgbG9nLmVycm9yKCdVbmNhdWdodCBpbnRlcm5hbCBzZXJ2ZXIgZXJyb3IuJywgZXJyLCBlcnIuc3RhY2spO1xuICAgIHJlcy5zdGF0dXMoNTAwKTtcbiAgICByZXMuanNvbih7XG4gICAgICBjb2RlOiBQYXJzZS5FcnJvci5JTlRFUk5BTF9TRVJWRVJfRVJST1IsXG4gICAgICBtZXNzYWdlOiAnSW50ZXJuYWwgc2VydmVyIGVycm9yLicsXG4gICAgfSk7XG4gICAgaWYgKCEocHJvY2VzcyAmJiBwcm9jZXNzLmVudi5URVNUSU5HKSkge1xuICAgICAgbmV4dChlcnIpO1xuICAgIH1cbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gZW5mb3JjZU1hc3RlcktleUFjY2VzcyhyZXEsIHJlcywgbmV4dCkge1xuICBpZiAoIXJlcS5hdXRoLmlzTWFzdGVyKSB7XG4gICAgcmVzLnN0YXR1cyg0MDMpO1xuICAgIHJlcy5lbmQoJ3tcImVycm9yXCI6XCJ1bmF1dGhvcml6ZWQ6IG1hc3RlciBrZXkgaXMgcmVxdWlyZWRcIn0nKTtcbiAgICByZXR1cm47XG4gIH1cbiAgbmV4dCgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcHJvbWlzZUVuZm9yY2VNYXN0ZXJLZXlBY2Nlc3MocmVxdWVzdCkge1xuICBpZiAoIXJlcXVlc3QuYXV0aC5pc01hc3Rlcikge1xuICAgIGNvbnN0IGVycm9yID0gbmV3IEVycm9yKCk7XG4gICAgZXJyb3Iuc3RhdHVzID0gNDAzO1xuICAgIGVycm9yLm1lc3NhZ2UgPSAndW5hdXRob3JpemVkOiBtYXN0ZXIga2V5IGlzIHJlcXVpcmVkJztcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG59XG5cbmV4cG9ydCBjb25zdCBhZGRSYXRlTGltaXQgPSAocm91dGUsIGNvbmZpZywgY2xvdWQpID0+IHtcbiAgaWYgKHR5cGVvZiBjb25maWcgPT09ICdzdHJpbmcnKSB7XG4gICAgY29uZmlnID0gQ29uZmlnLmdldChjb25maWcpO1xuICB9XG4gIGZvciAoY29uc3Qga2V5IGluIHJvdXRlKSB7XG4gICAgaWYgKCFSYXRlTGltaXRPcHRpb25zW2tleV0pIHtcbiAgICAgIHRocm93IGBJbnZhbGlkIHJhdGUgbGltaXQgb3B0aW9uIFwiJHtrZXl9XCJgO1xuICAgIH1cbiAgfVxuICBpZiAoIWNvbmZpZy5yYXRlTGltaXRzKSB7XG4gICAgY29uZmlnLnJhdGVMaW1pdHMgPSBbXTtcbiAgfVxuICBjb25zdCByZWRpc1N0b3JlID0ge1xuICAgIGNvbm5lY3Rpb25Qcm9taXNlOiBQcm9taXNlLnJlc29sdmUoKSxcbiAgICBzdG9yZTogbnVsbCxcbiAgfTtcbiAgaWYgKHJvdXRlLnJlZGlzVXJsKSB7XG4gICAgY29uc3QgbG9nID0gY29uZmlnPy5sb2dnZXJDb250cm9sbGVyIHx8IGRlZmF1bHRMb2dnZXI7XG4gICAgY29uc3QgY2xpZW50ID0gY3JlYXRlQ2xpZW50KHtcbiAgICAgIHVybDogcm91dGUucmVkaXNVcmwsXG4gICAgfSk7XG4gICAgY2xpZW50Lm9uKCdlcnJvcicsIGVyciA9PiB7IGxvZy5lcnJvcignTWlkZGxld2FyZXMgYWRkUmF0ZUxpbWl0IFJlZGlzIGNsaWVudCBlcnJvcicsIHsgZXJyb3I6IGVyciB9KSB9KTtcbiAgICBjbGllbnQub24oJ2Nvbm5lY3QnLCAoKSA9PiB7IH0pO1xuICAgIGNsaWVudC5vbigncmVjb25uZWN0aW5nJywgKCkgPT4geyB9KTtcbiAgICBjbGllbnQub24oJ3JlYWR5JywgKCkgPT4geyB9KTtcbiAgICByZWRpc1N0b3JlLmNvbm5lY3Rpb25Qcm9taXNlID0gYXN5bmMgKCkgPT4ge1xuICAgICAgaWYgKGNsaWVudC5pc09wZW4pIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgY2xpZW50LmNvbm5lY3QoKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgbG9nLmVycm9yKGBDb3VsZCBub3QgY29ubmVjdCB0byByZWRpc1VSTCBpbiByYXRlIGxpbWl0OiAke2V9YCk7XG4gICAgICB9XG4gICAgfTtcbiAgICByZWRpc1N0b3JlLmNvbm5lY3Rpb25Qcm9taXNlKCk7XG4gICAgcmVkaXNTdG9yZS5zdG9yZSA9IG5ldyBSZWRpc1N0b3JlKHtcbiAgICAgIHNlbmRDb21tYW5kOiBhc3luYyAoLi4uYXJncykgPT4ge1xuICAgICAgICBhd2FpdCByZWRpc1N0b3JlLmNvbm5lY3Rpb25Qcm9taXNlKCk7XG4gICAgICAgIHJldHVybiBjbGllbnQuc2VuZENvbW1hbmQoYXJncyk7XG4gICAgICB9LFxuICAgIH0pO1xuICB9XG4gIGxldCB0cmFuc2Zvcm1QYXRoID0gcm91dGUucmVxdWVzdFBhdGguc3BsaXQoJy8qJykuam9pbignLyguKiknKTtcbiAgaWYgKHRyYW5zZm9ybVBhdGggPT09ICcqJykge1xuICAgIHRyYW5zZm9ybVBhdGggPSAnKC4qKSc7XG4gIH1cbiAgY29uZmlnLnJhdGVMaW1pdHMucHVzaCh7XG4gICAgcGF0aDogcGF0aFRvUmVnZXhwKHRyYW5zZm9ybVBhdGgpLFxuICAgIGhhbmRsZXI6IHJhdGVMaW1pdCh7XG4gICAgICB3aW5kb3dNczogcm91dGUucmVxdWVzdFRpbWVXaW5kb3csXG4gICAgICBtYXg6IHJvdXRlLnJlcXVlc3RDb3VudCxcbiAgICAgIG1lc3NhZ2U6IHJvdXRlLmVycm9yUmVzcG9uc2VNZXNzYWdlIHx8IFJhdGVMaW1pdE9wdGlvbnMuZXJyb3JSZXNwb25zZU1lc3NhZ2UuZGVmYXVsdCxcbiAgICAgIGhhbmRsZXI6IChyZXF1ZXN0LCByZXNwb25zZSwgbmV4dCwgb3B0aW9ucykgPT4ge1xuICAgICAgICB0aHJvdyB7XG4gICAgICAgICAgY29kZTogUGFyc2UuRXJyb3IuQ09OTkVDVElPTl9GQUlMRUQsXG4gICAgICAgICAgbWVzc2FnZTogb3B0aW9ucy5tZXNzYWdlLFxuICAgICAgICB9O1xuICAgICAgfSxcbiAgICAgIHNraXA6IHJlcXVlc3QgPT4ge1xuICAgICAgICBpZiAocmVxdWVzdC5pcCA9PT0gJzEyNy4wLjAuMScgJiYgIXJvdXRlLmluY2x1ZGVJbnRlcm5hbFJlcXVlc3RzKSB7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJvdXRlLmluY2x1ZGVNYXN0ZXJLZXkpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJvdXRlLnJlcXVlc3RNZXRob2RzKSB7XG4gICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocm91dGUucmVxdWVzdE1ldGhvZHMpKSB7XG4gICAgICAgICAgICBpZiAoIXJvdXRlLnJlcXVlc3RNZXRob2RzLmluY2x1ZGVzKHJlcXVlc3QubWV0aG9kKSkge1xuICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgcmVnRXhwID0gbmV3IFJlZ0V4cChyb3V0ZS5yZXF1ZXN0TWV0aG9kcyk7XG4gICAgICAgICAgICBpZiAoIXJlZ0V4cC50ZXN0KHJlcXVlc3QubWV0aG9kKSkge1xuICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlcXVlc3QuYXV0aD8uaXNNYXN0ZXI7XG4gICAgICB9LFxuICAgICAga2V5R2VuZXJhdG9yOiBhc3luYyByZXF1ZXN0ID0+IHtcbiAgICAgICAgaWYgKHJvdXRlLnpvbmUgPT09IFBhcnNlLlNlcnZlci5SYXRlTGltaXRab25lLmdsb2JhbCkge1xuICAgICAgICAgIHJldHVybiByZXF1ZXN0LmNvbmZpZy5hcHBJZDtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB0b2tlbiA9IHJlcXVlc3QuaW5mby5zZXNzaW9uVG9rZW47XG4gICAgICAgIGlmIChyb3V0ZS56b25lID09PSBQYXJzZS5TZXJ2ZXIuUmF0ZUxpbWl0Wm9uZS5zZXNzaW9uICYmIHRva2VuKSB7XG4gICAgICAgICAgcmV0dXJuIHRva2VuO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyb3V0ZS56b25lID09PSBQYXJzZS5TZXJ2ZXIuUmF0ZUxpbWl0Wm9uZS51c2VyICYmIHRva2VuKSB7XG4gICAgICAgICAgaWYgKCFyZXF1ZXN0LmF1dGgpIHtcbiAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gaGFuZGxlUGFyc2VTZXNzaW9uKHJlcXVlc3QsIG51bGwsIHJlc29sdmUpKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlcXVlc3QuYXV0aD8udXNlcj8uaWQgJiYgcmVxdWVzdC56b25lID09PSAndXNlcicpIHtcbiAgICAgICAgICAgIHJldHVybiByZXF1ZXN0LmF1dGgudXNlci5pZDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlcXVlc3QuY29uZmlnLmlwO1xuICAgICAgfSxcbiAgICAgIHN0b3JlOiByZWRpc1N0b3JlLnN0b3JlLFxuICAgIH0pLFxuICAgIGNsb3VkLFxuICB9KTtcbiAgQ29uZmlnLnB1dChjb25maWcpO1xufTtcblxuLyoqXG4gKiBEZWR1cGxpY2F0ZXMgYSByZXF1ZXN0IHRvIGVuc3VyZSBpZGVtcG90ZW5jeS4gRHVwbGljYXRlcyBhcmUgZGV0ZXJtaW5lZCBieSB0aGUgcmVxdWVzdCBJRFxuICogaW4gdGhlIHJlcXVlc3QgaGVhZGVyLiBJZiBhIHJlcXVlc3QgaGFzIG5vIHJlcXVlc3QgSUQsIGl0IGlzIGV4ZWN1dGVkIGFueXdheS5cbiAqIEBwYXJhbSB7Kn0gcmVxIFRoZSByZXF1ZXN0IHRvIGV2YWx1YXRlLlxuICogQHJldHVybnMgUHJvbWlzZTx7fT5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByb21pc2VFbnN1cmVJZGVtcG90ZW5jeShyZXEpIHtcbiAgLy8gRW5hYmxlIGZlYXR1cmUgb25seSBmb3IgTW9uZ29EQlxuICBpZiAoXG4gICAgIShcbiAgICAgIHJlcS5jb25maWcuZGF0YWJhc2UuYWRhcHRlciBpbnN0YW5jZW9mIE1vbmdvU3RvcmFnZUFkYXB0ZXIgfHxcbiAgICAgIHJlcS5jb25maWcuZGF0YWJhc2UuYWRhcHRlciBpbnN0YW5jZW9mIFBvc3RncmVzU3RvcmFnZUFkYXB0ZXJcbiAgICApXG4gICkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICAvLyBHZXQgcGFyYW1ldGVyc1xuICBjb25zdCBjb25maWcgPSByZXEuY29uZmlnO1xuICBjb25zdCByZXF1ZXN0SWQgPSAoKHJlcSB8fCB7fSkuaGVhZGVycyB8fCB7fSlbJ3gtcGFyc2UtcmVxdWVzdC1pZCddO1xuICBjb25zdCB7IHBhdGhzLCB0dGwgfSA9IGNvbmZpZy5pZGVtcG90ZW5jeU9wdGlvbnM7XG4gIGlmICghcmVxdWVzdElkIHx8ICFjb25maWcuaWRlbXBvdGVuY3lPcHRpb25zKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFJlcXVlc3QgcGF0aCBtYXkgY29udGFpbiB0cmFpbGluZyBzbGFzaGVzLCBkZXBlbmRpbmcgb24gdGhlIG9yaWdpbmFsIHJlcXVlc3QsIHNvIHJlbW92ZVxuICAvLyBsZWFkaW5nIGFuZCB0cmFpbGluZyBzbGFzaGVzIHRvIG1ha2UgaXQgZWFzaWVyIHRvIHNwZWNpZnkgcGF0aHMgaW4gdGhlIGNvbmZpZ3VyYXRpb25cbiAgY29uc3QgcmVxUGF0aCA9IHJlcS5wYXRoLnJlcGxhY2UoL15cXC98XFwvJC8sICcnKTtcbiAgLy8gRGV0ZXJtaW5lIHdoZXRoZXIgaWRlbXBvdGVuY3kgaXMgZW5hYmxlZCBmb3IgY3VycmVudCByZXF1ZXN0IHBhdGhcbiAgbGV0IG1hdGNoID0gZmFsc2U7XG4gIGZvciAoY29uc3QgcGF0aCBvZiBwYXRocykge1xuICAgIC8vIEFzc3VtZSBvbmUgd2FudHMgYSBwYXRoIHRvIGFsd2F5cyBtYXRjaCBmcm9tIHRoZSBiZWdpbm5pbmcgdG8gcHJldmVudCBhbnkgbWlzdGFrZXNcbiAgICBjb25zdCByZWdleCA9IG5ldyBSZWdFeHAocGF0aC5jaGFyQXQoMCkgPT09ICdeJyA/IHBhdGggOiAnXicgKyBwYXRoKTtcbiAgICBpZiAocmVxUGF0aC5tYXRjaChyZWdleCkpIHtcbiAgICAgIG1hdGNoID0gdHJ1ZTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuICBpZiAoIW1hdGNoKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFRyeSB0byBzdG9yZSByZXF1ZXN0XG4gIGNvbnN0IGV4cGlyeURhdGUgPSBuZXcgRGF0ZShuZXcgRGF0ZSgpLnNldFNlY29uZHMobmV3IERhdGUoKS5nZXRTZWNvbmRzKCkgKyB0dGwpKTtcbiAgcmV0dXJuIHJlc3RcbiAgICAuY3JlYXRlKGNvbmZpZywgYXV0aC5tYXN0ZXIoY29uZmlnKSwgJ19JZGVtcG90ZW5jeScsIHtcbiAgICAgIHJlcUlkOiByZXF1ZXN0SWQsXG4gICAgICBleHBpcmU6IFBhcnNlLl9lbmNvZGUoZXhwaXJ5RGF0ZSksXG4gICAgfSlcbiAgICAuY2F0Y2goZSA9PiB7XG4gICAgICBpZiAoZS5jb2RlID09IFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRFVQTElDQVRFX1JFUVVFU1QsICdEdXBsaWNhdGUgcmVxdWVzdCcpO1xuICAgICAgfVxuICAgICAgdGhyb3cgZTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gaW52YWxpZFJlcXVlc3QocmVxLCByZXMpIHtcbiAgcmVzLnN0YXR1cyg0MDMpO1xuICByZXMuZW5kKCd7XCJlcnJvclwiOlwidW5hdXRob3JpemVkXCJ9Jyk7XG59XG5cbmZ1bmN0aW9uIG1hbGZvcm1lZENvbnRleHQocmVxLCByZXMpIHtcbiAgcmVzLnN0YXR1cyg0MDApO1xuICByZXMuanNvbih7IGNvZGU6IFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgZXJyb3I6ICdJbnZhbGlkIG9iamVjdCBmb3IgY29udGV4dC4nIH0pO1xufVxuXG4vKipcbiAqIEV4cHJlc3MgNCBhbGxvd2VkIGEgZG91YmxlIGZvcndhcmQgc2xhc2ggYmV0d2VlbiBhIHJvdXRlIGFuZCByb3V0ZXIuIEFsdGhvdWdoXG4gKiB0aGlzIHNob3VsZCBiZSBjb25zaWRlcmVkIGFuIGFudGktcGF0dGVybiwgd2UgbmVlZCB0byBzdXBwb3J0IGl0IGZvciBiYWNrd2FyZHNcbiAqIGNvbXBhdGliaWxpdHkuXG4gKlxuICogVGVjaG5pY2FsbHkgdmFsaWQgVVJMIHdpdGggZG91YmxlIGZvcm93YXJkIHNsYXNoOlxuICogaHR0cDovL2xvY2FsaG9zdDoxMzM3L3BhcnNlLy9mdW5jdGlvbnMvdGVzdEZ1bmN0aW9uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhbGxvd0RvdWJsZUZvcndhcmRTbGFzaChyZXEsIHJlcywgbmV4dCkge1xuICByZXEudXJsID0gcmVxLnVybC5zdGFydHNXaXRoKCcvLycpID8gcmVxLnVybC5zdWJzdHJpbmcoMSkgOiByZXEudXJsO1xuICBuZXh0KCk7XG59XG4iXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxJQUFBQSxNQUFBLEdBQUFDLHNC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