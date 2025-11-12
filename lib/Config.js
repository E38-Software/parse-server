"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.Config = void 0;
var _lodash = require("lodash");
var _net = _interopRequireDefault(require("net"));
var _cache = _interopRequireDefault(require("./cache"));
var _DatabaseController = _interopRequireDefault(require("./Controllers/DatabaseController"));
var _LoggerController = require("./Controllers/LoggerController");
var _package = require("../package.json");
var _Definitions = require("./Options/Definitions");
var _Parse = _interopRequireDefault(require("./cloud-code/Parse.Server"));
var _Deprecator = _interopRequireDefault(require("./Deprecator/Deprecator"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// A Config object provides information about how a specific app is
// configured.
// mount is the URL for the root of the API; includes http, domain, etc.

function removeTrailingSlash(str) {
  if (!str) {
    return str;
  }
  if (str.endsWith('/')) {
    str = str.substring(0, str.length - 1);
  }
  return str;
}

/**
 * Config keys that need to be loaded asynchronously.
 */
const asyncKeys = ['publicServerURL'];
class Config {
  static get(applicationId, mount) {
    const cacheInfo = _cache.default.get(applicationId);
    if (!cacheInfo) {
      return;
    }
    const config = new Config();
    config.applicationId = applicationId;
    Object.keys(cacheInfo).forEach(key => {
      if (key == 'databaseController') {
        config.database = new _DatabaseController.default(cacheInfo.databaseController.adapter, config);
      } else {
        config[key] = cacheInfo[key];
      }
    });
    config.mount = removeTrailingSlash(mount);
    config.generateSessionExpiresAt = config.generateSessionExpiresAt.bind(config);
    config.generateEmailVerifyTokenExpiresAt = config.generateEmailVerifyTokenExpiresAt.bind(config);
    config.version = _package.version;
    return config;
  }
  async loadKeys() {
    await Promise.all(asyncKeys.map(async key => {
      if (typeof this[`_${key}`] === 'function') {
        try {
          this[key] = await this[`_${key}`]();
        } catch (error) {
          throw new Error(`Failed to resolve async config key '${key}': ${error.message}`);
        }
      }
    }));
    const cachedConfig = _cache.default.get(this.appId);
    if (cachedConfig) {
      const updatedConfig = {
        ...cachedConfig
      };
      asyncKeys.forEach(key => {
        updatedConfig[key] = this[key];
      });
      _cache.default.put(this.appId, updatedConfig);
    }
  }
  static transformConfiguration(serverConfiguration) {
    for (const key of Object.keys(serverConfiguration)) {
      if (asyncKeys.includes(key) && typeof serverConfiguration[key] === 'function') {
        serverConfiguration[`_${key}`] = serverConfiguration[key];
        delete serverConfiguration[key];
      }
    }
  }
  static put(serverConfiguration) {
    Config.validateOptions(serverConfiguration);
    Config.validateControllers(serverConfiguration);
    Config.transformConfiguration(serverConfiguration);
    _cache.default.put(serverConfiguration.appId, serverConfiguration);
    Config.setupPasswordValidator(serverConfiguration.passwordPolicy);
    return serverConfiguration;
  }
  static validateOptions({
    customPages,
    publicServerURL,
    revokeSessionOnPasswordReset,
    expireInactiveSessions,
    sessionLength,
    defaultLimit,
    maxLimit,
    accountLockout,
    passwordPolicy,
    masterKeyIps,
    masterKey,
    maintenanceKey,
    maintenanceKeyIps,
    readOnlyMasterKey,
    allowHeaders,
    idempotencyOptions,
    fileUpload,
    pages,
    security,
    enforcePrivateUsers,
    enableInsecureAuthAdapters,
    schema,
    requestKeywordDenylist,
    allowExpiredAuthDataToken,
    logLevels,
    rateLimit,
    databaseOptions,
    extendSessionOnUse,
    allowClientClassCreation
  }) {
    if (masterKey === readOnlyMasterKey) {
      throw new Error('masterKey and readOnlyMasterKey should be different');
    }
    if (masterKey === maintenanceKey) {
      throw new Error('masterKey and maintenanceKey should be different');
    }
    this.validateAccountLockoutPolicy(accountLockout);
    this.validatePasswordPolicy(passwordPolicy);
    this.validateFileUploadOptions(fileUpload);
    if (typeof revokeSessionOnPasswordReset !== 'boolean') {
      throw 'revokeSessionOnPasswordReset must be a boolean value';
    }
    if (typeof extendSessionOnUse !== 'boolean') {
      throw 'extendSessionOnUse must be a boolean value';
    }
    this.validatePublicServerURL({
      publicServerURL
    });
    this.validateSessionConfiguration(sessionLength, expireInactiveSessions);
    this.validateIps('masterKeyIps', masterKeyIps);
    this.validateIps('maintenanceKeyIps', maintenanceKeyIps);
    this.validateDefaultLimit(defaultLimit);
    this.validateMaxLimit(maxLimit);
    this.validateAllowHeaders(allowHeaders);
    this.validateIdempotencyOptions(idempotencyOptions);
    this.validatePagesOptions(pages);
    this.validateSecurityOptions(security);
    this.validateSchemaOptions(schema);
    this.validateEnforcePrivateUsers(enforcePrivateUsers);
    this.validateEnableInsecureAuthAdapters(enableInsecureAuthAdapters);
    this.validateAllowExpiredAuthDataToken(allowExpiredAuthDataToken);
    this.validateRequestKeywordDenylist(requestKeywordDenylist);
    this.validateRateLimit(rateLimit);
    this.validateLogLevels(logLevels);
    this.validateDatabaseOptions(databaseOptions);
    this.validateCustomPages(customPages);
    this.validateAllowClientClassCreation(allowClientClassCreation);
  }
  static validateCustomPages(customPages) {
    if (!customPages) {
      return;
    }
    if (Object.prototype.toString.call(customPages) !== '[object Object]') {
      throw Error('Parse Server option customPages must be an object.');
    }
  }
  static validateControllers({
    verifyUserEmails,
    userController,
    appName,
    publicServerURL,
    _publicServerURL,
    emailVerifyTokenValidityDuration,
    emailVerifyTokenReuseIfValid
  }) {
    const emailAdapter = userController.adapter;
    if (verifyUserEmails) {
      this.validateEmailConfiguration({
        emailAdapter,
        appName,
        publicServerURL: publicServerURL || _publicServerURL,
        emailVerifyTokenValidityDuration,
        emailVerifyTokenReuseIfValid
      });
    }
  }
  static validateRequestKeywordDenylist(requestKeywordDenylist) {
    if (requestKeywordDenylist === undefined) {
      requestKeywordDenylist = requestKeywordDenylist.default;
    } else if (!Array.isArray(requestKeywordDenylist)) {
      throw 'Parse Server option requestKeywordDenylist must be an array.';
    }
  }
  static validateEnforcePrivateUsers(enforcePrivateUsers) {
    if (typeof enforcePrivateUsers !== 'boolean') {
      throw 'Parse Server option enforcePrivateUsers must be a boolean.';
    }
  }
  static validateAllowExpiredAuthDataToken(allowExpiredAuthDataToken) {
    if (typeof allowExpiredAuthDataToken !== 'boolean') {
      throw 'Parse Server option allowExpiredAuthDataToken must be a boolean.';
    }
  }
  static validateAllowClientClassCreation(allowClientClassCreation) {
    if (typeof allowClientClassCreation !== 'boolean') {
      throw 'Parse Server option allowClientClassCreation must be a boolean.';
    }
  }
  static validateSecurityOptions(security) {
    if (Object.prototype.toString.call(security) !== '[object Object]') {
      throw 'Parse Server option security must be an object.';
    }
    if (security.enableCheck === undefined) {
      security.enableCheck = _Definitions.SecurityOptions.enableCheck.default;
    } else if (!(0, _lodash.isBoolean)(security.enableCheck)) {
      throw 'Parse Server option security.enableCheck must be a boolean.';
    }
    if (security.enableCheckLog === undefined) {
      security.enableCheckLog = _Definitions.SecurityOptions.enableCheckLog.default;
    } else if (!(0, _lodash.isBoolean)(security.enableCheckLog)) {
      throw 'Parse Server option security.enableCheckLog must be a boolean.';
    }
  }
  static validateSchemaOptions(schema) {
    if (!schema) {
      return;
    }
    if (Object.prototype.toString.call(schema) !== '[object Object]') {
      throw 'Parse Server option schema must be an object.';
    }
    if (schema.definitions === undefined) {
      schema.definitions = _Definitions.SchemaOptions.definitions.default;
    } else if (!Array.isArray(schema.definitions)) {
      throw 'Parse Server option schema.definitions must be an array.';
    }
    if (schema.strict === undefined) {
      schema.strict = _Definitions.SchemaOptions.strict.default;
    } else if (!(0, _lodash.isBoolean)(schema.strict)) {
      throw 'Parse Server option schema.strict must be a boolean.';
    }
    if (schema.deleteExtraFields === undefined) {
      schema.deleteExtraFields = _Definitions.SchemaOptions.deleteExtraFields.default;
    } else if (!(0, _lodash.isBoolean)(schema.deleteExtraFields)) {
      throw 'Parse Server option schema.deleteExtraFields must be a boolean.';
    }
    if (schema.recreateModifiedFields === undefined) {
      schema.recreateModifiedFields = _Definitions.SchemaOptions.recreateModifiedFields.default;
    } else if (!(0, _lodash.isBoolean)(schema.recreateModifiedFields)) {
      throw 'Parse Server option schema.recreateModifiedFields must be a boolean.';
    }
    if (schema.lockSchemas === undefined) {
      schema.lockSchemas = _Definitions.SchemaOptions.lockSchemas.default;
    } else if (!(0, _lodash.isBoolean)(schema.lockSchemas)) {
      throw 'Parse Server option schema.lockSchemas must be a boolean.';
    }
    if (schema.beforeMigration === undefined) {
      schema.beforeMigration = null;
    } else if (schema.beforeMigration !== null && typeof schema.beforeMigration !== 'function') {
      throw 'Parse Server option schema.beforeMigration must be a function.';
    }
    if (schema.afterMigration === undefined) {
      schema.afterMigration = null;
    } else if (schema.afterMigration !== null && typeof schema.afterMigration !== 'function') {
      throw 'Parse Server option schema.afterMigration must be a function.';
    }
  }
  static validatePagesOptions(pages) {
    if (Object.prototype.toString.call(pages) !== '[object Object]') {
      throw 'Parse Server option pages must be an object.';
    }
    if (pages.enableRouter === undefined) {
      pages.enableRouter = _Definitions.PagesOptions.enableRouter.default;
    } else if (!(0, _lodash.isBoolean)(pages.enableRouter)) {
      throw 'Parse Server option pages.enableRouter must be a boolean.';
    }
    if (pages.enableLocalization === undefined) {
      pages.enableLocalization = _Definitions.PagesOptions.enableLocalization.default;
    } else if (!(0, _lodash.isBoolean)(pages.enableLocalization)) {
      throw 'Parse Server option pages.enableLocalization must be a boolean.';
    }
    if (pages.localizationJsonPath === undefined) {
      pages.localizationJsonPath = _Definitions.PagesOptions.localizationJsonPath.default;
    } else if (!(0, _lodash.isString)(pages.localizationJsonPath)) {
      throw 'Parse Server option pages.localizationJsonPath must be a string.';
    }
    if (pages.localizationFallbackLocale === undefined) {
      pages.localizationFallbackLocale = _Definitions.PagesOptions.localizationFallbackLocale.default;
    } else if (!(0, _lodash.isString)(pages.localizationFallbackLocale)) {
      throw 'Parse Server option pages.localizationFallbackLocale must be a string.';
    }
    if (pages.placeholders === undefined) {
      pages.placeholders = _Definitions.PagesOptions.placeholders.default;
    } else if (Object.prototype.toString.call(pages.placeholders) !== '[object Object]' && typeof pages.placeholders !== 'function') {
      throw 'Parse Server option pages.placeholders must be an object or a function.';
    }
    if (pages.forceRedirect === undefined) {
      pages.forceRedirect = _Definitions.PagesOptions.forceRedirect.default;
    } else if (!(0, _lodash.isBoolean)(pages.forceRedirect)) {
      throw 'Parse Server option pages.forceRedirect must be a boolean.';
    }
    if (pages.pagesPath === undefined) {
      pages.pagesPath = _Definitions.PagesOptions.pagesPath.default;
    } else if (!(0, _lodash.isString)(pages.pagesPath)) {
      throw 'Parse Server option pages.pagesPath must be a string.';
    }
    if (pages.pagesEndpoint === undefined) {
      pages.pagesEndpoint = _Definitions.PagesOptions.pagesEndpoint.default;
    } else if (!(0, _lodash.isString)(pages.pagesEndpoint)) {
      throw 'Parse Server option pages.pagesEndpoint must be a string.';
    }
    if (pages.customUrls === undefined) {
      pages.customUrls = _Definitions.PagesOptions.customUrls.default;
    } else if (Object.prototype.toString.call(pages.customUrls) !== '[object Object]') {
      throw 'Parse Server option pages.customUrls must be an object.';
    }
    if (pages.customRoutes === undefined) {
      pages.customRoutes = _Definitions.PagesOptions.customRoutes.default;
    } else if (!(pages.customRoutes instanceof Array)) {
      throw 'Parse Server option pages.customRoutes must be an array.';
    }
  }
  static validateIdempotencyOptions(idempotencyOptions) {
    if (!idempotencyOptions) {
      return;
    }
    if (idempotencyOptions.ttl === undefined) {
      idempotencyOptions.ttl = _Definitions.IdempotencyOptions.ttl.default;
    } else if (!isNaN(idempotencyOptions.ttl) && idempotencyOptions.ttl <= 0) {
      throw 'idempotency TTL value must be greater than 0 seconds';
    } else if (isNaN(idempotencyOptions.ttl)) {
      throw 'idempotency TTL value must be a number';
    }
    if (!idempotencyOptions.paths) {
      idempotencyOptions.paths = _Definitions.IdempotencyOptions.paths.default;
    } else if (!(idempotencyOptions.paths instanceof Array)) {
      throw 'idempotency paths must be of an array of strings';
    }
  }
  static validateAccountLockoutPolicy(accountLockout) {
    if (accountLockout) {
      if (typeof accountLockout.duration !== 'number' || accountLockout.duration <= 0 || accountLockout.duration > 99999) {
        throw 'Account lockout duration should be greater than 0 and less than 100000';
      }
      if (!Number.isInteger(accountLockout.threshold) || accountLockout.threshold < 1 || accountLockout.threshold > 999) {
        throw 'Account lockout threshold should be an integer greater than 0 and less than 1000';
      }
      if (accountLockout.unlockOnPasswordReset === undefined) {
        accountLockout.unlockOnPasswordReset = _Definitions.AccountLockoutOptions.unlockOnPasswordReset.default;
      } else if (!(0, _lodash.isBoolean)(accountLockout.unlockOnPasswordReset)) {
        throw 'Parse Server option accountLockout.unlockOnPasswordReset must be a boolean.';
      }
    }
  }
  static validatePasswordPolicy(passwordPolicy) {
    if (passwordPolicy) {
      if (passwordPolicy.maxPasswordAge !== undefined && (typeof passwordPolicy.maxPasswordAge !== 'number' || passwordPolicy.maxPasswordAge < 0)) {
        throw 'passwordPolicy.maxPasswordAge must be a positive number';
      }
      if (passwordPolicy.resetTokenValidityDuration !== undefined && (typeof passwordPolicy.resetTokenValidityDuration !== 'number' || passwordPolicy.resetTokenValidityDuration <= 0)) {
        throw 'passwordPolicy.resetTokenValidityDuration must be a positive number';
      }
      if (passwordPolicy.validatorPattern) {
        if (typeof passwordPolicy.validatorPattern === 'string') {
          passwordPolicy.validatorPattern = new RegExp(passwordPolicy.validatorPattern);
        } else if (!(passwordPolicy.validatorPattern instanceof RegExp)) {
          throw 'passwordPolicy.validatorPattern must be a regex string or RegExp object.';
        }
      }
      if (passwordPolicy.validatorCallback && typeof passwordPolicy.validatorCallback !== 'function') {
        throw 'passwordPolicy.validatorCallback must be a function.';
      }
      if (passwordPolicy.doNotAllowUsername && typeof passwordPolicy.doNotAllowUsername !== 'boolean') {
        throw 'passwordPolicy.doNotAllowUsername must be a boolean value.';
      }
      if (passwordPolicy.maxPasswordHistory && (!Number.isInteger(passwordPolicy.maxPasswordHistory) || passwordPolicy.maxPasswordHistory <= 0 || passwordPolicy.maxPasswordHistory > 20)) {
        throw 'passwordPolicy.maxPasswordHistory must be an integer ranging 0 - 20';
      }
      if (passwordPolicy.resetTokenReuseIfValid && typeof passwordPolicy.resetTokenReuseIfValid !== 'boolean') {
        throw 'resetTokenReuseIfValid must be a boolean value';
      }
      if (passwordPolicy.resetTokenReuseIfValid && !passwordPolicy.resetTokenValidityDuration) {
        throw 'You cannot use resetTokenReuseIfValid without resetTokenValidityDuration';
      }
      if (passwordPolicy.resetPasswordSuccessOnInvalidEmail && typeof passwordPolicy.resetPasswordSuccessOnInvalidEmail !== 'boolean') {
        throw 'resetPasswordSuccessOnInvalidEmail must be a boolean value';
      }
    }
  }

  // if the passwordPolicy.validatorPattern is configured then setup a callback to process the pattern
  static setupPasswordValidator(passwordPolicy) {
    if (passwordPolicy && passwordPolicy.validatorPattern) {
      passwordPolicy.patternValidator = value => {
        return passwordPolicy.validatorPattern.test(value);
      };
    }
  }
  static validatePublicServerURL({
    publicServerURL,
    required = false
  }) {
    if (!publicServerURL) {
      if (!required) {
        return;
      }
      throw 'The option publicServerURL is required.';
    }
    const type = typeof publicServerURL;
    if (type === 'string') {
      if (!publicServerURL.startsWith('http://') && !publicServerURL.startsWith('https://')) {
        throw 'The option publicServerURL must be a valid URL starting with http:// or https://.';
      }
      return;
    }
    if (type === 'function') {
      return;
    }
    throw `The option publicServerURL must be a string or function, but got ${type}.`;
  }
  static validateEmailConfiguration({
    emailAdapter,
    appName,
    publicServerURL,
    emailVerifyTokenValidityDuration,
    emailVerifyTokenReuseIfValid
  }) {
    if (!emailAdapter) {
      throw 'An emailAdapter is required for e-mail verification and password resets.';
    }
    if (typeof appName !== 'string') {
      throw 'An app name is required for e-mail verification and password resets.';
    }
    this.validatePublicServerURL({
      publicServerURL,
      required: true
    });
    if (emailVerifyTokenValidityDuration) {
      if (isNaN(emailVerifyTokenValidityDuration)) {
        throw 'Email verify token validity duration must be a valid number.';
      } else if (emailVerifyTokenValidityDuration <= 0) {
        throw 'Email verify token validity duration must be a value greater than 0.';
      }
    }
    if (emailVerifyTokenReuseIfValid && typeof emailVerifyTokenReuseIfValid !== 'boolean') {
      throw 'emailVerifyTokenReuseIfValid must be a boolean value';
    }
    if (emailVerifyTokenReuseIfValid && !emailVerifyTokenValidityDuration) {
      throw 'You cannot use emailVerifyTokenReuseIfValid without emailVerifyTokenValidityDuration';
    }
  }
  static validateFileUploadOptions(fileUpload) {
    try {
      if (fileUpload == null || typeof fileUpload !== 'object' || fileUpload instanceof Array) {
        throw 'fileUpload must be an object value.';
      }
    } catch (e) {
      if (e instanceof ReferenceError) {
        return;
      }
      throw e;
    }
    if (fileUpload.enableForAnonymousUser === undefined) {
      fileUpload.enableForAnonymousUser = _Definitions.FileUploadOptions.enableForAnonymousUser.default;
    } else if (typeof fileUpload.enableForAnonymousUser !== 'boolean') {
      throw 'fileUpload.enableForAnonymousUser must be a boolean value.';
    }
    if (fileUpload.enableForPublic === undefined) {
      fileUpload.enableForPublic = _Definitions.FileUploadOptions.enableForPublic.default;
    } else if (typeof fileUpload.enableForPublic !== 'boolean') {
      throw 'fileUpload.enableForPublic must be a boolean value.';
    }
    if (fileUpload.enableForAuthenticatedUser === undefined) {
      fileUpload.enableForAuthenticatedUser = _Definitions.FileUploadOptions.enableForAuthenticatedUser.default;
    } else if (typeof fileUpload.enableForAuthenticatedUser !== 'boolean') {
      throw 'fileUpload.enableForAuthenticatedUser must be a boolean value.';
    }
    if (fileUpload.fileExtensions === undefined) {
      fileUpload.fileExtensions = _Definitions.FileUploadOptions.fileExtensions.default;
    } else if (!Array.isArray(fileUpload.fileExtensions)) {
      throw 'fileUpload.fileExtensions must be an array.';
    }
  }
  static validateIps(field, masterKeyIps) {
    for (let ip of masterKeyIps) {
      if (ip.includes('/')) {
        ip = ip.split('/')[0];
      }
      if (!_net.default.isIP(ip)) {
        throw `The Parse Server option "${field}" contains an invalid IP address "${ip}".`;
      }
    }
  }
  static validateEnableInsecureAuthAdapters(enableInsecureAuthAdapters) {
    if (enableInsecureAuthAdapters && typeof enableInsecureAuthAdapters !== 'boolean') {
      throw 'Parse Server option enableInsecureAuthAdapters must be a boolean.';
    }
    if (enableInsecureAuthAdapters) {
      _Deprecator.default.logRuntimeDeprecation({
        usage: 'insecure adapter'
      });
    }
  }
  get mount() {
    var mount = this._mount;
    if (this.publicServerURL) {
      mount = this.publicServerURL;
    }
    return mount;
  }
  set mount(newValue) {
    this._mount = newValue;
  }
  static validateSessionConfiguration(sessionLength, expireInactiveSessions) {
    if (expireInactiveSessions) {
      if (isNaN(sessionLength)) {
        throw 'Session length must be a valid number.';
      } else if (sessionLength <= 0) {
        throw 'Session length must be a value greater than 0.';
      }
    }
  }
  static validateDefaultLimit(defaultLimit) {
    if (defaultLimit == null) {
      defaultLimit = _Definitions.ParseServerOptions.defaultLimit.default;
    }
    if (typeof defaultLimit !== 'number') {
      throw 'Default limit must be a number.';
    }
    if (defaultLimit <= 0) {
      throw 'Default limit must be a value greater than 0.';
    }
  }
  static validateMaxLimit(maxLimit) {
    if (maxLimit <= 0) {
      throw 'Max limit must be a value greater than 0.';
    }
  }
  static validateAllowHeaders(allowHeaders) {
    if (![null, undefined].includes(allowHeaders)) {
      if (Array.isArray(allowHeaders)) {
        allowHeaders.forEach(header => {
          if (typeof header !== 'string') {
            throw 'Allow headers must only contain strings';
          } else if (!header.trim().length) {
            throw 'Allow headers must not contain empty strings';
          }
        });
      } else {
        throw 'Allow headers must be an array';
      }
    }
  }
  static validateLogLevels(logLevels) {
    for (const key of Object.keys(_Definitions.LogLevels)) {
      if (logLevels[key]) {
        if (_LoggerController.logLevels.indexOf(logLevels[key]) === -1) {
          throw `'${key}' must be one of ${JSON.stringify(_LoggerController.logLevels)}`;
        }
      } else {
        logLevels[key] = _Definitions.LogLevels[key].default;
      }
    }
  }
  static validateDatabaseOptions(databaseOptions) {
    if (databaseOptions == undefined) {
      return;
    }
    if (Object.prototype.toString.call(databaseOptions) !== '[object Object]') {
      throw `databaseOptions must be an object`;
    }
    if (databaseOptions.enableSchemaHooks === undefined) {
      databaseOptions.enableSchemaHooks = _Definitions.DatabaseOptions.enableSchemaHooks.default;
    } else if (typeof databaseOptions.enableSchemaHooks !== 'boolean') {
      throw `databaseOptions.enableSchemaHooks must be a boolean`;
    }
    if (databaseOptions.schemaCacheTtl === undefined) {
      databaseOptions.schemaCacheTtl = _Definitions.DatabaseOptions.schemaCacheTtl.default;
    } else if (typeof databaseOptions.schemaCacheTtl !== 'number') {
      throw `databaseOptions.schemaCacheTtl must be a number`;
    }
    if (databaseOptions.allowPublicExplain === undefined) {
      databaseOptions.allowPublicExplain = _Definitions.DatabaseOptions.allowPublicExplain.default;
    } else if (typeof databaseOptions.allowPublicExplain !== 'boolean') {
      throw `Parse Server option 'databaseOptions.allowPublicExplain' must be a boolean.`;
    }
  }
  static validateRateLimit(rateLimit) {
    if (!rateLimit) {
      return;
    }
    if (Object.prototype.toString.call(rateLimit) !== '[object Object]' && !Array.isArray(rateLimit)) {
      throw `rateLimit must be an array or object`;
    }
    const options = Array.isArray(rateLimit) ? rateLimit : [rateLimit];
    for (const option of options) {
      if (Object.prototype.toString.call(option) !== '[object Object]') {
        throw `rateLimit must be an array of objects`;
      }
      if (option.requestPath == null) {
        throw `rateLimit.requestPath must be defined`;
      }
      if (typeof option.requestPath !== 'string') {
        throw `rateLimit.requestPath must be a string`;
      }
      if (option.requestTimeWindow == null) {
        throw `rateLimit.requestTimeWindow must be defined`;
      }
      if (typeof option.requestTimeWindow !== 'number') {
        throw `rateLimit.requestTimeWindow must be a number`;
      }
      if (option.includeInternalRequests && typeof option.includeInternalRequests !== 'boolean') {
        throw `rateLimit.includeInternalRequests must be a boolean`;
      }
      if (option.requestCount == null) {
        throw `rateLimit.requestCount must be defined`;
      }
      if (typeof option.requestCount !== 'number') {
        throw `rateLimit.requestCount must be a number`;
      }
      if (option.errorResponseMessage && typeof option.errorResponseMessage !== 'string') {
        throw `rateLimit.errorResponseMessage must be a string`;
      }
      const options = Object.keys(_Parse.default.RateLimitZone);
      if (option.zone && !options.includes(option.zone)) {
        const formatter = new Intl.ListFormat('en', {
          style: 'short',
          type: 'disjunction'
        });
        throw `rateLimit.zone must be one of ${formatter.format(options)}`;
      }
    }
  }
  generateEmailVerifyTokenExpiresAt() {
    if (!this.verifyUserEmails || !this.emailVerifyTokenValidityDuration) {
      return undefined;
    }
    var now = new Date();
    return new Date(now.getTime() + this.emailVerifyTokenValidityDuration * 1000);
  }
  generatePasswordResetTokenExpiresAt() {
    if (!this.passwordPolicy || !this.passwordPolicy.resetTokenValidityDuration) {
      return undefined;
    }
    const now = new Date();
    return new Date(now.getTime() + this.passwordPolicy.resetTokenValidityDuration * 1000);
  }
  generateSessionExpiresAt() {
    if (!this.expireInactiveSessions) {
      return undefined;
    }
    var now = new Date();
    return new Date(now.getTime() + this.sessionLength * 1000);
  }
  unregisterRateLimiters() {
    let i = this.rateLimits?.length;
    while (i--) {
      const limit = this.rateLimits[i];
      if (limit.cloud) {
        this.rateLimits.splice(i, 1);
      }
    }
  }
  get invalidLinkURL() {
    return this.customPages.invalidLink || `${this.publicServerURL}/apps/invalid_link.html`;
  }
  get invalidVerificationLinkURL() {
    return this.customPages.invalidVerificationLink || `${this.publicServerURL}/apps/invalid_verification_link.html`;
  }
  get linkSendSuccessURL() {
    return this.customPages.linkSendSuccess || `${this.publicServerURL}/apps/link_send_success.html`;
  }
  get linkSendFailURL() {
    return this.customPages.linkSendFail || `${this.publicServerURL}/apps/link_send_fail.html`;
  }
  get verifyEmailSuccessURL() {
    return this.customPages.verifyEmailSuccess || `${this.publicServerURL}/apps/verify_email_success.html`;
  }
  get choosePasswordURL() {
    return this.customPages.choosePassword || `${this.publicServerURL}/apps/choose_password`;
  }
  get requestResetPasswordURL() {
    return `${this.publicServerURL}/${this.pagesEndpoint}/${this.applicationId}/request_password_reset`;
  }
  get passwordResetSuccessURL() {
    return this.customPages.passwordResetSuccess || `${this.publicServerURL}/apps/password_reset_success.html`;
  }
  get parseFrameURL() {
    return this.customPages.parseFrameURL;
  }
  get verifyEmailURL() {
    return `${this.publicServerURL}/${this.pagesEndpoint}/${this.applicationId}/verify_email`;
  }
  async loadMasterKey() {
    if (typeof this.masterKey === 'function') {
      const ttlIsEmpty = !this.masterKeyTtl;
      const isExpired = this.masterKeyCache?.expiresAt && this.masterKeyCache.expiresAt < new Date();
      if ((!isExpired || ttlIsEmpty) && this.masterKeyCache?.masterKey) {
        return this.masterKeyCache.masterKey;
      }
      const masterKey = await this.masterKey();
      const expiresAt = this.masterKeyTtl ? new Date(Date.now() + 1000 * this.masterKeyTtl) : null;
      this.masterKeyCache = {
        masterKey,
        expiresAt
      };
      Config.put(this);
      return this.masterKeyCache.masterKey;
    }
    return this.masterKey;
  }

  // TODO: Remove this function once PagesRouter replaces the PublicAPIRouter;
  // the (default) endpoint has to be defined in PagesRouter only.
  get pagesEndpoint() {
    return this.pages && this.pages.enableRouter && this.pages.pagesEndpoint ? this.pages.pagesEndpoint : 'apps';
  }
}
exports.Config = Config;
var _default = exports.default = Config;
module.exports = Config;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbG9kYXNoIiwicmVxdWlyZSIsIl9uZXQiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwiX2NhY2hlIiwiX0RhdGFiYXNlQ29udHJvbGxlciIsIl9Mb2dnZXJDb250cm9sbGVyIiwiX3BhY2thZ2UiLCJfRGVmaW5pdGlvbnMiLCJfUGFyc2UiLCJfRGVwcmVjYXRvciIsImUiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsInJlbW92ZVRyYWlsaW5nU2xhc2giLCJzdHIiLCJlbmRzV2l0aCIsInN1YnN0cmluZyIsImxlbmd0aCIsImFzeW5jS2V5cyIsIkNvbmZpZyIsImdldCIsImFwcGxpY2F0aW9uSWQiLCJtb3VudCIsImNhY2hlSW5mbyIsIkFwcENhY2hlIiwiY29uZmlnIiwiT2JqZWN0Iiwia2V5cyIsImZvckVhY2giLCJrZXkiLCJkYXRhYmFzZSIsIkRhdGFiYXNlQ29udHJvbGxlciIsImRhdGFiYXNlQ29udHJvbGxlciIsImFkYXB0ZXIiLCJnZW5lcmF0ZVNlc3Npb25FeHBpcmVzQXQiLCJiaW5kIiwiZ2VuZXJhdGVFbWFpbFZlcmlmeVRva2VuRXhwaXJlc0F0IiwidmVyc2lvbiIsImxvYWRLZXlzIiwiUHJvbWlzZSIsImFsbCIsIm1hcCIsImVycm9yIiwiRXJyb3IiLCJtZXNzYWdlIiwiY2FjaGVkQ29uZmlnIiwiYXBwSWQiLCJ1cGRhdGVkQ29uZmlnIiwicHV0IiwidHJhbnNmb3JtQ29uZmlndXJhdGlvbiIsInNlcnZlckNvbmZpZ3VyYXRpb24iLCJpbmNsdWRlcyIsInZhbGlkYXRlT3B0aW9ucyIsInZhbGlkYXRlQ29udHJvbGxlcnMiLCJzZXR1cFBhc3N3b3JkVmFsaWRhdG9yIiwicGFzc3dvcmRQb2xpY3kiLCJjdXN0b21QYWdlcyIsInB1YmxpY1NlcnZlclVSTCIsInJldm9rZVNlc3Npb25PblBhc3N3b3JkUmVzZXQiLCJleHBpcmVJbmFjdGl2ZVNlc3Npb25zIiwic2Vzc2lvbkxlbmd0aCIsImRlZmF1bHRMaW1pdCIsIm1heExpbWl0IiwiYWNjb3VudExvY2tvdXQiLCJtYXN0ZXJLZXlJcHMiLCJtYXN0ZXJLZXkiLCJtYWludGVuYW5jZUtleSIsIm1haW50ZW5hbmNlS2V5SXBzIiwicmVhZE9ubHlNYXN0ZXJLZXkiLCJhbGxvd0hlYWRlcnMiLCJpZGVtcG90ZW5jeU9wdGlvbnMiLCJmaWxlVXBsb2FkIiwicGFnZXMiLCJzZWN1cml0eSIsImVuZm9yY2VQcml2YXRlVXNlcnMiLCJlbmFibGVJbnNlY3VyZUF1dGhBZGFwdGVycyIsInNjaGVtYSIsInJlcXVlc3RLZXl3b3JkRGVueWxpc3QiLCJhbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuIiwibG9nTGV2ZWxzIiwicmF0ZUxpbWl0IiwiZGF0YWJhc2VPcHRpb25zIiwiZXh0ZW5kU2Vzc2lvbk9uVXNlIiwiYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uIiwidmFsaWRhdGVBY2NvdW50TG9ja291dFBvbGljeSIsInZhbGlkYXRlUGFzc3dvcmRQb2xpY3kiLCJ2YWxpZGF0ZUZpbGVVcGxvYWRPcHRpb25zIiwidmFsaWRhdGVQdWJsaWNTZXJ2ZXJVUkwiLCJ2YWxpZGF0ZVNlc3Npb25Db25maWd1cmF0aW9uIiwidmFsaWRhdGVJcHMiLCJ2YWxpZGF0ZURlZmF1bHRMaW1pdCIsInZhbGlkYXRlTWF4TGltaXQiLCJ2YWxpZGF0ZUFsbG93SGVhZGVycyIsInZhbGlkYXRlSWRlbXBvdGVuY3lPcHRpb25zIiwidmFsaWRhdGVQYWdlc09wdGlvbnMiLCJ2YWxpZGF0ZVNlY3VyaXR5T3B0aW9ucyIsInZhbGlkYXRlU2NoZW1hT3B0aW9ucyIsInZhbGlkYXRlRW5mb3JjZVByaXZhdGVVc2VycyIsInZhbGlkYXRlRW5hYmxlSW5zZWN1cmVBdXRoQWRhcHRlcnMiLCJ2YWxpZGF0ZUFsbG93RXhwaXJlZEF1dGhEYXRhVG9rZW4iLCJ2YWxpZGF0ZVJlcXVlc3RLZXl3b3JkRGVueWxpc3QiLCJ2YWxpZGF0ZVJhdGVMaW1pdCIsInZhbGlkYXRlTG9nTGV2ZWxzIiwidmFsaWRhdGVEYXRhYmFzZU9wdGlvbnMiLCJ2YWxpZGF0ZUN1c3RvbVBhZ2VzIiwidmFsaWRhdGVBbGxvd0NsaWVudENsYXNzQ3JlYXRpb24iLCJwcm90b3R5cGUiLCJ0b1N0cmluZyIsImNhbGwiLCJ2ZXJpZnlVc2VyRW1haWxzIiwidXNlckNvbnRyb2xsZXIiLCJhcHBOYW1lIiwiX3B1YmxpY1NlcnZlclVSTCIsImVtYWlsVmVyaWZ5VG9rZW5WYWxpZGl0eUR1cmF0aW9uIiwiZW1haWxWZXJpZnlUb2tlblJldXNlSWZWYWxpZCIsImVtYWlsQWRhcHRlciIsInZhbGlkYXRlRW1haWxDb25maWd1cmF0aW9uIiwidW5kZWZpbmVkIiwiQXJyYXkiLCJpc0FycmF5IiwiZW5hYmxlQ2hlY2siLCJTZWN1cml0eU9wdGlvbnMiLCJpc0Jvb2xlYW4iLCJlbmFibGVDaGVja0xvZyIsImRlZmluaXRpb25zIiwiU2NoZW1hT3B0aW9ucyIsInN0cmljdCIsImRlbGV0ZUV4dHJhRmllbGRzIiwicmVjcmVhdGVNb2RpZmllZEZpZWxkcyIsImxvY2tTY2hlbWFzIiwiYmVmb3JlTWlncmF0aW9uIiwiYWZ0ZXJNaWdyYXRpb24iLCJlbmFibGVSb3V0ZXIiLCJQYWdlc09wdGlvbnMiLCJlbmFibGVMb2NhbGl6YXRpb24iLCJsb2NhbGl6YXRpb25Kc29uUGF0aCIsImlzU3RyaW5nIiwibG9jYWxpemF0aW9uRmFsbGJhY2tMb2NhbGUiLCJwbGFjZWhvbGRlcnMiLCJmb3JjZVJlZGlyZWN0IiwicGFnZXNQYXRoIiwicGFnZXNFbmRwb2ludCIsImN1c3RvbVVybHMiLCJjdXN0b21Sb3V0ZXMiLCJ0dGwiLCJJZGVtcG90ZW5jeU9wdGlvbnMiLCJpc05hTiIsInBhdGhzIiwiZHVyYXRpb24iLCJOdW1iZXIiLCJpc0ludGVnZXIiLCJ0aHJlc2hvbGQiLCJ1bmxvY2tPblBhc3N3b3JkUmVzZXQiLCJBY2NvdW50TG9ja291dE9wdGlvbnMiLCJtYXhQYXNzd29yZEFnZSIsInJlc2V0VG9rZW5WYWxpZGl0eUR1cmF0aW9uIiwidmFsaWRhdG9yUGF0dGVybiIsIlJlZ0V4cCIsInZhbGlkYXRvckNhbGxiYWNrIiwiZG9Ob3RBbGxvd1VzZXJuYW1lIiwibWF4UGFzc3dvcmRIaXN0b3J5IiwicmVzZXRUb2tlblJldXNlSWZWYWxpZCIsInJlc2V0UGFzc3dvcmRTdWNjZXNzT25JbnZhbGlkRW1haWwiLCJwYXR0ZXJuVmFsaWRhdG9yIiwidmFsdWUiLCJ0ZXN0IiwicmVxdWlyZWQiLCJ0eXBlIiwic3RhcnRzV2l0aCIsIlJlZmVyZW5jZUVycm9yIiwiZW5hYmxlRm9yQW5vbnltb3VzVXNlciIsIkZpbGVVcGxvYWRPcHRpb25zIiwiZW5hYmxlRm9yUHVibGljIiwiZW5hYmxlRm9yQXV0aGVudGljYXRlZFVzZXIiLCJmaWxlRXh0ZW5zaW9ucyIsImZpZWxkIiwiaXAiLCJzcGxpdCIsIm5ldCIsImlzSVAiLCJEZXByZWNhdG9yIiwibG9nUnVudGltZURlcHJlY2F0aW9uIiwidXNhZ2UiLCJfbW91bnQiLCJuZXdWYWx1ZSIsIlBhcnNlU2VydmVyT3B0aW9ucyIsImhlYWRlciIsInRyaW0iLCJMb2dMZXZlbHMiLCJ2YWxpZExvZ0xldmVscyIsImluZGV4T2YiLCJKU09OIiwic3RyaW5naWZ5IiwiZW5hYmxlU2NoZW1hSG9va3MiLCJEYXRhYmFzZU9wdGlvbnMiLCJzY2hlbWFDYWNoZVR0bCIsImFsbG93UHVibGljRXhwbGFpbiIsIm9wdGlvbnMiLCJvcHRpb24iLCJyZXF1ZXN0UGF0aCIsInJlcXVlc3RUaW1lV2luZG93IiwiaW5jbHVkZUludGVybmFsUmVxdWVzdHMiLCJyZXF1ZXN0Q291bnQiLCJlcnJvclJlc3BvbnNlTWVzc2FnZSIsIlBhcnNlU2VydmVyIiwiUmF0ZUxpbWl0Wm9uZSIsInpvbmUiLCJmb3JtYXR0ZXIiLCJJbnRsIiwiTGlzdEZvcm1hdCIsInN0eWxlIiwiZm9ybWF0Iiwibm93IiwiRGF0ZSIsImdldFRpbWUiLCJnZW5lcmF0ZVBhc3N3b3JkUmVzZXRUb2tlbkV4cGlyZXNBdCIsInVucmVnaXN0ZXJSYXRlTGltaXRlcnMiLCJpIiwicmF0ZUxpbWl0cyIsImxpbWl0IiwiY2xvdWQiLCJzcGxpY2UiLCJpbnZhbGlkTGlua1VSTCIsImludmFsaWRMaW5rIiwiaW52YWxpZFZlcmlmaWNhdGlvbkxpbmtVUkwiLCJpbnZhbGlkVmVyaWZpY2F0aW9uTGluayIsImxpbmtTZW5kU3VjY2Vzc1VSTCIsImxpbmtTZW5kU3VjY2VzcyIsImxpbmtTZW5kRmFpbFVSTCIsImxpbmtTZW5kRmFpbCIsInZlcmlmeUVtYWlsU3VjY2Vzc1VSTCIsInZlcmlmeUVtYWlsU3VjY2VzcyIsImNob29zZVBhc3N3b3JkVVJMIiwiY2hvb3NlUGFzc3dvcmQiLCJyZXF1ZXN0UmVzZXRQYXNzd29yZFVSTCIsInBhc3N3b3JkUmVzZXRTdWNjZXNzVVJMIiwicGFzc3dvcmRSZXNldFN1Y2Nlc3MiLCJwYXJzZUZyYW1lVVJMIiwidmVyaWZ5RW1haWxVUkwiLCJsb2FkTWFzdGVyS2V5IiwidHRsSXNFbXB0eSIsIm1hc3RlcktleVR0bCIsImlzRXhwaXJlZCIsIm1hc3RlcktleUNhY2hlIiwiZXhwaXJlc0F0IiwiZXhwb3J0cyIsIl9kZWZhdWx0IiwibW9kdWxlIl0sInNvdXJjZXMiOlsiLi4vc3JjL0NvbmZpZy5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBBIENvbmZpZyBvYmplY3QgcHJvdmlkZXMgaW5mb3JtYXRpb24gYWJvdXQgaG93IGEgc3BlY2lmaWMgYXBwIGlzXG4vLyBjb25maWd1cmVkLlxuLy8gbW91bnQgaXMgdGhlIFVSTCBmb3IgdGhlIHJvb3Qgb2YgdGhlIEFQSTsgaW5jbHVkZXMgaHR0cCwgZG9tYWluLCBldGMuXG5cbmltcG9ydCB7IGlzQm9vbGVhbiwgaXNTdHJpbmcgfSBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IG5ldCBmcm9tICduZXQnO1xuaW1wb3J0IEFwcENhY2hlIGZyb20gJy4vY2FjaGUnO1xuaW1wb3J0IERhdGFiYXNlQ29udHJvbGxlciBmcm9tICcuL0NvbnRyb2xsZXJzL0RhdGFiYXNlQ29udHJvbGxlcic7XG5pbXBvcnQgeyBsb2dMZXZlbHMgYXMgdmFsaWRMb2dMZXZlbHMgfSBmcm9tICcuL0NvbnRyb2xsZXJzL0xvZ2dlckNvbnRyb2xsZXInO1xuaW1wb3J0IHsgdmVyc2lvbiB9IGZyb20gJy4uL3BhY2thZ2UuanNvbic7XG5pbXBvcnQge1xuICBBY2NvdW50TG9ja291dE9wdGlvbnMsXG4gIERhdGFiYXNlT3B0aW9ucyxcbiAgRmlsZVVwbG9hZE9wdGlvbnMsXG4gIElkZW1wb3RlbmN5T3B0aW9ucyxcbiAgTG9nTGV2ZWxzLFxuICBQYWdlc09wdGlvbnMsXG4gIFBhcnNlU2VydmVyT3B0aW9ucyxcbiAgU2NoZW1hT3B0aW9ucyxcbiAgU2VjdXJpdHlPcHRpb25zLFxufSBmcm9tICcuL09wdGlvbnMvRGVmaW5pdGlvbnMnO1xuaW1wb3J0IFBhcnNlU2VydmVyIGZyb20gJy4vY2xvdWQtY29kZS9QYXJzZS5TZXJ2ZXInO1xuaW1wb3J0IERlcHJlY2F0b3IgZnJvbSAnLi9EZXByZWNhdG9yL0RlcHJlY2F0b3InO1xuXG5mdW5jdGlvbiByZW1vdmVUcmFpbGluZ1NsYXNoKHN0cikge1xuICBpZiAoIXN0cikge1xuICAgIHJldHVybiBzdHI7XG4gIH1cbiAgaWYgKHN0ci5lbmRzV2l0aCgnLycpKSB7XG4gICAgc3RyID0gc3RyLnN1YnN0cmluZygwLCBzdHIubGVuZ3RoIC0gMSk7XG4gIH1cbiAgcmV0dXJuIHN0cjtcbn1cblxuLyoqXG4gKiBDb25maWcga2V5cyB0aGF0IG5lZWQgdG8gYmUgbG9hZGVkIGFzeW5jaHJvbm91c2x5LlxuICovXG5jb25zdCBhc3luY0tleXMgPSBbJ3B1YmxpY1NlcnZlclVSTCddO1xuXG5leHBvcnQgY2xhc3MgQ29uZmlnIHtcbiAgc3RhdGljIGdldChhcHBsaWNhdGlvbklkOiBzdHJpbmcsIG1vdW50OiBzdHJpbmcpIHtcbiAgICBjb25zdCBjYWNoZUluZm8gPSBBcHBDYWNoZS5nZXQoYXBwbGljYXRpb25JZCk7XG4gICAgaWYgKCFjYWNoZUluZm8pIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgY29uZmlnID0gbmV3IENvbmZpZygpO1xuICAgIGNvbmZpZy5hcHBsaWNhdGlvbklkID0gYXBwbGljYXRpb25JZDtcbiAgICBPYmplY3Qua2V5cyhjYWNoZUluZm8pLmZvckVhY2goa2V5ID0+IHtcbiAgICAgIGlmIChrZXkgPT0gJ2RhdGFiYXNlQ29udHJvbGxlcicpIHtcbiAgICAgICAgY29uZmlnLmRhdGFiYXNlID0gbmV3IERhdGFiYXNlQ29udHJvbGxlcihjYWNoZUluZm8uZGF0YWJhc2VDb250cm9sbGVyLmFkYXB0ZXIsIGNvbmZpZyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25maWdba2V5XSA9IGNhY2hlSW5mb1trZXldO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGNvbmZpZy5tb3VudCA9IHJlbW92ZVRyYWlsaW5nU2xhc2gobW91bnQpO1xuICAgIGNvbmZpZy5nZW5lcmF0ZVNlc3Npb25FeHBpcmVzQXQgPSBjb25maWcuZ2VuZXJhdGVTZXNzaW9uRXhwaXJlc0F0LmJpbmQoY29uZmlnKTtcbiAgICBjb25maWcuZ2VuZXJhdGVFbWFpbFZlcmlmeVRva2VuRXhwaXJlc0F0ID0gY29uZmlnLmdlbmVyYXRlRW1haWxWZXJpZnlUb2tlbkV4cGlyZXNBdC5iaW5kKFxuICAgICAgY29uZmlnXG4gICAgKTtcbiAgICBjb25maWcudmVyc2lvbiA9IHZlcnNpb247XG4gICAgcmV0dXJuIGNvbmZpZztcbiAgfVxuXG4gIGFzeW5jIGxvYWRLZXlzKCkge1xuICAgIGF3YWl0IFByb21pc2UuYWxsKFxuICAgICAgYXN5bmNLZXlzLm1hcChhc3luYyBrZXkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHRoaXNbYF8ke2tleX1gXSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICB0aGlzW2tleV0gPSBhd2FpdCB0aGlzW2BfJHtrZXl9YF0oKTtcbiAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gcmVzb2x2ZSBhc3luYyBjb25maWcga2V5ICcke2tleX0nOiAke2Vycm9yLm1lc3NhZ2V9YCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9KVxuICAgICk7XG5cbiAgICBjb25zdCBjYWNoZWRDb25maWcgPSBBcHBDYWNoZS5nZXQodGhpcy5hcHBJZCk7XG4gICAgaWYgKGNhY2hlZENvbmZpZykge1xuICAgICAgY29uc3QgdXBkYXRlZENvbmZpZyA9IHsgLi4uY2FjaGVkQ29uZmlnIH07XG4gICAgICBhc3luY0tleXMuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgICB1cGRhdGVkQ29uZmlnW2tleV0gPSB0aGlzW2tleV07XG4gICAgICB9KTtcbiAgICAgIEFwcENhY2hlLnB1dCh0aGlzLmFwcElkLCB1cGRhdGVkQ29uZmlnKTtcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdHJhbnNmb3JtQ29uZmlndXJhdGlvbihzZXJ2ZXJDb25maWd1cmF0aW9uKSB7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoc2VydmVyQ29uZmlndXJhdGlvbikpIHtcbiAgICAgIGlmIChhc3luY0tleXMuaW5jbHVkZXMoa2V5KSAmJiB0eXBlb2Ygc2VydmVyQ29uZmlndXJhdGlvbltrZXldID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHNlcnZlckNvbmZpZ3VyYXRpb25bYF8ke2tleX1gXSA9IHNlcnZlckNvbmZpZ3VyYXRpb25ba2V5XTtcbiAgICAgICAgZGVsZXRlIHNlcnZlckNvbmZpZ3VyYXRpb25ba2V5XTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBzdGF0aWMgcHV0KHNlcnZlckNvbmZpZ3VyYXRpb24pIHtcbiAgICBDb25maWcudmFsaWRhdGVPcHRpb25zKHNlcnZlckNvbmZpZ3VyYXRpb24pO1xuICAgIENvbmZpZy52YWxpZGF0ZUNvbnRyb2xsZXJzKHNlcnZlckNvbmZpZ3VyYXRpb24pO1xuICAgIENvbmZpZy50cmFuc2Zvcm1Db25maWd1cmF0aW9uKHNlcnZlckNvbmZpZ3VyYXRpb24pO1xuICAgIEFwcENhY2hlLnB1dChzZXJ2ZXJDb25maWd1cmF0aW9uLmFwcElkLCBzZXJ2ZXJDb25maWd1cmF0aW9uKTtcbiAgICBDb25maWcuc2V0dXBQYXNzd29yZFZhbGlkYXRvcihzZXJ2ZXJDb25maWd1cmF0aW9uLnBhc3N3b3JkUG9saWN5KTtcbiAgICByZXR1cm4gc2VydmVyQ29uZmlndXJhdGlvbjtcbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZU9wdGlvbnMoe1xuICAgIGN1c3RvbVBhZ2VzLFxuICAgIHB1YmxpY1NlcnZlclVSTCxcbiAgICByZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0LFxuICAgIGV4cGlyZUluYWN0aXZlU2Vzc2lvbnMsXG4gICAgc2Vzc2lvbkxlbmd0aCxcbiAgICBkZWZhdWx0TGltaXQsXG4gICAgbWF4TGltaXQsXG4gICAgYWNjb3VudExvY2tvdXQsXG4gICAgcGFzc3dvcmRQb2xpY3ksXG4gICAgbWFzdGVyS2V5SXBzLFxuICAgIG1hc3RlcktleSxcbiAgICBtYWludGVuYW5jZUtleSxcbiAgICBtYWludGVuYW5jZUtleUlwcyxcbiAgICByZWFkT25seU1hc3RlcktleSxcbiAgICBhbGxvd0hlYWRlcnMsXG4gICAgaWRlbXBvdGVuY3lPcHRpb25zLFxuICAgIGZpbGVVcGxvYWQsXG4gICAgcGFnZXMsXG4gICAgc2VjdXJpdHksXG4gICAgZW5mb3JjZVByaXZhdGVVc2VycyxcbiAgICBlbmFibGVJbnNlY3VyZUF1dGhBZGFwdGVycyxcbiAgICBzY2hlbWEsXG4gICAgcmVxdWVzdEtleXdvcmREZW55bGlzdCxcbiAgICBhbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuLFxuICAgIGxvZ0xldmVscyxcbiAgICByYXRlTGltaXQsXG4gICAgZGF0YWJhc2VPcHRpb25zLFxuICAgIGV4dGVuZFNlc3Npb25PblVzZSxcbiAgICBhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24sXG4gIH0pIHtcbiAgICBpZiAobWFzdGVyS2V5ID09PSByZWFkT25seU1hc3RlcktleSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdtYXN0ZXJLZXkgYW5kIHJlYWRPbmx5TWFzdGVyS2V5IHNob3VsZCBiZSBkaWZmZXJlbnQnKTtcbiAgICB9XG5cbiAgICBpZiAobWFzdGVyS2V5ID09PSBtYWludGVuYW5jZUtleSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdtYXN0ZXJLZXkgYW5kIG1haW50ZW5hbmNlS2V5IHNob3VsZCBiZSBkaWZmZXJlbnQnKTtcbiAgICB9XG5cbiAgICB0aGlzLnZhbGlkYXRlQWNjb3VudExvY2tvdXRQb2xpY3koYWNjb3VudExvY2tvdXQpO1xuICAgIHRoaXMudmFsaWRhdGVQYXNzd29yZFBvbGljeShwYXNzd29yZFBvbGljeSk7XG4gICAgdGhpcy52YWxpZGF0ZUZpbGVVcGxvYWRPcHRpb25zKGZpbGVVcGxvYWQpO1xuXG4gICAgaWYgKHR5cGVvZiByZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0ICE9PSAnYm9vbGVhbicpIHtcbiAgICAgIHRocm93ICdyZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0IG11c3QgYmUgYSBib29sZWFuIHZhbHVlJztcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIGV4dGVuZFNlc3Npb25PblVzZSAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICB0aHJvdyAnZXh0ZW5kU2Vzc2lvbk9uVXNlIG11c3QgYmUgYSBib29sZWFuIHZhbHVlJztcbiAgICB9XG5cbiAgICB0aGlzLnZhbGlkYXRlUHVibGljU2VydmVyVVJMKHsgcHVibGljU2VydmVyVVJMIH0pO1xuICAgIHRoaXMudmFsaWRhdGVTZXNzaW9uQ29uZmlndXJhdGlvbihzZXNzaW9uTGVuZ3RoLCBleHBpcmVJbmFjdGl2ZVNlc3Npb25zKTtcbiAgICB0aGlzLnZhbGlkYXRlSXBzKCdtYXN0ZXJLZXlJcHMnLCBtYXN0ZXJLZXlJcHMpO1xuICAgIHRoaXMudmFsaWRhdGVJcHMoJ21haW50ZW5hbmNlS2V5SXBzJywgbWFpbnRlbmFuY2VLZXlJcHMpO1xuICAgIHRoaXMudmFsaWRhdGVEZWZhdWx0TGltaXQoZGVmYXVsdExpbWl0KTtcbiAgICB0aGlzLnZhbGlkYXRlTWF4TGltaXQobWF4TGltaXQpO1xuICAgIHRoaXMudmFsaWRhdGVBbGxvd0hlYWRlcnMoYWxsb3dIZWFkZXJzKTtcbiAgICB0aGlzLnZhbGlkYXRlSWRlbXBvdGVuY3lPcHRpb25zKGlkZW1wb3RlbmN5T3B0aW9ucyk7XG4gICAgdGhpcy52YWxpZGF0ZVBhZ2VzT3B0aW9ucyhwYWdlcyk7XG4gICAgdGhpcy52YWxpZGF0ZVNlY3VyaXR5T3B0aW9ucyhzZWN1cml0eSk7XG4gICAgdGhpcy52YWxpZGF0ZVNjaGVtYU9wdGlvbnMoc2NoZW1hKTtcbiAgICB0aGlzLnZhbGlkYXRlRW5mb3JjZVByaXZhdGVVc2VycyhlbmZvcmNlUHJpdmF0ZVVzZXJzKTtcbiAgICB0aGlzLnZhbGlkYXRlRW5hYmxlSW5zZWN1cmVBdXRoQWRhcHRlcnMoZW5hYmxlSW5zZWN1cmVBdXRoQWRhcHRlcnMpO1xuICAgIHRoaXMudmFsaWRhdGVBbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuKGFsbG93RXhwaXJlZEF1dGhEYXRhVG9rZW4pO1xuICAgIHRoaXMudmFsaWRhdGVSZXF1ZXN0S2V5d29yZERlbnlsaXN0KHJlcXVlc3RLZXl3b3JkRGVueWxpc3QpO1xuICAgIHRoaXMudmFsaWRhdGVSYXRlTGltaXQocmF0ZUxpbWl0KTtcbiAgICB0aGlzLnZhbGlkYXRlTG9nTGV2ZWxzKGxvZ0xldmVscyk7XG4gICAgdGhpcy52YWxpZGF0ZURhdGFiYXNlT3B0aW9ucyhkYXRhYmFzZU9wdGlvbnMpO1xuICAgIHRoaXMudmFsaWRhdGVDdXN0b21QYWdlcyhjdXN0b21QYWdlcyk7XG4gICAgdGhpcy52YWxpZGF0ZUFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbihhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24pO1xuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlQ3VzdG9tUGFnZXMoY3VzdG9tUGFnZXMpIHtcbiAgICBpZiAoIWN1c3RvbVBhZ2VzKSB7IHJldHVybjsgfVxuXG4gICAgaWYgKE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChjdXN0b21QYWdlcykgIT09ICdbb2JqZWN0IE9iamVjdF0nKSB7XG4gICAgICB0aHJvdyBFcnJvcignUGFyc2UgU2VydmVyIG9wdGlvbiBjdXN0b21QYWdlcyBtdXN0IGJlIGFuIG9iamVjdC4nKTtcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVDb250cm9sbGVycyh7XG4gICAgdmVyaWZ5VXNlckVtYWlscyxcbiAgICB1c2VyQ29udHJvbGxlcixcbiAgICBhcHBOYW1lLFxuICAgIHB1YmxpY1NlcnZlclVSTCxcbiAgICBfcHVibGljU2VydmVyVVJMLFxuICAgIGVtYWlsVmVyaWZ5VG9rZW5WYWxpZGl0eUR1cmF0aW9uLFxuICAgIGVtYWlsVmVyaWZ5VG9rZW5SZXVzZUlmVmFsaWQsXG4gIH0pIHtcbiAgICBjb25zdCBlbWFpbEFkYXB0ZXIgPSB1c2VyQ29udHJvbGxlci5hZGFwdGVyO1xuICAgIGlmICh2ZXJpZnlVc2VyRW1haWxzKSB7XG4gICAgICB0aGlzLnZhbGlkYXRlRW1haWxDb25maWd1cmF0aW9uKHtcbiAgICAgICAgZW1haWxBZGFwdGVyLFxuICAgICAgICBhcHBOYW1lLFxuICAgICAgICBwdWJsaWNTZXJ2ZXJVUkw6IHB1YmxpY1NlcnZlclVSTCB8fCBfcHVibGljU2VydmVyVVJMLFxuICAgICAgICBlbWFpbFZlcmlmeVRva2VuVmFsaWRpdHlEdXJhdGlvbixcbiAgICAgICAgZW1haWxWZXJpZnlUb2tlblJldXNlSWZWYWxpZCxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZVJlcXVlc3RLZXl3b3JkRGVueWxpc3QocmVxdWVzdEtleXdvcmREZW55bGlzdCkge1xuICAgIGlmIChyZXF1ZXN0S2V5d29yZERlbnlsaXN0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJlcXVlc3RLZXl3b3JkRGVueWxpc3QgPSByZXF1ZXN0S2V5d29yZERlbnlsaXN0LmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICghQXJyYXkuaXNBcnJheShyZXF1ZXN0S2V5d29yZERlbnlsaXN0KSkge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gcmVxdWVzdEtleXdvcmREZW55bGlzdCBtdXN0IGJlIGFuIGFycmF5Lic7XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlRW5mb3JjZVByaXZhdGVVc2VycyhlbmZvcmNlUHJpdmF0ZVVzZXJzKSB7XG4gICAgaWYgKHR5cGVvZiBlbmZvcmNlUHJpdmF0ZVVzZXJzICE9PSAnYm9vbGVhbicpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIGVuZm9yY2VQcml2YXRlVXNlcnMgbXVzdCBiZSBhIGJvb2xlYW4uJztcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVBbGxvd0V4cGlyZWRBdXRoRGF0YVRva2VuKGFsbG93RXhwaXJlZEF1dGhEYXRhVG9rZW4pIHtcbiAgICBpZiAodHlwZW9mIGFsbG93RXhwaXJlZEF1dGhEYXRhVG9rZW4gIT09ICdib29sZWFuJykge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gYWxsb3dFeHBpcmVkQXV0aERhdGFUb2tlbiBtdXN0IGJlIGEgYm9vbGVhbi4nO1xuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZUFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbihhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24pIHtcbiAgICBpZiAodHlwZW9mIGFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbiAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gbXVzdCBiZSBhIGJvb2xlYW4uJztcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVTZWN1cml0eU9wdGlvbnMoc2VjdXJpdHkpIHtcbiAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHNlY3VyaXR5KSAhPT0gJ1tvYmplY3QgT2JqZWN0XScpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHNlY3VyaXR5IG11c3QgYmUgYW4gb2JqZWN0Lic7XG4gICAgfVxuICAgIGlmIChzZWN1cml0eS5lbmFibGVDaGVjayA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBzZWN1cml0eS5lbmFibGVDaGVjayA9IFNlY3VyaXR5T3B0aW9ucy5lbmFibGVDaGVjay5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoIWlzQm9vbGVhbihzZWN1cml0eS5lbmFibGVDaGVjaykpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHNlY3VyaXR5LmVuYWJsZUNoZWNrIG11c3QgYmUgYSBib29sZWFuLic7XG4gICAgfVxuICAgIGlmIChzZWN1cml0eS5lbmFibGVDaGVja0xvZyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBzZWN1cml0eS5lbmFibGVDaGVja0xvZyA9IFNlY3VyaXR5T3B0aW9ucy5lbmFibGVDaGVja0xvZy5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoIWlzQm9vbGVhbihzZWN1cml0eS5lbmFibGVDaGVja0xvZykpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHNlY3VyaXR5LmVuYWJsZUNoZWNrTG9nIG11c3QgYmUgYSBib29sZWFuLic7XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlU2NoZW1hT3B0aW9ucyhzY2hlbWE6IFNjaGVtYU9wdGlvbnMpIHtcbiAgICBpZiAoIXNjaGVtYSkgeyByZXR1cm47IH1cbiAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHNjaGVtYSkgIT09ICdbb2JqZWN0IE9iamVjdF0nKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBzY2hlbWEgbXVzdCBiZSBhbiBvYmplY3QuJztcbiAgICB9XG4gICAgaWYgKHNjaGVtYS5kZWZpbml0aW9ucyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBzY2hlbWEuZGVmaW5pdGlvbnMgPSBTY2hlbWFPcHRpb25zLmRlZmluaXRpb25zLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICghQXJyYXkuaXNBcnJheShzY2hlbWEuZGVmaW5pdGlvbnMpKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBzY2hlbWEuZGVmaW5pdGlvbnMgbXVzdCBiZSBhbiBhcnJheS4nO1xuICAgIH1cbiAgICBpZiAoc2NoZW1hLnN0cmljdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBzY2hlbWEuc3RyaWN0ID0gU2NoZW1hT3B0aW9ucy5zdHJpY3QuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCFpc0Jvb2xlYW4oc2NoZW1hLnN0cmljdCkpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHNjaGVtYS5zdHJpY3QgbXVzdCBiZSBhIGJvb2xlYW4uJztcbiAgICB9XG4gICAgaWYgKHNjaGVtYS5kZWxldGVFeHRyYUZpZWxkcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBzY2hlbWEuZGVsZXRlRXh0cmFGaWVsZHMgPSBTY2hlbWFPcHRpb25zLmRlbGV0ZUV4dHJhRmllbGRzLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICghaXNCb29sZWFuKHNjaGVtYS5kZWxldGVFeHRyYUZpZWxkcykpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHNjaGVtYS5kZWxldGVFeHRyYUZpZWxkcyBtdXN0IGJlIGEgYm9vbGVhbi4nO1xuICAgIH1cbiAgICBpZiAoc2NoZW1hLnJlY3JlYXRlTW9kaWZpZWRGaWVsZHMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgc2NoZW1hLnJlY3JlYXRlTW9kaWZpZWRGaWVsZHMgPSBTY2hlbWFPcHRpb25zLnJlY3JlYXRlTW9kaWZpZWRGaWVsZHMuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCFpc0Jvb2xlYW4oc2NoZW1hLnJlY3JlYXRlTW9kaWZpZWRGaWVsZHMpKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBzY2hlbWEucmVjcmVhdGVNb2RpZmllZEZpZWxkcyBtdXN0IGJlIGEgYm9vbGVhbi4nO1xuICAgIH1cbiAgICBpZiAoc2NoZW1hLmxvY2tTY2hlbWFzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHNjaGVtYS5sb2NrU2NoZW1hcyA9IFNjaGVtYU9wdGlvbnMubG9ja1NjaGVtYXMuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCFpc0Jvb2xlYW4oc2NoZW1hLmxvY2tTY2hlbWFzKSkge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gc2NoZW1hLmxvY2tTY2hlbWFzIG11c3QgYmUgYSBib29sZWFuLic7XG4gICAgfVxuICAgIGlmIChzY2hlbWEuYmVmb3JlTWlncmF0aW9uID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHNjaGVtYS5iZWZvcmVNaWdyYXRpb24gPSBudWxsO1xuICAgIH0gZWxzZSBpZiAoc2NoZW1hLmJlZm9yZU1pZ3JhdGlvbiAhPT0gbnVsbCAmJiB0eXBlb2Ygc2NoZW1hLmJlZm9yZU1pZ3JhdGlvbiAhPT0gJ2Z1bmN0aW9uJykge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gc2NoZW1hLmJlZm9yZU1pZ3JhdGlvbiBtdXN0IGJlIGEgZnVuY3Rpb24uJztcbiAgICB9XG4gICAgaWYgKHNjaGVtYS5hZnRlck1pZ3JhdGlvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBzY2hlbWEuYWZ0ZXJNaWdyYXRpb24gPSBudWxsO1xuICAgIH0gZWxzZSBpZiAoc2NoZW1hLmFmdGVyTWlncmF0aW9uICE9PSBudWxsICYmIHR5cGVvZiBzY2hlbWEuYWZ0ZXJNaWdyYXRpb24gIT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHNjaGVtYS5hZnRlck1pZ3JhdGlvbiBtdXN0IGJlIGEgZnVuY3Rpb24uJztcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVQYWdlc09wdGlvbnMocGFnZXMpIHtcbiAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHBhZ2VzKSAhPT0gJ1tvYmplY3QgT2JqZWN0XScpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHBhZ2VzIG11c3QgYmUgYW4gb2JqZWN0Lic7XG4gICAgfVxuICAgIGlmIChwYWdlcy5lbmFibGVSb3V0ZXIgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcGFnZXMuZW5hYmxlUm91dGVyID0gUGFnZXNPcHRpb25zLmVuYWJsZVJvdXRlci5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoIWlzQm9vbGVhbihwYWdlcy5lbmFibGVSb3V0ZXIpKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBwYWdlcy5lbmFibGVSb3V0ZXIgbXVzdCBiZSBhIGJvb2xlYW4uJztcbiAgICB9XG4gICAgaWYgKHBhZ2VzLmVuYWJsZUxvY2FsaXphdGlvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBwYWdlcy5lbmFibGVMb2NhbGl6YXRpb24gPSBQYWdlc09wdGlvbnMuZW5hYmxlTG9jYWxpemF0aW9uLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICghaXNCb29sZWFuKHBhZ2VzLmVuYWJsZUxvY2FsaXphdGlvbikpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHBhZ2VzLmVuYWJsZUxvY2FsaXphdGlvbiBtdXN0IGJlIGEgYm9vbGVhbi4nO1xuICAgIH1cbiAgICBpZiAocGFnZXMubG9jYWxpemF0aW9uSnNvblBhdGggPT09IHVuZGVmaW5lZCkge1xuICAgICAgcGFnZXMubG9jYWxpemF0aW9uSnNvblBhdGggPSBQYWdlc09wdGlvbnMubG9jYWxpemF0aW9uSnNvblBhdGguZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCFpc1N0cmluZyhwYWdlcy5sb2NhbGl6YXRpb25Kc29uUGF0aCkpIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHBhZ2VzLmxvY2FsaXphdGlvbkpzb25QYXRoIG11c3QgYmUgYSBzdHJpbmcuJztcbiAgICB9XG4gICAgaWYgKHBhZ2VzLmxvY2FsaXphdGlvbkZhbGxiYWNrTG9jYWxlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHBhZ2VzLmxvY2FsaXphdGlvbkZhbGxiYWNrTG9jYWxlID0gUGFnZXNPcHRpb25zLmxvY2FsaXphdGlvbkZhbGxiYWNrTG9jYWxlLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICghaXNTdHJpbmcocGFnZXMubG9jYWxpemF0aW9uRmFsbGJhY2tMb2NhbGUpKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBwYWdlcy5sb2NhbGl6YXRpb25GYWxsYmFja0xvY2FsZSBtdXN0IGJlIGEgc3RyaW5nLic7XG4gICAgfVxuICAgIGlmIChwYWdlcy5wbGFjZWhvbGRlcnMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcGFnZXMucGxhY2Vob2xkZXJzID0gUGFnZXNPcHRpb25zLnBsYWNlaG9sZGVycy5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoXG4gICAgICBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwocGFnZXMucGxhY2Vob2xkZXJzKSAhPT0gJ1tvYmplY3QgT2JqZWN0XScgJiZcbiAgICAgIHR5cGVvZiBwYWdlcy5wbGFjZWhvbGRlcnMgIT09ICdmdW5jdGlvbidcbiAgICApIHtcbiAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIHBhZ2VzLnBsYWNlaG9sZGVycyBtdXN0IGJlIGFuIG9iamVjdCBvciBhIGZ1bmN0aW9uLic7XG4gICAgfVxuICAgIGlmIChwYWdlcy5mb3JjZVJlZGlyZWN0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHBhZ2VzLmZvcmNlUmVkaXJlY3QgPSBQYWdlc09wdGlvbnMuZm9yY2VSZWRpcmVjdC5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoIWlzQm9vbGVhbihwYWdlcy5mb3JjZVJlZGlyZWN0KSkge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gcGFnZXMuZm9yY2VSZWRpcmVjdCBtdXN0IGJlIGEgYm9vbGVhbi4nO1xuICAgIH1cbiAgICBpZiAocGFnZXMucGFnZXNQYXRoID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHBhZ2VzLnBhZ2VzUGF0aCA9IFBhZ2VzT3B0aW9ucy5wYWdlc1BhdGguZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCFpc1N0cmluZyhwYWdlcy5wYWdlc1BhdGgpKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBwYWdlcy5wYWdlc1BhdGggbXVzdCBiZSBhIHN0cmluZy4nO1xuICAgIH1cbiAgICBpZiAocGFnZXMucGFnZXNFbmRwb2ludCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBwYWdlcy5wYWdlc0VuZHBvaW50ID0gUGFnZXNPcHRpb25zLnBhZ2VzRW5kcG9pbnQuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCFpc1N0cmluZyhwYWdlcy5wYWdlc0VuZHBvaW50KSkge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gcGFnZXMucGFnZXNFbmRwb2ludCBtdXN0IGJlIGEgc3RyaW5nLic7XG4gICAgfVxuICAgIGlmIChwYWdlcy5jdXN0b21VcmxzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHBhZ2VzLmN1c3RvbVVybHMgPSBQYWdlc09wdGlvbnMuY3VzdG9tVXJscy5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHBhZ2VzLmN1c3RvbVVybHMpICE9PSAnW29iamVjdCBPYmplY3RdJykge1xuICAgICAgdGhyb3cgJ1BhcnNlIFNlcnZlciBvcHRpb24gcGFnZXMuY3VzdG9tVXJscyBtdXN0IGJlIGFuIG9iamVjdC4nO1xuICAgIH1cbiAgICBpZiAocGFnZXMuY3VzdG9tUm91dGVzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHBhZ2VzLmN1c3RvbVJvdXRlcyA9IFBhZ2VzT3B0aW9ucy5jdXN0b21Sb3V0ZXMuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCEocGFnZXMuY3VzdG9tUm91dGVzIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBwYWdlcy5jdXN0b21Sb3V0ZXMgbXVzdCBiZSBhbiBhcnJheS4nO1xuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZUlkZW1wb3RlbmN5T3B0aW9ucyhpZGVtcG90ZW5jeU9wdGlvbnMpIHtcbiAgICBpZiAoIWlkZW1wb3RlbmN5T3B0aW9ucykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoaWRlbXBvdGVuY3lPcHRpb25zLnR0bCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZGVtcG90ZW5jeU9wdGlvbnMudHRsID0gSWRlbXBvdGVuY3lPcHRpb25zLnR0bC5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAoIWlzTmFOKGlkZW1wb3RlbmN5T3B0aW9ucy50dGwpICYmIGlkZW1wb3RlbmN5T3B0aW9ucy50dGwgPD0gMCkge1xuICAgICAgdGhyb3cgJ2lkZW1wb3RlbmN5IFRUTCB2YWx1ZSBtdXN0IGJlIGdyZWF0ZXIgdGhhbiAwIHNlY29uZHMnO1xuICAgIH0gZWxzZSBpZiAoaXNOYU4oaWRlbXBvdGVuY3lPcHRpb25zLnR0bCkpIHtcbiAgICAgIHRocm93ICdpZGVtcG90ZW5jeSBUVEwgdmFsdWUgbXVzdCBiZSBhIG51bWJlcic7XG4gICAgfVxuICAgIGlmICghaWRlbXBvdGVuY3lPcHRpb25zLnBhdGhzKSB7XG4gICAgICBpZGVtcG90ZW5jeU9wdGlvbnMucGF0aHMgPSBJZGVtcG90ZW5jeU9wdGlvbnMucGF0aHMuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCEoaWRlbXBvdGVuY3lPcHRpb25zLnBhdGhzIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICB0aHJvdyAnaWRlbXBvdGVuY3kgcGF0aHMgbXVzdCBiZSBvZiBhbiBhcnJheSBvZiBzdHJpbmdzJztcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVBY2NvdW50TG9ja291dFBvbGljeShhY2NvdW50TG9ja291dCkge1xuICAgIGlmIChhY2NvdW50TG9ja291dCkge1xuICAgICAgaWYgKFxuICAgICAgICB0eXBlb2YgYWNjb3VudExvY2tvdXQuZHVyYXRpb24gIT09ICdudW1iZXInIHx8XG4gICAgICAgIGFjY291bnRMb2Nrb3V0LmR1cmF0aW9uIDw9IDAgfHxcbiAgICAgICAgYWNjb3VudExvY2tvdXQuZHVyYXRpb24gPiA5OTk5OVxuICAgICAgKSB7XG4gICAgICAgIHRocm93ICdBY2NvdW50IGxvY2tvdXQgZHVyYXRpb24gc2hvdWxkIGJlIGdyZWF0ZXIgdGhhbiAwIGFuZCBsZXNzIHRoYW4gMTAwMDAwJztcbiAgICAgIH1cblxuICAgICAgaWYgKFxuICAgICAgICAhTnVtYmVyLmlzSW50ZWdlcihhY2NvdW50TG9ja291dC50aHJlc2hvbGQpIHx8XG4gICAgICAgIGFjY291bnRMb2Nrb3V0LnRocmVzaG9sZCA8IDEgfHxcbiAgICAgICAgYWNjb3VudExvY2tvdXQudGhyZXNob2xkID4gOTk5XG4gICAgICApIHtcbiAgICAgICAgdGhyb3cgJ0FjY291bnQgbG9ja291dCB0aHJlc2hvbGQgc2hvdWxkIGJlIGFuIGludGVnZXIgZ3JlYXRlciB0aGFuIDAgYW5kIGxlc3MgdGhhbiAxMDAwJztcbiAgICAgIH1cblxuICAgICAgaWYgKGFjY291bnRMb2Nrb3V0LnVubG9ja09uUGFzc3dvcmRSZXNldCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGFjY291bnRMb2Nrb3V0LnVubG9ja09uUGFzc3dvcmRSZXNldCA9IEFjY291bnRMb2Nrb3V0T3B0aW9ucy51bmxvY2tPblBhc3N3b3JkUmVzZXQuZGVmYXVsdDtcbiAgICAgIH0gZWxzZSBpZiAoIWlzQm9vbGVhbihhY2NvdW50TG9ja291dC51bmxvY2tPblBhc3N3b3JkUmVzZXQpKSB7XG4gICAgICAgIHRocm93ICdQYXJzZSBTZXJ2ZXIgb3B0aW9uIGFjY291bnRMb2Nrb3V0LnVubG9ja09uUGFzc3dvcmRSZXNldCBtdXN0IGJlIGEgYm9vbGVhbi4nO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZVBhc3N3b3JkUG9saWN5KHBhc3N3b3JkUG9saWN5KSB7XG4gICAgaWYgKHBhc3N3b3JkUG9saWN5KSB7XG4gICAgICBpZiAoXG4gICAgICAgIHBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkQWdlICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICAgKHR5cGVvZiBwYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEFnZSAhPT0gJ251bWJlcicgfHwgcGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2UgPCAwKVxuICAgICAgKSB7XG4gICAgICAgIHRocm93ICdwYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEFnZSBtdXN0IGJlIGEgcG9zaXRpdmUgbnVtYmVyJztcbiAgICAgIH1cblxuICAgICAgaWYgKFxuICAgICAgICBwYXNzd29yZFBvbGljeS5yZXNldFRva2VuVmFsaWRpdHlEdXJhdGlvbiAhPT0gdW5kZWZpbmVkICYmXG4gICAgICAgICh0eXBlb2YgcGFzc3dvcmRQb2xpY3kucmVzZXRUb2tlblZhbGlkaXR5RHVyYXRpb24gIT09ICdudW1iZXInIHx8XG4gICAgICAgICAgcGFzc3dvcmRQb2xpY3kucmVzZXRUb2tlblZhbGlkaXR5RHVyYXRpb24gPD0gMClcbiAgICAgICkge1xuICAgICAgICB0aHJvdyAncGFzc3dvcmRQb2xpY3kucmVzZXRUb2tlblZhbGlkaXR5RHVyYXRpb24gbXVzdCBiZSBhIHBvc2l0aXZlIG51bWJlcic7XG4gICAgICB9XG5cbiAgICAgIGlmIChwYXNzd29yZFBvbGljeS52YWxpZGF0b3JQYXR0ZXJuKSB7XG4gICAgICAgIGlmICh0eXBlb2YgcGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yUGF0dGVybiA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICBwYXNzd29yZFBvbGljeS52YWxpZGF0b3JQYXR0ZXJuID0gbmV3IFJlZ0V4cChwYXNzd29yZFBvbGljeS52YWxpZGF0b3JQYXR0ZXJuKTtcbiAgICAgICAgfSBlbHNlIGlmICghKHBhc3N3b3JkUG9saWN5LnZhbGlkYXRvclBhdHRlcm4gaW5zdGFuY2VvZiBSZWdFeHApKSB7XG4gICAgICAgICAgdGhyb3cgJ3Bhc3N3b3JkUG9saWN5LnZhbGlkYXRvclBhdHRlcm4gbXVzdCBiZSBhIHJlZ2V4IHN0cmluZyBvciBSZWdFeHAgb2JqZWN0Lic7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKFxuICAgICAgICBwYXNzd29yZFBvbGljeS52YWxpZGF0b3JDYWxsYmFjayAmJlxuICAgICAgICB0eXBlb2YgcGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yQ2FsbGJhY2sgIT09ICdmdW5jdGlvbidcbiAgICAgICkge1xuICAgICAgICB0aHJvdyAncGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yQ2FsbGJhY2sgbXVzdCBiZSBhIGZ1bmN0aW9uLic7XG4gICAgICB9XG5cbiAgICAgIGlmIChcbiAgICAgICAgcGFzc3dvcmRQb2xpY3kuZG9Ob3RBbGxvd1VzZXJuYW1lICYmXG4gICAgICAgIHR5cGVvZiBwYXNzd29yZFBvbGljeS5kb05vdEFsbG93VXNlcm5hbWUgIT09ICdib29sZWFuJ1xuICAgICAgKSB7XG4gICAgICAgIHRocm93ICdwYXNzd29yZFBvbGljeS5kb05vdEFsbG93VXNlcm5hbWUgbXVzdCBiZSBhIGJvb2xlYW4gdmFsdWUuJztcbiAgICAgIH1cblxuICAgICAgaWYgKFxuICAgICAgICBwYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgJiZcbiAgICAgICAgKCFOdW1iZXIuaXNJbnRlZ2VyKHBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSkgfHxcbiAgICAgICAgICBwYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgPD0gMCB8fFxuICAgICAgICAgIHBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSA+IDIwKVxuICAgICAgKSB7XG4gICAgICAgIHRocm93ICdwYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgbXVzdCBiZSBhbiBpbnRlZ2VyIHJhbmdpbmcgMCAtIDIwJztcbiAgICAgIH1cblxuICAgICAgaWYgKFxuICAgICAgICBwYXNzd29yZFBvbGljeS5yZXNldFRva2VuUmV1c2VJZlZhbGlkICYmXG4gICAgICAgIHR5cGVvZiBwYXNzd29yZFBvbGljeS5yZXNldFRva2VuUmV1c2VJZlZhbGlkICE9PSAnYm9vbGVhbidcbiAgICAgICkge1xuICAgICAgICB0aHJvdyAncmVzZXRUb2tlblJldXNlSWZWYWxpZCBtdXN0IGJlIGEgYm9vbGVhbiB2YWx1ZSc7XG4gICAgICB9XG4gICAgICBpZiAocGFzc3dvcmRQb2xpY3kucmVzZXRUb2tlblJldXNlSWZWYWxpZCAmJiAhcGFzc3dvcmRQb2xpY3kucmVzZXRUb2tlblZhbGlkaXR5RHVyYXRpb24pIHtcbiAgICAgICAgdGhyb3cgJ1lvdSBjYW5ub3QgdXNlIHJlc2V0VG9rZW5SZXVzZUlmVmFsaWQgd2l0aG91dCByZXNldFRva2VuVmFsaWRpdHlEdXJhdGlvbic7XG4gICAgICB9XG5cbiAgICAgIGlmIChcbiAgICAgICAgcGFzc3dvcmRQb2xpY3kucmVzZXRQYXNzd29yZFN1Y2Nlc3NPbkludmFsaWRFbWFpbCAmJlxuICAgICAgICB0eXBlb2YgcGFzc3dvcmRQb2xpY3kucmVzZXRQYXNzd29yZFN1Y2Nlc3NPbkludmFsaWRFbWFpbCAhPT0gJ2Jvb2xlYW4nXG4gICAgICApIHtcbiAgICAgICAgdGhyb3cgJ3Jlc2V0UGFzc3dvcmRTdWNjZXNzT25JbnZhbGlkRW1haWwgbXVzdCBiZSBhIGJvb2xlYW4gdmFsdWUnO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIGlmIHRoZSBwYXNzd29yZFBvbGljeS52YWxpZGF0b3JQYXR0ZXJuIGlzIGNvbmZpZ3VyZWQgdGhlbiBzZXR1cCBhIGNhbGxiYWNrIHRvIHByb2Nlc3MgdGhlIHBhdHRlcm5cbiAgc3RhdGljIHNldHVwUGFzc3dvcmRWYWxpZGF0b3IocGFzc3dvcmRQb2xpY3kpIHtcbiAgICBpZiAocGFzc3dvcmRQb2xpY3kgJiYgcGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yUGF0dGVybikge1xuICAgICAgcGFzc3dvcmRQb2xpY3kucGF0dGVyblZhbGlkYXRvciA9IHZhbHVlID0+IHtcbiAgICAgICAgcmV0dXJuIHBhc3N3b3JkUG9saWN5LnZhbGlkYXRvclBhdHRlcm4udGVzdCh2YWx1ZSk7XG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZVB1YmxpY1NlcnZlclVSTCh7IHB1YmxpY1NlcnZlclVSTCwgcmVxdWlyZWQgPSBmYWxzZSB9KSB7XG4gICAgaWYgKCFwdWJsaWNTZXJ2ZXJVUkwpIHtcbiAgICAgIGlmICghcmVxdWlyZWQpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhyb3cgJ1RoZSBvcHRpb24gcHVibGljU2VydmVyVVJMIGlzIHJlcXVpcmVkLic7XG4gICAgfVxuXG4gICAgY29uc3QgdHlwZSA9IHR5cGVvZiBwdWJsaWNTZXJ2ZXJVUkw7XG5cbiAgICBpZiAodHlwZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIGlmICghcHVibGljU2VydmVyVVJMLnN0YXJ0c1dpdGgoJ2h0dHA6Ly8nKSAmJiAhcHVibGljU2VydmVyVVJMLnN0YXJ0c1dpdGgoJ2h0dHBzOi8vJykpIHtcbiAgICAgICAgdGhyb3cgJ1RoZSBvcHRpb24gcHVibGljU2VydmVyVVJMIG11c3QgYmUgYSB2YWxpZCBVUkwgc3RhcnRpbmcgd2l0aCBodHRwOi8vIG9yIGh0dHBzOi8vLic7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKHR5cGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0aHJvdyBgVGhlIG9wdGlvbiBwdWJsaWNTZXJ2ZXJVUkwgbXVzdCBiZSBhIHN0cmluZyBvciBmdW5jdGlvbiwgYnV0IGdvdCAke3R5cGV9LmA7XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVFbWFpbENvbmZpZ3VyYXRpb24oe1xuICAgIGVtYWlsQWRhcHRlcixcbiAgICBhcHBOYW1lLFxuICAgIHB1YmxpY1NlcnZlclVSTCxcbiAgICBlbWFpbFZlcmlmeVRva2VuVmFsaWRpdHlEdXJhdGlvbixcbiAgICBlbWFpbFZlcmlmeVRva2VuUmV1c2VJZlZhbGlkLFxuICB9KSB7XG4gICAgaWYgKCFlbWFpbEFkYXB0ZXIpIHtcbiAgICAgIHRocm93ICdBbiBlbWFpbEFkYXB0ZXIgaXMgcmVxdWlyZWQgZm9yIGUtbWFpbCB2ZXJpZmljYXRpb24gYW5kIHBhc3N3b3JkIHJlc2V0cy4nO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGFwcE5hbWUgIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyAnQW4gYXBwIG5hbWUgaXMgcmVxdWlyZWQgZm9yIGUtbWFpbCB2ZXJpZmljYXRpb24gYW5kIHBhc3N3b3JkIHJlc2V0cy4nO1xuICAgIH1cbiAgICB0aGlzLnZhbGlkYXRlUHVibGljU2VydmVyVVJMKHsgcHVibGljU2VydmVyVVJMLCByZXF1aXJlZDogdHJ1ZSB9KTtcbiAgICBpZiAoZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24pIHtcbiAgICAgIGlmIChpc05hTihlbWFpbFZlcmlmeVRva2VuVmFsaWRpdHlEdXJhdGlvbikpIHtcbiAgICAgICAgdGhyb3cgJ0VtYWlsIHZlcmlmeSB0b2tlbiB2YWxpZGl0eSBkdXJhdGlvbiBtdXN0IGJlIGEgdmFsaWQgbnVtYmVyLic7XG4gICAgICB9IGVsc2UgaWYgKGVtYWlsVmVyaWZ5VG9rZW5WYWxpZGl0eUR1cmF0aW9uIDw9IDApIHtcbiAgICAgICAgdGhyb3cgJ0VtYWlsIHZlcmlmeSB0b2tlbiB2YWxpZGl0eSBkdXJhdGlvbiBtdXN0IGJlIGEgdmFsdWUgZ3JlYXRlciB0aGFuIDAuJztcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGVtYWlsVmVyaWZ5VG9rZW5SZXVzZUlmVmFsaWQgJiYgdHlwZW9mIGVtYWlsVmVyaWZ5VG9rZW5SZXVzZUlmVmFsaWQgIT09ICdib29sZWFuJykge1xuICAgICAgdGhyb3cgJ2VtYWlsVmVyaWZ5VG9rZW5SZXVzZUlmVmFsaWQgbXVzdCBiZSBhIGJvb2xlYW4gdmFsdWUnO1xuICAgIH1cbiAgICBpZiAoZW1haWxWZXJpZnlUb2tlblJldXNlSWZWYWxpZCAmJiAhZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24pIHtcbiAgICAgIHRocm93ICdZb3UgY2Fubm90IHVzZSBlbWFpbFZlcmlmeVRva2VuUmV1c2VJZlZhbGlkIHdpdGhvdXQgZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24nO1xuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZUZpbGVVcGxvYWRPcHRpb25zKGZpbGVVcGxvYWQpIHtcbiAgICB0cnkge1xuICAgICAgaWYgKGZpbGVVcGxvYWQgPT0gbnVsbCB8fCB0eXBlb2YgZmlsZVVwbG9hZCAhPT0gJ29iamVjdCcgfHwgZmlsZVVwbG9hZCBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgICAgIHRocm93ICdmaWxlVXBsb2FkIG11c3QgYmUgYW4gb2JqZWN0IHZhbHVlLic7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGUgaW5zdGFuY2VvZiBSZWZlcmVuY2VFcnJvcikge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgICBpZiAoZmlsZVVwbG9hZC5lbmFibGVGb3JBbm9ueW1vdXNVc2VyID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGZpbGVVcGxvYWQuZW5hYmxlRm9yQW5vbnltb3VzVXNlciA9IEZpbGVVcGxvYWRPcHRpb25zLmVuYWJsZUZvckFub255bW91c1VzZXIuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWxlVXBsb2FkLmVuYWJsZUZvckFub255bW91c1VzZXIgIT09ICdib29sZWFuJykge1xuICAgICAgdGhyb3cgJ2ZpbGVVcGxvYWQuZW5hYmxlRm9yQW5vbnltb3VzVXNlciBtdXN0IGJlIGEgYm9vbGVhbiB2YWx1ZS4nO1xuICAgIH1cbiAgICBpZiAoZmlsZVVwbG9hZC5lbmFibGVGb3JQdWJsaWMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZmlsZVVwbG9hZC5lbmFibGVGb3JQdWJsaWMgPSBGaWxlVXBsb2FkT3B0aW9ucy5lbmFibGVGb3JQdWJsaWMuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWxlVXBsb2FkLmVuYWJsZUZvclB1YmxpYyAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICB0aHJvdyAnZmlsZVVwbG9hZC5lbmFibGVGb3JQdWJsaWMgbXVzdCBiZSBhIGJvb2xlYW4gdmFsdWUuJztcbiAgICB9XG4gICAgaWYgKGZpbGVVcGxvYWQuZW5hYmxlRm9yQXV0aGVudGljYXRlZFVzZXIgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZmlsZVVwbG9hZC5lbmFibGVGb3JBdXRoZW50aWNhdGVkVXNlciA9IEZpbGVVcGxvYWRPcHRpb25zLmVuYWJsZUZvckF1dGhlbnRpY2F0ZWRVc2VyLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgZmlsZVVwbG9hZC5lbmFibGVGb3JBdXRoZW50aWNhdGVkVXNlciAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICB0aHJvdyAnZmlsZVVwbG9hZC5lbmFibGVGb3JBdXRoZW50aWNhdGVkVXNlciBtdXN0IGJlIGEgYm9vbGVhbiB2YWx1ZS4nO1xuICAgIH1cbiAgICBpZiAoZmlsZVVwbG9hZC5maWxlRXh0ZW5zaW9ucyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBmaWxlVXBsb2FkLmZpbGVFeHRlbnNpb25zID0gRmlsZVVwbG9hZE9wdGlvbnMuZmlsZUV4dGVuc2lvbnMuZGVmYXVsdDtcbiAgICB9IGVsc2UgaWYgKCFBcnJheS5pc0FycmF5KGZpbGVVcGxvYWQuZmlsZUV4dGVuc2lvbnMpKSB7XG4gICAgICB0aHJvdyAnZmlsZVVwbG9hZC5maWxlRXh0ZW5zaW9ucyBtdXN0IGJlIGFuIGFycmF5Lic7XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlSXBzKGZpZWxkLCBtYXN0ZXJLZXlJcHMpIHtcbiAgICBmb3IgKGxldCBpcCBvZiBtYXN0ZXJLZXlJcHMpIHtcbiAgICAgIGlmIChpcC5pbmNsdWRlcygnLycpKSB7XG4gICAgICAgIGlwID0gaXAuc3BsaXQoJy8nKVswXTtcbiAgICAgIH1cbiAgICAgIGlmICghbmV0LmlzSVAoaXApKSB7XG4gICAgICAgIHRocm93IGBUaGUgUGFyc2UgU2VydmVyIG9wdGlvbiBcIiR7ZmllbGR9XCIgY29udGFpbnMgYW4gaW52YWxpZCBJUCBhZGRyZXNzIFwiJHtpcH1cIi5gO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZUVuYWJsZUluc2VjdXJlQXV0aEFkYXB0ZXJzKGVuYWJsZUluc2VjdXJlQXV0aEFkYXB0ZXJzKSB7XG4gICAgaWYgKGVuYWJsZUluc2VjdXJlQXV0aEFkYXB0ZXJzICYmIHR5cGVvZiBlbmFibGVJbnNlY3VyZUF1dGhBZGFwdGVycyAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICB0aHJvdyAnUGFyc2UgU2VydmVyIG9wdGlvbiBlbmFibGVJbnNlY3VyZUF1dGhBZGFwdGVycyBtdXN0IGJlIGEgYm9vbGVhbi4nO1xuICAgIH1cbiAgICBpZiAoZW5hYmxlSW5zZWN1cmVBdXRoQWRhcHRlcnMpIHtcbiAgICAgIERlcHJlY2F0b3IubG9nUnVudGltZURlcHJlY2F0aW9uKHsgdXNhZ2U6ICdpbnNlY3VyZSBhZGFwdGVyJyB9KTtcbiAgICB9XG4gIH1cblxuICBnZXQgbW91bnQoKSB7XG4gICAgdmFyIG1vdW50ID0gdGhpcy5fbW91bnQ7XG4gICAgaWYgKHRoaXMucHVibGljU2VydmVyVVJMKSB7XG4gICAgICBtb3VudCA9IHRoaXMucHVibGljU2VydmVyVVJMO1xuICAgIH1cbiAgICByZXR1cm4gbW91bnQ7XG4gIH1cblxuICBzZXQgbW91bnQobmV3VmFsdWUpIHtcbiAgICB0aGlzLl9tb3VudCA9IG5ld1ZhbHVlO1xuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlU2Vzc2lvbkNvbmZpZ3VyYXRpb24oc2Vzc2lvbkxlbmd0aCwgZXhwaXJlSW5hY3RpdmVTZXNzaW9ucykge1xuICAgIGlmIChleHBpcmVJbmFjdGl2ZVNlc3Npb25zKSB7XG4gICAgICBpZiAoaXNOYU4oc2Vzc2lvbkxlbmd0aCkpIHtcbiAgICAgICAgdGhyb3cgJ1Nlc3Npb24gbGVuZ3RoIG11c3QgYmUgYSB2YWxpZCBudW1iZXIuJztcbiAgICAgIH0gZWxzZSBpZiAoc2Vzc2lvbkxlbmd0aCA8PSAwKSB7XG4gICAgICAgIHRocm93ICdTZXNzaW9uIGxlbmd0aCBtdXN0IGJlIGEgdmFsdWUgZ3JlYXRlciB0aGFuIDAuJztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVEZWZhdWx0TGltaXQoZGVmYXVsdExpbWl0KSB7XG4gICAgaWYgKGRlZmF1bHRMaW1pdCA9PSBudWxsKSB7XG4gICAgICBkZWZhdWx0TGltaXQgPSBQYXJzZVNlcnZlck9wdGlvbnMuZGVmYXVsdExpbWl0LmRlZmF1bHQ7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgZGVmYXVsdExpbWl0ICE9PSAnbnVtYmVyJykge1xuICAgICAgdGhyb3cgJ0RlZmF1bHQgbGltaXQgbXVzdCBiZSBhIG51bWJlci4nO1xuICAgIH1cbiAgICBpZiAoZGVmYXVsdExpbWl0IDw9IDApIHtcbiAgICAgIHRocm93ICdEZWZhdWx0IGxpbWl0IG11c3QgYmUgYSB2YWx1ZSBncmVhdGVyIHRoYW4gMC4nO1xuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZU1heExpbWl0KG1heExpbWl0KSB7XG4gICAgaWYgKG1heExpbWl0IDw9IDApIHtcbiAgICAgIHRocm93ICdNYXggbGltaXQgbXVzdCBiZSBhIHZhbHVlIGdyZWF0ZXIgdGhhbiAwLic7XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlQWxsb3dIZWFkZXJzKGFsbG93SGVhZGVycykge1xuICAgIGlmICghW251bGwsIHVuZGVmaW5lZF0uaW5jbHVkZXMoYWxsb3dIZWFkZXJzKSkge1xuICAgICAgaWYgKEFycmF5LmlzQXJyYXkoYWxsb3dIZWFkZXJzKSkge1xuICAgICAgICBhbGxvd0hlYWRlcnMuZm9yRWFjaChoZWFkZXIgPT4ge1xuICAgICAgICAgIGlmICh0eXBlb2YgaGVhZGVyICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgJ0FsbG93IGhlYWRlcnMgbXVzdCBvbmx5IGNvbnRhaW4gc3RyaW5ncyc7XG4gICAgICAgICAgfSBlbHNlIGlmICghaGVhZGVyLnRyaW0oKS5sZW5ndGgpIHtcbiAgICAgICAgICAgIHRocm93ICdBbGxvdyBoZWFkZXJzIG11c3Qgbm90IGNvbnRhaW4gZW1wdHkgc3RyaW5ncyc7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93ICdBbGxvdyBoZWFkZXJzIG11c3QgYmUgYW4gYXJyYXknO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHN0YXRpYyB2YWxpZGF0ZUxvZ0xldmVscyhsb2dMZXZlbHMpIHtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhMb2dMZXZlbHMpKSB7XG4gICAgICBpZiAobG9nTGV2ZWxzW2tleV0pIHtcbiAgICAgICAgaWYgKHZhbGlkTG9nTGV2ZWxzLmluZGV4T2YobG9nTGV2ZWxzW2tleV0pID09PSAtMSkge1xuICAgICAgICAgIHRocm93IGAnJHtrZXl9JyBtdXN0IGJlIG9uZSBvZiAke0pTT04uc3RyaW5naWZ5KHZhbGlkTG9nTGV2ZWxzKX1gO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBsb2dMZXZlbHNba2V5XSA9IExvZ0xldmVsc1trZXldLmRlZmF1bHQ7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgc3RhdGljIHZhbGlkYXRlRGF0YWJhc2VPcHRpb25zKGRhdGFiYXNlT3B0aW9ucykge1xuICAgIGlmIChkYXRhYmFzZU9wdGlvbnMgPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwoZGF0YWJhc2VPcHRpb25zKSAhPT0gJ1tvYmplY3QgT2JqZWN0XScpIHtcbiAgICAgIHRocm93IGBkYXRhYmFzZU9wdGlvbnMgbXVzdCBiZSBhbiBvYmplY3RgO1xuICAgIH1cblxuICAgIGlmIChkYXRhYmFzZU9wdGlvbnMuZW5hYmxlU2NoZW1hSG9va3MgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZGF0YWJhc2VPcHRpb25zLmVuYWJsZVNjaGVtYUhvb2tzID0gRGF0YWJhc2VPcHRpb25zLmVuYWJsZVNjaGVtYUhvb2tzLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgZGF0YWJhc2VPcHRpb25zLmVuYWJsZVNjaGVtYUhvb2tzICE9PSAnYm9vbGVhbicpIHtcbiAgICAgIHRocm93IGBkYXRhYmFzZU9wdGlvbnMuZW5hYmxlU2NoZW1hSG9va3MgbXVzdCBiZSBhIGJvb2xlYW5gO1xuICAgIH1cbiAgICBpZiAoZGF0YWJhc2VPcHRpb25zLnNjaGVtYUNhY2hlVHRsID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGRhdGFiYXNlT3B0aW9ucy5zY2hlbWFDYWNoZVR0bCA9IERhdGFiYXNlT3B0aW9ucy5zY2hlbWFDYWNoZVR0bC5kZWZhdWx0O1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGRhdGFiYXNlT3B0aW9ucy5zY2hlbWFDYWNoZVR0bCAhPT0gJ251bWJlcicpIHtcbiAgICAgIHRocm93IGBkYXRhYmFzZU9wdGlvbnMuc2NoZW1hQ2FjaGVUdGwgbXVzdCBiZSBhIG51bWJlcmA7XG4gICAgfVxuICAgIGlmIChkYXRhYmFzZU9wdGlvbnMuYWxsb3dQdWJsaWNFeHBsYWluID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGRhdGFiYXNlT3B0aW9ucy5hbGxvd1B1YmxpY0V4cGxhaW4gPSBEYXRhYmFzZU9wdGlvbnMuYWxsb3dQdWJsaWNFeHBsYWluLmRlZmF1bHQ7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgZGF0YWJhc2VPcHRpb25zLmFsbG93UHVibGljRXhwbGFpbiAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICB0aHJvdyBgUGFyc2UgU2VydmVyIG9wdGlvbiAnZGF0YWJhc2VPcHRpb25zLmFsbG93UHVibGljRXhwbGFpbicgbXVzdCBiZSBhIGJvb2xlYW4uYDtcbiAgICB9XG4gIH1cblxuICBzdGF0aWMgdmFsaWRhdGVSYXRlTGltaXQocmF0ZUxpbWl0KSB7XG4gICAgaWYgKCFyYXRlTGltaXQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHJhdGVMaW1pdCkgIT09ICdbb2JqZWN0IE9iamVjdF0nICYmXG4gICAgICAhQXJyYXkuaXNBcnJheShyYXRlTGltaXQpXG4gICAgKSB7XG4gICAgICB0aHJvdyBgcmF0ZUxpbWl0IG11c3QgYmUgYW4gYXJyYXkgb3Igb2JqZWN0YDtcbiAgICB9XG4gICAgY29uc3Qgb3B0aW9ucyA9IEFycmF5LmlzQXJyYXkocmF0ZUxpbWl0KSA/IHJhdGVMaW1pdCA6IFtyYXRlTGltaXRdO1xuICAgIGZvciAoY29uc3Qgb3B0aW9uIG9mIG9wdGlvbnMpIHtcbiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwob3B0aW9uKSAhPT0gJ1tvYmplY3QgT2JqZWN0XScpIHtcbiAgICAgICAgdGhyb3cgYHJhdGVMaW1pdCBtdXN0IGJlIGFuIGFycmF5IG9mIG9iamVjdHNgO1xuICAgICAgfVxuICAgICAgaWYgKG9wdGlvbi5yZXF1ZXN0UGF0aCA9PSBudWxsKSB7XG4gICAgICAgIHRocm93IGByYXRlTGltaXQucmVxdWVzdFBhdGggbXVzdCBiZSBkZWZpbmVkYDtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2Ygb3B0aW9uLnJlcXVlc3RQYXRoICE9PSAnc3RyaW5nJykge1xuICAgICAgICB0aHJvdyBgcmF0ZUxpbWl0LnJlcXVlc3RQYXRoIG11c3QgYmUgYSBzdHJpbmdgO1xuICAgICAgfVxuICAgICAgaWYgKG9wdGlvbi5yZXF1ZXN0VGltZVdpbmRvdyA9PSBudWxsKSB7XG4gICAgICAgIHRocm93IGByYXRlTGltaXQucmVxdWVzdFRpbWVXaW5kb3cgbXVzdCBiZSBkZWZpbmVkYDtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2Ygb3B0aW9uLnJlcXVlc3RUaW1lV2luZG93ICE9PSAnbnVtYmVyJykge1xuICAgICAgICB0aHJvdyBgcmF0ZUxpbWl0LnJlcXVlc3RUaW1lV2luZG93IG11c3QgYmUgYSBudW1iZXJgO1xuICAgICAgfVxuICAgICAgaWYgKG9wdGlvbi5pbmNsdWRlSW50ZXJuYWxSZXF1ZXN0cyAmJiB0eXBlb2Ygb3B0aW9uLmluY2x1ZGVJbnRlcm5hbFJlcXVlc3RzICE9PSAnYm9vbGVhbicpIHtcbiAgICAgICAgdGhyb3cgYHJhdGVMaW1pdC5pbmNsdWRlSW50ZXJuYWxSZXF1ZXN0cyBtdXN0IGJlIGEgYm9vbGVhbmA7XG4gICAgICB9XG4gICAgICBpZiAob3B0aW9uLnJlcXVlc3RDb3VudCA9PSBudWxsKSB7XG4gICAgICAgIHRocm93IGByYXRlTGltaXQucmVxdWVzdENvdW50IG11c3QgYmUgZGVmaW5lZGA7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIG9wdGlvbi5yZXF1ZXN0Q291bnQgIT09ICdudW1iZXInKSB7XG4gICAgICAgIHRocm93IGByYXRlTGltaXQucmVxdWVzdENvdW50IG11c3QgYmUgYSBudW1iZXJgO1xuICAgICAgfVxuICAgICAgaWYgKG9wdGlvbi5lcnJvclJlc3BvbnNlTWVzc2FnZSAmJiB0eXBlb2Ygb3B0aW9uLmVycm9yUmVzcG9uc2VNZXNzYWdlICE9PSAnc3RyaW5nJykge1xuICAgICAgICB0aHJvdyBgcmF0ZUxpbWl0LmVycm9yUmVzcG9uc2VNZXNzYWdlIG11c3QgYmUgYSBzdHJpbmdgO1xuICAgICAgfVxuICAgICAgY29uc3Qgb3B0aW9ucyA9IE9iamVjdC5rZXlzKFBhcnNlU2VydmVyLlJhdGVMaW1pdFpvbmUpO1xuICAgICAgaWYgKG9wdGlvbi56b25lICYmICFvcHRpb25zLmluY2x1ZGVzKG9wdGlvbi56b25lKSkge1xuICAgICAgICBjb25zdCBmb3JtYXR0ZXIgPSBuZXcgSW50bC5MaXN0Rm9ybWF0KCdlbicsIHsgc3R5bGU6ICdzaG9ydCcsIHR5cGU6ICdkaXNqdW5jdGlvbicgfSk7XG4gICAgICAgIHRocm93IGByYXRlTGltaXQuem9uZSBtdXN0IGJlIG9uZSBvZiAke2Zvcm1hdHRlci5mb3JtYXQob3B0aW9ucyl9YDtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBnZW5lcmF0ZUVtYWlsVmVyaWZ5VG9rZW5FeHBpcmVzQXQoKSB7XG4gICAgaWYgKCF0aGlzLnZlcmlmeVVzZXJFbWFpbHMgfHwgIXRoaXMuZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24pIHtcbiAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxuICAgIHZhciBub3cgPSBuZXcgRGF0ZSgpO1xuICAgIHJldHVybiBuZXcgRGF0ZShub3cuZ2V0VGltZSgpICsgdGhpcy5lbWFpbFZlcmlmeVRva2VuVmFsaWRpdHlEdXJhdGlvbiAqIDEwMDApO1xuICB9XG5cbiAgZ2VuZXJhdGVQYXNzd29yZFJlc2V0VG9rZW5FeHBpcmVzQXQoKSB7XG4gICAgaWYgKCF0aGlzLnBhc3N3b3JkUG9saWN5IHx8ICF0aGlzLnBhc3N3b3JkUG9saWN5LnJlc2V0VG9rZW5WYWxpZGl0eUR1cmF0aW9uKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpO1xuICAgIHJldHVybiBuZXcgRGF0ZShub3cuZ2V0VGltZSgpICsgdGhpcy5wYXNzd29yZFBvbGljeS5yZXNldFRva2VuVmFsaWRpdHlEdXJhdGlvbiAqIDEwMDApO1xuICB9XG5cbiAgZ2VuZXJhdGVTZXNzaW9uRXhwaXJlc0F0KCkge1xuICAgIGlmICghdGhpcy5leHBpcmVJbmFjdGl2ZVNlc3Npb25zKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgICB2YXIgbm93ID0gbmV3IERhdGUoKTtcbiAgICByZXR1cm4gbmV3IERhdGUobm93LmdldFRpbWUoKSArIHRoaXMuc2Vzc2lvbkxlbmd0aCAqIDEwMDApO1xuICB9XG5cbiAgdW5yZWdpc3RlclJhdGVMaW1pdGVycygpIHtcbiAgICBsZXQgaSA9IHRoaXMucmF0ZUxpbWl0cz8ubGVuZ3RoO1xuICAgIHdoaWxlIChpLS0pIHtcbiAgICAgIGNvbnN0IGxpbWl0ID0gdGhpcy5yYXRlTGltaXRzW2ldO1xuICAgICAgaWYgKGxpbWl0LmNsb3VkKSB7XG4gICAgICAgIHRoaXMucmF0ZUxpbWl0cy5zcGxpY2UoaSwgMSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZ2V0IGludmFsaWRMaW5rVVJMKCkge1xuICAgIHJldHVybiB0aGlzLmN1c3RvbVBhZ2VzLmludmFsaWRMaW5rIHx8IGAke3RoaXMucHVibGljU2VydmVyVVJMfS9hcHBzL2ludmFsaWRfbGluay5odG1sYDtcbiAgfVxuXG4gIGdldCBpbnZhbGlkVmVyaWZpY2F0aW9uTGlua1VSTCgpIHtcbiAgICByZXR1cm4gKFxuICAgICAgdGhpcy5jdXN0b21QYWdlcy5pbnZhbGlkVmVyaWZpY2F0aW9uTGluayB8fFxuICAgICAgYCR7dGhpcy5wdWJsaWNTZXJ2ZXJVUkx9L2FwcHMvaW52YWxpZF92ZXJpZmljYXRpb25fbGluay5odG1sYFxuICAgICk7XG4gIH1cblxuICBnZXQgbGlua1NlbmRTdWNjZXNzVVJMKCkge1xuICAgIHJldHVybiAoXG4gICAgICB0aGlzLmN1c3RvbVBhZ2VzLmxpbmtTZW5kU3VjY2VzcyB8fCBgJHt0aGlzLnB1YmxpY1NlcnZlclVSTH0vYXBwcy9saW5rX3NlbmRfc3VjY2Vzcy5odG1sYFxuICAgICk7XG4gIH1cblxuICBnZXQgbGlua1NlbmRGYWlsVVJMKCkge1xuICAgIHJldHVybiB0aGlzLmN1c3RvbVBhZ2VzLmxpbmtTZW5kRmFpbCB8fCBgJHt0aGlzLnB1YmxpY1NlcnZlclVSTH0vYXBwcy9saW5rX3NlbmRfZmFpbC5odG1sYDtcbiAgfVxuXG4gIGdldCB2ZXJpZnlFbWFpbFN1Y2Nlc3NVUkwoKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIHRoaXMuY3VzdG9tUGFnZXMudmVyaWZ5RW1haWxTdWNjZXNzIHx8XG4gICAgICBgJHt0aGlzLnB1YmxpY1NlcnZlclVSTH0vYXBwcy92ZXJpZnlfZW1haWxfc3VjY2Vzcy5odG1sYFxuICAgICk7XG4gIH1cblxuICBnZXQgY2hvb3NlUGFzc3dvcmRVUkwoKSB7XG4gICAgcmV0dXJuIHRoaXMuY3VzdG9tUGFnZXMuY2hvb3NlUGFzc3dvcmQgfHwgYCR7dGhpcy5wdWJsaWNTZXJ2ZXJVUkx9L2FwcHMvY2hvb3NlX3Bhc3N3b3JkYDtcbiAgfVxuXG4gIGdldCByZXF1ZXN0UmVzZXRQYXNzd29yZFVSTCgpIHtcbiAgICByZXR1cm4gYCR7dGhpcy5wdWJsaWNTZXJ2ZXJVUkx9LyR7dGhpcy5wYWdlc0VuZHBvaW50fS8ke3RoaXMuYXBwbGljYXRpb25JZH0vcmVxdWVzdF9wYXNzd29yZF9yZXNldGA7XG4gIH1cblxuICBnZXQgcGFzc3dvcmRSZXNldFN1Y2Nlc3NVUkwoKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIHRoaXMuY3VzdG9tUGFnZXMucGFzc3dvcmRSZXNldFN1Y2Nlc3MgfHxcbiAgICAgIGAke3RoaXMucHVibGljU2VydmVyVVJMfS9hcHBzL3Bhc3N3b3JkX3Jlc2V0X3N1Y2Nlc3MuaHRtbGBcbiAgICApO1xuICB9XG5cbiAgZ2V0IHBhcnNlRnJhbWVVUkwoKSB7XG4gICAgcmV0dXJuIHRoaXMuY3VzdG9tUGFnZXMucGFyc2VGcmFtZVVSTDtcbiAgfVxuXG4gIGdldCB2ZXJpZnlFbWFpbFVSTCgpIHtcbiAgICByZXR1cm4gYCR7dGhpcy5wdWJsaWNTZXJ2ZXJVUkx9LyR7dGhpcy5wYWdlc0VuZHBvaW50fS8ke3RoaXMuYXBwbGljYXRpb25JZH0vdmVyaWZ5X2VtYWlsYDtcbiAgfVxuXG4gIGFzeW5jIGxvYWRNYXN0ZXJLZXkoKSB7XG4gICAgaWYgKHR5cGVvZiB0aGlzLm1hc3RlcktleSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgY29uc3QgdHRsSXNFbXB0eSA9ICF0aGlzLm1hc3RlcktleVR0bDtcbiAgICAgIGNvbnN0IGlzRXhwaXJlZCA9IHRoaXMubWFzdGVyS2V5Q2FjaGU/LmV4cGlyZXNBdCAmJiB0aGlzLm1hc3RlcktleUNhY2hlLmV4cGlyZXNBdCA8IG5ldyBEYXRlKCk7XG5cbiAgICAgIGlmICgoIWlzRXhwaXJlZCB8fCB0dGxJc0VtcHR5KSAmJiB0aGlzLm1hc3RlcktleUNhY2hlPy5tYXN0ZXJLZXkpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMubWFzdGVyS2V5Q2FjaGUubWFzdGVyS2V5O1xuICAgICAgfVxuXG4gICAgICBjb25zdCBtYXN0ZXJLZXkgPSBhd2FpdCB0aGlzLm1hc3RlcktleSgpO1xuXG4gICAgICBjb25zdCBleHBpcmVzQXQgPSB0aGlzLm1hc3RlcktleVR0bCA/IG5ldyBEYXRlKERhdGUubm93KCkgKyAxMDAwICogdGhpcy5tYXN0ZXJLZXlUdGwpIDogbnVsbFxuICAgICAgdGhpcy5tYXN0ZXJLZXlDYWNoZSA9IHsgbWFzdGVyS2V5LCBleHBpcmVzQXQgfTtcbiAgICAgIENvbmZpZy5wdXQodGhpcyk7XG5cbiAgICAgIHJldHVybiB0aGlzLm1hc3RlcktleUNhY2hlLm1hc3RlcktleTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5tYXN0ZXJLZXk7XG4gIH1cblxuICAvLyBUT0RPOiBSZW1vdmUgdGhpcyBmdW5jdGlvbiBvbmNlIFBhZ2VzUm91dGVyIHJlcGxhY2VzIHRoZSBQdWJsaWNBUElSb3V0ZXI7XG4gIC8vIHRoZSAoZGVmYXVsdCkgZW5kcG9pbnQgaGFzIHRvIGJlIGRlZmluZWQgaW4gUGFnZXNSb3V0ZXIgb25seS5cbiAgZ2V0IHBhZ2VzRW5kcG9pbnQoKSB7XG4gICAgcmV0dXJuIHRoaXMucGFnZXMgJiYgdGhpcy5wYWdlcy5lbmFibGVSb3V0ZXIgJiYgdGhpcy5wYWdlcy5wYWdlc0VuZHBvaW50XG4gICAgICA/IHRoaXMucGFnZXMucGFnZXNFbmRwb2ludFxuICAgICAgOiAnYXBwcyc7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQg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