"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _defaults = _interopRequireDefault(require("./defaults"));
var logging = _interopRequireWildcard(require("./logger"));
var _Config = _interopRequireDefault(require("./Config"));
var _PromiseRouter = _interopRequireDefault(require("./PromiseRouter"));
var _requiredParameter = _interopRequireDefault(require("./requiredParameter"));
var _AnalyticsRouter = require("./Routers/AnalyticsRouter");
var _ClassesRouter = require("./Routers/ClassesRouter");
var _FeaturesRouter = require("./Routers/FeaturesRouter");
var _FilesRouter = require("./Routers/FilesRouter");
var _FunctionsRouter = require("./Routers/FunctionsRouter");
var _GlobalConfigRouter = require("./Routers/GlobalConfigRouter");
var _GraphQLRouter = require("./Routers/GraphQLRouter");
var _HooksRouter = require("./Routers/HooksRouter");
var _IAPValidationRouter = require("./Routers/IAPValidationRouter");
var _InstallationsRouter = require("./Routers/InstallationsRouter");
var _LogsRouter = require("./Routers/LogsRouter");
var _ParseLiveQueryServer = require("./LiveQuery/ParseLiveQueryServer");
var _PagesRouter = require("./Routers/PagesRouter");
var _PublicAPIRouter = require("./Routers/PublicAPIRouter");
var _PushRouter = require("./Routers/PushRouter");
var _CloudCodeRouter = require("./Routers/CloudCodeRouter");
var _RolesRouter = require("./Routers/RolesRouter");
var _SchemasRouter = require("./Routers/SchemasRouter");
var _SessionsRouter = require("./Routers/SessionsRouter");
var _UsersRouter = require("./Routers/UsersRouter");
var _PurgeRouter = require("./Routers/PurgeRouter");
var _AudiencesRouter = require("./Routers/AudiencesRouter");
var _AggregateRouter = require("./Routers/AggregateRouter");
var _ParseServerRESTController = require("./ParseServerRESTController");
var controllers = _interopRequireWildcard(require("./Controllers"));
var _ParseGraphQLServer = require("./GraphQL/ParseGraphQLServer");
var _SecurityRouter = require("./Routers/SecurityRouter");
var _CheckRunner = _interopRequireDefault(require("./Security/CheckRunner"));
var _Deprecator = _interopRequireDefault(require("./Deprecator/Deprecator"));
var _DefinedSchemas = require("./SchemaMigrations/DefinedSchemas");
var _Definitions = _interopRequireDefault(require("./Options/Definitions"));
var _TestUtils = require("./TestUtils");
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// ParseServer - open-source compatible API Server for Parse apps

var batch = require('./batch'),
  express = require('express'),
  middlewares = require('./middlewares'),
  Parse = require('parse/node').Parse,
  {
    parse
  } = require('graphql'),
  path = require('path'),
  fs = require('fs');
// Mutate the Parse object to add the Cloud Code handlers
addParseCloud();

// Track connections to destroy them on shutdown
const connections = new _TestUtils.Connections();

// ParseServer works like a constructor of an express app.
// https://parseplatform.org/parse-server/api/master/ParseServerOptions.html
class ParseServer {
  /**
   * @constructor
   * @param {ParseServerOptions} options the parse server initialization options
   */
  constructor(options) {
    // Scan for deprecated Parse Server options
    _Deprecator.default.scanParseServerOptions(options);
    const interfaces = JSON.parse(JSON.stringify(_Definitions.default));
    function getValidObject(root) {
      const result = {};
      for (const key in root) {
        if (Object.prototype.hasOwnProperty.call(root[key], 'type')) {
          if (root[key].type.endsWith('[]')) {
            result[key] = [getValidObject(interfaces[root[key].type.slice(0, -2)])];
          } else {
            result[key] = getValidObject(interfaces[root[key].type]);
          }
        } else {
          result[key] = '';
        }
      }
      return result;
    }
    const optionsBlueprint = getValidObject(interfaces['ParseServerOptions']);
    function validateKeyNames(original, ref, name = '') {
      let result = [];
      const prefix = name + (name !== '' ? '.' : '');
      for (const key in original) {
        if (!Object.prototype.hasOwnProperty.call(ref, key)) {
          result.push(prefix + key);
        } else {
          if (ref[key] === '') {
            continue;
          }
          let res = [];
          if (Array.isArray(original[key]) && Array.isArray(ref[key])) {
            const type = ref[key][0];
            original[key].forEach((item, idx) => {
              if (typeof item === 'object' && item !== null) {
                res = res.concat(validateKeyNames(item, type, prefix + key + `[${idx}]`));
              }
            });
          } else if (typeof original[key] === 'object' && typeof ref[key] === 'object') {
            res = validateKeyNames(original[key], ref[key], prefix + key);
          }
          result = result.concat(res);
        }
      }
      return result;
    }
    const diff = validateKeyNames(options, optionsBlueprint);
    if (diff.length > 0) {
      const logger = logging.logger;
      logger.error(`Invalid key(s) found in Parse Server configuration: ${diff.join(', ')}`);
    }

    // Set option defaults
    injectDefaults(options);
    const {
      appId = (0, _requiredParameter.default)('You must provide an appId!'),
      masterKey = (0, _requiredParameter.default)('You must provide a masterKey!'),
      javascriptKey,
      serverURL = (0, _requiredParameter.default)('You must provide a serverURL!')
    } = options;
    // Initialize the node client SDK automatically
    Parse.initialize(appId, javascriptKey || 'unused', masterKey);
    Parse.serverURL = serverURL;
    _Config.default.validateOptions(options);
    const allControllers = controllers.getControllers(options);
    options.state = 'initialized';
    this.config = _Config.default.put(Object.assign({}, options, allControllers));
    this.config.masterKeyIpsStore = new Map();
    this.config.maintenanceKeyIpsStore = new Map();
    logging.setLogger(allControllers.loggerController);
  }

  /**
   * Starts Parse Server as an express app; this promise resolves when Parse Server is ready to accept requests.
   */

  async start() {
    try {
      if (this.config.state === 'ok') {
        return this;
      }
      this.config.state = 'starting';
      _Config.default.put(this.config);
      const {
        databaseController,
        hooksController,
        cacheController,
        cloud,
        security,
        schema,
        liveQueryController
      } = this.config;
      try {
        await databaseController.performInitialization();
      } catch (e) {
        if (e.code !== Parse.Error.DUPLICATE_VALUE) {
          throw e;
        }
      }
      const pushController = await controllers.getPushController(this.config);
      await hooksController.load();
      const startupPromises = [this.config.loadMasterKey?.()];
      if (schema) {
        startupPromises.push(new _DefinedSchemas.DefinedSchemas(schema, this.config).execute());
      }
      if (cacheController.adapter?.connect && typeof cacheController.adapter.connect === 'function') {
        startupPromises.push(cacheController.adapter.connect());
      }
      startupPromises.push(liveQueryController.connect());
      await Promise.all(startupPromises);
      if (cloud) {
        addParseCloud();
        if (typeof cloud === 'function') {
          await Promise.resolve(cloud(Parse));
        } else if (typeof cloud === 'string') {
          let json;
          if (process.env.npm_package_json) {
            json = require(process.env.npm_package_json);
          }
          if (process.env.npm_package_type === 'module' || json?.type === 'module') {
            await import(path.resolve(process.cwd(), cloud));
          } else {
            require(path.resolve(process.cwd(), cloud));
          }
        } else {
          throw "argument 'cloud' must either be a string or a function";
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (security && security.enableCheck && security.enableCheckLog) {
        new _CheckRunner.default(security).run();
      }
      this.config.state = 'ok';
      this.config = {
        ...this.config,
        ...pushController
      };
      _Config.default.put(this.config);
      return this;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
      this.config.state = 'error';
      throw error;
    }
  }
  get app() {
    if (!this._app) {
      this._app = ParseServer.app(this.config);
    }
    return this._app;
  }

  /**
   * Stops the parse server, cancels any ongoing requests and closes all connections.
   *
   * Currently, express doesn't shut down immediately after receiving SIGINT/SIGTERM
   * if it has client connections that haven't timed out.
   * (This is a known issue with node - https://github.com/nodejs/node/issues/2642)
   *
   * @returns {Promise<void>} a promise that resolves when the server is stopped
   */
  async handleShutdown() {
    const serverClosePromise = (0, _TestUtils.resolvingPromise)();
    const liveQueryServerClosePromise = (0, _TestUtils.resolvingPromise)();
    const promises = [];
    this.server.close(error => {
      /* istanbul ignore next */
      if (error) {
        // eslint-disable-next-line no-console
        console.error('Error while closing parse server', error);
      }
      serverClosePromise.resolve();
    });
    if (this.liveQueryServer?.server?.close && this.liveQueryServer.server !== this.server) {
      this.liveQueryServer.server.close(error => {
        /* istanbul ignore next */
        if (error) {
          // eslint-disable-next-line no-console
          console.error('Error while closing live query server', error);
        }
        liveQueryServerClosePromise.resolve();
      });
    } else {
      liveQueryServerClosePromise.resolve();
    }
    const {
      adapter: databaseAdapter
    } = this.config.databaseController;
    if (databaseAdapter && typeof databaseAdapter.handleShutdown === 'function') {
      promises.push(databaseAdapter.handleShutdown());
    }
    const {
      adapter: fileAdapter
    } = this.config.filesController;
    if (fileAdapter && typeof fileAdapter.handleShutdown === 'function') {
      promises.push(fileAdapter.handleShutdown());
    }
    const {
      adapter: cacheAdapter
    } = this.config.cacheController;
    if (cacheAdapter && typeof cacheAdapter.handleShutdown === 'function') {
      promises.push(cacheAdapter.handleShutdown());
    }
    if (this.liveQueryServer) {
      promises.push(this.liveQueryServer.shutdown());
    }
    await Promise.all(promises);
    connections.destroyAll();
    await Promise.all([serverClosePromise, liveQueryServerClosePromise]);
    if (this.config.serverCloseComplete) {
      this.config.serverCloseComplete();
    }
  }

  /**
   * @static
   * Allow developers to customize each request with inversion of control/dependency injection
   */
  static applyRequestContextMiddleware(api, options) {
    if (options.requestContextMiddleware) {
      if (typeof options.requestContextMiddleware !== 'function') {
        throw new Error('requestContextMiddleware must be a function');
      }
      api.use(options.requestContextMiddleware);
    }
  }
  /**
   * @static
   * Create an express app for the parse server
   * @param {Object} options let you specify the maxUploadSize when creating the express app  */
  static app(options) {
    const {
      maxUploadSize = '20mb',
      appId,
      directAccess,
      pages,
      rateLimit = []
    } = options;
    // This app serves the Parse API directly.
    // It's the equivalent of https://api.parse.com/1 in the hosted Parse API.
    var api = express();
    //api.use("/apps", express.static(__dirname + "/public"));
    api.use(middlewares.allowCrossDomain(appId));
    api.use(middlewares.allowDoubleForwardSlash);
    // File handling needs to be before default middlewares are applied
    api.use('/', new _FilesRouter.FilesRouter().expressRouter({
      maxUploadSize: maxUploadSize
    }));
    api.use('/health', function (req, res) {
      res.status(options.state === 'ok' ? 200 : 503);
      if (options.state === 'starting') {
        res.set('Retry-After', 1);
      }
      res.json({
        status: options.state
      });
    });
    api.use('/', express.urlencoded({
      extended: false
    }), pages.enableRouter ? new _PagesRouter.PagesRouter(pages).expressRouter() : new _PublicAPIRouter.PublicAPIRouter().expressRouter());
    api.use(express.json({
      type: '*/*',
      limit: maxUploadSize
    }));
    api.use(middlewares.allowMethodOverride);
    api.use(middlewares.handleParseHeaders);
    api.set('query parser', 'extended');
    const routes = Array.isArray(rateLimit) ? rateLimit : [rateLimit];
    for (const route of routes) {
      middlewares.addRateLimit(route, options);
    }
    api.use(middlewares.handleParseSession);
    this.applyRequestContextMiddleware(api, options);
    const appRouter = ParseServer.promiseRouter({
      appId
    });
    api.use(appRouter.expressRouter());
    api.use(middlewares.handleParseErrors);

    // run the following when not testing
    if (!process.env.TESTING) {
      //This causes tests to spew some useless warnings, so disable in test
      /* istanbul ignore next */
      process.on('uncaughtException', err => {
        if (err.code === 'EADDRINUSE') {
          // user-friendly message for this common error
          process.stderr.write(`Unable to listen on port ${err.port}. The port is already in use.`);
          process.exit(0);
        } else {
          if (err.message) {
            process.stderr.write('An uncaught exception occurred: ' + err.message);
          }
          if (err.stack) {
            process.stderr.write('Stack Trace:\n' + err.stack);
          } else {
            process.stderr.write(err);
          }
          process.exit(1);
        }
      });
    }
    if (process.env.PARSE_SERVER_ENABLE_EXPERIMENTAL_DIRECT_ACCESS === '1' || directAccess) {
      Parse.CoreManager.setRESTController((0, _ParseServerRESTController.ParseServerRESTController)(appId, appRouter));
    }
    return api;
  }
  static promiseRouter({
    appId
  }) {
    const routers = [new _ClassesRouter.ClassesRouter(), new _UsersRouter.UsersRouter(), new _SessionsRouter.SessionsRouter(), new _RolesRouter.RolesRouter(), new _AnalyticsRouter.AnalyticsRouter(), new _InstallationsRouter.InstallationsRouter(), new _FunctionsRouter.FunctionsRouter(), new _SchemasRouter.SchemasRouter(), new _PushRouter.PushRouter(), new _LogsRouter.LogsRouter(), new _IAPValidationRouter.IAPValidationRouter(), new _FeaturesRouter.FeaturesRouter(), new _GlobalConfigRouter.GlobalConfigRouter(), new _GraphQLRouter.GraphQLRouter(), new _PurgeRouter.PurgeRouter(), new _HooksRouter.HooksRouter(), new _CloudCodeRouter.CloudCodeRouter(), new _AudiencesRouter.AudiencesRouter(), new _AggregateRouter.AggregateRouter(), new _SecurityRouter.SecurityRouter()];
    const routes = routers.reduce((memo, router) => {
      return memo.concat(router.routes);
    }, []);
    const appRouter = new _PromiseRouter.default(routes, appId);
    batch.mountOnto(appRouter);
    return appRouter;
  }

  /**
   * starts the parse server's express app
   * @param {ParseServerOptions} options to use to start the server
   * @returns {ParseServer} the parse server instance
   */

  async startApp(options) {
    try {
      await this.start();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Error on ParseServer.startApp: ', e);
      throw e;
    }
    const app = express();
    if (options.middleware) {
      let middleware;
      if (typeof options.middleware == 'string') {
        middleware = require(path.resolve(process.cwd(), options.middleware));
      } else {
        middleware = options.middleware; // use as-is let express fail
      }
      app.use(middleware);
    }
    app.use(options.mountPath, this.app);
    if (options.mountGraphQL === true || options.mountPlayground === true) {
      let graphQLCustomTypeDefs = undefined;
      if (typeof options.graphQLSchema === 'string') {
        graphQLCustomTypeDefs = parse(fs.readFileSync(options.graphQLSchema, 'utf8'));
      } else if (typeof options.graphQLSchema === 'object' || typeof options.graphQLSchema === 'function') {
        graphQLCustomTypeDefs = options.graphQLSchema;
      }
      const parseGraphQLServer = new _ParseGraphQLServer.ParseGraphQLServer(this, {
        graphQLPath: options.graphQLPath,
        playgroundPath: options.playgroundPath,
        graphQLCustomTypeDefs
      });
      if (options.mountGraphQL) {
        parseGraphQLServer.applyGraphQL(app);
      }
      if (options.mountPlayground) {
        parseGraphQLServer.applyPlayground(app);
      }
    }
    const server = await new Promise(resolve => {
      app.listen(options.port, options.host, function () {
        resolve(this);
      });
    });
    this.server = server;
    connections.track(server);
    if (options.startLiveQueryServer || options.liveQueryServerOptions) {
      this.liveQueryServer = await ParseServer.createLiveQueryServer(server, options.liveQueryServerOptions, options);
      if (this.liveQueryServer.server !== this.server) {
        connections.track(this.liveQueryServer.server);
      }
    }
    if (options.trustProxy) {
      app.set('trust proxy', options.trustProxy);
    }
    /* istanbul ignore next */
    if (!process.env.TESTING) {
      configureListeners(this);
      if (options.verifyServerUrl !== false) {
        await ParseServer.verifyServerUrl();
      }
    }
    this.expressApp = app;
    return this;
  }

  /**
   * Creates a new ParseServer and starts it.
   * @param {ParseServerOptions} options used to start the server
   * @returns {ParseServer} the parse server instance
   */
  static async startApp(options) {
    const parseServer = new ParseServer(options);
    return parseServer.startApp(options);
  }

  /**
   * Helper method to create a liveQuery server
   * @static
   * @param {Server} httpServer an optional http server to pass
   * @param {LiveQueryServerOptions} config options for the liveQueryServer
   * @param {ParseServerOptions} options options for the ParseServer
   * @returns {Promise<ParseLiveQueryServer>} the live query server instance
   */
  static async createLiveQueryServer(httpServer, config, options) {
    if (!httpServer || config && config.port) {
      var app = express();
      httpServer = require('http').createServer(app);
      httpServer.listen(config.port);
    }
    const server = new _ParseLiveQueryServer.ParseLiveQueryServer(httpServer, config, options);
    await server.connect();
    return server;
  }
  static async verifyServerUrl() {
    // perform a health check on the serverURL value
    if (Parse.serverURL) {
      const isValidHttpUrl = string => {
        let url;
        try {
          url = new URL(string);
        } catch (_) {
          return false;
        }
        return url.protocol === 'http:' || url.protocol === 'https:';
      };
      const url = `${Parse.serverURL.replace(/\/$/, '')}/health`;
      if (!isValidHttpUrl(url)) {
        // eslint-disable-next-line no-console
        console.warn(`\nWARNING, Unable to connect to '${Parse.serverURL}' as the URL is invalid.` + ` Cloud code and push notifications may be unavailable!\n`);
        return;
      }
      const request = require('./request');
      const response = await request({
        url
      }).catch(response => response);
      const json = response.data || null;
      const retry = response.headers?.['retry-after'];
      if (retry) {
        await new Promise(resolve => setTimeout(resolve, retry * 1000));
        return this.verifyServerUrl();
      }
      if (response.status !== 200 || json?.status !== 'ok') {
        /* eslint-disable no-console */
        console.warn(`\nWARNING, Unable to connect to '${Parse.serverURL}'.` + ` Cloud code and push notifications may be unavailable!\n`);
        /* eslint-enable no-console */
        return;
      }
      return true;
    }
  }
}
function addParseCloud() {
  const ParseCloud = require('./cloud-code/Parse.Cloud');
  const ParseServer = require('./cloud-code/Parse.Server');
  Object.defineProperty(Parse, 'Server', {
    get() {
      const conf = _Config.default.get(Parse.applicationId);
      return {
        ...conf,
        ...ParseServer
      };
    },
    set(newVal) {
      newVal.appId = Parse.applicationId;
      _Config.default.put(newVal);
    },
    configurable: true
  });
  Object.assign(Parse.Cloud, ParseCloud);
  global.Parse = Parse;
}
function injectDefaults(options) {
  Object.keys(_defaults.default).forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(options, key)) {
      options[key] = _defaults.default[key];
    }
  });
  if (!Object.prototype.hasOwnProperty.call(options, 'serverURL')) {
    options.serverURL = `http://localhost:${options.port}${options.mountPath}`;
  }

  // Reserved Characters
  if (options.appId) {
    const regex = /[!#$%'()*+&/:;=?@[\]{}^,|<>]/g;
    if (options.appId.match(regex)) {
      // eslint-disable-next-line no-console
      console.warn(`\nWARNING, appId that contains special characters can cause issues while using with urls.\n`);
    }
  }

  // Backwards compatibility
  if (options.userSensitiveFields) {
    /* eslint-disable no-console */
    !process.env.TESTING && console.warn(`\nDEPRECATED: userSensitiveFields has been replaced by protectedFields allowing the ability to protect fields in all classes with CLP. \n`);
    /* eslint-enable no-console */

    const userSensitiveFields = Array.from(new Set([...(_defaults.default.userSensitiveFields || []), ...(options.userSensitiveFields || [])]));

    // If the options.protectedFields is unset,
    // it'll be assigned the default above.
    // Here, protect against the case where protectedFields
    // is set, but doesn't have _User.
    if (!('_User' in options.protectedFields)) {
      options.protectedFields = Object.assign({
        _User: []
      }, options.protectedFields);
    }
    options.protectedFields['_User']['*'] = Array.from(new Set([...(options.protectedFields['_User']['*'] || []), ...userSensitiveFields]));
  }

  // Merge protectedFields options with defaults.
  Object.keys(_defaults.default.protectedFields).forEach(c => {
    const cur = options.protectedFields[c];
    if (!cur) {
      options.protectedFields[c] = _defaults.default.protectedFields[c];
    } else {
      Object.keys(_defaults.default.protectedFields[c]).forEach(r => {
        const unq = new Set([...(options.protectedFields[c][r] || []), ..._defaults.default.protectedFields[c][r]]);
        options.protectedFields[c][r] = Array.from(unq);
      });
    }
  });
}

// Those can't be tested as it requires a subprocess
/* istanbul ignore next */
function configureListeners(parseServer) {
  const handleShutdown = function () {
    process.stdout.write('Termination signal received. Shutting down.');
    parseServer.handleShutdown();
  };
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
}
var _default = exports.default = ParseServer;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfZGVmYXVsdHMiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwicmVxdWlyZSIsImxvZ2dpbmciLCJfaW50ZXJvcFJlcXVpcmVXaWxkY2FyZCIsIl9Db25maWciLCJfUHJvbWlzZVJvdXRlciIsIl9yZXF1aXJlZFBhcmFtZXRlciIsIl9BbmFseXRpY3NSb3V0ZXIiLCJfQ2xhc3Nlc1JvdXRlciIsIl9GZWF0dXJlc1JvdXRlciIsIl9GaWxlc1JvdXRlciIsIl9GdW5jdGlvbnNSb3V0ZXIiLCJfR2xvYmFsQ29uZmlnUm91dGVyIiwiX0dyYXBoUUxSb3V0ZXIiLCJfSG9va3NSb3V0ZXIiLCJfSUFQVmFsaWRhdGlvblJvdXRlciIsIl9JbnN0YWxsYXRpb25zUm91dGVyIiwiX0xvZ3NSb3V0ZXIiLCJfUGFyc2VMaXZlUXVlcnlTZXJ2ZXIiLCJfUGFnZXNSb3V0ZXIiLCJfUHVibGljQVBJUm91dGVyIiwiX1B1c2hSb3V0ZXIiLCJfQ2xvdWRDb2RlUm91dGVyIiwiX1JvbGVzUm91dGVyIiwiX1NjaGVtYXNSb3V0ZXIiLCJfU2Vzc2lvbnNSb3V0ZXIiLCJfVXNlcnNSb3V0ZXIiLCJfUHVyZ2VSb3V0ZXIiLCJfQXVkaWVuY2VzUm91dGVyIiwiX0FnZ3JlZ2F0ZVJvdXRlciIsIl9QYXJzZVNlcnZlclJFU1RDb250cm9sbGVyIiwiY29udHJvbGxlcnMiLCJfUGFyc2VHcmFwaFFMU2VydmVyIiwiX1NlY3VyaXR5Um91dGVyIiwiX0NoZWNrUnVubmVyIiwiX0RlcHJlY2F0b3IiLCJfRGVmaW5lZFNjaGVtYXMiLCJfRGVmaW5pdGlvbnMiLCJfVGVzdFV0aWxzIiwiZSIsInQiLCJXZWFrTWFwIiwiciIsIm4iLCJfX2VzTW9kdWxlIiwibyIsImkiLCJmIiwiX19wcm90b19fIiwiZGVmYXVsdCIsImhhcyIsImdldCIsInNldCIsImhhc093blByb3BlcnR5IiwiY2FsbCIsIk9iamVjdCIsImRlZmluZVByb3BlcnR5IiwiZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yIiwiYmF0Y2giLCJleHByZXNzIiwibWlkZGxld2FyZXMiLCJQYXJzZSIsInBhcnNlIiwicGF0aCIsImZzIiwiYWRkUGFyc2VDbG91ZCIsImNvbm5lY3Rpb25zIiwiQ29ubmVjdGlvbnMiLCJQYXJzZVNlcnZlciIsImNvbnN0cnVjdG9yIiwib3B0aW9ucyIsIkRlcHJlY2F0b3IiLCJzY2FuUGFyc2VTZXJ2ZXJPcHRpb25zIiwiaW50ZXJmYWNlcyIsIkpTT04iLCJzdHJpbmdpZnkiLCJPcHRpb25zRGVmaW5pdGlvbnMiLCJnZXRWYWxpZE9iamVjdCIsInJvb3QiLCJyZXN1bHQiLCJrZXkiLCJwcm90b3R5cGUiLCJ0eXBlIiwiZW5kc1dpdGgiLCJzbGljZSIsIm9wdGlvbnNCbHVlcHJpbnQiLCJ2YWxpZGF0ZUtleU5hbWVzIiwib3JpZ2luYWwiLCJyZWYiLCJuYW1lIiwicHJlZml4IiwicHVzaCIsInJlcyIsIkFycmF5IiwiaXNBcnJheSIsImZvckVhY2giLCJpdGVtIiwiaWR4IiwiY29uY2F0IiwiZGlmZiIsImxlbmd0aCIsImxvZ2dlciIsImVycm9yIiwiam9pbiIsImluamVjdERlZmF1bHRzIiwiYXBwSWQiLCJyZXF1aXJlZFBhcmFtZXRlciIsIm1hc3RlcktleSIsImphdmFzY3JpcHRLZXkiLCJzZXJ2ZXJVUkwiLCJpbml0aWFsaXplIiwiQ29uZmlnIiwidmFsaWRhdGVPcHRpb25zIiwiYWxsQ29udHJvbGxlcnMiLCJnZXRDb250cm9sbGVycyIsInN0YXRlIiwiY29uZmlnIiwicHV0IiwiYXNzaWduIiwibWFzdGVyS2V5SXBzU3RvcmUiLCJNYXAiLCJtYWludGVuYW5jZUtleUlwc1N0b3JlIiwic2V0TG9nZ2VyIiwibG9nZ2VyQ29udHJvbGxlciIsInN0YXJ0IiwiZGF0YWJhc2VDb250cm9sbGVyIiwiaG9va3NDb250cm9sbGVyIiwiY2FjaGVDb250cm9sbGVyIiwiY2xvdWQiLCJzZWN1cml0eSIsInNjaGVtYSIsImxpdmVRdWVyeUNvbnRyb2xsZXIiLCJwZXJmb3JtSW5pdGlhbGl6YXRpb24iLCJjb2RlIiwiRXJyb3IiLCJEVVBMSUNBVEVfVkFMVUUiLCJwdXNoQ29udHJvbGxlciIsImdldFB1c2hDb250cm9sbGVyIiwibG9hZCIsInN0YXJ0dXBQcm9taXNlcyIsImxvYWRNYXN0ZXJLZXkiLCJEZWZpbmVkU2NoZW1hcyIsImV4ZWN1dGUiLCJhZGFwdGVyIiwiY29ubmVjdCIsIlByb21pc2UiLCJhbGwiLCJyZXNvbHZlIiwianNvbiIsInByb2Nlc3MiLCJlbnYiLCJucG1fcGFja2FnZV9qc29uIiwibnBtX3BhY2thZ2VfdHlwZSIsImN3ZCIsInNldFRpbWVvdXQiLCJlbmFibGVDaGVjayIsImVuYWJsZUNoZWNrTG9nIiwiQ2hlY2tSdW5uZXIiLCJydW4iLCJjb25zb2xlIiwiYXBwIiwiX2FwcCIsImhhbmRsZVNodXRkb3duIiwic2VydmVyQ2xvc2VQcm9taXNlIiwicmVzb2x2aW5nUHJvbWlzZSIsImxpdmVRdWVyeVNlcnZlckNsb3NlUHJvbWlzZSIsInByb21pc2VzIiwic2VydmVyIiwiY2xvc2UiLCJsaXZlUXVlcnlTZXJ2ZXIiLCJkYXRhYmFzZUFkYXB0ZXIiLCJmaWxlQWRhcHRlciIsImZpbGVzQ29udHJvbGxlciIsImNhY2hlQWRhcHRlciIsInNodXRkb3duIiwiZGVzdHJveUFsbCIsInNlcnZlckNsb3NlQ29tcGxldGUiLCJhcHBseVJlcXVlc3RDb250ZXh0TWlkZGxld2FyZSIsImFwaSIsInJlcXVlc3RDb250ZXh0TWlkZGxld2FyZSIsInVzZSIsIm1heFVwbG9hZFNpemUiLCJkaXJlY3RBY2Nlc3MiLCJwYWdlcyIsInJhdGVMaW1pdCIsImFsbG93Q3Jvc3NEb21haW4iLCJhbGxvd0RvdWJsZUZvcndhcmRTbGFzaCIsIkZpbGVzUm91dGVyIiwiZXhwcmVzc1JvdXRlciIsInJlcSIsInN0YXR1cyIsInVybGVuY29kZWQiLCJleHRlbmRlZCIsImVuYWJsZVJvdXRlciIsIlBhZ2VzUm91dGVyIiwiUHVibGljQVBJUm91dGVyIiwibGltaXQiLCJhbGxvd01ldGhvZE92ZXJyaWRlIiwiaGFuZGxlUGFyc2VIZWFkZXJzIiwicm91dGVzIiwicm91dGUiLCJhZGRSYXRlTGltaXQiLCJoYW5kbGVQYXJzZVNlc3Npb24iLCJhcHBSb3V0ZXIiLCJwcm9taXNlUm91dGVyIiwiaGFuZGxlUGFyc2VFcnJvcnMiLCJURVNUSU5HIiwib24iLCJlcnIiLCJzdGRlcnIiLCJ3cml0ZSIsInBvcnQiLCJleGl0IiwibWVzc2FnZSIsInN0YWNrIiwiUEFSU0VfU0VSVkVSX0VOQUJMRV9FWFBFUklNRU5UQUxfRElSRUNUX0FDQ0VTUyIsIkNvcmVNYW5hZ2VyIiwic2V0UkVTVENvbnRyb2xsZXIiLCJQYXJzZVNlcnZlclJFU1RDb250cm9sbGVyIiwicm91dGVycyIsIkNsYXNzZXNSb3V0ZXIiLCJVc2Vyc1JvdXRlciIsIlNlc3Npb25zUm91dGVyIiwiUm9sZXNSb3V0ZXIiLCJBbmFseXRpY3NSb3V0ZXIiLCJJbnN0YWxsYXRpb25zUm91dGVyIiwiRnVuY3Rpb25zUm91dGVyIiwiU2NoZW1hc1JvdXRlciIsIlB1c2hSb3V0ZXIiLCJMb2dzUm91dGVyIiwiSUFQVmFsaWRhdGlvblJvdXRlciIsIkZlYXR1cmVzUm91dGVyIiwiR2xvYmFsQ29uZmlnUm91dGVyIiwiR3JhcGhRTFJvdXRlciIsIlB1cmdlUm91dGVyIiwiSG9va3NSb3V0ZXIiLCJDbG91ZENvZGVSb3V0ZXIiLCJBdWRpZW5jZXNSb3V0ZXIiLCJBZ2dyZWdhdGVSb3V0ZXIiLCJTZWN1cml0eVJvdXRlciIsInJlZHVjZSIsIm1lbW8iLCJyb3V0ZXIiLCJQcm9taXNlUm91dGVyIiwibW91bnRPbnRvIiwic3RhcnRBcHAiLCJtaWRkbGV3YXJlIiwibW91bnRQYXRoIiwibW91bnRHcmFwaFFMIiwibW91bnRQbGF5Z3JvdW5kIiwiZ3JhcGhRTEN1c3RvbVR5cGVEZWZzIiwidW5kZWZpbmVkIiwiZ3JhcGhRTFNjaGVtYSIsInJlYWRGaWxlU3luYyIsInBhcnNlR3JhcGhRTFNlcnZlciIsIlBhcnNlR3JhcGhRTFNlcnZlciIsImdyYXBoUUxQYXRoIiwicGxheWdyb3VuZFBhdGgiLCJhcHBseUdyYXBoUUwiLCJhcHBseVBsYXlncm91bmQiLCJsaXN0ZW4iLCJob3N0IiwidHJhY2siLCJzdGFydExpdmVRdWVyeVNlcnZlciIsImxpdmVRdWVyeVNlcnZlck9wdGlvbnMiLCJjcmVhdGVMaXZlUXVlcnlTZXJ2ZXIiLCJ0cnVzdFByb3h5IiwiY29uZmlndXJlTGlzdGVuZXJzIiwidmVyaWZ5U2VydmVyVXJsIiwiZXhwcmVzc0FwcCIsInBhcnNlU2VydmVyIiwiaHR0cFNlcnZlciIsImNyZWF0ZVNlcnZlciIsIlBhcnNlTGl2ZVF1ZXJ5U2VydmVyIiwiaXNWYWxpZEh0dHBVcmwiLCJzdHJpbmciLCJ1cmwiLCJVUkwiLCJfIiwicHJvdG9jb2wiLCJyZXBsYWNlIiwid2FybiIsInJlcXVlc3QiLCJyZXNwb25zZSIsImNhdGNoIiwiZGF0YSIsInJldHJ5IiwiaGVhZGVycyIsIlBhcnNlQ2xvdWQiLCJjb25mIiwiYXBwbGljYXRpb25JZCIsIm5ld1ZhbCIsImNvbmZpZ3VyYWJsZSIsIkNsb3VkIiwiZ2xvYmFsIiwia2V5cyIsImRlZmF1bHRzIiwicmVnZXgiLCJtYXRjaCIsInVzZXJTZW5zaXRpdmVGaWVsZHMiLCJmcm9tIiwiU2V0IiwicHJvdGVjdGVkRmllbGRzIiwiX1VzZXIiLCJjIiwiY3VyIiwidW5xIiwic3Rkb3V0IiwiX2RlZmF1bHQiLCJleHBvcnRzIl0sInNvdXJjZXMiOlsiLi4vc3JjL1BhcnNlU2VydmVyLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIFBhcnNlU2VydmVyIC0gb3Blbi1zb3VyY2UgY29tcGF0aWJsZSBBUEkgU2VydmVyIGZvciBQYXJzZSBhcHBzXG5cbnZhciBiYXRjaCA9IHJlcXVpcmUoJy4vYmF0Y2gnKSxcbiAgZXhwcmVzcyA9IHJlcXVpcmUoJ2V4cHJlc3MnKSxcbiAgbWlkZGxld2FyZXMgPSByZXF1aXJlKCcuL21pZGRsZXdhcmVzJyksXG4gIFBhcnNlID0gcmVxdWlyZSgncGFyc2Uvbm9kZScpLlBhcnNlLFxuICB7IHBhcnNlIH0gPSByZXF1aXJlKCdncmFwaHFsJyksXG4gIHBhdGggPSByZXF1aXJlKCdwYXRoJyksXG4gIGZzID0gcmVxdWlyZSgnZnMnKTtcblxuaW1wb3J0IHsgUGFyc2VTZXJ2ZXJPcHRpb25zLCBMaXZlUXVlcnlTZXJ2ZXJPcHRpb25zIH0gZnJvbSAnLi9PcHRpb25zJztcbmltcG9ydCBkZWZhdWx0cyBmcm9tICcuL2RlZmF1bHRzJztcbmltcG9ydCAqIGFzIGxvZ2dpbmcgZnJvbSAnLi9sb2dnZXInO1xuaW1wb3J0IENvbmZpZyBmcm9tICcuL0NvbmZpZyc7XG5pbXBvcnQgUHJvbWlzZVJvdXRlciBmcm9tICcuL1Byb21pc2VSb3V0ZXInO1xuaW1wb3J0IHJlcXVpcmVkUGFyYW1ldGVyIGZyb20gJy4vcmVxdWlyZWRQYXJhbWV0ZXInO1xuaW1wb3J0IHsgQW5hbHl0aWNzUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0FuYWx5dGljc1JvdXRlcic7XG5pbXBvcnQgeyBDbGFzc2VzUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0NsYXNzZXNSb3V0ZXInO1xuaW1wb3J0IHsgRmVhdHVyZXNSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvRmVhdHVyZXNSb3V0ZXInO1xuaW1wb3J0IHsgRmlsZXNSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvRmlsZXNSb3V0ZXInO1xuaW1wb3J0IHsgRnVuY3Rpb25zUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0Z1bmN0aW9uc1JvdXRlcic7XG5pbXBvcnQgeyBHbG9iYWxDb25maWdSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvR2xvYmFsQ29uZmlnUm91dGVyJztcbmltcG9ydCB7IEdyYXBoUUxSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvR3JhcGhRTFJvdXRlcic7XG5pbXBvcnQgeyBIb29rc1JvdXRlciB9IGZyb20gJy4vUm91dGVycy9Ib29rc1JvdXRlcic7XG5pbXBvcnQgeyBJQVBWYWxpZGF0aW9uUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0lBUFZhbGlkYXRpb25Sb3V0ZXInO1xuaW1wb3J0IHsgSW5zdGFsbGF0aW9uc1JvdXRlciB9IGZyb20gJy4vUm91dGVycy9JbnN0YWxsYXRpb25zUm91dGVyJztcbmltcG9ydCB7IExvZ3NSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvTG9nc1JvdXRlcic7XG5pbXBvcnQgeyBQYXJzZUxpdmVRdWVyeVNlcnZlciB9IGZyb20gJy4vTGl2ZVF1ZXJ5L1BhcnNlTGl2ZVF1ZXJ5U2VydmVyJztcbmltcG9ydCB7IFBhZ2VzUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL1BhZ2VzUm91dGVyJztcbmltcG9ydCB7IFB1YmxpY0FQSVJvdXRlciB9IGZyb20gJy4vUm91dGVycy9QdWJsaWNBUElSb3V0ZXInO1xuaW1wb3J0IHsgUHVzaFJvdXRlciB9IGZyb20gJy4vUm91dGVycy9QdXNoUm91dGVyJztcbmltcG9ydCB7IENsb3VkQ29kZVJvdXRlciB9IGZyb20gJy4vUm91dGVycy9DbG91ZENvZGVSb3V0ZXInO1xuaW1wb3J0IHsgUm9sZXNSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvUm9sZXNSb3V0ZXInO1xuaW1wb3J0IHsgU2NoZW1hc1JvdXRlciB9IGZyb20gJy4vUm91dGVycy9TY2hlbWFzUm91dGVyJztcbmltcG9ydCB7IFNlc3Npb25zUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL1Nlc3Npb25zUm91dGVyJztcbmltcG9ydCB7IFVzZXJzUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL1VzZXJzUm91dGVyJztcbmltcG9ydCB7IFB1cmdlUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL1B1cmdlUm91dGVyJztcbmltcG9ydCB7IEF1ZGllbmNlc1JvdXRlciB9IGZyb20gJy4vUm91dGVycy9BdWRpZW5jZXNSb3V0ZXInO1xuaW1wb3J0IHsgQWdncmVnYXRlUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0FnZ3JlZ2F0ZVJvdXRlcic7XG5pbXBvcnQgeyBQYXJzZVNlcnZlclJFU1RDb250cm9sbGVyIH0gZnJvbSAnLi9QYXJzZVNlcnZlclJFU1RDb250cm9sbGVyJztcbmltcG9ydCAqIGFzIGNvbnRyb2xsZXJzIGZyb20gJy4vQ29udHJvbGxlcnMnO1xuaW1wb3J0IHsgUGFyc2VHcmFwaFFMU2VydmVyIH0gZnJvbSAnLi9HcmFwaFFML1BhcnNlR3JhcGhRTFNlcnZlcic7XG5pbXBvcnQgeyBTZWN1cml0eVJvdXRlciB9IGZyb20gJy4vUm91dGVycy9TZWN1cml0eVJvdXRlcic7XG5pbXBvcnQgQ2hlY2tSdW5uZXIgZnJvbSAnLi9TZWN1cml0eS9DaGVja1J1bm5lcic7XG5pbXBvcnQgRGVwcmVjYXRvciBmcm9tICcuL0RlcHJlY2F0b3IvRGVwcmVjYXRvcic7XG5pbXBvcnQgeyBEZWZpbmVkU2NoZW1hcyB9IGZyb20gJy4vU2NoZW1hTWlncmF0aW9ucy9EZWZpbmVkU2NoZW1hcyc7XG5pbXBvcnQgT3B0aW9uc0RlZmluaXRpb25zIGZyb20gJy4vT3B0aW9ucy9EZWZpbml0aW9ucyc7XG5pbXBvcnQgeyByZXNvbHZpbmdQcm9taXNlLCBDb25uZWN0aW9ucyB9IGZyb20gJy4vVGVzdFV0aWxzJztcblxuLy8gTXV0YXRlIHRoZSBQYXJzZSBvYmplY3QgdG8gYWRkIHRoZSBDbG91ZCBDb2RlIGhhbmRsZXJzXG5hZGRQYXJzZUNsb3VkKCk7XG5cbi8vIFRyYWNrIGNvbm5lY3Rpb25zIHRvIGRlc3Ryb3kgdGhlbSBvbiBzaHV0ZG93blxuY29uc3QgY29ubmVjdGlvbnMgPSBuZXcgQ29ubmVjdGlvbnMoKTtcblxuLy8gUGFyc2VTZXJ2ZXIgd29ya3MgbGlrZSBhIGNvbnN0cnVjdG9yIG9mIGFuIGV4cHJlc3MgYXBwLlxuLy8gaHR0cHM6Ly9wYXJzZXBsYXRmb3JtLm9yZy9wYXJzZS1zZXJ2ZXIvYXBpL21hc3Rlci9QYXJzZVNlcnZlck9wdGlvbnMuaHRtbFxuY2xhc3MgUGFyc2VTZXJ2ZXIge1xuICBfYXBwOiBhbnk7XG4gIGNvbmZpZzogYW55O1xuICBzZXJ2ZXI6IGFueTtcbiAgZXhwcmVzc0FwcDogYW55O1xuICBsaXZlUXVlcnlTZXJ2ZXI6IGFueTtcbiAgLyoqXG4gICAqIEBjb25zdHJ1Y3RvclxuICAgKiBAcGFyYW0ge1BhcnNlU2VydmVyT3B0aW9uc30gb3B0aW9ucyB0aGUgcGFyc2Ugc2VydmVyIGluaXRpYWxpemF0aW9uIG9wdGlvbnNcbiAgICovXG4gIGNvbnN0cnVjdG9yKG9wdGlvbnM6IFBhcnNlU2VydmVyT3B0aW9ucykge1xuICAgIC8vIFNjYW4gZm9yIGRlcHJlY2F0ZWQgUGFyc2UgU2VydmVyIG9wdGlvbnNcbiAgICBEZXByZWNhdG9yLnNjYW5QYXJzZVNlcnZlck9wdGlvbnMob3B0aW9ucyk7XG5cbiAgICBjb25zdCBpbnRlcmZhY2VzID0gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShPcHRpb25zRGVmaW5pdGlvbnMpKTtcblxuICAgIGZ1bmN0aW9uIGdldFZhbGlkT2JqZWN0KHJvb3QpIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHt9O1xuICAgICAgZm9yIChjb25zdCBrZXkgaW4gcm9vdCkge1xuICAgICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJvb3Rba2V5XSwgJ3R5cGUnKSkge1xuICAgICAgICAgIGlmIChyb290W2tleV0udHlwZS5lbmRzV2l0aCgnW10nKSkge1xuICAgICAgICAgICAgcmVzdWx0W2tleV0gPSBbZ2V0VmFsaWRPYmplY3QoaW50ZXJmYWNlc1tyb290W2tleV0udHlwZS5zbGljZSgwLCAtMildKV07XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJlc3VsdFtrZXldID0gZ2V0VmFsaWRPYmplY3QoaW50ZXJmYWNlc1tyb290W2tleV0udHlwZV0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXN1bHRba2V5XSA9ICcnO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIGNvbnN0IG9wdGlvbnNCbHVlcHJpbnQgPSBnZXRWYWxpZE9iamVjdChpbnRlcmZhY2VzWydQYXJzZVNlcnZlck9wdGlvbnMnXSk7XG5cbiAgICBmdW5jdGlvbiB2YWxpZGF0ZUtleU5hbWVzKG9yaWdpbmFsLCByZWYsIG5hbWUgPSAnJykge1xuICAgICAgbGV0IHJlc3VsdCA9IFtdO1xuICAgICAgY29uc3QgcHJlZml4ID0gbmFtZSArIChuYW1lICE9PSAnJyA/ICcuJyA6ICcnKTtcbiAgICAgIGZvciAoY29uc3Qga2V5IGluIG9yaWdpbmFsKSB7XG4gICAgICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlZiwga2V5KSkge1xuICAgICAgICAgIHJlc3VsdC5wdXNoKHByZWZpeCArIGtleSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgaWYgKHJlZltrZXldID09PSAnJykgeyBjb250aW51ZTsgfVxuICAgICAgICAgIGxldCByZXMgPSBbXTtcbiAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShvcmlnaW5hbFtrZXldKSAmJiBBcnJheS5pc0FycmF5KHJlZltrZXldKSkge1xuICAgICAgICAgICAgY29uc3QgdHlwZSA9IHJlZltrZXldWzBdO1xuICAgICAgICAgICAgb3JpZ2luYWxba2V5XS5mb3JFYWNoKChpdGVtLCBpZHgpID0+IHtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBpdGVtID09PSAnb2JqZWN0JyAmJiBpdGVtICE9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgcmVzID0gcmVzLmNvbmNhdCh2YWxpZGF0ZUtleU5hbWVzKGl0ZW0sIHR5cGUsIHByZWZpeCArIGtleSArIGBbJHtpZHh9XWApKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSBlbHNlIGlmICh0eXBlb2Ygb3JpZ2luYWxba2V5XSA9PT0gJ29iamVjdCcgJiYgdHlwZW9mIHJlZltrZXldID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgcmVzID0gdmFsaWRhdGVLZXlOYW1lcyhvcmlnaW5hbFtrZXldLCByZWZba2V5XSwgcHJlZml4ICsga2V5KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmVzdWx0ID0gcmVzdWx0LmNvbmNhdChyZXMpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIGNvbnN0IGRpZmYgPSB2YWxpZGF0ZUtleU5hbWVzKG9wdGlvbnMsIG9wdGlvbnNCbHVlcHJpbnQpO1xuICAgIGlmIChkaWZmLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGxvZ2dlciA9IChsb2dnaW5nIGFzIGFueSkubG9nZ2VyO1xuICAgICAgbG9nZ2VyLmVycm9yKGBJbnZhbGlkIGtleShzKSBmb3VuZCBpbiBQYXJzZSBTZXJ2ZXIgY29uZmlndXJhdGlvbjogJHtkaWZmLmpvaW4oJywgJyl9YCk7XG4gICAgfVxuXG4gICAgLy8gU2V0IG9wdGlvbiBkZWZhdWx0c1xuICAgIGluamVjdERlZmF1bHRzKG9wdGlvbnMpO1xuICAgIGNvbnN0IHtcbiAgICAgIGFwcElkID0gcmVxdWlyZWRQYXJhbWV0ZXIoJ1lvdSBtdXN0IHByb3ZpZGUgYW4gYXBwSWQhJyksXG4gICAgICBtYXN0ZXJLZXkgPSByZXF1aXJlZFBhcmFtZXRlcignWW91IG11c3QgcHJvdmlkZSBhIG1hc3RlcktleSEnKSxcbiAgICAgIGphdmFzY3JpcHRLZXksXG4gICAgICBzZXJ2ZXJVUkwgPSByZXF1aXJlZFBhcmFtZXRlcignWW91IG11c3QgcHJvdmlkZSBhIHNlcnZlclVSTCEnKSxcbiAgICB9ID0gb3B0aW9ucztcbiAgICAvLyBJbml0aWFsaXplIHRoZSBub2RlIGNsaWVudCBTREsgYXV0b21hdGljYWxseVxuICAgIFBhcnNlLmluaXRpYWxpemUoYXBwSWQsIGphdmFzY3JpcHRLZXkgfHwgJ3VudXNlZCcsIG1hc3RlcktleSk7XG4gICAgUGFyc2Uuc2VydmVyVVJMID0gc2VydmVyVVJMO1xuICAgIENvbmZpZy52YWxpZGF0ZU9wdGlvbnMob3B0aW9ucyk7XG4gICAgY29uc3QgYWxsQ29udHJvbGxlcnMgPSBjb250cm9sbGVycy5nZXRDb250cm9sbGVycyhvcHRpb25zKTtcblxuICAgIChvcHRpb25zIGFzIGFueSkuc3RhdGUgPSAnaW5pdGlhbGl6ZWQnO1xuICAgIHRoaXMuY29uZmlnID0gQ29uZmlnLnB1dChPYmplY3QuYXNzaWduKHt9LCBvcHRpb25zLCBhbGxDb250cm9sbGVycykpO1xuICAgIHRoaXMuY29uZmlnLm1hc3RlcktleUlwc1N0b3JlID0gbmV3IE1hcCgpO1xuICAgIHRoaXMuY29uZmlnLm1haW50ZW5hbmNlS2V5SXBzU3RvcmUgPSBuZXcgTWFwKCk7XG4gICAgbG9nZ2luZy5zZXRMb2dnZXIoYWxsQ29udHJvbGxlcnMubG9nZ2VyQ29udHJvbGxlcik7XG4gIH1cblxuICAvKipcbiAgICogU3RhcnRzIFBhcnNlIFNlcnZlciBhcyBhbiBleHByZXNzIGFwcDsgdGhpcyBwcm9taXNlIHJlc29sdmVzIHdoZW4gUGFyc2UgU2VydmVyIGlzIHJlYWR5IHRvIGFjY2VwdCByZXF1ZXN0cy5cbiAgICovXG5cbiAgYXN5bmMgc3RhcnQoKTogUHJvbWlzZTx0aGlzPiB7XG4gICAgdHJ5IHtcbiAgICAgIGlmICh0aGlzLmNvbmZpZy5zdGF0ZSA9PT0gJ29rJykge1xuICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgIH1cbiAgICAgIHRoaXMuY29uZmlnLnN0YXRlID0gJ3N0YXJ0aW5nJztcbiAgICAgIENvbmZpZy5wdXQodGhpcy5jb25maWcpO1xuICAgICAgY29uc3Qge1xuICAgICAgICBkYXRhYmFzZUNvbnRyb2xsZXIsXG4gICAgICAgIGhvb2tzQ29udHJvbGxlcixcbiAgICAgICAgY2FjaGVDb250cm9sbGVyLFxuICAgICAgICBjbG91ZCxcbiAgICAgICAgc2VjdXJpdHksXG4gICAgICAgIHNjaGVtYSxcbiAgICAgICAgbGl2ZVF1ZXJ5Q29udHJvbGxlcixcbiAgICAgIH0gPSB0aGlzLmNvbmZpZztcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGRhdGFiYXNlQ29udHJvbGxlci5wZXJmb3JtSW5pdGlhbGl6YXRpb24oKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKGUuY29kZSAhPT0gUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFKSB7XG4gICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgY29uc3QgcHVzaENvbnRyb2xsZXIgPSBhd2FpdCBjb250cm9sbGVycy5nZXRQdXNoQ29udHJvbGxlcih0aGlzLmNvbmZpZyk7XG4gICAgICBhd2FpdCBob29rc0NvbnRyb2xsZXIubG9hZCgpO1xuICAgICAgY29uc3Qgc3RhcnR1cFByb21pc2VzID0gW3RoaXMuY29uZmlnLmxvYWRNYXN0ZXJLZXk/LigpXTtcbiAgICAgIGlmIChzY2hlbWEpIHtcbiAgICAgICAgc3RhcnR1cFByb21pc2VzLnB1c2gobmV3IERlZmluZWRTY2hlbWFzKHNjaGVtYSwgdGhpcy5jb25maWcpLmV4ZWN1dGUoKSk7XG4gICAgICB9XG4gICAgICBpZiAoXG4gICAgICAgIGNhY2hlQ29udHJvbGxlci5hZGFwdGVyPy5jb25uZWN0ICYmXG4gICAgICAgIHR5cGVvZiBjYWNoZUNvbnRyb2xsZXIuYWRhcHRlci5jb25uZWN0ID09PSAnZnVuY3Rpb24nXG4gICAgICApIHtcbiAgICAgICAgc3RhcnR1cFByb21pc2VzLnB1c2goY2FjaGVDb250cm9sbGVyLmFkYXB0ZXIuY29ubmVjdCgpKTtcbiAgICAgIH1cbiAgICAgIHN0YXJ0dXBQcm9taXNlcy5wdXNoKGxpdmVRdWVyeUNvbnRyb2xsZXIuY29ubmVjdCgpKTtcbiAgICAgIGF3YWl0IFByb21pc2UuYWxsKHN0YXJ0dXBQcm9taXNlcyk7XG4gICAgICBpZiAoY2xvdWQpIHtcbiAgICAgICAgYWRkUGFyc2VDbG91ZCgpO1xuICAgICAgICBpZiAodHlwZW9mIGNsb3VkID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgYXdhaXQgUHJvbWlzZS5yZXNvbHZlKGNsb3VkKFBhcnNlKSk7XG4gICAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGNsb3VkID09PSAnc3RyaW5nJykge1xuICAgICAgICAgIGxldCBqc29uO1xuICAgICAgICAgIGlmIChwcm9jZXNzLmVudi5ucG1fcGFja2FnZV9qc29uKSB7XG4gICAgICAgICAgICBqc29uID0gcmVxdWlyZShwcm9jZXNzLmVudi5ucG1fcGFja2FnZV9qc29uKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHByb2Nlc3MuZW52Lm5wbV9wYWNrYWdlX3R5cGUgPT09ICdtb2R1bGUnIHx8IGpzb24/LnR5cGUgPT09ICdtb2R1bGUnKSB7XG4gICAgICAgICAgICBhd2FpdCBpbXBvcnQocGF0aC5yZXNvbHZlKHByb2Nlc3MuY3dkKCksIGNsb3VkKSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJlcXVpcmUocGF0aC5yZXNvbHZlKHByb2Nlc3MuY3dkKCksIGNsb3VkKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IFwiYXJndW1lbnQgJ2Nsb3VkJyBtdXN0IGVpdGhlciBiZSBhIHN0cmluZyBvciBhIGZ1bmN0aW9uXCI7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDEwKSk7XG4gICAgICB9XG4gICAgICBpZiAoc2VjdXJpdHkgJiYgc2VjdXJpdHkuZW5hYmxlQ2hlY2sgJiYgc2VjdXJpdHkuZW5hYmxlQ2hlY2tMb2cpIHtcbiAgICAgICAgbmV3IENoZWNrUnVubmVyKHNlY3VyaXR5KS5ydW4oKTtcbiAgICAgIH1cbiAgICAgIHRoaXMuY29uZmlnLnN0YXRlID0gJ29rJztcbiAgICAgIHRoaXMuY29uZmlnID0geyAuLi50aGlzLmNvbmZpZywgLi4ucHVzaENvbnRyb2xsZXIgfTtcbiAgICAgIENvbmZpZy5wdXQodGhpcy5jb25maWcpO1xuICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICBjb25zb2xlLmVycm9yKGVycm9yKTtcbiAgICAgIHRoaXMuY29uZmlnLnN0YXRlID0gJ2Vycm9yJztcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuXG4gIGdldCBhcHAoKSB7XG4gICAgaWYgKCF0aGlzLl9hcHApIHtcbiAgICAgIHRoaXMuX2FwcCA9IFBhcnNlU2VydmVyLmFwcCh0aGlzLmNvbmZpZyk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLl9hcHA7XG4gIH1cblxuICAvKipcbiAgICogU3RvcHMgdGhlIHBhcnNlIHNlcnZlciwgY2FuY2VscyBhbnkgb25nb2luZyByZXF1ZXN0cyBhbmQgY2xvc2VzIGFsbCBjb25uZWN0aW9ucy5cbiAgICpcbiAgICogQ3VycmVudGx5LCBleHByZXNzIGRvZXNuJ3Qgc2h1dCBkb3duIGltbWVkaWF0ZWx5IGFmdGVyIHJlY2VpdmluZyBTSUdJTlQvU0lHVEVSTVxuICAgKiBpZiBpdCBoYXMgY2xpZW50IGNvbm5lY3Rpb25zIHRoYXQgaGF2ZW4ndCB0aW1lZCBvdXQuXG4gICAqIChUaGlzIGlzIGEga25vd24gaXNzdWUgd2l0aCBub2RlIC0gaHR0cHM6Ly9naXRodWIuY29tL25vZGVqcy9ub2RlL2lzc3Vlcy8yNjQyKVxuICAgKlxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTx2b2lkPn0gYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiB0aGUgc2VydmVyIGlzIHN0b3BwZWRcbiAgICovXG4gIGFzeW5jIGhhbmRsZVNodXRkb3duKCkge1xuICAgIGNvbnN0IHNlcnZlckNsb3NlUHJvbWlzZSA9IHJlc29sdmluZ1Byb21pc2UoKTtcbiAgICBjb25zdCBsaXZlUXVlcnlTZXJ2ZXJDbG9zZVByb21pc2UgPSByZXNvbHZpbmdQcm9taXNlKCk7XG4gICAgY29uc3QgcHJvbWlzZXMgPSBbXTtcbiAgICB0aGlzLnNlcnZlci5jbG9zZSgoZXJyb3IpID0+IHtcbiAgICAgIC8qIGlzdGFuYnVsIGlnbm9yZSBuZXh0ICovXG4gICAgICBpZiAoZXJyb3IpIHtcbiAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgICAgY29uc29sZS5lcnJvcignRXJyb3Igd2hpbGUgY2xvc2luZyBwYXJzZSBzZXJ2ZXInLCBlcnJvcik7XG4gICAgICB9XG4gICAgICBzZXJ2ZXJDbG9zZVByb21pc2UucmVzb2x2ZSgpO1xuICAgIH0pO1xuICAgIGlmICh0aGlzLmxpdmVRdWVyeVNlcnZlcj8uc2VydmVyPy5jbG9zZSAmJiB0aGlzLmxpdmVRdWVyeVNlcnZlci5zZXJ2ZXIgIT09IHRoaXMuc2VydmVyKSB7XG4gICAgICB0aGlzLmxpdmVRdWVyeVNlcnZlci5zZXJ2ZXIuY2xvc2UoKGVycm9yKSA9PiB7XG4gICAgICAgIC8qIGlzdGFuYnVsIGlnbm9yZSBuZXh0ICovXG4gICAgICAgIGlmIChlcnJvcikge1xuICAgICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICAgICAgY29uc29sZS5lcnJvcignRXJyb3Igd2hpbGUgY2xvc2luZyBsaXZlIHF1ZXJ5IHNlcnZlcicsIGVycm9yKTtcbiAgICAgICAgfVxuICAgICAgICBsaXZlUXVlcnlTZXJ2ZXJDbG9zZVByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGxpdmVRdWVyeVNlcnZlckNsb3NlUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgfVxuICAgIGNvbnN0IHsgYWRhcHRlcjogZGF0YWJhc2VBZGFwdGVyIH0gPSB0aGlzLmNvbmZpZy5kYXRhYmFzZUNvbnRyb2xsZXI7XG4gICAgaWYgKGRhdGFiYXNlQWRhcHRlciAmJiB0eXBlb2YgZGF0YWJhc2VBZGFwdGVyLmhhbmRsZVNodXRkb3duID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBwcm9taXNlcy5wdXNoKGRhdGFiYXNlQWRhcHRlci5oYW5kbGVTaHV0ZG93bigpKTtcbiAgICB9XG4gICAgY29uc3QgeyBhZGFwdGVyOiBmaWxlQWRhcHRlciB9ID0gdGhpcy5jb25maWcuZmlsZXNDb250cm9sbGVyO1xuICAgIGlmIChmaWxlQWRhcHRlciAmJiB0eXBlb2YgZmlsZUFkYXB0ZXIuaGFuZGxlU2h1dGRvd24gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHByb21pc2VzLnB1c2goZmlsZUFkYXB0ZXIuaGFuZGxlU2h1dGRvd24oKSk7XG4gICAgfVxuICAgIGNvbnN0IHsgYWRhcHRlcjogY2FjaGVBZGFwdGVyIH0gPSB0aGlzLmNvbmZpZy5jYWNoZUNvbnRyb2xsZXI7XG4gICAgaWYgKGNhY2hlQWRhcHRlciAmJiB0eXBlb2YgY2FjaGVBZGFwdGVyLmhhbmRsZVNodXRkb3duID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBwcm9taXNlcy5wdXNoKGNhY2hlQWRhcHRlci5oYW5kbGVTaHV0ZG93bigpKTtcbiAgICB9XG4gICAgaWYgKHRoaXMubGl2ZVF1ZXJ5U2VydmVyKSB7XG4gICAgICBwcm9taXNlcy5wdXNoKHRoaXMubGl2ZVF1ZXJ5U2VydmVyLnNodXRkb3duKCkpO1xuICAgIH1cbiAgICBhd2FpdCBQcm9taXNlLmFsbChwcm9taXNlcyk7XG4gICAgY29ubmVjdGlvbnMuZGVzdHJveUFsbCgpO1xuICAgIGF3YWl0IFByb21pc2UuYWxsKFtzZXJ2ZXJDbG9zZVByb21pc2UsIGxpdmVRdWVyeVNlcnZlckNsb3NlUHJvbWlzZV0pO1xuICAgIGlmICh0aGlzLmNvbmZpZy5zZXJ2ZXJDbG9zZUNvbXBsZXRlKSB7XG4gICAgICB0aGlzLmNvbmZpZy5zZXJ2ZXJDbG9zZUNvbXBsZXRlKCk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEBzdGF0aWNcbiAgICogQWxsb3cgZGV2ZWxvcGVycyB0byBjdXN0b21pemUgZWFjaCByZXF1ZXN0IHdpdGggaW52ZXJzaW9uIG9mIGNvbnRyb2wvZGVwZW5kZW5jeSBpbmplY3Rpb25cbiAgICovXG4gIHN0YXRpYyBhcHBseVJlcXVlc3RDb250ZXh0TWlkZGxld2FyZShhcGksIG9wdGlvbnMpIHtcbiAgICBpZiAob3B0aW9ucy5yZXF1ZXN0Q29udGV4dE1pZGRsZXdhcmUpIHtcbiAgICAgIGlmICh0eXBlb2Ygb3B0aW9ucy5yZXF1ZXN0Q29udGV4dE1pZGRsZXdhcmUgIT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdyZXF1ZXN0Q29udGV4dE1pZGRsZXdhcmUgbXVzdCBiZSBhIGZ1bmN0aW9uJyk7XG4gICAgICB9XG4gICAgICBhcGkudXNlKG9wdGlvbnMucmVxdWVzdENvbnRleHRNaWRkbGV3YXJlKTtcbiAgICB9XG4gIH1cbiAgLyoqXG4gICAqIEBzdGF0aWNcbiAgICogQ3JlYXRlIGFuIGV4cHJlc3MgYXBwIGZvciB0aGUgcGFyc2Ugc2VydmVyXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBvcHRpb25zIGxldCB5b3Ugc3BlY2lmeSB0aGUgbWF4VXBsb2FkU2l6ZSB3aGVuIGNyZWF0aW5nIHRoZSBleHByZXNzIGFwcCAgKi9cbiAgc3RhdGljIGFwcChvcHRpb25zKSB7XG4gICAgY29uc3Qge1xuICAgICAgbWF4VXBsb2FkU2l6ZSA9ICcyMG1iJyxcbiAgICAgIGFwcElkLFxuICAgICAgZGlyZWN0QWNjZXNzLFxuICAgICAgcGFnZXMsXG4gICAgICByYXRlTGltaXQgPSBbXSxcbiAgICB9ID0gb3B0aW9ucztcbiAgICAvLyBUaGlzIGFwcCBzZXJ2ZXMgdGhlIFBhcnNlIEFQSSBkaXJlY3RseS5cbiAgICAvLyBJdCdzIHRoZSBlcXVpdmFsZW50IG9mIGh0dHBzOi8vYXBpLnBhcnNlLmNvbS8xIGluIHRoZSBob3N0ZWQgUGFyc2UgQVBJLlxuICAgIHZhciBhcGkgPSBleHByZXNzKCk7XG4gICAgLy9hcGkudXNlKFwiL2FwcHNcIiwgZXhwcmVzcy5zdGF0aWMoX19kaXJuYW1lICsgXCIvcHVibGljXCIpKTtcbiAgICBhcGkudXNlKG1pZGRsZXdhcmVzLmFsbG93Q3Jvc3NEb21haW4oYXBwSWQpKTtcbiAgICBhcGkudXNlKG1pZGRsZXdhcmVzLmFsbG93RG91YmxlRm9yd2FyZFNsYXNoKTtcbiAgICAvLyBGaWxlIGhhbmRsaW5nIG5lZWRzIHRvIGJlIGJlZm9yZSBkZWZhdWx0IG1pZGRsZXdhcmVzIGFyZSBhcHBsaWVkXG4gICAgYXBpLnVzZShcbiAgICAgICcvJyxcbiAgICAgIG5ldyBGaWxlc1JvdXRlcigpLmV4cHJlc3NSb3V0ZXIoe1xuICAgICAgICBtYXhVcGxvYWRTaXplOiBtYXhVcGxvYWRTaXplLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgYXBpLnVzZSgnL2hlYWx0aCcsIGZ1bmN0aW9uIChyZXEsIHJlcykge1xuICAgICAgcmVzLnN0YXR1cyhvcHRpb25zLnN0YXRlID09PSAnb2snID8gMjAwIDogNTAzKTtcbiAgICAgIGlmIChvcHRpb25zLnN0YXRlID09PSAnc3RhcnRpbmcnKSB7XG4gICAgICAgIHJlcy5zZXQoJ1JldHJ5LUFmdGVyJywgMSk7XG4gICAgICB9XG4gICAgICByZXMuanNvbih7XG4gICAgICAgIHN0YXR1czogb3B0aW9ucy5zdGF0ZSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgYXBpLnVzZShcbiAgICAgICcvJyxcbiAgICAgIGV4cHJlc3MudXJsZW5jb2RlZCh7IGV4dGVuZGVkOiBmYWxzZSB9KSxcbiAgICAgIHBhZ2VzLmVuYWJsZVJvdXRlclxuICAgICAgICA/IG5ldyBQYWdlc1JvdXRlcihwYWdlcykuZXhwcmVzc1JvdXRlcigpXG4gICAgICAgIDogbmV3IFB1YmxpY0FQSVJvdXRlcigpLmV4cHJlc3NSb3V0ZXIoKVxuICAgICk7XG5cbiAgICBhcGkudXNlKGV4cHJlc3MuanNvbih7IHR5cGU6ICcqLyonLCBsaW1pdDogbWF4VXBsb2FkU2l6ZSB9KSk7XG4gICAgYXBpLnVzZShtaWRkbGV3YXJlcy5hbGxvd01ldGhvZE92ZXJyaWRlKTtcbiAgICBhcGkudXNlKG1pZGRsZXdhcmVzLmhhbmRsZVBhcnNlSGVhZGVycyk7XG4gICAgYXBpLnNldCgncXVlcnkgcGFyc2VyJywgJ2V4dGVuZGVkJyk7XG4gICAgY29uc3Qgcm91dGVzID0gQXJyYXkuaXNBcnJheShyYXRlTGltaXQpID8gcmF0ZUxpbWl0IDogW3JhdGVMaW1pdF07XG4gICAgZm9yIChjb25zdCByb3V0ZSBvZiByb3V0ZXMpIHtcbiAgICAgIG1pZGRsZXdhcmVzLmFkZFJhdGVMaW1pdChyb3V0ZSwgb3B0aW9ucyk7XG4gICAgfVxuICAgIGFwaS51c2UobWlkZGxld2FyZXMuaGFuZGxlUGFyc2VTZXNzaW9uKTtcbiAgICB0aGlzLmFwcGx5UmVxdWVzdENvbnRleHRNaWRkbGV3YXJlKGFwaSwgb3B0aW9ucyk7XG4gICAgY29uc3QgYXBwUm91dGVyID0gUGFyc2VTZXJ2ZXIucHJvbWlzZVJvdXRlcih7IGFwcElkIH0pO1xuICAgIGFwaS51c2UoYXBwUm91dGVyLmV4cHJlc3NSb3V0ZXIoKSk7XG5cbiAgICBhcGkudXNlKG1pZGRsZXdhcmVzLmhhbmRsZVBhcnNlRXJyb3JzKTtcblxuICAgIC8vIHJ1biB0aGUgZm9sbG93aW5nIHdoZW4gbm90IHRlc3RpbmdcbiAgICBpZiAoIXByb2Nlc3MuZW52LlRFU1RJTkcpIHtcbiAgICAgIC8vVGhpcyBjYXVzZXMgdGVzdHMgdG8gc3BldyBzb21lIHVzZWxlc3Mgd2FybmluZ3MsIHNvIGRpc2FibGUgaW4gdGVzdFxuICAgICAgLyogaXN0YW5idWwgaWdub3JlIG5leHQgKi9cbiAgICAgIHByb2Nlc3Mub24oJ3VuY2F1Z2h0RXhjZXB0aW9uJywgKGVycjogYW55KSA9PiB7XG4gICAgICAgIGlmIChlcnIuY29kZSA9PT0gJ0VBRERSSU5VU0UnKSB7XG4gICAgICAgICAgLy8gdXNlci1mcmllbmRseSBtZXNzYWdlIGZvciB0aGlzIGNvbW1vbiBlcnJvclxuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBVbmFibGUgdG8gbGlzdGVuIG9uIHBvcnQgJHtlcnIucG9ydH0uIFRoZSBwb3J0IGlzIGFscmVhZHkgaW4gdXNlLmApO1xuICAgICAgICAgIHByb2Nlc3MuZXhpdCgwKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBpZiAoZXJyLm1lc3NhZ2UpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdBbiB1bmNhdWdodCBleGNlcHRpb24gb2NjdXJyZWQ6ICcgKyBlcnIubWVzc2FnZSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChlcnIuc3RhY2spIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdTdGFjayBUcmFjZTpcXG4nICsgZXJyLnN0YWNrKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZXJyKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9XG4gICAgaWYgKHByb2Nlc3MuZW52LlBBUlNFX1NFUlZFUl9FTkFCTEVfRVhQRVJJTUVOVEFMX0RJUkVDVF9BQ0NFU1MgPT09ICcxJyB8fCBkaXJlY3RBY2Nlc3MpIHtcbiAgICAgIFBhcnNlLkNvcmVNYW5hZ2VyLnNldFJFU1RDb250cm9sbGVyKFBhcnNlU2VydmVyUkVTVENvbnRyb2xsZXIoYXBwSWQsIGFwcFJvdXRlcikpO1xuICAgIH1cbiAgICByZXR1cm4gYXBpO1xuICB9XG5cbiAgc3RhdGljIHByb21pc2VSb3V0ZXIoeyBhcHBJZCB9KSB7XG4gICAgY29uc3Qgcm91dGVycyA9IFtcbiAgICAgIG5ldyBDbGFzc2VzUm91dGVyKCksXG4gICAgICBuZXcgVXNlcnNSb3V0ZXIoKSxcbiAgICAgIG5ldyBTZXNzaW9uc1JvdXRlcigpLFxuICAgICAgbmV3IFJvbGVzUm91dGVyKCksXG4gICAgICBuZXcgQW5hbHl0aWNzUm91dGVyKCksXG4gICAgICBuZXcgSW5zdGFsbGF0aW9uc1JvdXRlcigpLFxuICAgICAgbmV3IEZ1bmN0aW9uc1JvdXRlcigpLFxuICAgICAgbmV3IFNjaGVtYXNSb3V0ZXIoKSxcbiAgICAgIG5ldyBQdXNoUm91dGVyKCksXG4gICAgICBuZXcgTG9nc1JvdXRlcigpLFxuICAgICAgbmV3IElBUFZhbGlkYXRpb25Sb3V0ZXIoKSxcbiAgICAgIG5ldyBGZWF0dXJlc1JvdXRlcigpLFxuICAgICAgbmV3IEdsb2JhbENvbmZpZ1JvdXRlcigpLFxuICAgICAgbmV3IEdyYXBoUUxSb3V0ZXIoKSxcbiAgICAgIG5ldyBQdXJnZVJvdXRlcigpLFxuICAgICAgbmV3IEhvb2tzUm91dGVyKCksXG4gICAgICBuZXcgQ2xvdWRDb2RlUm91dGVyKCksXG4gICAgICBuZXcgQXVkaWVuY2VzUm91dGVyKCksXG4gICAgICBuZXcgQWdncmVnYXRlUm91dGVyKCksXG4gICAgICBuZXcgU2VjdXJpdHlSb3V0ZXIoKSxcbiAgICBdO1xuXG4gICAgY29uc3Qgcm91dGVzID0gcm91dGVycy5yZWR1Y2UoKG1lbW8sIHJvdXRlcikgPT4ge1xuICAgICAgcmV0dXJuIG1lbW8uY29uY2F0KHJvdXRlci5yb3V0ZXMpO1xuICAgIH0sIFtdKTtcblxuICAgIGNvbnN0IGFwcFJvdXRlciA9IG5ldyBQcm9taXNlUm91dGVyKHJvdXRlcywgYXBwSWQpO1xuXG4gICAgYmF0Y2gubW91bnRPbnRvKGFwcFJvdXRlcik7XG4gICAgcmV0dXJuIGFwcFJvdXRlcjtcbiAgfVxuXG4gIC8qKlxuICAgKiBzdGFydHMgdGhlIHBhcnNlIHNlcnZlcidzIGV4cHJlc3MgYXBwXG4gICAqIEBwYXJhbSB7UGFyc2VTZXJ2ZXJPcHRpb25zfSBvcHRpb25zIHRvIHVzZSB0byBzdGFydCB0aGUgc2VydmVyXG4gICAqIEByZXR1cm5zIHtQYXJzZVNlcnZlcn0gdGhlIHBhcnNlIHNlcnZlciBpbnN0YW5jZVxuICAgKi9cblxuICBhc3luYyBzdGFydEFwcChvcHRpb25zOiBQYXJzZVNlcnZlck9wdGlvbnMpIHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgdGhpcy5zdGFydCgpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICBjb25zb2xlLmVycm9yKCdFcnJvciBvbiBQYXJzZVNlcnZlci5zdGFydEFwcDogJywgZSk7XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgICBjb25zdCBhcHAgPSBleHByZXNzKCk7XG4gICAgaWYgKG9wdGlvbnMubWlkZGxld2FyZSkge1xuICAgICAgbGV0IG1pZGRsZXdhcmU7XG4gICAgICBpZiAodHlwZW9mIG9wdGlvbnMubWlkZGxld2FyZSA9PSAnc3RyaW5nJykge1xuICAgICAgICBtaWRkbGV3YXJlID0gcmVxdWlyZShwYXRoLnJlc29sdmUocHJvY2Vzcy5jd2QoKSwgb3B0aW9ucy5taWRkbGV3YXJlKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBtaWRkbGV3YXJlID0gb3B0aW9ucy5taWRkbGV3YXJlOyAvLyB1c2UgYXMtaXMgbGV0IGV4cHJlc3MgZmFpbFxuICAgICAgfVxuICAgICAgYXBwLnVzZShtaWRkbGV3YXJlKTtcbiAgICB9XG4gICAgYXBwLnVzZShvcHRpb25zLm1vdW50UGF0aCwgdGhpcy5hcHApO1xuXG4gICAgaWYgKG9wdGlvbnMubW91bnRHcmFwaFFMID09PSB0cnVlIHx8IG9wdGlvbnMubW91bnRQbGF5Z3JvdW5kID09PSB0cnVlKSB7XG4gICAgICBsZXQgZ3JhcGhRTEN1c3RvbVR5cGVEZWZzID0gdW5kZWZpbmVkO1xuICAgICAgaWYgKHR5cGVvZiBvcHRpb25zLmdyYXBoUUxTY2hlbWEgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGdyYXBoUUxDdXN0b21UeXBlRGVmcyA9IHBhcnNlKGZzLnJlYWRGaWxlU3luYyhvcHRpb25zLmdyYXBoUUxTY2hlbWEsICd1dGY4JykpO1xuICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgdHlwZW9mIG9wdGlvbnMuZ3JhcGhRTFNjaGVtYSA9PT0gJ29iamVjdCcgfHxcbiAgICAgICAgdHlwZW9mIG9wdGlvbnMuZ3JhcGhRTFNjaGVtYSA9PT0gJ2Z1bmN0aW9uJ1xuICAgICAgKSB7XG4gICAgICAgIGdyYXBoUUxDdXN0b21UeXBlRGVmcyA9IG9wdGlvbnMuZ3JhcGhRTFNjaGVtYTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcGFyc2VHcmFwaFFMU2VydmVyID0gbmV3IFBhcnNlR3JhcGhRTFNlcnZlcih0aGlzLCB7XG4gICAgICAgIGdyYXBoUUxQYXRoOiBvcHRpb25zLmdyYXBoUUxQYXRoLFxuICAgICAgICBwbGF5Z3JvdW5kUGF0aDogb3B0aW9ucy5wbGF5Z3JvdW5kUGF0aCxcbiAgICAgICAgZ3JhcGhRTEN1c3RvbVR5cGVEZWZzLFxuICAgICAgfSk7XG5cbiAgICAgIGlmIChvcHRpb25zLm1vdW50R3JhcGhRTCkge1xuICAgICAgICBwYXJzZUdyYXBoUUxTZXJ2ZXIuYXBwbHlHcmFwaFFMKGFwcCk7XG4gICAgICB9XG5cbiAgICAgIGlmIChvcHRpb25zLm1vdW50UGxheWdyb3VuZCkge1xuICAgICAgICBwYXJzZUdyYXBoUUxTZXJ2ZXIuYXBwbHlQbGF5Z3JvdW5kKGFwcCk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHNlcnZlciA9IGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgYXBwLmxpc3RlbihvcHRpb25zLnBvcnQsIG9wdGlvbnMuaG9zdCwgZnVuY3Rpb24gKCkge1xuICAgICAgICByZXNvbHZlKHRoaXMpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gICAgdGhpcy5zZXJ2ZXIgPSBzZXJ2ZXI7XG4gICAgY29ubmVjdGlvbnMudHJhY2soc2VydmVyKTtcblxuICAgIGlmIChvcHRpb25zLnN0YXJ0TGl2ZVF1ZXJ5U2VydmVyIHx8IG9wdGlvbnMubGl2ZVF1ZXJ5U2VydmVyT3B0aW9ucykge1xuICAgICAgdGhpcy5saXZlUXVlcnlTZXJ2ZXIgPSBhd2FpdCBQYXJzZVNlcnZlci5jcmVhdGVMaXZlUXVlcnlTZXJ2ZXIoXG4gICAgICAgIHNlcnZlcixcbiAgICAgICAgb3B0aW9ucy5saXZlUXVlcnlTZXJ2ZXJPcHRpb25zLFxuICAgICAgICBvcHRpb25zXG4gICAgICApO1xuICAgICAgaWYgKHRoaXMubGl2ZVF1ZXJ5U2VydmVyLnNlcnZlciAhPT0gdGhpcy5zZXJ2ZXIpIHtcbiAgICAgICAgY29ubmVjdGlvbnMudHJhY2sodGhpcy5saXZlUXVlcnlTZXJ2ZXIuc2VydmVyKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKG9wdGlvbnMudHJ1c3RQcm94eSkge1xuICAgICAgYXBwLnNldCgndHJ1c3QgcHJveHknLCBvcHRpb25zLnRydXN0UHJveHkpO1xuICAgIH1cbiAgICAvKiBpc3RhbmJ1bCBpZ25vcmUgbmV4dCAqL1xuICAgIGlmICghcHJvY2Vzcy5lbnYuVEVTVElORykge1xuICAgICAgY29uZmlndXJlTGlzdGVuZXJzKHRoaXMpO1xuICAgICAgaWYgKG9wdGlvbnMudmVyaWZ5U2VydmVyVXJsICE9PSBmYWxzZSkge1xuICAgICAgICBhd2FpdCBQYXJzZVNlcnZlci52ZXJpZnlTZXJ2ZXJVcmwoKTtcbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5leHByZXNzQXBwID0gYXBwO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLyoqXG4gICAqIENyZWF0ZXMgYSBuZXcgUGFyc2VTZXJ2ZXIgYW5kIHN0YXJ0cyBpdC5cbiAgICogQHBhcmFtIHtQYXJzZVNlcnZlck9wdGlvbnN9IG9wdGlvbnMgdXNlZCB0byBzdGFydCB0aGUgc2VydmVyXG4gICAqIEByZXR1cm5zIHtQYXJzZVNlcnZlcn0gdGhlIHBhcnNlIHNlcnZlciBpbnN0YW5jZVxuICAgKi9cbiAgc3RhdGljIGFzeW5jIHN0YXJ0QXBwKG9wdGlvbnM6IFBhcnNlU2VydmVyT3B0aW9ucykge1xuICAgIGNvbnN0IHBhcnNlU2VydmVyID0gbmV3IFBhcnNlU2VydmVyKG9wdGlvbnMpO1xuICAgIHJldHVybiBwYXJzZVNlcnZlci5zdGFydEFwcChvcHRpb25zKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBIZWxwZXIgbWV0aG9kIHRvIGNyZWF0ZSBhIGxpdmVRdWVyeSBzZXJ2ZXJcbiAgICogQHN0YXRpY1xuICAgKiBAcGFyYW0ge1NlcnZlcn0gaHR0cFNlcnZlciBhbiBvcHRpb25hbCBodHRwIHNlcnZlciB0byBwYXNzXG4gICAqIEBwYXJhbSB7TGl2ZVF1ZXJ5U2VydmVyT3B0aW9uc30gY29uZmlnIG9wdGlvbnMgZm9yIHRoZSBsaXZlUXVlcnlTZXJ2ZXJcbiAgICogQHBhcmFtIHtQYXJzZVNlcnZlck9wdGlvbnN9IG9wdGlvbnMgb3B0aW9ucyBmb3IgdGhlIFBhcnNlU2VydmVyXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPFBhcnNlTGl2ZVF1ZXJ5U2VydmVyPn0gdGhlIGxpdmUgcXVlcnkgc2VydmVyIGluc3RhbmNlXG4gICAqL1xuICBzdGF0aWMgYXN5bmMgY3JlYXRlTGl2ZVF1ZXJ5U2VydmVyKFxuICAgIGh0dHBTZXJ2ZXIsXG4gICAgY29uZmlnOiBMaXZlUXVlcnlTZXJ2ZXJPcHRpb25zLFxuICAgIG9wdGlvbnM6IFBhcnNlU2VydmVyT3B0aW9uc1xuICApOiBQcm9taXNlPFBhcnNlTGl2ZVF1ZXJ5U2VydmVyPiB7XG4gICAgaWYgKCFodHRwU2VydmVyIHx8IChjb25maWcgJiYgY29uZmlnLnBvcnQpKSB7XG4gICAgICB2YXIgYXBwID0gZXhwcmVzcygpO1xuICAgICAgaHR0cFNlcnZlciA9IHJlcXVpcmUoJ2h0dHAnKS5jcmVhdGVTZXJ2ZXIoYXBwKTtcbiAgICAgIGh0dHBTZXJ2ZXIubGlzdGVuKGNvbmZpZy5wb3J0KTtcbiAgICB9XG4gICAgY29uc3Qgc2VydmVyID0gbmV3IFBhcnNlTGl2ZVF1ZXJ5U2VydmVyKGh0dHBTZXJ2ZXIsIGNvbmZpZywgb3B0aW9ucyk7XG4gICAgYXdhaXQgc2VydmVyLmNvbm5lY3QoKTtcbiAgICByZXR1cm4gc2VydmVyO1xuICB9XG5cbiAgc3RhdGljIGFzeW5jIHZlcmlmeVNlcnZlclVybCgpIHtcbiAgICAvLyBwZXJmb3JtIGEgaGVhbHRoIGNoZWNrIG9uIHRoZSBzZXJ2ZXJVUkwgdmFsdWVcbiAgICBpZiAoUGFyc2Uuc2VydmVyVVJMKSB7XG4gICAgICBjb25zdCBpc1ZhbGlkSHR0cFVybCA9IHN0cmluZyA9PiB7XG4gICAgICAgIGxldCB1cmw7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgdXJsID0gbmV3IFVSTChzdHJpbmcpO1xuICAgICAgICB9IGNhdGNoIChfKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB1cmwucHJvdG9jb2wgPT09ICdodHRwOicgfHwgdXJsLnByb3RvY29sID09PSAnaHR0cHM6JztcbiAgICAgIH07XG4gICAgICBjb25zdCB1cmwgPSBgJHtQYXJzZS5zZXJ2ZXJVUkwucmVwbGFjZSgvXFwvJC8sICcnKX0vaGVhbHRoYDtcbiAgICAgIGlmICghaXNWYWxpZEh0dHBVcmwodXJsKSkge1xuICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICAgYFxcbldBUk5JTkcsIFVuYWJsZSB0byBjb25uZWN0IHRvICcke1BhcnNlLnNlcnZlclVSTH0nIGFzIHRoZSBVUkwgaXMgaW52YWxpZC5gICtcbiAgICAgICAgICAgIGAgQ2xvdWQgY29kZSBhbmQgcHVzaCBub3RpZmljYXRpb25zIG1heSBiZSB1bmF2YWlsYWJsZSFcXG5gXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlcXVlc3QgPSByZXF1aXJlKCcuL3JlcXVlc3QnKTtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdCh7IHVybCB9KS5jYXRjaChyZXNwb25zZSA9PiByZXNwb25zZSk7XG4gICAgICBjb25zdCBqc29uID0gcmVzcG9uc2UuZGF0YSB8fCBudWxsO1xuICAgICAgY29uc3QgcmV0cnkgPSByZXNwb25zZS5oZWFkZXJzPy5bJ3JldHJ5LWFmdGVyJ107XG4gICAgICBpZiAocmV0cnkpIHtcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIHJldHJ5ICogMTAwMCkpO1xuICAgICAgICByZXR1cm4gdGhpcy52ZXJpZnlTZXJ2ZXJVcmwoKTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXNwb25zZS5zdGF0dXMgIT09IDIwMCB8fCBqc29uPy5zdGF0dXMgIT09ICdvaycpIHtcbiAgICAgICAgLyogZXNsaW50LWRpc2FibGUgbm8tY29uc29sZSAqL1xuICAgICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICAgYFxcbldBUk5JTkcsIFVuYWJsZSB0byBjb25uZWN0IHRvICcke1BhcnNlLnNlcnZlclVSTH0nLmAgK1xuICAgICAgICAgICAgYCBDbG91ZCBjb2RlIGFuZCBwdXNoIG5vdGlmaWNhdGlvbnMgbWF5IGJlIHVuYXZhaWxhYmxlIVxcbmBcbiAgICAgICAgKTtcbiAgICAgICAgLyogZXNsaW50LWVuYWJsZSBuby1jb25zb2xlICovXG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBhZGRQYXJzZUNsb3VkKCkge1xuICBjb25zdCBQYXJzZUNsb3VkID0gcmVxdWlyZSgnLi9jbG91ZC1jb2RlL1BhcnNlLkNsb3VkJyk7XG4gIGNvbnN0IFBhcnNlU2VydmVyID0gcmVxdWlyZSgnLi9jbG91ZC1jb2RlL1BhcnNlLlNlcnZlcicpO1xuICBPYmplY3QuZGVmaW5lUHJvcGVydHkoUGFyc2UsICdTZXJ2ZXInLCB7XG4gICAgZ2V0KCkge1xuICAgICAgY29uc3QgY29uZiA9IENvbmZpZy5nZXQoUGFyc2UuYXBwbGljYXRpb25JZCk7XG4gICAgICByZXR1cm4geyAuLi5jb25mLCAuLi5QYXJzZVNlcnZlciB9O1xuICAgIH0sXG4gICAgc2V0KG5ld1ZhbCkge1xuICAgICAgbmV3VmFsLmFwcElkID0gUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgICAgIENvbmZpZy5wdXQobmV3VmFsKTtcbiAgICB9LFxuICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZSxcbiAgfSk7XG4gIE9iamVjdC5hc3NpZ24oUGFyc2UuQ2xvdWQsIFBhcnNlQ2xvdWQpO1xuICBnbG9iYWwuUGFyc2UgPSBQYXJzZTtcbn1cblxuZnVuY3Rpb24gaW5qZWN0RGVmYXVsdHMob3B0aW9uczogUGFyc2VTZXJ2ZXJPcHRpb25zKSB7XG4gIE9iamVjdC5rZXlzKGRlZmF1bHRzKS5mb3JFYWNoKGtleSA9PiB7XG4gICAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob3B0aW9ucywga2V5KSkge1xuICAgICAgb3B0aW9uc1trZXldID0gZGVmYXVsdHNba2V5XTtcbiAgICB9XG4gIH0pO1xuXG4gIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG9wdGlvbnMsICdzZXJ2ZXJVUkwnKSkge1xuICAgIG9wdGlvbnMuc2VydmVyVVJMID0gYGh0dHA6Ly9sb2NhbGhvc3Q6JHtvcHRpb25zLnBvcnR9JHtvcHRpb25zLm1vdW50UGF0aH1gO1xuICB9XG5cbiAgLy8gUmVzZXJ2ZWQgQ2hhcmFjdGVyc1xuICBpZiAob3B0aW9ucy5hcHBJZCkge1xuICAgIGNvbnN0IHJlZ2V4ID0gL1shIyQlJygpKismLzo7PT9AW1xcXXt9Xix8PD5dL2c7XG4gICAgaWYgKG9wdGlvbnMuYXBwSWQubWF0Y2gocmVnZXgpKSB7XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICBgXFxuV0FSTklORywgYXBwSWQgdGhhdCBjb250YWlucyBzcGVjaWFsIGNoYXJhY3RlcnMgY2FuIGNhdXNlIGlzc3VlcyB3aGlsZSB1c2luZyB3aXRoIHVybHMuXFxuYFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvLyBCYWNrd2FyZHMgY29tcGF0aWJpbGl0eVxuICBpZiAob3B0aW9ucy51c2VyU2Vuc2l0aXZlRmllbGRzKSB7XG4gICAgLyogZXNsaW50LWRpc2FibGUgbm8tY29uc29sZSAqL1xuICAgICFwcm9jZXNzLmVudi5URVNUSU5HICYmXG4gICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgIGBcXG5ERVBSRUNBVEVEOiB1c2VyU2Vuc2l0aXZlRmllbGRzIGhhcyBiZWVuIHJlcGxhY2VkIGJ5IHByb3RlY3RlZEZpZWxkcyBhbGxvd2luZyB0aGUgYWJpbGl0eSB0byBwcm90ZWN0IGZpZWxkcyBpbiBhbGwgY2xhc3NlcyB3aXRoIENMUC4gXFxuYFxuICAgICAgKTtcbiAgICAvKiBlc2xpbnQtZW5hYmxlIG5vLWNvbnNvbGUgKi9cblxuICAgIGNvbnN0IHVzZXJTZW5zaXRpdmVGaWVsZHMgPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChbLi4uKGRlZmF1bHRzLnVzZXJTZW5zaXRpdmVGaWVsZHMgfHwgW10pLCAuLi4ob3B0aW9ucy51c2VyU2Vuc2l0aXZlRmllbGRzIHx8IFtdKV0pXG4gICAgKTtcblxuICAgIC8vIElmIHRoZSBvcHRpb25zLnByb3RlY3RlZEZpZWxkcyBpcyB1bnNldCxcbiAgICAvLyBpdCdsbCBiZSBhc3NpZ25lZCB0aGUgZGVmYXVsdCBhYm92ZS5cbiAgICAvLyBIZXJlLCBwcm90ZWN0IGFnYWluc3QgdGhlIGNhc2Ugd2hlcmUgcHJvdGVjdGVkRmllbGRzXG4gICAgLy8gaXMgc2V0LCBidXQgZG9lc24ndCBoYXZlIF9Vc2VyLlxuICAgIGlmICghKCdfVXNlcicgaW4gb3B0aW9ucy5wcm90ZWN0ZWRGaWVsZHMpKSB7XG4gICAgICBvcHRpb25zLnByb3RlY3RlZEZpZWxkcyA9IE9iamVjdC5hc3NpZ24oeyBfVXNlcjogW10gfSwgb3B0aW9ucy5wcm90ZWN0ZWRGaWVsZHMpO1xuICAgIH1cblxuICAgIG9wdGlvbnMucHJvdGVjdGVkRmllbGRzWydfVXNlciddWycqJ10gPSBBcnJheS5mcm9tKFxuICAgICAgbmV3IFNldChbLi4uKG9wdGlvbnMucHJvdGVjdGVkRmllbGRzWydfVXNlciddWycqJ10gfHwgW10pLCAuLi51c2VyU2Vuc2l0aXZlRmllbGRzXSlcbiAgICApO1xuICB9XG5cbiAgLy8gTWVyZ2UgcHJvdGVjdGVkRmllbGRzIG9wdGlvbnMgd2l0aCBkZWZhdWx0cy5cbiAgT2JqZWN0LmtleXMoZGVmYXVsdHMucHJvdGVjdGVkRmllbGRzKS5mb3JFYWNoKGMgPT4ge1xuICAgIGNvbnN0IGN1ciA9IG9wdGlvbnMucHJvdGVjdGVkRmllbGRzW2NdO1xuICAgIGlmICghY3VyKSB7XG4gICAgICBvcHRpb25zLnByb3RlY3RlZEZpZWxkc1tjXSA9IGRlZmF1bHRzLnByb3RlY3RlZEZpZWxkc1tjXTtcbiAgICB9IGVsc2Uge1xuICAgICAgT2JqZWN0LmtleXMoZGVmYXVsdHMucHJvdGVjdGVkRmllbGRzW2NdKS5mb3JFYWNoKHIgPT4ge1xuICAgICAgICBjb25zdCB1bnEgPSBuZXcgU2V0KFtcbiAgICAgICAgICAuLi4ob3B0aW9ucy5wcm90ZWN0ZWRGaWVsZHNbY11bcl0gfHwgW10pLFxuICAgICAgICAgIC4uLmRlZmF1bHRzLnByb3RlY3RlZEZpZWxkc1tjXVtyXSxcbiAgICAgICAgXSk7XG4gICAgICAgIG9wdGlvbnMucHJvdGVjdGVkRmllbGRzW2NdW3JdID0gQXJyYXkuZnJvbSh1bnEpO1xuICAgICAgfSk7XG4gICAgfVxuICB9KTtcbn1cblxuLy8gVGhvc2UgY2FuJ3QgYmUgdGVzdGVkIGFzIGl0IHJlcXVpcmVzIGEgc3VicHJvY2Vzc1xuLyogaXN0YW5idWwgaWdub3JlIG5leHQgKi9cbmZ1bmN0aW9uIGNvbmZpZ3VyZUxpc3RlbmVycyhwYXJzZVNlcnZlcikge1xuICBjb25zdCBoYW5kbGVTaHV0ZG93biA9IGZ1bmN0aW9uICgpIHtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZSgnVGVybWluYXRpb24gc2lnbmFsIHJlY2VpdmVkLiBTaHV0dGluZyBkb3duLicpO1xuICAgIHBhcnNlU2VydmVyLmhhbmRsZVNodXRkb3duKCk7XG4gIH07XG4gIHByb2Nlc3Mub24oJ1NJR1RFUk0nLCBoYW5kbGVTaHV0ZG93bik7XG4gIHByb2Nlc3Mub24oJ1NJR0lOVCcsIGhhbmRsZVNodXRkb3duKTtcbn1cblxuZXhwb3J0IGRlZmF1bHQgUGFyc2VTZXJ2ZXI7XG4iXSwibWFwcGluZ3MiOiI7Ozs7OztBQVdBLElBQUFBLFNBQUEsR0FB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