"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.Types = void 0;
exports._unregisterAll = _unregisterAll;
exports.addConnectTrigger = addConnectTrigger;
exports.addFunction = addFunction;
exports.addJob = addJob;
exports.addLiveQueryEventHandler = addLiveQueryEventHandler;
exports.addTrigger = addTrigger;
exports.getClassName = getClassName;
exports.getFunction = getFunction;
exports.getFunctionNames = getFunctionNames;
exports.getJob = getJob;
exports.getJobs = getJobs;
exports.getRequestFileObject = getRequestFileObject;
exports.getRequestObject = getRequestObject;
exports.getRequestQueryObject = getRequestQueryObject;
exports.getResponseObject = getResponseObject;
exports.getTrigger = getTrigger;
exports.getValidator = getValidator;
exports.inflate = inflate;
exports.maybeRunAfterFindTrigger = maybeRunAfterFindTrigger;
exports.maybeRunFileTrigger = maybeRunFileTrigger;
exports.maybeRunGlobalConfigTrigger = maybeRunGlobalConfigTrigger;
exports.maybeRunQueryTrigger = maybeRunQueryTrigger;
exports.maybeRunTrigger = maybeRunTrigger;
exports.maybeRunValidator = maybeRunValidator;
exports.removeFunction = removeFunction;
exports.removeTrigger = removeTrigger;
exports.resolveError = resolveError;
exports.runLiveQueryEventHandlers = runLiveQueryEventHandlers;
exports.runTrigger = runTrigger;
exports.toJSONwithObjects = toJSONwithObjects;
exports.triggerExists = triggerExists;
var _node = _interopRequireDefault(require("parse/node"));
var _logger = require("./logger");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// triggers.js

const Types = exports.Types = {
  beforeLogin: 'beforeLogin',
  afterLogin: 'afterLogin',
  afterLogout: 'afterLogout',
  beforeSave: 'beforeSave',
  afterSave: 'afterSave',
  beforeDelete: 'beforeDelete',
  afterDelete: 'afterDelete',
  beforeFind: 'beforeFind',
  afterFind: 'afterFind',
  beforeConnect: 'beforeConnect',
  beforeSubscribe: 'beforeSubscribe',
  afterEvent: 'afterEvent'
};
const ConnectClassName = '@Connect';
const baseStore = function () {
  const Validators = Object.keys(Types).reduce(function (base, key) {
    base[key] = {};
    return base;
  }, {});
  const Functions = {};
  const Jobs = {};
  const LiveQuery = [];
  const Triggers = Object.keys(Types).reduce(function (base, key) {
    base[key] = {};
    return base;
  }, {});
  return Object.freeze({
    Functions,
    Jobs,
    Validators,
    Triggers,
    LiveQuery
  });
};
function getClassName(parseClass) {
  if (parseClass && parseClass.className) {
    return parseClass.className;
  }
  if (parseClass && parseClass.name) {
    return parseClass.name.replace('Parse', '@');
  }
  return parseClass;
}
function validateClassNameForTriggers(className, type) {
  if (type == Types.beforeSave && className === '_PushStatus') {
    // _PushStatus uses undocumented nested key increment ops
    // allowing beforeSave would mess up the objects big time
    // TODO: Allow proper documented way of using nested increment ops
    throw 'Only afterSave is allowed on _PushStatus';
  }
  if ((type === Types.beforeLogin || type === Types.afterLogin) && className !== '_User') {
    // TODO: check if upstream code will handle `Error` instance rather
    // than this anti-pattern of throwing strings
    throw 'Only the _User class is allowed for the beforeLogin and afterLogin triggers';
  }
  if (type === Types.afterLogout && className !== '_Session') {
    // TODO: check if upstream code will handle `Error` instance rather
    // than this anti-pattern of throwing strings
    throw 'Only the _Session class is allowed for the afterLogout trigger.';
  }
  if (className === '_Session' && type !== Types.afterLogout) {
    // TODO: check if upstream code will handle `Error` instance rather
    // than this anti-pattern of throwing strings
    throw 'Only the afterLogout trigger is allowed for the _Session class.';
  }
  return className;
}
const _triggerStore = {};
const Category = {
  Functions: 'Functions',
  Validators: 'Validators',
  Jobs: 'Jobs',
  Triggers: 'Triggers'
};
function getStore(category, name, applicationId) {
  const invalidNameRegex = /['"`]/;
  if (invalidNameRegex.test(name)) {
    // Prevent a malicious user from injecting properties into the store
    return {};
  }
  const path = name.split('.');
  path.splice(-1); // remove last component
  applicationId = applicationId || _node.default.applicationId;
  _triggerStore[applicationId] = _triggerStore[applicationId] || baseStore();
  let store = _triggerStore[applicationId][category];
  for (const component of path) {
    store = store[component];
    if (!store) {
      return {};
    }
  }
  return store;
}
function add(category, name, handler, applicationId) {
  const lastComponent = name.split('.').splice(-1);
  const store = getStore(category, name, applicationId);
  if (store[lastComponent]) {
    _logger.logger.warn(`Warning: Duplicate cloud functions exist for ${lastComponent}. Only the last one will be used and the others will be ignored.`);
  }
  store[lastComponent] = handler;
}
function remove(category, name, applicationId) {
  const lastComponent = name.split('.').splice(-1);
  const store = getStore(category, name, applicationId);
  delete store[lastComponent];
}
function get(category, name, applicationId) {
  const lastComponent = name.split('.').splice(-1);
  const store = getStore(category, name, applicationId);
  return store[lastComponent];
}
function addFunction(functionName, handler, validationHandler, applicationId) {
  add(Category.Functions, functionName, handler, applicationId);
  add(Category.Validators, functionName, validationHandler, applicationId);
}
function addJob(jobName, handler, applicationId) {
  add(Category.Jobs, jobName, handler, applicationId);
}
function addTrigger(type, className, handler, applicationId, validationHandler) {
  validateClassNameForTriggers(className, type);
  add(Category.Triggers, `${type}.${className}`, handler, applicationId);
  add(Category.Validators, `${type}.${className}`, validationHandler, applicationId);
}
function addConnectTrigger(type, handler, applicationId, validationHandler) {
  add(Category.Triggers, `${type}.${ConnectClassName}`, handler, applicationId);
  add(Category.Validators, `${type}.${ConnectClassName}`, validationHandler, applicationId);
}
function addLiveQueryEventHandler(handler, applicationId) {
  applicationId = applicationId || _node.default.applicationId;
  _triggerStore[applicationId] = _triggerStore[applicationId] || baseStore();
  _triggerStore[applicationId].LiveQuery.push(handler);
}
function removeFunction(functionName, applicationId) {
  remove(Category.Functions, functionName, applicationId);
}
function removeTrigger(type, className, applicationId) {
  remove(Category.Triggers, `${type}.${className}`, applicationId);
}
function _unregisterAll() {
  Object.keys(_triggerStore).forEach(appId => delete _triggerStore[appId]);
}
function toJSONwithObjects(object, className) {
  if (!object || !object.toJSON) {
    return {};
  }
  const toJSON = object.toJSON();
  const stateController = _node.default.CoreManager.getObjectStateController();
  const [pending] = stateController.getPendingOps(object._getStateIdentifier());
  for (const key in pending) {
    const val = object.get(key);
    if (!val || !val._toFullJSON) {
      toJSON[key] = val;
      continue;
    }
    toJSON[key] = val._toFullJSON();
  }
  // Preserve original object's className if no override className is provided
  if (className) {
    toJSON.className = className;
  } else if (object.className && !toJSON.className) {
    toJSON.className = object.className;
  }
  return toJSON;
}
function getTrigger(className, triggerType, applicationId) {
  if (!applicationId) {
    throw 'Missing ApplicationID';
  }
  return get(Category.Triggers, `${triggerType}.${className}`, applicationId);
}
async function runTrigger(trigger, name, request, auth) {
  if (!trigger) {
    return;
  }
  await maybeRunValidator(request, name, auth);
  if (request.skipWithMasterKey) {
    return;
  }
  return await trigger(request);
}
function triggerExists(className, type, applicationId) {
  return getTrigger(className, type, applicationId) != undefined;
}
function getFunction(functionName, applicationId) {
  return get(Category.Functions, functionName, applicationId);
}
function getFunctionNames(applicationId) {
  const store = _triggerStore[applicationId] && _triggerStore[applicationId][Category.Functions] || {};
  const functionNames = [];
  const extractFunctionNames = (namespace, store) => {
    Object.keys(store).forEach(name => {
      const value = store[name];
      if (namespace) {
        name = `${namespace}.${name}`;
      }
      if (typeof value === 'function') {
        functionNames.push(name);
      } else {
        extractFunctionNames(name, value);
      }
    });
  };
  extractFunctionNames(null, store);
  return functionNames;
}
function getJob(jobName, applicationId) {
  return get(Category.Jobs, jobName, applicationId);
}
function getJobs(applicationId) {
  var manager = _triggerStore[applicationId];
  if (manager && manager.Jobs) {
    return manager.Jobs;
  }
  return undefined;
}
function getValidator(functionName, applicationId) {
  return get(Category.Validators, functionName, applicationId);
}
function getRequestObject(triggerType, auth, parseObject, originalParseObject, config, context, isGet) {
  const request = {
    triggerName: triggerType,
    object: parseObject,
    master: false,
    log: config.loggerController,
    headers: config.headers,
    ip: config.ip,
    config
  };
  if (isGet !== undefined) {
    request.isGet = !!isGet;
  }
  if (originalParseObject) {
    request.original = originalParseObject;
  }
  if (triggerType === Types.beforeSave || triggerType === Types.afterSave || triggerType === Types.beforeDelete || triggerType === Types.afterDelete || triggerType === Types.beforeLogin || triggerType === Types.afterLogin || triggerType === Types.afterFind) {
    // Set a copy of the context on the request object.
    request.context = Object.assign({}, context);
  }
  if (!auth) {
    return request;
  }
  if (auth.isMaster) {
    request['master'] = true;
  }
  if (auth.user) {
    request['user'] = auth.user;
  }
  if (auth.installationId) {
    request['installationId'] = auth.installationId;
  }
  return request;
}
function getRequestQueryObject(triggerType, auth, query, count, config, context, isGet) {
  isGet = !!isGet;
  var request = {
    triggerName: triggerType,
    query,
    master: false,
    count,
    log: config.loggerController,
    isGet,
    headers: config.headers,
    ip: config.ip,
    context: context || {},
    config
  };
  if (!auth) {
    return request;
  }
  if (auth.isMaster) {
    request['master'] = true;
  }
  if (auth.user) {
    request['user'] = auth.user;
  }
  if (auth.installationId) {
    request['installationId'] = auth.installationId;
  }
  return request;
}

// Creates the response object, and uses the request object to pass data
// The API will call this with REST API formatted objects, this will
// transform them to Parse.Object instances expected by Cloud Code.
// Any changes made to the object in a beforeSave will be included.
function getResponseObject(request, resolve, reject) {
  return {
    success: function (response) {
      if (request.triggerName === Types.afterFind) {
        if (!response) {
          response = request.objects;
        }
        response = response.map(object => {
          return toJSONwithObjects(object);
        });
        return resolve(response);
      }
      // Use the JSON response
      if (response && typeof response === 'object' && !request.object.equals(response) && request.triggerName === Types.beforeSave) {
        return resolve(response);
      }
      if (response && typeof response === 'object' && request.triggerName === Types.afterSave) {
        return resolve(response);
      }
      if (request.triggerName === Types.afterSave) {
        return resolve();
      }
      response = {};
      if (request.triggerName === Types.beforeSave) {
        response['object'] = request.object._getSaveJSON();
        response['object']['objectId'] = request.object.id;
      }
      return resolve(response);
    },
    error: function (error) {
      const e = resolveError(error, {
        code: _node.default.Error.SCRIPT_FAILED,
        message: 'Script failed. Unknown error.'
      });
      reject(e);
    }
  };
}
function userIdForLog(auth) {
  return auth && auth.user ? auth.user.id : undefined;
}
function logTriggerAfterHook(triggerType, className, input, auth, logLevel) {
  if (logLevel === 'silent') {
    return;
  }
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));
  _logger.logger[logLevel](`${triggerType} triggered for ${className} for user ${userIdForLog(auth)}:\n  Input: ${cleanInput}`, {
    className,
    triggerType,
    user: userIdForLog(auth)
  });
}
function logTriggerSuccessBeforeHook(triggerType, className, input, result, auth, logLevel) {
  if (logLevel === 'silent') {
    return;
  }
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));
  const cleanResult = _logger.logger.truncateLogMessage(JSON.stringify(result));
  _logger.logger[logLevel](`${triggerType} triggered for ${className} for user ${userIdForLog(auth)}:\n  Input: ${cleanInput}\n  Result: ${cleanResult}`, {
    className,
    triggerType,
    user: userIdForLog(auth)
  });
}
function logTriggerErrorBeforeHook(triggerType, className, input, auth, error, logLevel) {
  if (logLevel === 'silent') {
    return;
  }
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));
  _logger.logger[logLevel](`${triggerType} failed for ${className} for user ${userIdForLog(auth)}:\n  Input: ${cleanInput}\n  Error: ${JSON.stringify(error)}`, {
    className,
    triggerType,
    error,
    user: userIdForLog(auth)
  });
}
function maybeRunAfterFindTrigger(triggerType, auth, classNameQuery, objectsInput, config, query, context, isGet) {
  return new Promise((resolve, reject) => {
    const trigger = getTrigger(classNameQuery, triggerType, config.applicationId);
    if (!trigger) {
      if (objectsInput && objectsInput.length > 0 && objectsInput[0] instanceof _node.default.Object) {
        return resolve(objectsInput.map(obj => toJSONwithObjects(obj)));
      }
      return resolve(objectsInput || []);
    }
    const request = getRequestObject(triggerType, auth, null, null, config, context, isGet);
    // Convert query parameter to Parse.Query instance
    if (query instanceof _node.default.Query) {
      request.query = query;
    } else if (typeof query === 'object' && query !== null) {
      const parseQueryInstance = new _node.default.Query(classNameQuery);
      if (query.where) {
        parseQueryInstance.withJSON(query);
      }
      request.query = parseQueryInstance;
    } else {
      request.query = new _node.default.Query(classNameQuery);
    }
    const {
      success,
      error
    } = getResponseObject(request, processedObjectsJSON => {
      resolve(processedObjectsJSON);
    }, errorData => {
      reject(errorData);
    });
    logTriggerSuccessBeforeHook(triggerType, classNameQuery, 'AfterFind Input (Pre-Transform)', JSON.stringify(objectsInput.map(o => o instanceof _node.default.Object ? o.id + ':' + o.className : o)), auth, config.logLevels.triggerBeforeSuccess);

    // Convert plain objects to Parse.Object instances for trigger
    request.objects = objectsInput.map(currentObject => {
      if (currentObject instanceof _node.default.Object) {
        return currentObject;
      }
      // Preserve the original className if it exists, otherwise use the query className
      const originalClassName = currentObject.className || classNameQuery;
      const tempObjectWithClassName = {
        ...currentObject,
        className: originalClassName
      };
      return _node.default.Object.fromJSON(tempObjectWithClassName);
    });
    return Promise.resolve().then(() => {
      return maybeRunValidator(request, `${triggerType}.${classNameQuery}`, auth);
    }).then(() => {
      if (request.skipWithMasterKey) {
        return request.objects;
      }
      const responseFromTrigger = trigger(request);
      if (responseFromTrigger && typeof responseFromTrigger.then === 'function') {
        return responseFromTrigger.then(results => {
          return results;
        });
      }
      return responseFromTrigger;
    }).then(success, error);
  }).then(resultsAsJSON => {
    logTriggerAfterHook(triggerType, classNameQuery, JSON.stringify(resultsAsJSON), auth, config.logLevels.triggerAfter);
    return resultsAsJSON;
  });
}
function maybeRunQueryTrigger(triggerType, className, restWhere, restOptions, config, auth, context, isGet) {
  const trigger = getTrigger(className, triggerType, config.applicationId);
  if (!trigger) {
    return Promise.resolve({
      restWhere,
      restOptions
    });
  }
  const json = Object.assign({}, restOptions);
  json.where = restWhere;
  const parseQuery = new _node.default.Query(className);
  parseQuery.withJSON(json);
  let count = false;
  if (restOptions) {
    count = !!restOptions.count;
  }
  const requestObject = getRequestQueryObject(triggerType, auth, parseQuery, count, config, context, isGet);
  return Promise.resolve().then(() => {
    return maybeRunValidator(requestObject, `${triggerType}.${className}`, auth);
  }).then(() => {
    if (requestObject.skipWithMasterKey) {
      return requestObject.query;
    }
    return trigger(requestObject);
  }).then(result => {
    let queryResult = parseQuery;
    if (result && result instanceof _node.default.Query) {
      queryResult = result;
    }
    const jsonQuery = queryResult.toJSON();
    if (jsonQuery.where) {
      restWhere = jsonQuery.where;
    }
    if (jsonQuery.limit) {
      restOptions = restOptions || {};
      restOptions.limit = jsonQuery.limit;
    }
    if (jsonQuery.skip) {
      restOptions = restOptions || {};
      restOptions.skip = jsonQuery.skip;
    }
    if (jsonQuery.include) {
      restOptions = restOptions || {};
      restOptions.include = jsonQuery.include;
    }
    if (jsonQuery.excludeKeys) {
      restOptions = restOptions || {};
      restOptions.excludeKeys = jsonQuery.excludeKeys;
    }
    if (jsonQuery.explain) {
      restOptions = restOptions || {};
      restOptions.explain = jsonQuery.explain;
    }
    if (jsonQuery.keys) {
      restOptions = restOptions || {};
      restOptions.keys = jsonQuery.keys;
    }
    if (jsonQuery.order) {
      restOptions = restOptions || {};
      restOptions.order = jsonQuery.order;
    }
    if (jsonQuery.hint) {
      restOptions = restOptions || {};
      restOptions.hint = jsonQuery.hint;
    }
    if (jsonQuery.comment) {
      restOptions = restOptions || {};
      restOptions.comment = jsonQuery.comment;
    }
    if (requestObject.readPreference) {
      restOptions = restOptions || {};
      restOptions.readPreference = requestObject.readPreference;
    }
    if (requestObject.includeReadPreference) {
      restOptions = restOptions || {};
      restOptions.includeReadPreference = requestObject.includeReadPreference;
    }
    if (requestObject.subqueryReadPreference) {
      restOptions = restOptions || {};
      restOptions.subqueryReadPreference = requestObject.subqueryReadPreference;
    }
    let objects = undefined;
    if (result instanceof _node.default.Object) {
      objects = [result];
    } else if (Array.isArray(result) && (!result.length || result.every(obj => obj instanceof _node.default.Object))) {
      objects = result;
    }
    return {
      restWhere,
      restOptions,
      objects
    };
  }, err => {
    const error = resolveError(err, {
      code: _node.default.Error.SCRIPT_FAILED,
      message: 'Script failed. Unknown error.'
    });
    throw error;
  });
}
function resolveError(message, defaultOpts) {
  if (!defaultOpts) {
    defaultOpts = {};
  }
  if (!message) {
    return new _node.default.Error(defaultOpts.code || _node.default.Error.SCRIPT_FAILED, defaultOpts.message || 'Script failed.');
  }
  if (message instanceof _node.default.Error) {
    return message;
  }
  const code = defaultOpts.code || _node.default.Error.SCRIPT_FAILED;
  // If it's an error, mark it as a script failed
  if (typeof message === 'string') {
    return new _node.default.Error(code, message);
  }
  const error = new _node.default.Error(code, message.message || message);
  if (message instanceof Error) {
    error.stack = message.stack;
  }
  return error;
}
function maybeRunValidator(request, functionName, auth) {
  const theValidator = getValidator(functionName, _node.default.applicationId);
  if (!theValidator) {
    return;
  }
  if (typeof theValidator === 'object' && theValidator.skipWithMasterKey && request.master) {
    request.skipWithMasterKey = true;
  }
  return new Promise((resolve, reject) => {
    return Promise.resolve().then(() => {
      return typeof theValidator === 'object' ? builtInTriggerValidator(theValidator, request, auth) : theValidator(request);
    }).then(() => {
      resolve();
    }).catch(e => {
      const error = resolveError(e, {
        code: _node.default.Error.VALIDATION_ERROR,
        message: 'Validation failed.'
      });
      reject(error);
    });
  });
}
async function builtInTriggerValidator(options, request, auth) {
  if (request.master && !options.validateMasterKey) {
    return;
  }
  let reqUser = request.user;
  if (!reqUser && request.object && request.object.className === '_User' && !request.object.existed()) {
    reqUser = request.object;
  }
  if ((options.requireUser || options.requireAnyUserRoles || options.requireAllUserRoles) && !reqUser) {
    throw 'Validation failed. Please login to continue.';
  }
  if (options.requireMaster && !request.master) {
    throw 'Validation failed. Master key is required to complete this request.';
  }
  let params = request.params || {};
  if (request.object) {
    params = request.object.toJSON();
  }
  const requiredParam = key => {
    const value = params[key];
    if (value == null) {
      throw `Validation failed. Please specify data for ${key}.`;
    }
  };
  const validateOptions = async (opt, key, val) => {
    let opts = opt.options;
    if (typeof opts === 'function') {
      try {
        const result = await opts(val);
        if (!result && result != null) {
          throw opt.error || `Validation failed. Invalid value for ${key}.`;
        }
      } catch (e) {
        if (!e) {
          throw opt.error || `Validation failed. Invalid value for ${key}.`;
        }
        throw opt.error || e.message || e;
      }
      return;
    }
    if (!Array.isArray(opts)) {
      opts = [opt.options];
    }
    if (!opts.includes(val)) {
      throw opt.error || `Validation failed. Invalid option for ${key}. Expected: ${opts.join(', ')}`;
    }
  };
  const getType = fn => {
    const match = fn && fn.toString().match(/^\s*function (\w+)/);
    return (match ? match[1] : '').toLowerCase();
  };
  if (Array.isArray(options.fields)) {
    for (const key of options.fields) {
      requiredParam(key);
    }
  } else {
    const optionPromises = [];
    for (const key in options.fields) {
      const opt = options.fields[key];
      let val = params[key];
      if (typeof opt === 'string') {
        requiredParam(opt);
      }
      if (typeof opt === 'object') {
        if (opt.default != null && val == null) {
          val = opt.default;
          params[key] = val;
          if (request.object) {
            request.object.set(key, val);
          }
        }
        if (opt.constant && request.object) {
          if (request.original) {
            request.object.revert(key);
          } else if (opt.default != null) {
            request.object.set(key, opt.default);
          }
        }
        if (opt.required) {
          requiredParam(key);
        }
        const optional = !opt.required && val === undefined;
        if (!optional) {
          if (opt.type) {
            const type = getType(opt.type);
            const valType = Array.isArray(val) ? 'array' : typeof val;
            if (valType !== type) {
              throw `Validation failed. Invalid type for ${key}. Expected: ${type}`;
            }
          }
          if (opt.options) {
            optionPromises.push(validateOptions(opt, key, val));
          }
        }
      }
    }
    await Promise.all(optionPromises);
  }
  let userRoles = options.requireAnyUserRoles;
  let requireAllRoles = options.requireAllUserRoles;
  const promises = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
  if (userRoles || requireAllRoles) {
    promises[0] = auth.getUserRoles();
  }
  if (typeof userRoles === 'function') {
    promises[1] = userRoles();
  }
  if (typeof requireAllRoles === 'function') {
    promises[2] = requireAllRoles();
  }
  const [roles, resolvedUserRoles, resolvedRequireAll] = await Promise.all(promises);
  if (resolvedUserRoles && Array.isArray(resolvedUserRoles)) {
    userRoles = resolvedUserRoles;
  }
  if (resolvedRequireAll && Array.isArray(resolvedRequireAll)) {
    requireAllRoles = resolvedRequireAll;
  }
  if (userRoles) {
    const hasRole = userRoles.some(requiredRole => roles.includes(`role:${requiredRole}`));
    if (!hasRole) {
      throw `Validation failed. User does not match the required roles.`;
    }
  }
  if (requireAllRoles) {
    for (const requiredRole of requireAllRoles) {
      if (!roles.includes(`role:${requiredRole}`)) {
        throw `Validation failed. User does not match all the required roles.`;
      }
    }
  }
  const userKeys = options.requireUserKeys || [];
  if (Array.isArray(userKeys)) {
    for (const key of userKeys) {
      if (!reqUser) {
        throw 'Please login to make this request.';
      }
      if (reqUser.get(key) == null) {
        throw `Validation failed. Please set data for ${key} on your account.`;
      }
    }
  } else if (typeof userKeys === 'object') {
    const optionPromises = [];
    for (const key in options.requireUserKeys) {
      const opt = options.requireUserKeys[key];
      if (opt.options) {
        optionPromises.push(validateOptions(opt, key, reqUser.get(key)));
      }
    }
    await Promise.all(optionPromises);
  }
}

// To be used as part of the promise chain when saving/deleting an object
// Will resolve successfully if no trigger is configured
// Resolves to an object, empty or containing an object key. A beforeSave
// trigger will set the object key to the rest format object to save.
// originalParseObject is optional, we only need that for before/afterSave functions
function maybeRunTrigger(triggerType, auth, parseObject, originalParseObject, config, context) {
  if (!parseObject) {
    return Promise.resolve({});
  }
  return new Promise(function (resolve, reject) {
    var trigger = getTrigger(parseObject.className, triggerType, config.applicationId);
    if (!trigger) {
      return resolve();
    }
    var request = getRequestObject(triggerType, auth, parseObject, originalParseObject, config, context);
    var {
      success,
      error
    } = getResponseObject(request, object => {
      logTriggerSuccessBeforeHook(triggerType, parseObject.className, parseObject.toJSON(), object, auth, triggerType.startsWith('after') ? config.logLevels.triggerAfter : config.logLevels.triggerBeforeSuccess);
      if (triggerType === Types.beforeSave || triggerType === Types.afterSave || triggerType === Types.beforeDelete || triggerType === Types.afterDelete) {
        Object.assign(context, request.context);
      }
      resolve(object);
    }, error => {
      logTriggerErrorBeforeHook(triggerType, parseObject.className, parseObject.toJSON(), auth, error, config.logLevels.triggerBeforeError);
      reject(error);
    });

    // AfterSave and afterDelete triggers can return a promise, which if they
    // do, needs to be resolved before this promise is resolved,
    // so trigger execution is synced with RestWrite.execute() call.
    // If triggers do not return a promise, they can run async code parallel
    // to the RestWrite.execute() call.
    return Promise.resolve().then(() => {
      return maybeRunValidator(request, `${triggerType}.${parseObject.className}`, auth);
    }).then(() => {
      if (request.skipWithMasterKey) {
        return Promise.resolve();
      }
      const promise = trigger(request);
      if (triggerType === Types.afterSave || triggerType === Types.afterDelete || triggerType === Types.afterLogin) {
        logTriggerAfterHook(triggerType, parseObject.className, parseObject.toJSON(), auth, config.logLevels.triggerAfter);
      }
      // beforeSave is expected to return null (nothing)
      if (triggerType === Types.beforeSave) {
        if (promise && typeof promise.then === 'function') {
          return promise.then(response => {
            // response.object may come from express routing before hook
            if (response && response.object) {
              return response;
            }
            return null;
          });
        }
        return null;
      }
      return promise;
    }).then(success, error);
  });
}

// Converts a REST-format object to a Parse.Object
// data is either className or an object
function inflate(data, restObject) {
  var copy = typeof data == 'object' ? data : {
    className: data
  };
  for (var key in restObject) {
    copy[key] = restObject[key];
  }
  return _node.default.Object.fromJSON(copy);
}
function runLiveQueryEventHandlers(data, applicationId = _node.default.applicationId) {
  if (!_triggerStore || !_triggerStore[applicationId] || !_triggerStore[applicationId].LiveQuery) {
    return;
  }
  _triggerStore[applicationId].LiveQuery.forEach(handler => handler(data));
}
function getRequestFileObject(triggerType, auth, fileObject, config) {
  const request = {
    ...fileObject,
    triggerName: triggerType,
    master: false,
    log: config.loggerController,
    headers: config.headers,
    ip: config.ip,
    config
  };
  if (!auth) {
    return request;
  }
  if (auth.isMaster) {
    request['master'] = true;
  }
  if (auth.user) {
    request['user'] = auth.user;
  }
  if (auth.installationId) {
    request['installationId'] = auth.installationId;
  }
  return request;
}
async function maybeRunFileTrigger(triggerType, fileObject, config, auth) {
  const FileClassName = getClassName(_node.default.File);
  const fileTrigger = getTrigger(FileClassName, triggerType, config.applicationId);
  if (typeof fileTrigger === 'function') {
    try {
      const request = getRequestFileObject(triggerType, auth, fileObject, config);
      await maybeRunValidator(request, `${triggerType}.${FileClassName}`, auth);
      if (request.skipWithMasterKey) {
        return fileObject;
      }
      const result = await fileTrigger(request);
      if (request.forceDownload) {
        fileObject.forceDownload = true;
      }
      logTriggerSuccessBeforeHook(triggerType, 'Parse.File', {
        ...fileObject.file.toJSON(),
        fileSize: fileObject.fileSize
      }, result, auth, config.logLevels.triggerBeforeSuccess);
      return result || fileObject;
    } catch (error) {
      logTriggerErrorBeforeHook(triggerType, 'Parse.File', {
        ...fileObject.file.toJSON(),
        fileSize: fileObject.fileSize
      }, auth, error, config.logLevels.triggerBeforeError);
      throw error;
    }
  }
  return fileObject;
}
async function maybeRunGlobalConfigTrigger(triggerType, auth, configObject, originalConfigObject, config, context) {
  const GlobalConfigClassName = getClassName(_node.default.Config);
  const configTrigger = getTrigger(GlobalConfigClassName, triggerType, config.applicationId);
  if (typeof configTrigger === 'function') {
    try {
      const request = getRequestObject(triggerType, auth, configObject, originalConfigObject, config, context);
      await maybeRunValidator(request, `${triggerType}.${GlobalConfigClassName}`, auth);
      if (request.skipWithMasterKey) {
        return configObject;
      }
      const result = await configTrigger(request);
      logTriggerSuccessBeforeHook(triggerType, 'Parse.Config', configObject, result, auth, config.logLevels.triggerBeforeSuccess);
      return result || configObject;
    } catch (error) {
      logTriggerErrorBeforeHook(triggerType, 'Parse.Config', configObject, auth, error, config.logLevels.triggerBeforeError);
      throw error;
    }
  }
  return configObject;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbm9kZSIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX2xvZ2dlciIsImUiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsIlR5cGVzIiwiZXhwb3J0cyIsImJlZm9yZUxvZ2luIiwiYWZ0ZXJMb2dpbiIsImFmdGVyTG9nb3V0IiwiYmVmb3JlU2F2ZSIsImFmdGVyU2F2ZSIsImJlZm9yZURlbGV0ZSIsImFmdGVyRGVsZXRlIiwiYmVmb3JlRmluZCIsImFmdGVyRmluZCIsImJlZm9yZUNvbm5lY3QiLCJiZWZvcmVTdWJzY3JpYmUiLCJhZnRlckV2ZW50IiwiQ29ubmVjdENsYXNzTmFtZSIsImJhc2VTdG9yZSIsIlZhbGlkYXRvcnMiLCJPYmplY3QiLCJrZXlzIiwicmVkdWNlIiwiYmFzZSIsImtleSIsIkZ1bmN0aW9ucyIsIkpvYnMiLCJMaXZlUXVlcnkiLCJUcmlnZ2VycyIsImZyZWV6ZSIsImdldENsYXNzTmFtZSIsInBhcnNlQ2xhc3MiLCJjbGFzc05hbWUiLCJuYW1lIiwicmVwbGFjZSIsInZhbGlkYXRlQ2xhc3NOYW1lRm9yVHJpZ2dlcnMiLCJ0eXBlIiwiX3RyaWdnZXJTdG9yZSIsIkNhdGVnb3J5IiwiZ2V0U3RvcmUiLCJjYXRlZ29yeSIsImFwcGxpY2F0aW9uSWQiLCJpbnZhbGlkTmFtZVJlZ2V4IiwidGVzdCIsInBhdGgiLCJzcGxpdCIsInNwbGljZSIsIlBhcnNlIiwic3RvcmUiLCJjb21wb25lbnQiLCJhZGQiLCJoYW5kbGVyIiwibGFzdENvbXBvbmVudCIsImxvZ2dlciIsIndhcm4iLCJyZW1vdmUiLCJnZXQiLCJhZGRGdW5jdGlvbiIsImZ1bmN0aW9uTmFtZSIsInZhbGlkYXRpb25IYW5kbGVyIiwiYWRkSm9iIiwiam9iTmFtZSIsImFkZFRyaWdnZXIiLCJhZGRDb25uZWN0VHJpZ2dlciIsImFkZExpdmVRdWVyeUV2ZW50SGFuZGxlciIsInB1c2giLCJyZW1vdmVGdW5jdGlvbiIsInJlbW92ZVRyaWdnZXIiLCJfdW5yZWdpc3RlckFsbCIsImZvckVhY2giLCJhcHBJZCIsInRvSlNPTndpdGhPYmplY3RzIiwib2JqZWN0IiwidG9KU09OIiwic3RhdGVDb250cm9sbGVyIiwiQ29yZU1hbmFnZXIiLCJnZXRPYmplY3RTdGF0ZUNvbnRyb2xsZXIiLCJwZW5kaW5nIiwiZ2V0UGVuZGluZ09wcyIsIl9nZXRTdGF0ZUlkZW50aWZpZXIiLCJ2YWwiLCJfdG9GdWxsSlNPTiIsImdldFRyaWdnZXIiLCJ0cmlnZ2VyVHlwZSIsInJ1blRyaWdnZXIiLCJ0cmlnZ2VyIiwicmVxdWVzdCIsImF1dGgiLCJtYXliZVJ1blZhbGlkYXRvciIsInNraXBXaXRoTWFzdGVyS2V5IiwidHJpZ2dlckV4aXN0cyIsInVuZGVmaW5lZCIsImdldEZ1bmN0aW9uIiwiZ2V0RnVuY3Rpb25OYW1lcyIsImZ1bmN0aW9uTmFtZXMiLCJleHRyYWN0RnVuY3Rpb25OYW1lcyIsIm5hbWVzcGFjZSIsInZhbHVlIiwiZ2V0Sm9iIiwiZ2V0Sm9icyIsIm1hbmFnZXIiLCJnZXRWYWxpZGF0b3IiLCJnZXRSZXF1ZXN0T2JqZWN0IiwicGFyc2VPYmplY3QiLCJvcmlnaW5hbFBhcnNlT2JqZWN0IiwiY29uZmlnIiwiY29udGV4dCIsImlzR2V0IiwidHJpZ2dlck5hbWUiLCJtYXN0ZXIiLCJsb2ciLCJsb2dnZXJDb250cm9sbGVyIiwiaGVhZGVycyIsImlwIiwib3JpZ2luYWwiLCJhc3NpZ24iLCJpc01hc3RlciIsInVzZXIiLCJpbnN0YWxsYXRpb25JZCIsImdldFJlcXVlc3RRdWVyeU9iamVjdCIsInF1ZXJ5IiwiY291bnQiLCJnZXRSZXNwb25zZU9iamVjdCIsInJlc29sdmUiLCJyZWplY3QiLCJzdWNjZXNzIiwicmVzcG9uc2UiLCJvYmplY3RzIiwibWFwIiwiZXF1YWxzIiwiX2dldFNhdmVKU09OIiwiaWQiLCJlcnJvciIsInJlc29sdmVFcnJvciIsImNvZGUiLCJFcnJvciIsIlNDUklQVF9GQUlMRUQiLCJtZXNzYWdlIiwidXNlcklkRm9yTG9nIiwibG9nVHJpZ2dlckFmdGVySG9vayIsImlucHV0IiwibG9nTGV2ZWwiLCJjbGVhbklucHV0IiwidHJ1bmNhdGVMb2dNZXNzYWdlIiwiSlNPTiIsInN0cmluZ2lmeSIsImxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayIsInJlc3VsdCIsImNsZWFuUmVzdWx0IiwibG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayIsIm1heWJlUnVuQWZ0ZXJGaW5kVHJpZ2dlciIsImNsYXNzTmFtZVF1ZXJ5Iiwib2JqZWN0c0lucHV0IiwiUHJvbWlzZSIsImxlbmd0aCIsIm9iaiIsIlF1ZXJ5IiwicGFyc2VRdWVyeUluc3RhbmNlIiwid2hlcmUiLCJ3aXRoSlNPTiIsInByb2Nlc3NlZE9iamVjdHNKU09OIiwiZXJyb3JEYXRhIiwibyIsImxvZ0xldmVscyIsInRyaWdnZXJCZWZvcmVTdWNjZXNzIiwiY3VycmVudE9iamVjdCIsIm9yaWdpbmFsQ2xhc3NOYW1lIiwidGVtcE9iamVjdFdpdGhDbGFzc05hbWUiLCJmcm9tSlNPTiIsInRoZW4iLCJyZXNwb25zZUZyb21UcmlnZ2VyIiwicmVzdWx0cyIsInJlc3VsdHNBc0pTT04iLCJ0cmlnZ2VyQWZ0ZXIiLCJtYXliZVJ1blF1ZXJ5VHJpZ2dlciIsInJlc3RXaGVyZSIsInJlc3RPcHRpb25zIiwianNvbiIsInBhcnNlUXVlcnkiLCJyZXF1ZXN0T2JqZWN0IiwicXVlcnlSZXN1bHQiLCJqc29uUXVlcnkiLCJsaW1pdCIsInNraXAiLCJpbmNsdWRlIiwiZXhjbHVkZUtleXMiLCJleHBsYWluIiwib3JkZXIiLCJoaW50IiwiY29tbWVudCIsInJlYWRQcmVmZXJlbmNlIiwiaW5jbHVkZVJlYWRQcmVmZXJlbmNlIiwic3VicXVlcnlSZWFkUHJlZmVyZW5jZSIsIkFycmF5IiwiaXNBcnJheSIsImV2ZXJ5IiwiZXJyIiwiZGVmYXVsdE9wdHMiLCJzdGFjayIsInRoZVZhbGlkYXRvciIsImJ1aWx0SW5UcmlnZ2VyVmFsaWRhdG9yIiwiY2F0Y2giLCJWQUxJREFUSU9OX0VSUk9SIiwib3B0aW9ucyIsInZhbGlkYXRlTWFzdGVyS2V5IiwicmVxVXNlciIsImV4aXN0ZWQiLCJyZXF1aXJlVXNlciIsInJlcXVpcmVBbnlVc2VyUm9sZXMiLCJyZXF1aXJlQWxsVXNlclJvbGVzIiwicmVxdWlyZU1hc3RlciIsInBhcmFtcyIsInJlcXVpcmVkUGFyYW0iLCJ2YWxpZGF0ZU9wdGlvbnMiLCJvcHQiLCJvcHRzIiwiaW5jbHVkZXMiLCJqb2luIiwiZ2V0VHlwZSIsImZuIiwibWF0Y2giLCJ0b1N0cmluZyIsInRvTG93ZXJDYXNlIiwiZmllbGRzIiwib3B0aW9uUHJvbWlzZXMiLCJzZXQiLCJjb25zdGFudCIsInJldmVydCIsInJlcXVpcmVkIiwib3B0aW9uYWwiLCJ2YWxUeXBlIiwiYWxsIiwidXNlclJvbGVzIiwicmVxdWlyZUFsbFJvbGVzIiwicHJvbWlzZXMiLCJnZXRVc2VyUm9sZXMiLCJyb2xlcyIsInJlc29sdmVkVXNlclJvbGVzIiwicmVzb2x2ZWRSZXF1aXJlQWxsIiwiaGFzUm9sZSIsInNvbWUiLCJyZXF1aXJlZFJvbGUiLCJ1c2VyS2V5cyIsInJlcXVpcmVVc2VyS2V5cyIsIm1heWJlUnVuVHJpZ2dlciIsInN0YXJ0c1dpdGgiLCJ0cmlnZ2VyQmVmb3JlRXJyb3IiLCJwcm9taXNlIiwiaW5mbGF0ZSIsImRhdGEiLCJyZXN0T2JqZWN0IiwiY29weSIsInJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMiLCJnZXRSZXF1ZXN0RmlsZU9iamVjdCIsImZpbGVPYmplY3QiLCJtYXliZVJ1bkZpbGVUcmlnZ2VyIiwiRmlsZUNsYXNzTmFtZSIsIkZpbGUiLCJmaWxlVHJpZ2dlciIsImZvcmNlRG93bmxvYWQiLCJmaWxlIiwiZmlsZVNpemUiLCJtYXliZVJ1bkdsb2JhbENvbmZpZ1RyaWdnZXIiLCJjb25maWdPYmplY3QiLCJvcmlnaW5hbENvbmZpZ09iamVjdCIsIkdsb2JhbENvbmZpZ0NsYXNzTmFtZSIsIkNvbmZpZyIsImNvbmZpZ1RyaWdnZXIiXSwic291cmNlcyI6WyIuLi9zcmMvdHJpZ2dlcnMuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gdHJpZ2dlcnMuanNcbmltcG9ydCBQYXJzZSBmcm9tICdwYXJzZS9ub2RlJztcbmltcG9ydCB7IGxvZ2dlciB9IGZyb20gJy4vbG9nZ2VyJztcblxuZXhwb3J0IGNvbnN0IFR5cGVzID0ge1xuICBiZWZvcmVMb2dpbjogJ2JlZm9yZUxvZ2luJyxcbiAgYWZ0ZXJMb2dpbjogJ2FmdGVyTG9naW4nLFxuICBhZnRlckxvZ291dDogJ2FmdGVyTG9nb3V0JyxcbiAgYmVmb3JlU2F2ZTogJ2JlZm9yZVNhdmUnLFxuICBhZnRlclNhdmU6ICdhZnRlclNhdmUnLFxuICBiZWZvcmVEZWxldGU6ICdiZWZvcmVEZWxldGUnLFxuICBhZnRlckRlbGV0ZTogJ2FmdGVyRGVsZXRlJyxcbiAgYmVmb3JlRmluZDogJ2JlZm9yZUZpbmQnLFxuICBhZnRlckZpbmQ6ICdhZnRlckZpbmQnLFxuICBiZWZvcmVDb25uZWN0OiAnYmVmb3JlQ29ubmVjdCcsXG4gIGJlZm9yZVN1YnNjcmliZTogJ2JlZm9yZVN1YnNjcmliZScsXG4gIGFmdGVyRXZlbnQ6ICdhZnRlckV2ZW50Jyxcbn07XG5cbmNvbnN0IENvbm5lY3RDbGFzc05hbWUgPSAnQENvbm5lY3QnO1xuXG5jb25zdCBiYXNlU3RvcmUgPSBmdW5jdGlvbiAoKSB7XG4gIGNvbnN0IFZhbGlkYXRvcnMgPSBPYmplY3Qua2V5cyhUeXBlcykucmVkdWNlKGZ1bmN0aW9uIChiYXNlLCBrZXkpIHtcbiAgICBiYXNlW2tleV0gPSB7fTtcbiAgICByZXR1cm4gYmFzZTtcbiAgfSwge30pO1xuICBjb25zdCBGdW5jdGlvbnMgPSB7fTtcbiAgY29uc3QgSm9icyA9IHt9O1xuICBjb25zdCBMaXZlUXVlcnkgPSBbXTtcbiAgY29uc3QgVHJpZ2dlcnMgPSBPYmplY3Qua2V5cyhUeXBlcykucmVkdWNlKGZ1bmN0aW9uIChiYXNlLCBrZXkpIHtcbiAgICBiYXNlW2tleV0gPSB7fTtcbiAgICByZXR1cm4gYmFzZTtcbiAgfSwge30pO1xuXG4gIHJldHVybiBPYmplY3QuZnJlZXplKHtcbiAgICBGdW5jdGlvbnMsXG4gICAgSm9icyxcbiAgICBWYWxpZGF0b3JzLFxuICAgIFRyaWdnZXJzLFxuICAgIExpdmVRdWVyeSxcbiAgfSk7XG59O1xuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q2xhc3NOYW1lKHBhcnNlQ2xhc3MpIHtcbiAgaWYgKHBhcnNlQ2xhc3MgJiYgcGFyc2VDbGFzcy5jbGFzc05hbWUpIHtcbiAgICByZXR1cm4gcGFyc2VDbGFzcy5jbGFzc05hbWU7XG4gIH1cbiAgaWYgKHBhcnNlQ2xhc3MgJiYgcGFyc2VDbGFzcy5uYW1lKSB7XG4gICAgcmV0dXJuIHBhcnNlQ2xhc3MubmFtZS5yZXBsYWNlKCdQYXJzZScsICdAJyk7XG4gIH1cbiAgcmV0dXJuIHBhcnNlQ2xhc3M7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlQ2xhc3NOYW1lRm9yVHJpZ2dlcnMoY2xhc3NOYW1lLCB0eXBlKSB7XG4gIGlmICh0eXBlID09IFR5cGVzLmJlZm9yZVNhdmUgJiYgY2xhc3NOYW1lID09PSAnX1B1c2hTdGF0dXMnKSB7XG4gICAgLy8gX1B1c2hTdGF0dXMgdXNlcyB1bmRvY3VtZW50ZWQgbmVzdGVkIGtleSBpbmNyZW1lbnQgb3BzXG4gICAgLy8gYWxsb3dpbmcgYmVmb3JlU2F2ZSB3b3VsZCBtZXNzIHVwIHRoZSBvYmplY3RzIGJpZyB0aW1lXG4gICAgLy8gVE9ETzogQWxsb3cgcHJvcGVyIGRvY3VtZW50ZWQgd2F5IG9mIHVzaW5nIG5lc3RlZCBpbmNyZW1lbnQgb3BzXG4gICAgdGhyb3cgJ09ubHkgYWZ0ZXJTYXZlIGlzIGFsbG93ZWQgb24gX1B1c2hTdGF0dXMnO1xuICB9XG4gIGlmICgodHlwZSA9PT0gVHlwZXMuYmVmb3JlTG9naW4gfHwgdHlwZSA9PT0gVHlwZXMuYWZ0ZXJMb2dpbikgJiYgY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgLy8gVE9ETzogY2hlY2sgaWYgdXBzdHJlYW0gY29kZSB3aWxsIGhhbmRsZSBgRXJyb3JgIGluc3RhbmNlIHJhdGhlclxuICAgIC8vIHRoYW4gdGhpcyBhbnRpLXBhdHRlcm4gb2YgdGhyb3dpbmcgc3RyaW5nc1xuICAgIHRocm93ICdPbmx5IHRoZSBfVXNlciBjbGFzcyBpcyBhbGxvd2VkIGZvciB0aGUgYmVmb3JlTG9naW4gYW5kIGFmdGVyTG9naW4gdHJpZ2dlcnMnO1xuICB9XG4gIGlmICh0eXBlID09PSBUeXBlcy5hZnRlckxvZ291dCAmJiBjbGFzc05hbWUgIT09ICdfU2Vzc2lvbicpIHtcbiAgICAvLyBUT0RPOiBjaGVjayBpZiB1cHN0cmVhbSBjb2RlIHdpbGwgaGFuZGxlIGBFcnJvcmAgaW5zdGFuY2UgcmF0aGVyXG4gICAgLy8gdGhhbiB0aGlzIGFudGktcGF0dGVybiBvZiB0aHJvd2luZyBzdHJpbmdzXG4gICAgdGhyb3cgJ09ubHkgdGhlIF9TZXNzaW9uIGNsYXNzIGlzIGFsbG93ZWQgZm9yIHRoZSBhZnRlckxvZ291dCB0cmlnZ2VyLic7XG4gIH1cbiAgaWYgKGNsYXNzTmFtZSA9PT0gJ19TZXNzaW9uJyAmJiB0eXBlICE9PSBUeXBlcy5hZnRlckxvZ291dCkge1xuICAgIC8vIFRPRE86IGNoZWNrIGlmIHVwc3RyZWFtIGNvZGUgd2lsbCBoYW5kbGUgYEVycm9yYCBpbnN0YW5jZSByYXRoZXJcbiAgICAvLyB0aGFuIHRoaXMgYW50aS1wYXR0ZXJuIG9mIHRocm93aW5nIHN0cmluZ3NcbiAgICB0aHJvdyAnT25seSB0aGUgYWZ0ZXJMb2dvdXQgdHJpZ2dlciBpcyBhbGxvd2VkIGZvciB0aGUgX1Nlc3Npb24gY2xhc3MuJztcbiAgfVxuICByZXR1cm4gY2xhc3NOYW1lO1xufVxuXG5jb25zdCBfdHJpZ2dlclN0b3JlID0ge307XG5cbmNvbnN0IENhdGVnb3J5ID0ge1xuICBGdW5jdGlvbnM6ICdGdW5jdGlvbnMnLFxuICBWYWxpZGF0b3JzOiAnVmFsaWRhdG9ycycsXG4gIEpvYnM6ICdKb2JzJyxcbiAgVHJpZ2dlcnM6ICdUcmlnZ2VycycsXG59O1xuXG5mdW5jdGlvbiBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBpbnZhbGlkTmFtZVJlZ2V4ID0gL1snXCJgXS87XG4gIGlmIChpbnZhbGlkTmFtZVJlZ2V4LnRlc3QobmFtZSkpIHtcbiAgICAvLyBQcmV2ZW50IGEgbWFsaWNpb3VzIHVzZXIgZnJvbSBpbmplY3RpbmcgcHJvcGVydGllcyBpbnRvIHRoZSBzdG9yZVxuICAgIHJldHVybiB7fTtcbiAgfVxuXG4gIGNvbnN0IHBhdGggPSBuYW1lLnNwbGl0KCcuJyk7XG4gIHBhdGguc3BsaWNlKC0xKTsgLy8gcmVtb3ZlIGxhc3QgY29tcG9uZW50XG4gIGFwcGxpY2F0aW9uSWQgPSBhcHBsaWNhdGlvbklkIHx8IFBhcnNlLmFwcGxpY2F0aW9uSWQ7XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdIHx8IGJhc2VTdG9yZSgpO1xuICBsZXQgc3RvcmUgPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdW2NhdGVnb3J5XTtcbiAgZm9yIChjb25zdCBjb21wb25lbnQgb2YgcGF0aCkge1xuICAgIHN0b3JlID0gc3RvcmVbY29tcG9uZW50XTtcbiAgICBpZiAoIXN0b3JlKSB7XG4gICAgICByZXR1cm4ge307XG4gICAgfVxuICB9XG4gIHJldHVybiBzdG9yZTtcbn1cblxuZnVuY3Rpb24gYWRkKGNhdGVnb3J5LCBuYW1lLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIGlmIChzdG9yZVtsYXN0Q29tcG9uZW50XSkge1xuICAgIGxvZ2dlci53YXJuKFxuICAgICAgYFdhcm5pbmc6IER1cGxpY2F0ZSBjbG91ZCBmdW5jdGlvbnMgZXhpc3QgZm9yICR7bGFzdENvbXBvbmVudH0uIE9ubHkgdGhlIGxhc3Qgb25lIHdpbGwgYmUgdXNlZCBhbmQgdGhlIG90aGVycyB3aWxsIGJlIGlnbm9yZWQuYFxuICAgICk7XG4gIH1cbiAgc3RvcmVbbGFzdENvbXBvbmVudF0gPSBoYW5kbGVyO1xufVxuXG5mdW5jdGlvbiByZW1vdmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3QgbGFzdENvbXBvbmVudCA9IG5hbWUuc3BsaXQoJy4nKS5zcGxpY2UoLTEpO1xuICBjb25zdCBzdG9yZSA9IGdldFN0b3JlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKTtcbiAgZGVsZXRlIHN0b3JlW2xhc3RDb21wb25lbnRdO1xufVxuXG5mdW5jdGlvbiBnZXQoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3QgbGFzdENvbXBvbmVudCA9IG5hbWUuc3BsaXQoJy4nKS5zcGxpY2UoLTEpO1xuICBjb25zdCBzdG9yZSA9IGdldFN0b3JlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKTtcbiAgcmV0dXJuIHN0b3JlW2xhc3RDb21wb25lbnRdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkRnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBoYW5kbGVyLCB2YWxpZGF0aW9uSGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBhZGQoQ2F0ZWdvcnkuRnVuY3Rpb25zLCBmdW5jdGlvbk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xuICBhZGQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgZnVuY3Rpb25OYW1lLCB2YWxpZGF0aW9uSGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRKb2Ioam9iTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBhZGQoQ2F0ZWdvcnkuSm9icywgam9iTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRUcmlnZ2VyKHR5cGUsIGNsYXNzTmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCwgdmFsaWRhdGlvbkhhbmRsZXIpIHtcbiAgdmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyhjbGFzc05hbWUsIHR5cGUpO1xuICBhZGQoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xuICBhZGQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgYCR7dHlwZX0uJHtjbGFzc05hbWV9YCwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkQ29ubmVjdFRyaWdnZXIodHlwZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCwgdmFsaWRhdGlvbkhhbmRsZXIpIHtcbiAgYWRkKENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0eXBlfS4ke0Nvbm5lY3RDbGFzc05hbWV9YCwgaGFuZGxlciwgYXBwbGljYXRpb25JZCk7XG4gIGFkZChDYXRlZ29yeS5WYWxpZGF0b3JzLCBgJHt0eXBlfS4ke0Nvbm5lY3RDbGFzc05hbWV9YCwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVyKGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYXBwbGljYXRpb25JZCA9IGFwcGxpY2F0aW9uSWQgfHwgUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSA9IF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gfHwgYmFzZVN0b3JlKCk7XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0uTGl2ZVF1ZXJ5LnB1c2goaGFuZGxlcik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVGdW5jdGlvbihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmVtb3ZlKENhdGVnb3J5LkZ1bmN0aW9ucywgZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZVRyaWdnZXIodHlwZSwgY2xhc3NOYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJlbW92ZShDYXRlZ29yeS5UcmlnZ2VycywgYCR7dHlwZX0uJHtjbGFzc05hbWV9YCwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBfdW5yZWdpc3RlckFsbCgpIHtcbiAgT2JqZWN0LmtleXMoX3RyaWdnZXJTdG9yZSkuZm9yRWFjaChhcHBJZCA9PiBkZWxldGUgX3RyaWdnZXJTdG9yZVthcHBJZF0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdG9KU09Od2l0aE9iamVjdHMob2JqZWN0LCBjbGFzc05hbWUpIHtcbiAgaWYgKCFvYmplY3QgfHwgIW9iamVjdC50b0pTT04pIHtcbiAgICByZXR1cm4ge307XG4gIH1cbiAgY29uc3QgdG9KU09OID0gb2JqZWN0LnRvSlNPTigpO1xuICBjb25zdCBzdGF0ZUNvbnRyb2xsZXIgPSBQYXJzZS5Db3JlTWFuYWdlci5nZXRPYmplY3RTdGF0ZUNvbnRyb2xsZXIoKTtcbiAgY29uc3QgW3BlbmRpbmddID0gc3RhdGVDb250cm9sbGVyLmdldFBlbmRpbmdPcHMob2JqZWN0Ll9nZXRTdGF0ZUlkZW50aWZpZXIoKSk7XG4gIGZvciAoY29uc3Qga2V5IGluIHBlbmRpbmcpIHtcbiAgICBjb25zdCB2YWwgPSBvYmplY3QuZ2V0KGtleSk7XG4gICAgaWYgKCF2YWwgfHwgIXZhbC5fdG9GdWxsSlNPTikge1xuICAgICAgdG9KU09OW2tleV0gPSB2YWw7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgdG9KU09OW2tleV0gPSB2YWwuX3RvRnVsbEpTT04oKTtcbiAgfVxuICAvLyBQcmVzZXJ2ZSBvcmlnaW5hbCBvYmplY3QncyBjbGFzc05hbWUgaWYgbm8gb3ZlcnJpZGUgY2xhc3NOYW1lIGlzIHByb3ZpZGVkXG4gIGlmIChjbGFzc05hbWUpIHtcbiAgICB0b0pTT04uY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICB9IGVsc2UgaWYgKG9iamVjdC5jbGFzc05hbWUgJiYgIXRvSlNPTi5jbGFzc05hbWUpIHtcbiAgICB0b0pTT04uY2xhc3NOYW1lID0gb2JqZWN0LmNsYXNzTmFtZTtcbiAgfVxuICByZXR1cm4gdG9KU09OO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0VHJpZ2dlcihjbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBhcHBsaWNhdGlvbklkKSB7XG4gIGlmICghYXBwbGljYXRpb25JZCkge1xuICAgIHRocm93ICdNaXNzaW5nIEFwcGxpY2F0aW9uSUQnO1xuICB9XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZX1gLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1blRyaWdnZXIodHJpZ2dlciwgbmFtZSwgcmVxdWVzdCwgYXV0aCkge1xuICBpZiAoIXRyaWdnZXIpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgYXdhaXQgbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgbmFtZSwgYXV0aCk7XG4gIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJldHVybiBhd2FpdCB0cmlnZ2VyKHJlcXVlc3QpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdHJpZ2dlckV4aXN0cyhjbGFzc05hbWU6IHN0cmluZywgdHlwZTogc3RyaW5nLCBhcHBsaWNhdGlvbklkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0eXBlLCBhcHBsaWNhdGlvbklkKSAhPSB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGdW5jdGlvbihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmV0dXJuIGdldChDYXRlZ29yeS5GdW5jdGlvbnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGdW5jdGlvbk5hbWVzKGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3Qgc3RvcmUgPVxuICAgIChfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdICYmIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF1bQ2F0ZWdvcnkuRnVuY3Rpb25zXSkgfHwge307XG4gIGNvbnN0IGZ1bmN0aW9uTmFtZXMgPSBbXTtcbiAgY29uc3QgZXh0cmFjdEZ1bmN0aW9uTmFtZXMgPSAobmFtZXNwYWNlLCBzdG9yZSkgPT4ge1xuICAgIE9iamVjdC5rZXlzKHN0b3JlKS5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgY29uc3QgdmFsdWUgPSBzdG9yZVtuYW1lXTtcbiAgICAgIGlmIChuYW1lc3BhY2UpIHtcbiAgICAgICAgbmFtZSA9IGAke25hbWVzcGFjZX0uJHtuYW1lfWA7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZXMucHVzaChuYW1lKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGV4dHJhY3RGdW5jdGlvbk5hbWVzKG5hbWUsIHZhbHVlKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcbiAgZXh0cmFjdEZ1bmN0aW9uTmFtZXMobnVsbCwgc3RvcmUpO1xuICByZXR1cm4gZnVuY3Rpb25OYW1lcztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEpvYihqb2JOYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuSm9icywgam9iTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRKb2JzKGFwcGxpY2F0aW9uSWQpIHtcbiAgdmFyIG1hbmFnZXIgPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdO1xuICBpZiAobWFuYWdlciAmJiBtYW5hZ2VyLkpvYnMpIHtcbiAgICByZXR1cm4gbWFuYWdlci5Kb2JzO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRWYWxpZGF0b3IoZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcXVlc3RPYmplY3QoXG4gIHRyaWdnZXJUeXBlLFxuICBhdXRoLFxuICBwYXJzZU9iamVjdCxcbiAgb3JpZ2luYWxQYXJzZU9iamVjdCxcbiAgY29uZmlnLFxuICBjb250ZXh0LFxuICBpc0dldFxuKSB7XG4gIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgdHJpZ2dlck5hbWU6IHRyaWdnZXJUeXBlLFxuICAgIG9iamVjdDogcGFyc2VPYmplY3QsXG4gICAgbWFzdGVyOiBmYWxzZSxcbiAgICBsb2c6IGNvbmZpZy5sb2dnZXJDb250cm9sbGVyLFxuICAgIGhlYWRlcnM6IGNvbmZpZy5oZWFkZXJzLFxuICAgIGlwOiBjb25maWcuaXAsXG4gICAgY29uZmlnLFxuICB9O1xuXG4gIGlmIChpc0dldCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmVxdWVzdC5pc0dldCA9ICEhaXNHZXQ7XG4gIH1cblxuICBpZiAob3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgIHJlcXVlc3Qub3JpZ2luYWwgPSBvcmlnaW5hbFBhcnNlT2JqZWN0O1xuICB9XG4gIGlmIChcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZSB8fFxuICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmUgfHxcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlRGVsZXRlIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyRGVsZXRlIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZUxvZ2luIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyTG9naW4gfHxcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJGaW5kXG4gICkge1xuICAgIC8vIFNldCBhIGNvcHkgb2YgdGhlIGNvbnRleHQgb24gdGhlIHJlcXVlc3Qgb2JqZWN0LlxuICAgIHJlcXVlc3QuY29udGV4dCA9IE9iamVjdC5hc3NpZ24oe30sIGNvbnRleHQpO1xuICB9XG5cbiAgaWYgKCFhdXRoKSB7XG4gICAgcmV0dXJuIHJlcXVlc3Q7XG4gIH1cbiAgaWYgKGF1dGguaXNNYXN0ZXIpIHtcbiAgICByZXF1ZXN0WydtYXN0ZXInXSA9IHRydWU7XG4gIH1cbiAgaWYgKGF1dGgudXNlcikge1xuICAgIHJlcXVlc3RbJ3VzZXInXSA9IGF1dGgudXNlcjtcbiAgfVxuICBpZiAoYXV0aC5pbnN0YWxsYXRpb25JZCkge1xuICAgIHJlcXVlc3RbJ2luc3RhbGxhdGlvbklkJ10gPSBhdXRoLmluc3RhbGxhdGlvbklkO1xuICB9XG4gIHJldHVybiByZXF1ZXN0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVxdWVzdFF1ZXJ5T2JqZWN0KHRyaWdnZXJUeXBlLCBhdXRoLCBxdWVyeSwgY291bnQsIGNvbmZpZywgY29udGV4dCwgaXNHZXQpIHtcbiAgaXNHZXQgPSAhIWlzR2V0O1xuXG4gIHZhciByZXF1ZXN0ID0ge1xuICAgIHRyaWdnZXJOYW1lOiB0cmlnZ2VyVHlwZSxcbiAgICBxdWVyeSxcbiAgICBtYXN0ZXI6IGZhbHNlLFxuICAgIGNvdW50LFxuICAgIGxvZzogY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIsXG4gICAgaXNHZXQsXG4gICAgaGVhZGVyczogY29uZmlnLmhlYWRlcnMsXG4gICAgaXA6IGNvbmZpZy5pcCxcbiAgICBjb250ZXh0OiBjb250ZXh0IHx8IHt9LFxuICAgIGNvbmZpZyxcbiAgfTtcblxuICBpZiAoIWF1dGgpIHtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoYXV0aC5pc01hc3Rlcikge1xuICAgIHJlcXVlc3RbJ21hc3RlciddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC51c2VyKSB7XG4gICAgcmVxdWVzdFsndXNlciddID0gYXV0aC51c2VyO1xuICB9XG4gIGlmIChhdXRoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgcmVxdWVzdFsnaW5zdGFsbGF0aW9uSWQnXSA9IGF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbi8vIENyZWF0ZXMgdGhlIHJlc3BvbnNlIG9iamVjdCwgYW5kIHVzZXMgdGhlIHJlcXVlc3Qgb2JqZWN0IHRvIHBhc3MgZGF0YVxuLy8gVGhlIEFQSSB3aWxsIGNhbGwgdGhpcyB3aXRoIFJFU1QgQVBJIGZvcm1hdHRlZCBvYmplY3RzLCB0aGlzIHdpbGxcbi8vIHRyYW5zZm9ybSB0aGVtIHRvIFBhcnNlLk9iamVjdCBpbnN0YW5jZXMgZXhwZWN0ZWQgYnkgQ2xvdWQgQ29kZS5cbi8vIEFueSBjaGFuZ2VzIG1hZGUgdG8gdGhlIG9iamVjdCBpbiBhIGJlZm9yZVNhdmUgd2lsbCBiZSBpbmNsdWRlZC5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXNwb25zZU9iamVjdChyZXF1ZXN0LCByZXNvbHZlLCByZWplY3QpIHtcbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiBmdW5jdGlvbiAocmVzcG9uc2UpIHtcbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5hZnRlckZpbmQpIHtcbiAgICAgICAgaWYgKCFyZXNwb25zZSkge1xuICAgICAgICAgIHJlc3BvbnNlID0gcmVxdWVzdC5vYmplY3RzO1xuICAgICAgICB9XG4gICAgICAgIHJlc3BvbnNlID0gcmVzcG9uc2UubWFwKG9iamVjdCA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRvSlNPTndpdGhPYmplY3RzKG9iamVjdCk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICB9XG4gICAgICAvLyBVc2UgdGhlIEpTT04gcmVzcG9uc2VcbiAgICAgIGlmIChcbiAgICAgICAgcmVzcG9uc2UgJiZcbiAgICAgICAgdHlwZW9mIHJlc3BvbnNlID09PSAnb2JqZWN0JyAmJlxuICAgICAgICAhcmVxdWVzdC5vYmplY3QuZXF1YWxzKHJlc3BvbnNlKSAmJlxuICAgICAgICByZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5iZWZvcmVTYXZlXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgICAgfVxuICAgICAgaWYgKHJlc3BvbnNlICYmIHR5cGVvZiByZXNwb25zZSA9PT0gJ29iamVjdCcgJiYgcmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlKSB7XG4gICAgICAgIHJldHVybiByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5hZnRlclNhdmUpIHtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUoKTtcbiAgICAgIH1cbiAgICAgIHJlc3BvbnNlID0ge307XG4gICAgICBpZiAocmVxdWVzdC50cmlnZ2VyTmFtZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZSkge1xuICAgICAgICByZXNwb25zZVsnb2JqZWN0J10gPSByZXF1ZXN0Lm9iamVjdC5fZ2V0U2F2ZUpTT04oKTtcbiAgICAgICAgcmVzcG9uc2VbJ29iamVjdCddWydvYmplY3RJZCddID0gcmVxdWVzdC5vYmplY3QuaWQ7XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgfSxcbiAgICBlcnJvcjogZnVuY3Rpb24gKGVycm9yKSB7XG4gICAgICBjb25zdCBlID0gcmVzb2x2ZUVycm9yKGVycm9yLCB7XG4gICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsXG4gICAgICAgIG1lc3NhZ2U6ICdTY3JpcHQgZmFpbGVkLiBVbmtub3duIGVycm9yLicsXG4gICAgICB9KTtcbiAgICAgIHJlamVjdChlKTtcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiB1c2VySWRGb3JMb2coYXV0aCkge1xuICByZXR1cm4gYXV0aCAmJiBhdXRoLnVzZXIgPyBhdXRoLnVzZXIuaWQgOiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGxvZ1RyaWdnZXJBZnRlckhvb2sodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgaW5wdXQsIGF1dGgsIGxvZ0xldmVsKSB7XG4gIGlmIChsb2dMZXZlbCA9PT0gJ3NpbGVudCcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgY2xlYW5JbnB1dCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoaW5wdXQpKTtcbiAgbG9nZ2VyW2xvZ0xldmVsXShcbiAgICBgJHt0cmlnZ2VyVHlwZX0gdHJpZ2dlcmVkIGZvciAke2NsYXNzTmFtZX0gZm9yIHVzZXIgJHt1c2VySWRGb3JMb2coXG4gICAgICBhdXRoXG4gICAgKX06XFxuICBJbnB1dDogJHtjbGVhbklucHV0fWAsXG4gICAge1xuICAgICAgY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICB1c2VyOiB1c2VySWRGb3JMb2coYXV0aCksXG4gICAgfVxuICApO1xufVxuXG5mdW5jdGlvbiBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2sodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgaW5wdXQsIHJlc3VsdCwgYXV0aCwgbG9nTGV2ZWwpIHtcbiAgaWYgKGxvZ0xldmVsID09PSAnc2lsZW50Jykge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBjbGVhbklucHV0ID0gbG9nZ2VyLnRydW5jYXRlTG9nTWVzc2FnZShKU09OLnN0cmluZ2lmeShpbnB1dCkpO1xuICBjb25zdCBjbGVhblJlc3VsdCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkocmVzdWx0KSk7XG4gIGxvZ2dlcltsb2dMZXZlbF0oXG4gICAgYCR7dHJpZ2dlclR5cGV9IHRyaWdnZXJlZCBmb3IgJHtjbGFzc05hbWV9IGZvciB1c2VyICR7dXNlcklkRm9yTG9nKFxuICAgICAgYXV0aFxuICAgICl9OlxcbiAgSW5wdXQ6ICR7Y2xlYW5JbnB1dH1cXG4gIFJlc3VsdDogJHtjbGVhblJlc3VsdH1gLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpLFxuICAgIH1cbiAgKTtcbn1cblxuZnVuY3Rpb24gbG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBpbnB1dCwgYXV0aCwgZXJyb3IsIGxvZ0xldmVsKSB7XG4gIGlmIChsb2dMZXZlbCA9PT0gJ3NpbGVudCcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgY2xlYW5JbnB1dCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoaW5wdXQpKTtcbiAgbG9nZ2VyW2xvZ0xldmVsXShcbiAgICBgJHt0cmlnZ2VyVHlwZX0gZmFpbGVkIGZvciAke2NsYXNzTmFtZX0gZm9yIHVzZXIgJHt1c2VySWRGb3JMb2coXG4gICAgICBhdXRoXG4gICAgKX06XFxuICBJbnB1dDogJHtjbGVhbklucHV0fVxcbiAgRXJyb3I6ICR7SlNPTi5zdHJpbmdpZnkoZXJyb3IpfWAsXG4gICAge1xuICAgICAgY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBlcnJvcixcbiAgICAgIHVzZXI6IHVzZXJJZEZvckxvZyhhdXRoKSxcbiAgICB9XG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIoXG4gIHRyaWdnZXJUeXBlLFxuICBhdXRoLFxuICBjbGFzc05hbWVRdWVyeSxcbiAgb2JqZWN0c0lucHV0LFxuICBjb25maWcsXG4gIHF1ZXJ5LFxuICBjb250ZXh0LFxuICBpc0dldFxuKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lUXVlcnksIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG5cbiAgICBpZiAoIXRyaWdnZXIpIHtcbiAgICAgIGlmIChvYmplY3RzSW5wdXQgJiYgb2JqZWN0c0lucHV0Lmxlbmd0aCA+IDAgJiYgb2JqZWN0c0lucHV0WzBdIGluc3RhbmNlb2YgUGFyc2UuT2JqZWN0KSB7XG4gICAgICAgIHJldHVybiByZXNvbHZlKG9iamVjdHNJbnB1dC5tYXAob2JqID0+IHRvSlNPTndpdGhPYmplY3RzKG9iaikpKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXNvbHZlKG9iamVjdHNJbnB1dCB8fCBbXSk7XG4gICAgfVxuXG4gICAgY29uc3QgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIG51bGwsIG51bGwsIGNvbmZpZywgY29udGV4dCwgaXNHZXQpO1xuICAgIC8vIENvbnZlcnQgcXVlcnkgcGFyYW1ldGVyIHRvIFBhcnNlLlF1ZXJ5IGluc3RhbmNlXG4gICAgaWYgKHF1ZXJ5IGluc3RhbmNlb2YgUGFyc2UuUXVlcnkpIHtcbiAgICAgIHJlcXVlc3QucXVlcnkgPSBxdWVyeTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBxdWVyeSA9PT0gJ29iamVjdCcgJiYgcXVlcnkgIT09IG51bGwpIHtcbiAgICAgIGNvbnN0IHBhcnNlUXVlcnlJbnN0YW5jZSA9IG5ldyBQYXJzZS5RdWVyeShjbGFzc05hbWVRdWVyeSk7XG4gICAgICBpZiAocXVlcnkud2hlcmUpIHtcbiAgICAgICAgcGFyc2VRdWVyeUluc3RhbmNlLndpdGhKU09OKHF1ZXJ5KTtcbiAgICAgIH1cbiAgICAgIHJlcXVlc3QucXVlcnkgPSBwYXJzZVF1ZXJ5SW5zdGFuY2U7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlcXVlc3QucXVlcnkgPSBuZXcgUGFyc2UuUXVlcnkoY2xhc3NOYW1lUXVlcnkpO1xuICAgIH1cblxuICAgIGNvbnN0IHsgc3VjY2VzcywgZXJyb3IgfSA9IGdldFJlc3BvbnNlT2JqZWN0KFxuICAgICAgcmVxdWVzdCxcbiAgICAgIHByb2Nlc3NlZE9iamVjdHNKU09OID0+IHtcbiAgICAgICAgcmVzb2x2ZShwcm9jZXNzZWRPYmplY3RzSlNPTik7XG4gICAgICB9LFxuICAgICAgZXJyb3JEYXRhID0+IHtcbiAgICAgICAgcmVqZWN0KGVycm9yRGF0YSk7XG4gICAgICB9XG4gICAgKTtcbiAgICBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2soXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGNsYXNzTmFtZVF1ZXJ5LFxuICAgICAgJ0FmdGVyRmluZCBJbnB1dCAoUHJlLVRyYW5zZm9ybSknLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoXG4gICAgICAgIG9iamVjdHNJbnB1dC5tYXAobyA9PiAobyBpbnN0YW5jZW9mIFBhcnNlLk9iamVjdCA/IG8uaWQgKyAnOicgKyBvLmNsYXNzTmFtZSA6IG8pKVxuICAgICAgKSxcbiAgICAgIGF1dGgsXG4gICAgICBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJCZWZvcmVTdWNjZXNzXG4gICAgKTtcblxuICAgIC8vIENvbnZlcnQgcGxhaW4gb2JqZWN0cyB0byBQYXJzZS5PYmplY3QgaW5zdGFuY2VzIGZvciB0cmlnZ2VyXG4gICAgcmVxdWVzdC5vYmplY3RzID0gb2JqZWN0c0lucHV0Lm1hcChjdXJyZW50T2JqZWN0ID0+IHtcbiAgICAgIGlmIChjdXJyZW50T2JqZWN0IGluc3RhbmNlb2YgUGFyc2UuT2JqZWN0KSB7XG4gICAgICAgIHJldHVybiBjdXJyZW50T2JqZWN0O1xuICAgICAgfVxuICAgICAgLy8gUHJlc2VydmUgdGhlIG9yaWdpbmFsIGNsYXNzTmFtZSBpZiBpdCBleGlzdHMsIG90aGVyd2lzZSB1c2UgdGhlIHF1ZXJ5IGNsYXNzTmFtZVxuICAgICAgY29uc3Qgb3JpZ2luYWxDbGFzc05hbWUgPSBjdXJyZW50T2JqZWN0LmNsYXNzTmFtZSB8fCBjbGFzc05hbWVRdWVyeTtcbiAgICAgIGNvbnN0IHRlbXBPYmplY3RXaXRoQ2xhc3NOYW1lID0geyAuLi5jdXJyZW50T2JqZWN0LCBjbGFzc05hbWU6IG9yaWdpbmFsQ2xhc3NOYW1lIH07XG4gICAgICByZXR1cm4gUGFyc2UuT2JqZWN0LmZyb21KU09OKHRlbXBPYmplY3RXaXRoQ2xhc3NOYW1lKTtcbiAgICB9KTtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZVF1ZXJ5fWAsIGF1dGgpO1xuICAgICAgfSlcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgaWYgKHJlcXVlc3Quc2tpcFdpdGhNYXN0ZXJLZXkpIHtcbiAgICAgICAgICByZXR1cm4gcmVxdWVzdC5vYmplY3RzO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlc3BvbnNlRnJvbVRyaWdnZXIgPSB0cmlnZ2VyKHJlcXVlc3QpO1xuICAgICAgICBpZiAocmVzcG9uc2VGcm9tVHJpZ2dlciAmJiB0eXBlb2YgcmVzcG9uc2VGcm9tVHJpZ2dlci50aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgcmV0dXJuIHJlc3BvbnNlRnJvbVRyaWdnZXIudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHRzO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXNwb25zZUZyb21UcmlnZ2VyO1xuICAgICAgfSlcbiAgICAgIC50aGVuKHN1Y2Nlc3MsIGVycm9yKTtcbiAgfSkudGhlbihyZXN1bHRzQXNKU09OID0+IHtcbiAgICBsb2dUcmlnZ2VyQWZ0ZXJIb29rKFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBjbGFzc05hbWVRdWVyeSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHJlc3VsdHNBc0pTT04pLFxuICAgICAgYXV0aCxcbiAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckFmdGVyXG4gICAgKTtcbiAgICByZXR1cm4gcmVzdWx0c0FzSlNPTjtcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1blF1ZXJ5VHJpZ2dlcihcbiAgdHJpZ2dlclR5cGUsXG4gIGNsYXNzTmFtZSxcbiAgcmVzdFdoZXJlLFxuICByZXN0T3B0aW9ucyxcbiAgY29uZmlnLFxuICBhdXRoLFxuICBjb250ZXh0LFxuICBpc0dldFxuKSB7XG4gIGNvbnN0IHRyaWdnZXIgPSBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIGNvbmZpZy5hcHBsaWNhdGlvbklkKTtcbiAgaWYgKCF0cmlnZ2VyKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7XG4gICAgICByZXN0V2hlcmUsXG4gICAgICByZXN0T3B0aW9ucyxcbiAgICB9KTtcbiAgfVxuICBjb25zdCBqc29uID0gT2JqZWN0LmFzc2lnbih7fSwgcmVzdE9wdGlvbnMpO1xuICBqc29uLndoZXJlID0gcmVzdFdoZXJlO1xuXG4gIGNvbnN0IHBhcnNlUXVlcnkgPSBuZXcgUGFyc2UuUXVlcnkoY2xhc3NOYW1lKTtcbiAgcGFyc2VRdWVyeS53aXRoSlNPTihqc29uKTtcblxuICBsZXQgY291bnQgPSBmYWxzZTtcbiAgaWYgKHJlc3RPcHRpb25zKSB7XG4gICAgY291bnQgPSAhIXJlc3RPcHRpb25zLmNvdW50O1xuICB9XG4gIGNvbnN0IHJlcXVlc3RPYmplY3QgPSBnZXRSZXF1ZXN0UXVlcnlPYmplY3QoXG4gICAgdHJpZ2dlclR5cGUsXG4gICAgYXV0aCxcbiAgICBwYXJzZVF1ZXJ5LFxuICAgIGNvdW50LFxuICAgIGNvbmZpZyxcbiAgICBjb250ZXh0LFxuICAgIGlzR2V0XG4gICk7XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0T2JqZWN0LCBgJHt0cmlnZ2VyVHlwZX0uJHtjbGFzc05hbWV9YCwgYXV0aCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICBpZiAocmVxdWVzdE9iamVjdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgICAgICByZXR1cm4gcmVxdWVzdE9iamVjdC5xdWVyeTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0cmlnZ2VyKHJlcXVlc3RPYmplY3QpO1xuICAgIH0pXG4gICAgLnRoZW4oXG4gICAgICByZXN1bHQgPT4ge1xuICAgICAgICBsZXQgcXVlcnlSZXN1bHQgPSBwYXJzZVF1ZXJ5O1xuICAgICAgICBpZiAocmVzdWx0ICYmIHJlc3VsdCBpbnN0YW5jZW9mIFBhcnNlLlF1ZXJ5KSB7XG4gICAgICAgICAgcXVlcnlSZXN1bHQgPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QganNvblF1ZXJ5ID0gcXVlcnlSZXN1bHQudG9KU09OKCk7XG4gICAgICAgIGlmIChqc29uUXVlcnkud2hlcmUpIHtcbiAgICAgICAgICByZXN0V2hlcmUgPSBqc29uUXVlcnkud2hlcmU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5saW1pdCkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMubGltaXQgPSBqc29uUXVlcnkubGltaXQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5za2lwKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5za2lwID0ganNvblF1ZXJ5LnNraXA7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5pbmNsdWRlKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5pbmNsdWRlID0ganNvblF1ZXJ5LmluY2x1ZGU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5leGNsdWRlS2V5cykge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuZXhjbHVkZUtleXMgPSBqc29uUXVlcnkuZXhjbHVkZUtleXM7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5leHBsYWluKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5leHBsYWluID0ganNvblF1ZXJ5LmV4cGxhaW47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5rZXlzKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5rZXlzID0ganNvblF1ZXJ5LmtleXM7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5vcmRlcikge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMub3JkZXIgPSBqc29uUXVlcnkub3JkZXI7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5oaW50KSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5oaW50ID0ganNvblF1ZXJ5LmhpbnQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGpzb25RdWVyeS5jb21tZW50KSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5jb21tZW50ID0ganNvblF1ZXJ5LmNvbW1lbnQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcXVlc3RPYmplY3QucmVhZFByZWZlcmVuY2UpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gcmVxdWVzdE9iamVjdC5yZWFkUHJlZmVyZW5jZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxdWVzdE9iamVjdC5pbmNsdWRlUmVhZFByZWZlcmVuY2UpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZSA9IHJlcXVlc3RPYmplY3QuaW5jbHVkZVJlYWRQcmVmZXJlbmNlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXF1ZXN0T2JqZWN0LnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UgPSByZXF1ZXN0T2JqZWN0LnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gICAgICAgIH1cbiAgICAgICAgbGV0IG9iamVjdHMgPSB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChyZXN1bHQgaW5zdGFuY2VvZiBQYXJzZS5PYmplY3QpIHtcbiAgICAgICAgICBvYmplY3RzID0gW3Jlc3VsdF07XG4gICAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgICAgQXJyYXkuaXNBcnJheShyZXN1bHQpICYmXG4gICAgICAgICAgKCFyZXN1bHQubGVuZ3RoIHx8IHJlc3VsdC5ldmVyeShvYmogPT4gb2JqIGluc3RhbmNlb2YgUGFyc2UuT2JqZWN0KSlcbiAgICAgICAgKSB7XG4gICAgICAgICAgb2JqZWN0cyA9IHJlc3VsdDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHJlc3RXaGVyZSxcbiAgICAgICAgICByZXN0T3B0aW9ucyxcbiAgICAgICAgICBvYmplY3RzLFxuICAgICAgICB9O1xuICAgICAgfSxcbiAgICAgIGVyciA9PiB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gcmVzb2x2ZUVycm9yKGVyciwge1xuICAgICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsXG4gICAgICAgICAgbWVzc2FnZTogJ1NjcmlwdCBmYWlsZWQuIFVua25vd24gZXJyb3IuJyxcbiAgICAgICAgfSk7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlRXJyb3IobWVzc2FnZSwgZGVmYXVsdE9wdHMpIHtcbiAgaWYgKCFkZWZhdWx0T3B0cykge1xuICAgIGRlZmF1bHRPcHRzID0ge307XG4gIH1cbiAgaWYgKCFtZXNzYWdlKSB7XG4gICAgcmV0dXJuIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIGRlZmF1bHRPcHRzLmNvZGUgfHwgUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCxcbiAgICAgIGRlZmF1bHRPcHRzLm1lc3NhZ2UgfHwgJ1NjcmlwdCBmYWlsZWQuJ1xuICAgICk7XG4gIH1cbiAgaWYgKG1lc3NhZ2UgaW5zdGFuY2VvZiBQYXJzZS5FcnJvcikge1xuICAgIHJldHVybiBtZXNzYWdlO1xuICB9XG5cbiAgY29uc3QgY29kZSA9IGRlZmF1bHRPcHRzLmNvZGUgfHwgUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRDtcbiAgLy8gSWYgaXQncyBhbiBlcnJvciwgbWFyayBpdCBhcyBhIHNjcmlwdCBmYWlsZWRcbiAgaWYgKHR5cGVvZiBtZXNzYWdlID09PSAnc3RyaW5nJykge1xuICAgIHJldHVybiBuZXcgUGFyc2UuRXJyb3IoY29kZSwgbWVzc2FnZSk7XG4gIH1cbiAgY29uc3QgZXJyb3IgPSBuZXcgUGFyc2UuRXJyb3IoY29kZSwgbWVzc2FnZS5tZXNzYWdlIHx8IG1lc3NhZ2UpO1xuICBpZiAobWVzc2FnZSBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgZXJyb3Iuc3RhY2sgPSBtZXNzYWdlLnN0YWNrO1xuICB9XG4gIHJldHVybiBlcnJvcjtcbn1cbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBmdW5jdGlvbk5hbWUsIGF1dGgpIHtcbiAgY29uc3QgdGhlVmFsaWRhdG9yID0gZ2V0VmFsaWRhdG9yKGZ1bmN0aW9uTmFtZSwgUGFyc2UuYXBwbGljYXRpb25JZCk7XG4gIGlmICghdGhlVmFsaWRhdG9yKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0eXBlb2YgdGhlVmFsaWRhdG9yID09PSAnb2JqZWN0JyAmJiB0aGVWYWxpZGF0b3Iuc2tpcFdpdGhNYXN0ZXJLZXkgJiYgcmVxdWVzdC5tYXN0ZXIpIHtcbiAgICByZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5ID0gdHJ1ZTtcbiAgfVxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gdHlwZW9mIHRoZVZhbGlkYXRvciA9PT0gJ29iamVjdCdcbiAgICAgICAgICA/IGJ1aWx0SW5UcmlnZ2VyVmFsaWRhdG9yKHRoZVZhbGlkYXRvciwgcmVxdWVzdCwgYXV0aClcbiAgICAgICAgICA6IHRoZVZhbGlkYXRvcihyZXF1ZXN0KTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZSA9PiB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gcmVzb2x2ZUVycm9yKGUsIHtcbiAgICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgIG1lc3NhZ2U6ICdWYWxpZGF0aW9uIGZhaWxlZC4nLFxuICAgICAgICB9KTtcbiAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgIH0pO1xuICB9KTtcbn1cbmFzeW5jIGZ1bmN0aW9uIGJ1aWx0SW5UcmlnZ2VyVmFsaWRhdG9yKG9wdGlvbnMsIHJlcXVlc3QsIGF1dGgpIHtcbiAgaWYgKHJlcXVlc3QubWFzdGVyICYmICFvcHRpb25zLnZhbGlkYXRlTWFzdGVyS2V5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGxldCByZXFVc2VyID0gcmVxdWVzdC51c2VyO1xuICBpZiAoXG4gICAgIXJlcVVzZXIgJiZcbiAgICByZXF1ZXN0Lm9iamVjdCAmJlxuICAgIHJlcXVlc3Qub2JqZWN0LmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJlxuICAgICFyZXF1ZXN0Lm9iamVjdC5leGlzdGVkKClcbiAgKSB7XG4gICAgcmVxVXNlciA9IHJlcXVlc3Qub2JqZWN0O1xuICB9XG4gIGlmIChcbiAgICAob3B0aW9ucy5yZXF1aXJlVXNlciB8fCBvcHRpb25zLnJlcXVpcmVBbnlVc2VyUm9sZXMgfHwgb3B0aW9ucy5yZXF1aXJlQWxsVXNlclJvbGVzKSAmJlxuICAgICFyZXFVc2VyXG4gICkge1xuICAgIHRocm93ICdWYWxpZGF0aW9uIGZhaWxlZC4gUGxlYXNlIGxvZ2luIHRvIGNvbnRpbnVlLic7XG4gIH1cbiAgaWYgKG9wdGlvbnMucmVxdWlyZU1hc3RlciAmJiAhcmVxdWVzdC5tYXN0ZXIpIHtcbiAgICB0aHJvdyAnVmFsaWRhdGlvbiBmYWlsZWQuIE1hc3RlciBrZXkgaXMgcmVxdWlyZWQgdG8gY29tcGxldGUgdGhpcyByZXF1ZXN0Lic7XG4gIH1cbiAgbGV0IHBhcmFtcyA9IHJlcXVlc3QucGFyYW1zIHx8IHt9O1xuICBpZiAocmVxdWVzdC5vYmplY3QpIHtcbiAgICBwYXJhbXMgPSByZXF1ZXN0Lm9iamVjdC50b0pTT04oKTtcbiAgfVxuICBjb25zdCByZXF1aXJlZFBhcmFtID0ga2V5ID0+IHtcbiAgICBjb25zdCB2YWx1ZSA9IHBhcmFtc1trZXldO1xuICAgIGlmICh2YWx1ZSA9PSBudWxsKSB7XG4gICAgICB0aHJvdyBgVmFsaWRhdGlvbiBmYWlsZWQuIFBsZWFzZSBzcGVjaWZ5IGRhdGEgZm9yICR7a2V5fS5gO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCB2YWxpZGF0ZU9wdGlvbnMgPSBhc3luYyAob3B0LCBrZXksIHZhbCkgPT4ge1xuICAgIGxldCBvcHRzID0gb3B0Lm9wdGlvbnM7XG4gICAgaWYgKHR5cGVvZiBvcHRzID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBvcHRzKHZhbCk7XG4gICAgICAgIGlmICghcmVzdWx0ICYmIHJlc3VsdCAhPSBudWxsKSB7XG4gICAgICAgICAgdGhyb3cgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB2YWx1ZSBmb3IgJHtrZXl9LmA7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKCFlKSB7XG4gICAgICAgICAgdGhyb3cgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB2YWx1ZSBmb3IgJHtrZXl9LmA7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBvcHQuZXJyb3IgfHwgZS5tZXNzYWdlIHx8IGU7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghQXJyYXkuaXNBcnJheShvcHRzKSkge1xuICAgICAgb3B0cyA9IFtvcHQub3B0aW9uc107XG4gICAgfVxuXG4gICAgaWYgKCFvcHRzLmluY2x1ZGVzKHZhbCkpIHtcbiAgICAgIHRocm93IChcbiAgICAgICAgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCBvcHRpb24gZm9yICR7a2V5fS4gRXhwZWN0ZWQ6ICR7b3B0cy5qb2luKCcsICcpfWBcbiAgICAgICk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGdldFR5cGUgPSBmbiA9PiB7XG4gICAgY29uc3QgbWF0Y2ggPSBmbiAmJiBmbi50b1N0cmluZygpLm1hdGNoKC9eXFxzKmZ1bmN0aW9uIChcXHcrKS8pO1xuICAgIHJldHVybiAobWF0Y2ggPyBtYXRjaFsxXSA6ICcnKS50b0xvd2VyQ2FzZSgpO1xuICB9O1xuICBpZiAoQXJyYXkuaXNBcnJheShvcHRpb25zLmZpZWxkcykpIHtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBvcHRpb25zLmZpZWxkcykge1xuICAgICAgcmVxdWlyZWRQYXJhbShrZXkpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBjb25zdCBvcHRpb25Qcm9taXNlcyA9IFtdO1xuICAgIGZvciAoY29uc3Qga2V5IGluIG9wdGlvbnMuZmllbGRzKSB7XG4gICAgICBjb25zdCBvcHQgPSBvcHRpb25zLmZpZWxkc1trZXldO1xuICAgICAgbGV0IHZhbCA9IHBhcmFtc1trZXldO1xuICAgICAgaWYgKHR5cGVvZiBvcHQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHJlcXVpcmVkUGFyYW0ob3B0KTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2Ygb3B0ID09PSAnb2JqZWN0Jykge1xuICAgICAgICBpZiAob3B0LmRlZmF1bHQgIT0gbnVsbCAmJiB2YWwgPT0gbnVsbCkge1xuICAgICAgICAgIHZhbCA9IG9wdC5kZWZhdWx0O1xuICAgICAgICAgIHBhcmFtc1trZXldID0gdmFsO1xuICAgICAgICAgIGlmIChyZXF1ZXN0Lm9iamVjdCkge1xuICAgICAgICAgICAgcmVxdWVzdC5vYmplY3Quc2V0KGtleSwgdmFsKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdC5jb25zdGFudCAmJiByZXF1ZXN0Lm9iamVjdCkge1xuICAgICAgICAgIGlmIChyZXF1ZXN0Lm9yaWdpbmFsKSB7XG4gICAgICAgICAgICByZXF1ZXN0Lm9iamVjdC5yZXZlcnQoa2V5KTtcbiAgICAgICAgICB9IGVsc2UgaWYgKG9wdC5kZWZhdWx0ICE9IG51bGwpIHtcbiAgICAgICAgICAgIHJlcXVlc3Qub2JqZWN0LnNldChrZXksIG9wdC5kZWZhdWx0KTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdC5yZXF1aXJlZCkge1xuICAgICAgICAgIHJlcXVpcmVkUGFyYW0oa2V5KTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBvcHRpb25hbCA9ICFvcHQucmVxdWlyZWQgJiYgdmFsID09PSB1bmRlZmluZWQ7XG4gICAgICAgIGlmICghb3B0aW9uYWwpIHtcbiAgICAgICAgICBpZiAob3B0LnR5cGUpIHtcbiAgICAgICAgICAgIGNvbnN0IHR5cGUgPSBnZXRUeXBlKG9wdC50eXBlKTtcbiAgICAgICAgICAgIGNvbnN0IHZhbFR5cGUgPSBBcnJheS5pc0FycmF5KHZhbCkgPyAnYXJyYXknIDogdHlwZW9mIHZhbDtcbiAgICAgICAgICAgIGlmICh2YWxUeXBlICE9PSB0eXBlKSB7XG4gICAgICAgICAgICAgIHRocm93IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB0eXBlIGZvciAke2tleX0uIEV4cGVjdGVkOiAke3R5cGV9YDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKG9wdC5vcHRpb25zKSB7XG4gICAgICAgICAgICBvcHRpb25Qcm9taXNlcy5wdXNoKHZhbGlkYXRlT3B0aW9ucyhvcHQsIGtleSwgdmFsKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGF3YWl0IFByb21pc2UuYWxsKG9wdGlvblByb21pc2VzKTtcbiAgfVxuICBsZXQgdXNlclJvbGVzID0gb3B0aW9ucy5yZXF1aXJlQW55VXNlclJvbGVzO1xuICBsZXQgcmVxdWlyZUFsbFJvbGVzID0gb3B0aW9ucy5yZXF1aXJlQWxsVXNlclJvbGVzO1xuICBjb25zdCBwcm9taXNlcyA9IFtQcm9taXNlLnJlc29sdmUoKSwgUHJvbWlzZS5yZXNvbHZlKCksIFByb21pc2UucmVzb2x2ZSgpXTtcbiAgaWYgKHVzZXJSb2xlcyB8fCByZXF1aXJlQWxsUm9sZXMpIHtcbiAgICBwcm9taXNlc1swXSA9IGF1dGguZ2V0VXNlclJvbGVzKCk7XG4gIH1cbiAgaWYgKHR5cGVvZiB1c2VyUm9sZXMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBwcm9taXNlc1sxXSA9IHVzZXJSb2xlcygpO1xuICB9XG4gIGlmICh0eXBlb2YgcmVxdWlyZUFsbFJvbGVzID09PSAnZnVuY3Rpb24nKSB7XG4gICAgcHJvbWlzZXNbMl0gPSByZXF1aXJlQWxsUm9sZXMoKTtcbiAgfVxuICBjb25zdCBbcm9sZXMsIHJlc29sdmVkVXNlclJvbGVzLCByZXNvbHZlZFJlcXVpcmVBbGxdID0gYXdhaXQgUHJvbWlzZS5hbGwocHJvbWlzZXMpO1xuICBpZiAocmVzb2x2ZWRVc2VyUm9sZXMgJiYgQXJyYXkuaXNBcnJheShyZXNvbHZlZFVzZXJSb2xlcykpIHtcbiAgICB1c2VyUm9sZXMgPSByZXNvbHZlZFVzZXJSb2xlcztcbiAgfVxuICBpZiAocmVzb2x2ZWRSZXF1aXJlQWxsICYmIEFycmF5LmlzQXJyYXkocmVzb2x2ZWRSZXF1aXJlQWxsKSkge1xuICAgIHJlcXVpcmVBbGxSb2xlcyA9IHJlc29sdmVkUmVxdWlyZUFsbDtcbiAgfVxuICBpZiAodXNlclJvbGVzKSB7XG4gICAgY29uc3QgaGFzUm9sZSA9IHVzZXJSb2xlcy5zb21lKHJlcXVpcmVkUm9sZSA9PiByb2xlcy5pbmNsdWRlcyhgcm9sZToke3JlcXVpcmVkUm9sZX1gKSk7XG4gICAgaWYgKCFoYXNSb2xlKSB7XG4gICAgICB0aHJvdyBgVmFsaWRhdGlvbiBmYWlsZWQuIFVzZXIgZG9lcyBub3QgbWF0Y2ggdGhlIHJlcXVpcmVkIHJvbGVzLmA7XG4gICAgfVxuICB9XG4gIGlmIChyZXF1aXJlQWxsUm9sZXMpIHtcbiAgICBmb3IgKGNvbnN0IHJlcXVpcmVkUm9sZSBvZiByZXF1aXJlQWxsUm9sZXMpIHtcbiAgICAgIGlmICghcm9sZXMuaW5jbHVkZXMoYHJvbGU6JHtyZXF1aXJlZFJvbGV9YCkpIHtcbiAgICAgICAgdGhyb3cgYFZhbGlkYXRpb24gZmFpbGVkLiBVc2VyIGRvZXMgbm90IG1hdGNoIGFsbCB0aGUgcmVxdWlyZWQgcm9sZXMuYDtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgY29uc3QgdXNlcktleXMgPSBvcHRpb25zLnJlcXVpcmVVc2VyS2V5cyB8fCBbXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkodXNlcktleXMpKSB7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgdXNlcktleXMpIHtcbiAgICAgIGlmICghcmVxVXNlcikge1xuICAgICAgICB0aHJvdyAnUGxlYXNlIGxvZ2luIHRvIG1ha2UgdGhpcyByZXF1ZXN0Lic7XG4gICAgICB9XG5cbiAgICAgIGlmIChyZXFVc2VyLmdldChrZXkpID09IG51bGwpIHtcbiAgICAgICAgdGhyb3cgYFZhbGlkYXRpb24gZmFpbGVkLiBQbGVhc2Ugc2V0IGRhdGEgZm9yICR7a2V5fSBvbiB5b3VyIGFjY291bnQuYDtcbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSBpZiAodHlwZW9mIHVzZXJLZXlzID09PSAnb2JqZWN0Jykge1xuICAgIGNvbnN0IG9wdGlvblByb21pc2VzID0gW107XG4gICAgZm9yIChjb25zdCBrZXkgaW4gb3B0aW9ucy5yZXF1aXJlVXNlcktleXMpIHtcbiAgICAgIGNvbnN0IG9wdCA9IG9wdGlvbnMucmVxdWlyZVVzZXJLZXlzW2tleV07XG4gICAgICBpZiAob3B0Lm9wdGlvbnMpIHtcbiAgICAgICAgb3B0aW9uUHJvbWlzZXMucHVzaCh2YWxpZGF0ZU9wdGlvbnMob3B0LCBrZXksIHJlcVVzZXIuZ2V0KGtleSkpKTtcbiAgICAgIH1cbiAgICB9XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwob3B0aW9uUHJvbWlzZXMpO1xuICB9XG59XG5cbi8vIFRvIGJlIHVzZWQgYXMgcGFydCBvZiB0aGUgcHJvbWlzZSBjaGFpbiB3aGVuIHNhdmluZy9kZWxldGluZyBhbiBvYmplY3Rcbi8vIFdpbGwgcmVzb2x2ZSBzdWNjZXNzZnVsbHkgaWYgbm8gdHJpZ2dlciBpcyBjb25maWd1cmVkXG4vLyBSZXNvbHZlcyB0byBhbiBvYmplY3QsIGVtcHR5IG9yIGNvbnRhaW5pbmcgYW4gb2JqZWN0IGtleS4gQSBiZWZvcmVTYXZlXG4vLyB0cmlnZ2VyIHdpbGwgc2V0IHRoZSBvYmplY3Qga2V5IHRvIHRoZSByZXN0IGZvcm1hdCBvYmplY3QgdG8gc2F2ZS5cbi8vIG9yaWdpbmFsUGFyc2VPYmplY3QgaXMgb3B0aW9uYWwsIHdlIG9ubHkgbmVlZCB0aGF0IGZvciBiZWZvcmUvYWZ0ZXJTYXZlIGZ1bmN0aW9uc1xuZXhwb3J0IGZ1bmN0aW9uIG1heWJlUnVuVHJpZ2dlcihcbiAgdHJpZ2dlclR5cGUsXG4gIGF1dGgsXG4gIHBhcnNlT2JqZWN0LFxuICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICBjb25maWcsXG4gIGNvbnRleHRcbikge1xuICBpZiAoIXBhcnNlT2JqZWN0KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gIH1cbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uIChyZXNvbHZlLCByZWplY3QpIHtcbiAgICB2YXIgdHJpZ2dlciA9IGdldFRyaWdnZXIocGFyc2VPYmplY3QuY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICAgIGlmICghdHJpZ2dlcikgeyByZXR1cm4gcmVzb2x2ZSgpOyB9XG4gICAgdmFyIHJlcXVlc3QgPSBnZXRSZXF1ZXN0T2JqZWN0KFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBhdXRoLFxuICAgICAgcGFyc2VPYmplY3QsXG4gICAgICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICAgICAgY29uZmlnLFxuICAgICAgY29udGV4dFxuICAgICk7XG4gICAgdmFyIHsgc3VjY2VzcywgZXJyb3IgfSA9IGdldFJlc3BvbnNlT2JqZWN0KFxuICAgICAgcmVxdWVzdCxcbiAgICAgIG9iamVjdCA9PiB7XG4gICAgICAgIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayhcbiAgICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgICAgcGFyc2VPYmplY3QudG9KU09OKCksXG4gICAgICAgICAgb2JqZWN0LFxuICAgICAgICAgIGF1dGgsXG4gICAgICAgICAgdHJpZ2dlclR5cGUuc3RhcnRzV2l0aCgnYWZ0ZXInKVxuICAgICAgICAgICAgPyBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJBZnRlclxuICAgICAgICAgICAgOiBjb25maWcubG9nTGV2ZWxzLnRyaWdnZXJCZWZvcmVTdWNjZXNzXG4gICAgICAgICk7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlRGVsZXRlIHx8XG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyRGVsZXRlXG4gICAgICAgICkge1xuICAgICAgICAgIE9iamVjdC5hc3NpZ24oY29udGV4dCwgcmVxdWVzdC5jb250ZXh0KTtcbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlKG9iamVjdCk7XG4gICAgICB9LFxuICAgICAgZXJyb3IgPT4ge1xuICAgICAgICBsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rKFxuICAgICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAgIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC50b0pTT04oKSxcbiAgICAgICAgICBhdXRoLFxuICAgICAgICAgIGVycm9yLFxuICAgICAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckJlZm9yZUVycm9yXG4gICAgICAgICk7XG4gICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICB9XG4gICAgKTtcblxuICAgIC8vIEFmdGVyU2F2ZSBhbmQgYWZ0ZXJEZWxldGUgdHJpZ2dlcnMgY2FuIHJldHVybiBhIHByb21pc2UsIHdoaWNoIGlmIHRoZXlcbiAgICAvLyBkbywgbmVlZHMgdG8gYmUgcmVzb2x2ZWQgYmVmb3JlIHRoaXMgcHJvbWlzZSBpcyByZXNvbHZlZCxcbiAgICAvLyBzbyB0cmlnZ2VyIGV4ZWN1dGlvbiBpcyBzeW5jZWQgd2l0aCBSZXN0V3JpdGUuZXhlY3V0ZSgpIGNhbGwuXG4gICAgLy8gSWYgdHJpZ2dlcnMgZG8gbm90IHJldHVybiBhIHByb21pc2UsIHRoZXkgY2FuIHJ1biBhc3luYyBjb2RlIHBhcmFsbGVsXG4gICAgLy8gdG8gdGhlIFJlc3RXcml0ZS5leGVjdXRlKCkgY2FsbC5cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGAke3RyaWdnZXJUeXBlfS4ke3BhcnNlT2JqZWN0LmNsYXNzTmFtZX1gLCBhdXRoKTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHByb21pc2UgPSB0cmlnZ2VyKHJlcXVlc3QpO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyU2F2ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckRlbGV0ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlckxvZ2luXG4gICAgICAgICkge1xuICAgICAgICAgIGxvZ1RyaWdnZXJBZnRlckhvb2soXG4gICAgICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgICAgIHBhcnNlT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHBhcnNlT2JqZWN0LnRvSlNPTigpLFxuICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckFmdGVyXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBiZWZvcmVTYXZlIGlzIGV4cGVjdGVkIHRvIHJldHVybiBudWxsIChub3RoaW5nKVxuICAgICAgICBpZiAodHJpZ2dlclR5cGUgPT09IFR5cGVzLmJlZm9yZVNhdmUpIHtcbiAgICAgICAgICBpZiAocHJvbWlzZSAmJiB0eXBlb2YgcHJvbWlzZS50aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICByZXR1cm4gcHJvbWlzZS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgICAgICAgICAgLy8gcmVzcG9uc2Uub2JqZWN0IG1heSBjb21lIGZyb20gZXhwcmVzcyByb3V0aW5nIGJlZm9yZSBob29rXG4gICAgICAgICAgICAgIGlmIChyZXNwb25zZSAmJiByZXNwb25zZS5vYmplY3QpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICAgIH0pXG4gICAgICAudGhlbihzdWNjZXNzLCBlcnJvcik7XG4gIH0pO1xufVxuXG4vLyBDb252ZXJ0cyBhIFJFU1QtZm9ybWF0IG9iamVjdCB0byBhIFBhcnNlLk9iamVjdFxuLy8gZGF0YSBpcyBlaXRoZXIgY2xhc3NOYW1lIG9yIGFuIG9iamVjdFxuZXhwb3J0IGZ1bmN0aW9uIGluZmxhdGUoZGF0YSwgcmVzdE9iamVjdCkge1xuICB2YXIgY29weSA9IHR5cGVvZiBkYXRhID09ICdvYmplY3QnID8gZGF0YSA6IHsgY2xhc3NOYW1lOiBkYXRhIH07XG4gIGZvciAodmFyIGtleSBpbiByZXN0T2JqZWN0KSB7XG4gICAgY29weVtrZXldID0gcmVzdE9iamVjdFtrZXldO1xuICB9XG4gIHJldHVybiBQYXJzZS5PYmplY3QuZnJvbUpTT04oY29weSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKGRhdGEsIGFwcGxpY2F0aW9uSWQgPSBQYXJzZS5hcHBsaWNhdGlvbklkKSB7XG4gIGlmICghX3RyaWdnZXJTdG9yZSB8fCAhX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXSB8fCAhX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXS5MaXZlUXVlcnkpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgX3RyaWdnZXJTdG9yZVthcHBsaWNhdGlvbklkXS5MaXZlUXVlcnkuZm9yRWFjaChoYW5kbGVyID0+IGhhbmRsZXIoZGF0YSkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVxdWVzdEZpbGVPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIGZpbGVPYmplY3QsIGNvbmZpZykge1xuICBjb25zdCByZXF1ZXN0ID0ge1xuICAgIC4uLmZpbGVPYmplY3QsXG4gICAgdHJpZ2dlck5hbWU6IHRyaWdnZXJUeXBlLFxuICAgIG1hc3RlcjogZmFsc2UsXG4gICAgbG9nOiBjb25maWcubG9nZ2VyQ29udHJvbGxlcixcbiAgICBoZWFkZXJzOiBjb25maWcuaGVhZGVycyxcbiAgICBpcDogY29uZmlnLmlwLFxuICAgIGNvbmZpZyxcbiAgfTtcblxuICBpZiAoIWF1dGgpIHtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoYXV0aC5pc01hc3Rlcikge1xuICAgIHJlcXVlc3RbJ21hc3RlciddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC51c2VyKSB7XG4gICAgcmVxdWVzdFsndXNlciddID0gYXV0aC51c2VyO1xuICB9XG4gIGlmIChhdXRoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgcmVxdWVzdFsnaW5zdGFsbGF0aW9uSWQnXSA9IGF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYXliZVJ1bkZpbGVUcmlnZ2VyKHRyaWdnZXJUeXBlLCBmaWxlT2JqZWN0LCBjb25maWcsIGF1dGgpIHtcbiAgY29uc3QgRmlsZUNsYXNzTmFtZSA9IGdldENsYXNzTmFtZShQYXJzZS5GaWxlKTtcbiAgY29uc3QgZmlsZVRyaWdnZXIgPSBnZXRUcmlnZ2VyKEZpbGVDbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBjb25maWcuYXBwbGljYXRpb25JZCk7XG4gIGlmICh0eXBlb2YgZmlsZVRyaWdnZXIgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVxdWVzdCA9IGdldFJlcXVlc3RGaWxlT2JqZWN0KHRyaWdnZXJUeXBlLCBhdXRoLCBmaWxlT2JqZWN0LCBjb25maWcpO1xuICAgICAgYXdhaXQgbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgYCR7dHJpZ2dlclR5cGV9LiR7RmlsZUNsYXNzTmFtZX1gLCBhdXRoKTtcbiAgICAgIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgICAgIHJldHVybiBmaWxlT2JqZWN0O1xuICAgICAgfVxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZmlsZVRyaWdnZXIocmVxdWVzdCk7XG4gICAgICBpZiAocmVxdWVzdC5mb3JjZURvd25sb2FkKSB7XG4gICAgICAgIGZpbGVPYmplY3QuZm9yY2VEb3dubG9hZCA9IHRydWU7XG4gICAgICB9XG4gICAgICBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2soXG4gICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAnUGFyc2UuRmlsZScsXG4gICAgICAgIHsgLi4uZmlsZU9iamVjdC5maWxlLnRvSlNPTigpLCBmaWxlU2l6ZTogZmlsZU9iamVjdC5maWxlU2l6ZSB9LFxuICAgICAgICByZXN1bHQsXG4gICAgICAgIGF1dGgsXG4gICAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckJlZm9yZVN1Y2Nlc3NcbiAgICAgICk7XG4gICAgICByZXR1cm4gcmVzdWx0IHx8IGZpbGVPYmplY3Q7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2soXG4gICAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgICAnUGFyc2UuRmlsZScsXG4gICAgICAgIHsgLi4uZmlsZU9iamVjdC5maWxlLnRvSlNPTigpLCBmaWxlU2l6ZTogZmlsZU9iamVjdC5maWxlU2l6ZSB9LFxuICAgICAgICBhdXRoLFxuICAgICAgICBlcnJvcixcbiAgICAgICAgY29uZmlnLmxvZ0xldmVscy50cmlnZ2VyQmVmb3JlRXJyb3JcbiAgICAgICk7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGZpbGVPYmplY3Q7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYXliZVJ1bkdsb2JhbENvbmZpZ1RyaWdnZXIodHJpZ2dlclR5cGUsIGF1dGgsIGNvbmZpZ09iamVjdCwgb3JpZ2luYWxDb25maWdPYmplY3QsIGNvbmZpZywgY29udGV4dCkge1xuICBjb25zdCBHbG9iYWxDb25maWdDbGFzc05hbWUgPSBnZXRDbGFzc05hbWUoUGFyc2UuQ29uZmlnKTtcbiAgY29uc3QgY29uZmlnVHJpZ2dlciA9IGdldFRyaWdnZXIoR2xvYmFsQ29uZmlnQ2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICBpZiAodHlwZW9mIGNvbmZpZ1RyaWdnZXIgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIGNvbmZpZ09iamVjdCwgb3JpZ2luYWxDb25maWdPYmplY3QsIGNvbmZpZywgY29udGV4dCk7XG4gICAgICBhd2FpdCBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBgJHt0cmlnZ2VyVHlwZX0uJHtHbG9iYWxDb25maWdDbGFzc05hbWV9YCwgYXV0aCk7XG4gICAgICBpZiAocmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgICAgICByZXR1cm4gY29uZmlnT2JqZWN0O1xuICAgICAgfVxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY29uZmlnVHJpZ2dlcihyZXF1ZXN0KTtcbiAgICAgIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayhcbiAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICdQYXJzZS5Db25maWcnLFxuICAgICAgICBjb25maWdPYmplY3QsXG4gICAgICAgIHJlc3VsdCxcbiAgICAgICAgYXV0aCxcbiAgICAgICAgY29uZmlnLmxvZ0xldmVscy50cmlnZ2VyQmVmb3JlU3VjY2Vzc1xuICAgICAgKTtcbiAgICAgIHJldHVybiByZXN1bHQgfHwgY29uZmlnT2JqZWN0O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rKFxuICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgJ1BhcnNlLkNvbmZpZycsXG4gICAgICAgIGNvbmZpZ09iamVjdCxcbiAgICAgICAgYXV0aCxcbiAgICAgICAgZXJyb3IsXG4gICAgICAgIGNvbmZpZy5sb2dMZXZlbHMudHJpZ2dlckJlZm9yZUVycm9yXG4gICAgICApO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG4gIHJldHVybiBjb25maWdPYmplY3Q7XG59XG4iXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFDQSxJQUFBQSxLQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBQyxPQUFBLEdBQUFELE9BQUE7QUFBa0MsU0FBQUQsdUJBQUFHLENBQUEsV0FBQUEsQ0FBQSxJQUFBQSxDQUFBLENBQUFDLFVBQUEsR0FBQUQsQ0FBQSxLQUFBRSxPQUFBLEVBQUFGLENBQUE7QUFGbEM7O0FBSU8sTUFBTUcsS0FBSyxHQUFBQyxPQUFBLENBQUFELEtBQUEsR0FBRztFQUNuQkUsV0FBVyxFQUFFLGFBQWE7RUFDMUJDLFVBQVUsRUFBRSxZQUFZO0VBQ3hCQyxXQUFXLEVBQUUsYUFBYTtFQUMxQkMsVUFBVSxFQUFFLFlBQVk7RUFDeEJDLFNBQVMsRUFBRSxXQUFXO0VBQ3RCQyxZQUFZLEVBQUUsY0FBYztFQUM1QkMsV0FBVyxFQUFFLGFBQWE7RUFD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