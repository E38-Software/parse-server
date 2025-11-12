"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _RestQuery = _interopRequireDefault(require("./RestQuery"));
var _lodash = _interopRequireDefault(require("lodash"));
var _logger = _interopRequireDefault(require("./logger"));
var _SchemaController = require("./Controllers/SchemaController");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// A RestWrite encapsulates everything we need to run an operation
// that writes to the database.
// This could be either a "create" or an "update".

var SchemaController = require('./Controllers/SchemaController');
var deepcopy = require('deepcopy');
const Auth = require('./Auth');
const Utils = require('./Utils');
var cryptoUtils = require('./cryptoUtils');
var passwordCrypto = require('./password');
var Parse = require('parse/node');
var triggers = require('./triggers');
var ClientSDK = require('./ClientSDK');
const util = require('util');
// query and data are both provided in REST API format. So data
// types are encoded by plain old objects.
// If query is null, this is a "create" and the data in data should be
// created.
// Otherwise this is an "update" - the object matching the query
// should get updated with data.
// RestWrite will handle objectId, createdAt, and updatedAt for
// everything. It also knows to use triggers and special modifications
// for the _User class.
function RestWrite(config, auth, className, query, data, originalData, clientSDK, context, action) {
  if (auth.isReadOnly) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Cannot perform a write operation when using readOnlyMasterKey');
  }
  this.config = config;
  this.auth = auth;
  this.className = className;
  this.clientSDK = clientSDK;
  this.storage = {};
  this.runOptions = {};
  this.context = context || {};
  if (action) {
    this.runOptions.action = action;
  }
  if (!query) {
    if (this.config.allowCustomObjectId) {
      if (Object.prototype.hasOwnProperty.call(data, 'objectId') && !data.objectId) {
        throw new Parse.Error(Parse.Error.MISSING_OBJECT_ID, 'objectId must not be empty, null or undefined');
      }
    } else {
      if (data.objectId) {
        throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'objectId is an invalid field name.');
      }
      if (data.id) {
        throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'id is an invalid field name.');
      }
    }
  }

  // When the operation is complete, this.response may have several
  // fields.
  // response: the actual data to be returned
  // status: the http status code. if not present, treated like a 200
  // location: the location header. if not present, no location header
  this.response = null;

  // Processing this operation may mutate our data, so we operate on a
  // copy
  this.query = deepcopy(query);
  this.data = deepcopy(data);
  // We never change originalData, so we do not need a deep copy
  this.originalData = originalData;

  // The timestamp we'll use for this whole operation
  this.updatedAt = Parse._encode(new Date()).iso;

  // Shared SchemaController to be reused to reduce the number of loadSchema() calls per request
  // Once set the schemaData should be immutable
  this.validSchemaController = null;
  this.pendingOps = {
    operations: null,
    identifier: null
  };
}

// A convenient method to perform all the steps of processing the
// write, in order.
// Returns a promise for a {response, status, location} object.
// status and location are optional.
RestWrite.prototype.execute = function () {
  return Promise.resolve().then(() => {
    return this.getUserAndRoleACL();
  }).then(() => {
    return this.validateClientClassCreation();
  }).then(() => {
    return this.handleInstallation();
  }).then(() => {
    return this.handleSession();
  }).then(() => {
    return this.validateAuthData();
  }).then(() => {
    return this.checkRestrictedFields();
  }).then(() => {
    return this.runBeforeSaveTrigger();
  }).then(() => {
    return this.ensureUniqueAuthDataId();
  }).then(() => {
    return this.deleteEmailResetTokenIfNeeded();
  }).then(() => {
    return this.validateSchema();
  }).then(schemaController => {
    this.validSchemaController = schemaController;
    return this.setRequiredFieldsIfNeeded();
  }).then(() => {
    return this.transformUser();
  }).then(() => {
    return this.expandFilesForExistingObjects();
  }).then(() => {
    return this.destroyDuplicatedSessions();
  }).then(() => {
    return this.runDatabaseOperation();
  }).then(() => {
    return this.createSessionTokenIfNeeded();
  }).then(() => {
    return this.handleFollowup();
  }).then(() => {
    return this.runAfterSaveTrigger();
  }).then(() => {
    return this.cleanUserAuthData();
  }).then(() => {
    // Append the authDataResponse if exists
    if (this.authDataResponse) {
      if (this.response && this.response.response) {
        this.response.response.authDataResponse = this.authDataResponse;
      }
    }
    if (this.storage.rejectSignup && this.config.preventSignupWithUnverifiedEmail) {
      throw new Parse.Error(Parse.Error.EMAIL_NOT_FOUND, 'User email is not verified.');
    }
    return this.response;
  });
};

// Uses the Auth object to get the list of roles, adds the user id
RestWrite.prototype.getUserAndRoleACL = function () {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return Promise.resolve();
  }
  this.runOptions.acl = ['*'];
  if (this.auth.user) {
    return this.auth.getUserRoles().then(roles => {
      this.runOptions.acl = this.runOptions.acl.concat(roles, [this.auth.user.id]);
      return;
    });
  } else {
    return Promise.resolve();
  }
};

// Validates this operation against the allowClientClassCreation config.
RestWrite.prototype.validateClientClassCreation = function () {
  if (this.config.allowClientClassCreation === false && !this.auth.isMaster && !this.auth.isMaintenance && SchemaController.systemClasses.indexOf(this.className) === -1) {
    return this.config.database.loadSchema().then(schemaController => schemaController.hasClass(this.className)).then(hasClass => {
      if (hasClass !== true) {
        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'This user is not allowed to access ' + 'non-existent class: ' + this.className);
      }
    });
  } else {
    return Promise.resolve();
  }
};

// Validates this operation against the schema.
RestWrite.prototype.validateSchema = function () {
  return this.config.database.validateObject(this.className, this.data, this.query, this.runOptions, this.auth.isMaintenance);
};

// Runs any beforeSave triggers against this operation.
// Any change leads to our data being mutated.
RestWrite.prototype.runBeforeSaveTrigger = function () {
  if (this.response || this.runOptions.many) {
    return;
  }

  // Avoid doing any setup for triggers if there is no 'beforeSave' trigger for this class.
  if (!triggers.triggerExists(this.className, triggers.Types.beforeSave, this.config.applicationId)) {
    return Promise.resolve();
  }
  const {
    originalObject,
    updatedObject
  } = this.buildParseObjects();
  const identifier = updatedObject._getStateIdentifier();
  const stateController = Parse.CoreManager.getObjectStateController();
  const [pending] = stateController.getPendingOps(identifier);
  this.pendingOps = {
    operations: {
      ...pending
    },
    identifier
  };
  return Promise.resolve().then(() => {
    // Before calling the trigger, validate the permissions for the save operation
    let databasePromise = null;
    if (this.query) {
      // Validate for updating
      databasePromise = this.config.database.update(this.className, this.query, this.data, this.runOptions, true, true);
    } else {
      // Validate for creating
      databasePromise = this.config.database.create(this.className, this.data, this.runOptions, true);
    }
    // In the case that there is no permission for the operation, it throws an error
    return databasePromise.then(result => {
      if (!result || result.length <= 0) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
      }
    });
  }).then(() => {
    return triggers.maybeRunTrigger(triggers.Types.beforeSave, this.auth, updatedObject, originalObject, this.config, this.context);
  }).then(response => {
    if (response && response.object) {
      this.storage.fieldsChangedByTrigger = _lodash.default.reduce(response.object, (result, value, key) => {
        if (!_lodash.default.isEqual(this.data[key], value)) {
          result.push(key);
        }
        return result;
      }, []);
      this.data = response.object;
      // We should delete the objectId for an update write
      if (this.query && this.query.objectId) {
        delete this.data.objectId;
      }
    }
    try {
      Utils.checkProhibitedKeywords(this.config, this.data);
    } catch (error) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, error);
    }
  });
};
RestWrite.prototype.runBeforeLoginTrigger = async function (userData) {
  // Avoid doing any setup for triggers if there is no 'beforeLogin' trigger
  if (!triggers.triggerExists(this.className, triggers.Types.beforeLogin, this.config.applicationId)) {
    return;
  }

  // Cloud code gets a bit of extra data for its objects
  const extraData = {
    className: this.className
  };

  // Expand file objects
  await this.config.filesController.expandFilesInObject(this.config, userData);
  const user = triggers.inflate(extraData, userData);

  // no need to return a response
  await triggers.maybeRunTrigger(triggers.Types.beforeLogin, this.auth, user, null, this.config, this.context);
};
RestWrite.prototype.setRequiredFieldsIfNeeded = function () {
  if (this.data) {
    return this.validSchemaController.getAllClasses().then(allClasses => {
      const schema = allClasses.find(oneClass => oneClass.className === this.className);
      const setRequiredFieldIfNeeded = (fieldName, setDefault) => {
        if (this.data[fieldName] === undefined || this.data[fieldName] === null || this.data[fieldName] === '' || typeof this.data[fieldName] === 'object' && this.data[fieldName].__op === 'Delete') {
          if (setDefault && schema.fields[fieldName] && schema.fields[fieldName].defaultValue !== null && schema.fields[fieldName].defaultValue !== undefined && (this.data[fieldName] === undefined || typeof this.data[fieldName] === 'object' && this.data[fieldName].__op === 'Delete')) {
            this.data[fieldName] = schema.fields[fieldName].defaultValue;
            this.storage.fieldsChangedByTrigger = this.storage.fieldsChangedByTrigger || [];
            if (this.storage.fieldsChangedByTrigger.indexOf(fieldName) < 0) {
              this.storage.fieldsChangedByTrigger.push(fieldName);
            }
          } else if (schema.fields[fieldName] && schema.fields[fieldName].required === true) {
            throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `${fieldName} is required`);
          }
        }
      };

      // add default ACL
      if (schema?.classLevelPermissions?.ACL && !this.data.ACL && JSON.stringify(schema.classLevelPermissions.ACL) !== JSON.stringify({
        '*': {
          read: true,
          write: true
        }
      })) {
        const acl = deepcopy(schema.classLevelPermissions.ACL);
        if (acl.currentUser) {
          if (this.auth.user?.id) {
            acl[this.auth.user?.id] = deepcopy(acl.currentUser);
          }
          delete acl.currentUser;
        }
        this.data.ACL = acl;
        this.storage.fieldsChangedByTrigger = this.storage.fieldsChangedByTrigger || [];
        this.storage.fieldsChangedByTrigger.push('ACL');
      }

      // Add default fields
      if (!this.query) {
        // allow customizing createdAt and updatedAt when using maintenance key
        if (this.auth.isMaintenance && this.data.createdAt && this.data.createdAt.__type === 'Date') {
          this.data.createdAt = this.data.createdAt.iso;
          if (this.data.updatedAt && this.data.updatedAt.__type === 'Date') {
            const createdAt = new Date(this.data.createdAt);
            const updatedAt = new Date(this.data.updatedAt.iso);
            if (updatedAt < createdAt) {
              throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'updatedAt cannot occur before createdAt');
            }
            this.data.updatedAt = this.data.updatedAt.iso;
          }
          // if no updatedAt is provided, set it to createdAt to match default behavior
          else {
            this.data.updatedAt = this.data.createdAt;
          }
        } else {
          this.data.updatedAt = this.updatedAt;
          this.data.createdAt = this.updatedAt;
        }

        // Only assign new objectId if we are creating new object
        if (!this.data.objectId) {
          this.data.objectId = cryptoUtils.newObjectId(this.config.objectIdSize);
        }
        if (schema) {
          Object.keys(schema.fields).forEach(fieldName => {
            setRequiredFieldIfNeeded(fieldName, true);
          });
        }
      } else if (schema) {
        this.data.updatedAt = this.updatedAt;
        Object.keys(this.data).forEach(fieldName => {
          setRequiredFieldIfNeeded(fieldName, false);
        });
      }
    });
  }
  return Promise.resolve();
};

// Transforms auth data for a user object.
// Does nothing if this isn't a user object.
// Returns a promise for when we're done if it can't finish this tick.
RestWrite.prototype.validateAuthData = function () {
  if (this.className !== '_User') {
    return;
  }
  const authData = this.data.authData;
  const hasUsernameAndPassword = typeof this.data.username === 'string' && typeof this.data.password === 'string';
  if (!this.query && !authData) {
    if (typeof this.data.username !== 'string' || _lodash.default.isEmpty(this.data.username)) {
      throw new Parse.Error(Parse.Error.USERNAME_MISSING, 'bad or missing username');
    }
    if (typeof this.data.password !== 'string' || _lodash.default.isEmpty(this.data.password)) {
      throw new Parse.Error(Parse.Error.PASSWORD_MISSING, 'password is required');
    }
  }
  if (authData && !Object.keys(authData).length || !Object.prototype.hasOwnProperty.call(this.data, 'authData')) {
    // Nothing to validate here
    return;
  } else if (Object.prototype.hasOwnProperty.call(this.data, 'authData') && !this.data.authData) {
    // Handle saving authData to null
    throw new Parse.Error(Parse.Error.UNSUPPORTED_SERVICE, 'This authentication method is unsupported.');
  }
  var providers = Object.keys(authData);
  if (providers.length > 0) {
    const canHandleAuthData = providers.some(provider => {
      const providerAuthData = authData[provider] || {};
      return !!Object.keys(providerAuthData).length;
    });
    if (canHandleAuthData || hasUsernameAndPassword || this.auth.isMaster || this.getUserId()) {
      return this.handleAuthData(authData);
    }
  }
  throw new Parse.Error(Parse.Error.UNSUPPORTED_SERVICE, 'This authentication method is unsupported.');
};
RestWrite.prototype.filteredObjectsByACL = function (objects) {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return objects;
  }
  return objects.filter(object => {
    if (!object.ACL) {
      return true; // legacy users that have no ACL field on them
    }
    // Regular users that have been locked out.
    return object.ACL && Object.keys(object.ACL).length > 0;
  });
};
RestWrite.prototype.getUserId = function () {
  if (this.query && this.query.objectId && this.className === '_User') {
    return this.query.objectId;
  } else if (this.auth && this.auth.user && this.auth.user.id) {
    return this.auth.user.id;
  }
};

// Developers are allowed to change authData via before save trigger
// we need after before save to ensure that the developer
// is not currently duplicating auth data ID
RestWrite.prototype.ensureUniqueAuthDataId = async function () {
  if (this.className !== '_User' || !this.data.authData) {
    return;
  }
  const hasAuthDataId = Object.keys(this.data.authData).some(key => this.data.authData[key] && this.data.authData[key].id);
  if (!hasAuthDataId) {
    return;
  }
  const r = await Auth.findUsersWithAuthData(this.config, this.data.authData);
  const results = this.filteredObjectsByACL(r);
  if (results.length > 1) {
    throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
  }
  // use data.objectId in case of login time and found user during handle validateAuthData
  const userId = this.getUserId() || this.data.objectId;
  if (results.length === 1 && userId !== results[0].objectId) {
    throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
  }
};
RestWrite.prototype.handleAuthData = async function (authData) {
  const r = await Auth.findUsersWithAuthData(this.config, authData, true);
  const results = this.filteredObjectsByACL(r);
  const userId = this.getUserId();
  const userResult = results[0];
  const foundUserIsNotCurrentUser = userId && userResult && userId !== userResult.objectId;
  if (results.length > 1 || foundUserIsNotCurrentUser) {
    // To avoid https://github.com/parse-community/parse-server/security/advisories/GHSA-8w3j-g983-8jh5
    // Let's run some validation before throwing
    await Auth.handleAuthDataValidation(authData, this, userResult);
    throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
  }

  // No user found with provided authData we need to validate
  if (!results.length) {
    const {
      authData: validatedAuthData,
      authDataResponse
    } = await Auth.handleAuthDataValidation(authData, this);
    this.authDataResponse = authDataResponse;
    // Replace current authData by the new validated one
    this.data.authData = validatedAuthData;
    return;
  }

  // User found with provided authData
  if (results.length === 1) {
    this.storage.authProvider = Object.keys(authData).join(',');
    const {
      hasMutatedAuthData,
      mutatedAuthData
    } = Auth.hasMutatedAuthData(authData, userResult.authData);
    const isCurrentUserLoggedOrMaster = this.auth && this.auth.user && this.auth.user.id === userResult.objectId || this.auth.isMaster;
    const isLogin = !userId;
    if (isLogin || isCurrentUserLoggedOrMaster) {
      // no user making the call
      // OR the user making the call is the right one
      // Login with auth data
      delete results[0].password;

      // need to set the objectId first otherwise location has trailing undefined
      this.data.objectId = userResult.objectId;
      if (!this.query || !this.query.objectId) {
        this.response = {
          response: userResult,
          location: this.location()
        };
        // Run beforeLogin hook before storing any updates
        // to authData on the db; changes to userResult
        // will be ignored.
        await this.runBeforeLoginTrigger(deepcopy(userResult));

        // If we are in login operation via authData
        // we need to be sure that the user has provided
        // required authData
        Auth.checkIfUserHasProvidedConfiguredProvidersForLogin({
          config: this.config,
          auth: this.auth
        }, authData, userResult.authData, this.config);
      }

      // Prevent validating if no mutated data detected on update
      if (!hasMutatedAuthData && isCurrentUserLoggedOrMaster) {
        return;
      }

      // Force to validate all provided authData on login
      // on update only validate mutated ones
      if (hasMutatedAuthData || !this.config.allowExpiredAuthDataToken) {
        const res = await Auth.handleAuthDataValidation(isLogin ? authData : mutatedAuthData, this, userResult);
        this.data.authData = res.authData;
        this.authDataResponse = res.authDataResponse;
      }

      // IF we are in login we'll skip the database operation / beforeSave / afterSave etc...
      // we need to set it up there.
      // We are supposed to have a response only on LOGIN with authData, so we skip those
      // If we're not logging in, but just updating the current user, we can safely skip that part
      if (this.response) {
        // Assign the new authData in the response
        Object.keys(mutatedAuthData).forEach(provider => {
          this.response.response.authData[provider] = mutatedAuthData[provider];
        });

        // Run the DB update directly, as 'master' only if authData contains some keys
        // authData could not contains keys after validation if the authAdapter
        // uses the `doNotSave` option. Just update the authData part
        // Then we're good for the user, early exit of sorts
        if (Object.keys(this.data.authData).length) {
          await this.config.database.update(this.className, {
            objectId: this.data.objectId
          }, {
            authData: this.data.authData
          }, {});
        }
      }
    }
  }
};
RestWrite.prototype.checkRestrictedFields = async function () {
  if (this.className !== '_User') {
    return;
  }
  if (!this.auth.isMaintenance && !this.auth.isMaster && 'emailVerified' in this.data) {
    const error = `Clients aren't allowed to manually update email verification.`;
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, error);
  }
};

// The non-third-party parts of User transformation
RestWrite.prototype.transformUser = async function () {
  var promise = Promise.resolve();
  if (this.className !== '_User') {
    return promise;
  }

  // Do not cleanup session if objectId is not set
  if (this.query && this.objectId()) {
    // If we're updating a _User object, we need to clear out the cache for that user. Find all their
    // session tokens, and remove them from the cache.
    const query = await (0, _RestQuery.default)({
      method: _RestQuery.default.Method.find,
      config: this.config,
      auth: Auth.master(this.config),
      className: '_Session',
      runBeforeFind: false,
      restWhere: {
        user: {
          __type: 'Pointer',
          className: '_User',
          objectId: this.objectId()
        }
      }
    });
    promise = query.execute().then(results => {
      results.results.forEach(session => this.config.cacheController.user.del(session.sessionToken));
    });
  }
  return promise.then(() => {
    // Transform the password
    if (this.data.password === undefined) {
      // ignore only if undefined. should proceed if empty ('')
      return Promise.resolve();
    }
    if (this.query) {
      this.storage['clearSessions'] = true;
      // Generate a new session only if the user requested
      if (!this.auth.isMaster && !this.auth.isMaintenance) {
        this.storage['generateNewSession'] = true;
      }
    }
    return this._validatePasswordPolicy().then(() => {
      return passwordCrypto.hash(this.data.password).then(hashedPassword => {
        this.data._hashed_password = hashedPassword;
        delete this.data.password;
      });
    });
  }).then(() => {
    return this._validateUserName();
  }).then(() => {
    return this._validateEmail();
  });
};
RestWrite.prototype._validateUserName = function () {
  // Check for username uniqueness
  if (!this.data.username) {
    if (!this.query) {
      this.data.username = cryptoUtils.randomString(25);
      this.responseShouldHaveUsername = true;
    }
    return Promise.resolve();
  }
  /*
    Usernames should be unique when compared case insensitively
     Users should be able to make case sensitive usernames and
    login using the case they entered.  I.e. 'Snoopy' should preclude
    'snoopy' as a valid username.
  */
  return this.config.database.find(this.className, {
    username: this.data.username,
    objectId: {
      $ne: this.objectId()
    }
  }, {
    limit: 1,
    caseInsensitive: true
  }, {}, this.validSchemaController).then(results => {
    if (results.length > 0) {
      throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
    }
    return;
  });
};

/*
  As with usernames, Parse should not allow case insensitive collisions of email.
  unlike with usernames (which can have case insensitive collisions in the case of
  auth adapters), emails should never have a case insensitive collision.

  This behavior can be enforced through a properly configured index see:
  https://docs.mongodb.com/manual/core/index-case-insensitive/#create-a-case-insensitive-index
  which could be implemented instead of this code based validation.

  Given that this lookup should be a relatively low use case and that the case sensitive
  unique index will be used by the db for the query, this is an adequate solution.
*/
RestWrite.prototype._validateEmail = function () {
  if (!this.data.email || this.data.email.__op === 'Delete') {
    return Promise.resolve();
  }
  // Validate basic email address format
  if (!this.data.email.match(/^.+@.+$/)) {
    return Promise.reject(new Parse.Error(Parse.Error.INVALID_EMAIL_ADDRESS, 'Email address format is invalid.'));
  }
  // Case insensitive match, see note above function.
  return this.config.database.find(this.className, {
    email: this.data.email,
    objectId: {
      $ne: this.objectId()
    }
  }, {
    limit: 1,
    caseInsensitive: true
  }, {}, this.validSchemaController).then(results => {
    if (results.length > 0) {
      throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
    }
    if (!this.data.authData || !Object.keys(this.data.authData).length || Object.keys(this.data.authData).length === 1 && Object.keys(this.data.authData)[0] === 'anonymous') {
      // We updated the email, send a new validation
      const {
        originalObject,
        updatedObject
      } = this.buildParseObjects();
      const request = {
        original: originalObject,
        object: updatedObject,
        master: this.auth.isMaster,
        ip: this.config.ip,
        installationId: this.auth.installationId
      };
      return this.config.userController.setEmailVerifyToken(this.data, request, this.storage);
    }
  });
};
RestWrite.prototype._validatePasswordPolicy = function () {
  if (!this.config.passwordPolicy) {
    return Promise.resolve();
  }
  return this._validatePasswordRequirements().then(() => {
    return this._validatePasswordHistory();
  });
};
RestWrite.prototype._validatePasswordRequirements = function () {
  // check if the password conforms to the defined password policy if configured
  // If we specified a custom error in our configuration use it.
  // Example: "Passwords must include a Capital Letter, Lowercase Letter, and a number."
  //
  // This is especially useful on the generic "password reset" page,
  // as it allows the programmer to communicate specific requirements instead of:
  // a. making the user guess whats wrong
  // b. making a custom password reset page that shows the requirements
  const policyError = this.config.passwordPolicy.validationError ? this.config.passwordPolicy.validationError : 'Password does not meet the Password Policy requirements.';
  const containsUsernameError = 'Password cannot contain your username.';

  // check whether the password meets the password strength requirements
  if (this.config.passwordPolicy.patternValidator && !this.config.passwordPolicy.patternValidator(this.data.password) || this.config.passwordPolicy.validatorCallback && !this.config.passwordPolicy.validatorCallback(this.data.password)) {
    return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, policyError));
  }

  // check whether password contain username
  if (this.config.passwordPolicy.doNotAllowUsername === true) {
    if (this.data.username) {
      // username is not passed during password reset
      if (this.data.password.indexOf(this.data.username) >= 0) {
        return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, containsUsernameError));
      }
    } else {
      // retrieve the User object using objectId during password reset
      return this.config.database.find('_User', {
        objectId: this.objectId()
      }).then(results => {
        if (results.length != 1) {
          throw undefined;
        }
        if (this.data.password.indexOf(results[0].username) >= 0) {
          return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, containsUsernameError));
        }
        return Promise.resolve();
      });
    }
  }
  return Promise.resolve();
};
RestWrite.prototype._validatePasswordHistory = function () {
  // check whether password is repeating from specified history
  if (this.query && this.config.passwordPolicy.maxPasswordHistory) {
    return this.config.database.find('_User', {
      objectId: this.objectId()
    }, {
      keys: ['_password_history', '_hashed_password']
    }, Auth.maintenance(this.config)).then(results => {
      if (results.length != 1) {
        throw undefined;
      }
      const user = results[0];
      let oldPasswords = [];
      if (user._password_history) {
        oldPasswords = _lodash.default.take(user._password_history, this.config.passwordPolicy.maxPasswordHistory - 1);
      }
      oldPasswords.push(user.password);
      const newPassword = this.data.password;
      // compare the new password hash with all old password hashes
      const promises = oldPasswords.map(function (hash) {
        return passwordCrypto.compare(newPassword, hash).then(result => {
          if (result)
            // reject if there is a match
            {
              return Promise.reject('REPEAT_PASSWORD');
            }
          return Promise.resolve();
        });
      });
      // wait for all comparisons to complete
      return Promise.all(promises).then(() => {
        return Promise.resolve();
      }).catch(err => {
        if (err === 'REPEAT_PASSWORD')
          // a match was found
          {
            return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, `New password should not be the same as last ${this.config.passwordPolicy.maxPasswordHistory} passwords.`));
          }
        throw err;
      });
    });
  }
  return Promise.resolve();
};
RestWrite.prototype.createSessionTokenIfNeeded = async function () {
  if (this.className !== '_User') {
    return;
  }
  // Don't generate session for updating user (this.query is set) unless authData exists
  if (this.query && !this.data.authData) {
    return;
  }
  // Don't generate new sessionToken if linking via sessionToken
  if (this.auth.user && this.data.authData) {
    return;
  }
  // If sign-up call
  if (!this.storage.authProvider) {
    // Create request object for verification functions
    const {
      originalObject,
      updatedObject
    } = this.buildParseObjects();
    const request = {
      original: originalObject,
      object: updatedObject,
      master: this.auth.isMaster,
      ip: this.config.ip,
      installationId: this.auth.installationId
    };
    // Get verification conditions which can be booleans or functions; the purpose of this async/await
    // structure is to avoid unnecessarily executing subsequent functions if previous ones fail in the
    // conditional statement below, as a developer may decide to execute expensive operations in them
    const verifyUserEmails = async () => this.config.verifyUserEmails === true || typeof this.config.verifyUserEmails === 'function' && (await Promise.resolve(this.config.verifyUserEmails(request))) === true;
    const preventLoginWithUnverifiedEmail = async () => this.config.preventLoginWithUnverifiedEmail === true || typeof this.config.preventLoginWithUnverifiedEmail === 'function' && (await Promise.resolve(this.config.preventLoginWithUnverifiedEmail(request))) === true;
    // If verification is required
    if ((await verifyUserEmails()) && (await preventLoginWithUnverifiedEmail())) {
      this.storage.rejectSignup = true;
      return;
    }
  }
  return this.createSessionToken();
};
RestWrite.prototype.createSessionToken = async function () {
  // cloud installationId from Cloud Code,
  // never create session tokens from there.
  if (this.auth.installationId && this.auth.installationId === 'cloud') {
    return;
  }
  if (this.storage.authProvider == null && this.data.authData) {
    this.storage.authProvider = Object.keys(this.data.authData).join(',');
  }
  const {
    sessionData,
    createSession
  } = RestWrite.createSession(this.config, {
    userId: this.objectId(),
    createdWith: {
      action: this.storage.authProvider ? 'login' : 'signup',
      authProvider: this.storage.authProvider || 'password'
    },
    installationId: this.auth.installationId
  });
  if (this.response && this.response.response) {
    this.response.response.sessionToken = sessionData.sessionToken;
  }
  return createSession();
};
RestWrite.createSession = function (config, {
  userId,
  createdWith,
  installationId,
  additionalSessionData
}) {
  const token = 'r:' + cryptoUtils.newToken();
  const expiresAt = config.generateSessionExpiresAt();
  const sessionData = {
    sessionToken: token,
    user: {
      __type: 'Pointer',
      className: '_User',
      objectId: userId
    },
    createdWith,
    expiresAt: Parse._encode(expiresAt)
  };
  if (installationId) {
    sessionData.installationId = installationId;
  }
  Object.assign(sessionData, additionalSessionData);
  return {
    sessionData,
    createSession: () => new RestWrite(config, Auth.master(config), '_Session', null, sessionData).execute()
  };
};

// Delete email reset tokens if user is changing password or email.
RestWrite.prototype.deleteEmailResetTokenIfNeeded = function () {
  if (this.className !== '_User' || this.query === null) {
    // null query means create
    return;
  }
  if ('password' in this.data || 'email' in this.data) {
    const addOps = {
      _perishable_token: {
        __op: 'Delete'
      },
      _perishable_token_expires_at: {
        __op: 'Delete'
      }
    };
    this.data = Object.assign(this.data, addOps);
  }
};
RestWrite.prototype.destroyDuplicatedSessions = function () {
  // Only for _Session, and at creation time
  if (this.className != '_Session' || this.query) {
    return;
  }
  // Destroy the sessions in 'Background'
  const {
    user,
    installationId,
    sessionToken
  } = this.data;
  if (!user || !installationId) {
    return;
  }
  if (!user.objectId) {
    return;
  }
  this.config.database.destroy('_Session', {
    user,
    installationId,
    sessionToken: {
      $ne: sessionToken
    }
  }, {}, this.validSchemaController);
};

// Handles any followup logic
RestWrite.prototype.handleFollowup = function () {
  if (this.storage && this.storage['clearSessions'] && this.config.revokeSessionOnPasswordReset) {
    var sessionQuery = {
      user: {
        __type: 'Pointer',
        className: '_User',
        objectId: this.objectId()
      }
    };
    delete this.storage['clearSessions'];
    return this.config.database.destroy('_Session', sessionQuery).then(this.handleFollowup.bind(this));
  }
  if (this.storage && this.storage['generateNewSession']) {
    delete this.storage['generateNewSession'];
    return this.createSessionToken().then(this.handleFollowup.bind(this));
  }
  if (this.storage && this.storage['sendVerificationEmail']) {
    delete this.storage['sendVerificationEmail'];
    // Fire and forget!
    this.config.userController.sendVerificationEmail(this.data, {
      auth: this.auth
    });
    return this.handleFollowup.bind(this);
  }
};

// Handles the _Session class specialness.
// Does nothing if this isn't an _Session object.
RestWrite.prototype.handleSession = function () {
  if (this.response || this.className !== '_Session') {
    return;
  }
  if (!this.auth.user && !this.auth.isMaster && !this.auth.isMaintenance) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Session token required.');
  }

  // TODO: Verify proper error to throw
  if (this.data.ACL) {
    throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'Cannot set ' + 'ACL on a Session.');
  }
  if (this.query) {
    if (this.data.user && !this.auth.isMaster && this.data.user.objectId != this.auth.user.id) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME);
    } else if (this.data.installationId) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME);
    } else if (this.data.sessionToken) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME);
    }
    if (!this.auth.isMaster) {
      this.query = {
        $and: [this.query, {
          user: {
            __type: 'Pointer',
            className: '_User',
            objectId: this.auth.user.id
          }
        }]
      };
    }
  }
  if (!this.query && !this.auth.isMaster && !this.auth.isMaintenance) {
    const additionalSessionData = {};
    for (var key in this.data) {
      if (key === 'objectId' || key === 'user') {
        continue;
      }
      additionalSessionData[key] = this.data[key];
    }
    const {
      sessionData,
      createSession
    } = RestWrite.createSession(this.config, {
      userId: this.auth.user.id,
      createdWith: {
        action: 'create'
      },
      additionalSessionData
    });
    return createSession().then(results => {
      if (!results.response) {
        throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'Error creating session.');
      }
      sessionData['objectId'] = results.response['objectId'];
      this.response = {
        status: 201,
        location: results.location,
        response: sessionData
      };
    });
  }
};

// Handles the _Installation class specialness.
// Does nothing if this isn't an installation object.
// If an installation is found, this can mutate this.query and turn a create
// into an update.
// Returns a promise for when we're done if it can't finish this tick.
RestWrite.prototype.handleInstallation = function () {
  if (this.response || this.className !== '_Installation') {
    return;
  }
  if (!this.query && !this.data.deviceToken && !this.data.installationId && !this.auth.installationId) {
    throw new Parse.Error(135, 'at least one ID field (deviceToken, installationId) ' + 'must be specified in this operation');
  }

  // If the device token is 64 characters long, we assume it is for iOS
  // and lowercase it.
  if (this.data.deviceToken && this.data.deviceToken.length == 64) {
    this.data.deviceToken = this.data.deviceToken.toLowerCase();
  }

  // We lowercase the installationId if present
  if (this.data.installationId) {
    this.data.installationId = this.data.installationId.toLowerCase();
  }
  let installationId = this.data.installationId;

  // If data.installationId is not set and we're not master, we can lookup in auth
  if (!installationId && !this.auth.isMaster && !this.auth.isMaintenance) {
    installationId = this.auth.installationId;
  }
  if (installationId) {
    installationId = installationId.toLowerCase();
  }

  // Updating _Installation but not updating anything critical
  if (this.query && !this.data.deviceToken && !installationId && !this.data.deviceType) {
    return;
  }
  var promise = Promise.resolve();
  var idMatch; // Will be a match on either objectId or installationId
  var objectIdMatch;
  var installationIdMatch;
  var deviceTokenMatches = [];

  // Instead of issuing 3 reads, let's do it with one OR.
  const orQueries = [];
  if (this.query && this.query.objectId) {
    orQueries.push({
      objectId: this.query.objectId
    });
  }
  if (installationId) {
    orQueries.push({
      installationId: installationId
    });
  }
  if (this.data.deviceToken) {
    orQueries.push({
      deviceToken: this.data.deviceToken
    });
  }
  if (orQueries.length == 0) {
    return;
  }
  promise = promise.then(() => {
    return this.config.database.find('_Installation', {
      $or: orQueries
    }, {});
  }).then(results => {
    results.forEach(result => {
      if (this.query && this.query.objectId && result.objectId == this.query.objectId) {
        objectIdMatch = result;
      }
      if (result.installationId == installationId) {
        installationIdMatch = result;
      }
      if (result.deviceToken == this.data.deviceToken) {
        deviceTokenMatches.push(result);
      }
    });

    // Sanity checks when running a query
    if (this.query && this.query.objectId) {
      if (!objectIdMatch) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found for update.');
      }
      if (this.data.installationId && objectIdMatch.installationId && this.data.installationId !== objectIdMatch.installationId) {
        throw new Parse.Error(136, 'installationId may not be changed in this ' + 'operation');
      }
      if (this.data.deviceToken && objectIdMatch.deviceToken && this.data.deviceToken !== objectIdMatch.deviceToken && !this.data.installationId && !objectIdMatch.installationId) {
        throw new Parse.Error(136, 'deviceToken may not be changed in this ' + 'operation');
      }
      if (this.data.deviceType && this.data.deviceType && this.data.deviceType !== objectIdMatch.deviceType) {
        throw new Parse.Error(136, 'deviceType may not be changed in this ' + 'operation');
      }
    }
    if (this.query && this.query.objectId && objectIdMatch) {
      idMatch = objectIdMatch;
    }
    if (installationId && installationIdMatch) {
      idMatch = installationIdMatch;
    }
    // need to specify deviceType only if it's new
    if (!this.query && !this.data.deviceType && !idMatch) {
      throw new Parse.Error(135, 'deviceType must be specified in this operation');
    }
  }).then(() => {
    if (!idMatch) {
      if (!deviceTokenMatches.length) {
        return;
      } else if (deviceTokenMatches.length == 1 && (!deviceTokenMatches[0]['installationId'] || !installationId)) {
        // Single match on device token but none on installationId, and either
        // the passed object or the match is missing an installationId, so we
        // can just return the match.
        return deviceTokenMatches[0]['objectId'];
      } else if (!this.data.installationId) {
        throw new Parse.Error(132, 'Must specify installationId when deviceToken ' + 'matches multiple Installation objects');
      } else {
        // Multiple device token matches and we specified an installation ID,
        // or a single match where both the passed and matching objects have
        // an installation ID. Try cleaning out old installations that match
        // the deviceToken, and return nil to signal that a new object should
        // be created.
        var delQuery = {
          deviceToken: this.data.deviceToken,
          installationId: {
            $ne: installationId
          }
        };
        if (this.data.appIdentifier) {
          delQuery['appIdentifier'] = this.data.appIdentifier;
        }
        this.config.database.destroy('_Installation', delQuery).catch(err => {
          if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
            // no deletions were made. Can be ignored.
            return;
          }
          // rethrow the error
          throw err;
        });
        return;
      }
    } else {
      if (deviceTokenMatches.length == 1 && !deviceTokenMatches[0]['installationId']) {
        // Exactly one device token match and it doesn't have an installation
        // ID. This is the one case where we want to merge with the existing
        // object.
        const delQuery = {
          objectId: idMatch.objectId
        };
        return this.config.database.destroy('_Installation', delQuery).then(() => {
          return deviceTokenMatches[0]['objectId'];
        }).catch(err => {
          if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
            // no deletions were made. Can be ignored
            return;
          }
          // rethrow the error
          throw err;
        });
      } else {
        if (this.data.deviceToken && idMatch.deviceToken != this.data.deviceToken) {
          // We're setting the device token on an existing installation, so
          // we should try cleaning out old installations that match this
          // device token.
          const delQuery = {
            deviceToken: this.data.deviceToken
          };
          // We have a unique install Id, use that to preserve
          // the interesting installation
          if (this.data.installationId) {
            delQuery['installationId'] = {
              $ne: this.data.installationId
            };
          } else if (idMatch.objectId && this.data.objectId && idMatch.objectId == this.data.objectId) {
            // we passed an objectId, preserve that instalation
            delQuery['objectId'] = {
              $ne: idMatch.objectId
            };
          } else {
            // What to do here? can't really clean up everything...
            return idMatch.objectId;
          }
          if (this.data.appIdentifier) {
            delQuery['appIdentifier'] = this.data.appIdentifier;
          }
          this.config.database.destroy('_Installation', delQuery).catch(err => {
            if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
              // no deletions were made. Can be ignored.
              return;
            }
            // rethrow the error
            throw err;
          });
        }
        // In non-merge scenarios, just return the installation match id
        return idMatch.objectId;
      }
    }
  }).then(objId => {
    if (objId) {
      this.query = {
        objectId: objId
      };
      delete this.data.objectId;
      delete this.data.createdAt;
    }
    // TODO: Validate ops (add/remove on channels, $inc on badge, etc.)
  });
  return promise;
};

// If we short-circuited the object response - then we need to make sure we expand all the files,
// since this might not have a query, meaning it won't return the full result back.
// TODO: (nlutsenko) This should die when we move to per-class based controllers on _Session/_User
RestWrite.prototype.expandFilesForExistingObjects = async function () {
  // Check whether we have a short-circuited response - only then run expansion.
  if (this.response && this.response.response) {
    await this.config.filesController.expandFilesInObject(this.config, this.response.response);
  }
};
RestWrite.prototype.runDatabaseOperation = function () {
  if (this.response) {
    return;
  }
  if (this.className === '_Role') {
    this.config.cacheController.role.clear();
    if (this.config.liveQueryController) {
      this.config.liveQueryController.clearCachedRoles(this.auth.user);
    }
  }
  if (this.className === '_User' && this.query && this.auth.isUnauthenticated()) {
    throw new Parse.Error(Parse.Error.SESSION_MISSING, `Cannot modify user ${this.query.objectId}.`);
  }
  if (this.className === '_Product' && this.data.download) {
    this.data.downloadName = this.data.download.name;
  }

  // TODO: Add better detection for ACL, ensuring a user can't be locked from
  //       their own user record.
  if (this.data.ACL && this.data.ACL['*unresolved']) {
    throw new Parse.Error(Parse.Error.INVALID_ACL, 'Invalid ACL.');
  }
  if (this.query) {
    // Force the user to not lockout
    // Matched with parse.com
    if (this.className === '_User' && this.data.ACL && this.auth.isMaster !== true && this.auth.isMaintenance !== true) {
      this.data.ACL[this.query.objectId] = {
        read: true,
        write: true
      };
    }
    // update password timestamp if user password is being changed
    if (this.className === '_User' && this.data._hashed_password && this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordAge) {
      this.data._password_changed_at = Parse._encode(new Date());
    }
    // Ignore createdAt when update
    delete this.data.createdAt;
    let defer = Promise.resolve();
    // if password history is enabled then save the current password to history
    if (this.className === '_User' && this.data._hashed_password && this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordHistory) {
      defer = this.config.database.find('_User', {
        objectId: this.objectId()
      }, {
        keys: ['_password_history', '_hashed_password']
      }, Auth.maintenance(this.config)).then(results => {
        if (results.length != 1) {
          throw undefined;
        }
        const user = results[0];
        let oldPasswords = [];
        if (user._password_history) {
          oldPasswords = _lodash.default.take(user._password_history, this.config.passwordPolicy.maxPasswordHistory);
        }
        //n-1 passwords go into history including last password
        while (oldPasswords.length > Math.max(0, this.config.passwordPolicy.maxPasswordHistory - 2)) {
          oldPasswords.shift();
        }
        oldPasswords.push(user.password);
        this.data._password_history = oldPasswords;
      });
    }
    return defer.then(() => {
      // Run an update
      return this.config.database.update(this.className, this.query, this.data, this.runOptions, false, false, this.validSchemaController).then(response => {
        response.updatedAt = this.updatedAt;
        this._updateResponseWithData(response, this.data);
        this.response = {
          response
        };
      });
    });
  } else {
    // Set the default ACL and password timestamp for the new _User
    if (this.className === '_User') {
      var ACL = this.data.ACL;
      // default public r/w ACL
      if (!ACL) {
        ACL = {};
        if (!this.config.enforcePrivateUsers) {
          ACL['*'] = {
            read: true,
            write: false
          };
        }
      }
      // make sure the user is not locked down
      ACL[this.data.objectId] = {
        read: true,
        write: true
      };
      this.data.ACL = ACL;
      // password timestamp to be used when password expiry policy is enforced
      if (this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordAge) {
        this.data._password_changed_at = Parse._encode(new Date());
      }
    }

    // Run a create
    return this.config.database.create(this.className, this.data, this.runOptions, false, this.validSchemaController).catch(error => {
      if (this.className !== '_User' || error.code !== Parse.Error.DUPLICATE_VALUE) {
        throw error;
      }

      // Quick check, if we were able to infer the duplicated field name
      if (error && error.userInfo && error.userInfo.duplicated_field === 'username') {
        throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
      }
      if (error && error.userInfo && error.userInfo.duplicated_field === 'email') {
        throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
      }

      // If this was a failed user creation due to username or email already taken, we need to
      // check whether it was username or email and return the appropriate error.
      // Fallback to the original method
      // TODO: See if we can later do this without additional queries by using named indexes.
      return this.config.database.find(this.className, {
        username: this.data.username,
        objectId: {
          $ne: this.objectId()
        }
      }, {
        limit: 1
      }).then(results => {
        if (results.length > 0) {
          throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
        }
        return this.config.database.find(this.className, {
          email: this.data.email,
          objectId: {
            $ne: this.objectId()
          }
        }, {
          limit: 1
        });
      }).then(results => {
        if (results.length > 0) {
          throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
        }
        throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      });
    }).then(response => {
      response.objectId = this.data.objectId;
      response.createdAt = this.data.createdAt;
      if (this.responseShouldHaveUsername) {
        response.username = this.data.username;
      }
      this._updateResponseWithData(response, this.data);
      this.response = {
        status: 201,
        response,
        location: this.location()
      };
    });
  }
};

// Returns nothing - doesn't wait for the trigger.
RestWrite.prototype.runAfterSaveTrigger = function () {
  if (!this.response || !this.response.response || this.runOptions.many) {
    return;
  }

  // Avoid doing any setup for triggers if there is no 'afterSave' trigger for this class.
  const hasAfterSaveHook = triggers.triggerExists(this.className, triggers.Types.afterSave, this.config.applicationId);
  const hasLiveQuery = this.config.liveQueryController.hasLiveQuery(this.className);
  if (!hasAfterSaveHook && !hasLiveQuery) {
    return Promise.resolve();
  }
  const {
    originalObject,
    updatedObject
  } = this.buildParseObjects();
  updatedObject._handleSaveResponse(this.response.response, this.response.status || 200);
  if (hasLiveQuery) {
    this.config.database.loadSchema().then(schemaController => {
      // Notify LiveQueryServer if possible
      const perms = schemaController.getClassLevelPermissions(updatedObject.className);
      this.config.liveQueryController.onAfterSave(updatedObject.className, updatedObject, originalObject, perms);
    });
  }
  if (!hasAfterSaveHook) {
    return Promise.resolve();
  }
  // Run afterSave trigger
  return triggers.maybeRunTrigger(triggers.Types.afterSave, this.auth, updatedObject, originalObject, this.config, this.context).then(result => {
    const jsonReturned = result && !result._toFullJSON;
    if (jsonReturned) {
      this.pendingOps.operations = {};
      this.response.response = result;
    } else {
      this.response.response = this._updateResponseWithData((result || updatedObject).toJSON(), this.data);
    }
  }).catch(function (err) {
    _logger.default.warn('afterSave caught an error', err);
  });
};

// A helper to figure out what location this operation happens at.
RestWrite.prototype.location = function () {
  var middle = this.className === '_User' ? '/users/' : '/classes/' + this.className + '/';
  const mount = this.config.mount || this.config.serverURL;
  return mount + middle + this.data.objectId;
};

// A helper to get the object id for this operation.
// Because it could be either on the query or on the data
RestWrite.prototype.objectId = function () {
  return this.data.objectId || this.query.objectId;
};

// Returns a copy of the data and delete bad keys (_auth_data, _hashed_password...)
RestWrite.prototype.sanitizedData = function () {
  const data = Object.keys(this.data).reduce((data, key) => {
    // Regexp comes from Parse.Object.prototype.validate
    if (!/^[A-Za-z][0-9A-Za-z_]*$/.test(key)) {
      delete data[key];
    }
    return data;
  }, deepcopy(this.data));
  return Parse._decode(undefined, data);
};

// Returns an updated copy of the object
RestWrite.prototype.buildParseObjects = function () {
  const extraData = {
    className: this.className,
    objectId: this.query?.objectId
  };
  let originalObject;
  if (this.query && this.query.objectId) {
    originalObject = triggers.inflate(extraData, this.originalData);
  }
  const className = Parse.Object.fromJSON(extraData);
  const readOnlyAttributes = className.constructor.readOnlyAttributes ? className.constructor.readOnlyAttributes() : [];

  // For _Role class, 'name' cannot be set after the role has an objectId.
  // In afterSave context, _handleSaveResponse has already set the objectId,
  // so we treat 'name' as read-only to avoid Parse SDK validation errors.
  const isRoleAfterSave = this.className === '_Role' && this.response && !this.query;
  if (isRoleAfterSave && this.data.name && !readOnlyAttributes.includes('name')) {
    readOnlyAttributes.push('name');
  }
  if (!this.originalData) {
    for (const attribute of readOnlyAttributes) {
      extraData[attribute] = this.data[attribute];
    }
  }
  const updatedObject = triggers.inflate(extraData, this.originalData);
  Object.keys(this.data).reduce(function (data, key) {
    if (key.indexOf('.') > 0) {
      if (typeof data[key].__op === 'string') {
        if (!readOnlyAttributes.includes(key)) {
          updatedObject.set(key, data[key]);
        }
      } else {
        // subdocument key with dot notation { 'x.y': v } => { 'x': { 'y' : v } })
        const splittedKey = key.split('.');
        const parentProp = splittedKey[0];
        let parentVal = updatedObject.get(parentProp);
        if (typeof parentVal !== 'object') {
          parentVal = {};
        }
        parentVal[splittedKey[1]] = data[key];
        updatedObject.set(parentProp, parentVal);
      }
      delete data[key];
    }
    return data;
  }, deepcopy(this.data));
  const sanitized = this.sanitizedData();
  for (const attribute of readOnlyAttributes) {
    delete sanitized[attribute];
  }
  updatedObject.set(sanitized);
  return {
    updatedObject,
    originalObject
  };
};
RestWrite.prototype.cleanUserAuthData = function () {
  if (this.response && this.response.response && this.className === '_User') {
    const user = this.response.response;
    if (user.authData) {
      Object.keys(user.authData).forEach(provider => {
        if (user.authData[provider] === null) {
          delete user.authData[provider];
        }
      });
      if (Object.keys(user.authData).length == 0) {
        delete user.authData;
      }
    }
  }
};
RestWrite.prototype._updateResponseWithData = function (response, data) {
  const stateController = Parse.CoreManager.getObjectStateController();
  const [pending] = stateController.getPendingOps(this.pendingOps.identifier);
  for (const key in this.pendingOps.operations) {
    if (!pending[key]) {
      data[key] = this.originalData ? this.originalData[key] : {
        __op: 'Delete'
      };
      this.storage.fieldsChangedByTrigger.push(key);
    }
  }
  const skipKeys = [...(_SchemaController.requiredColumns.read[this.className] || [])];
  if (!this.query) {
    skipKeys.push('objectId', 'createdAt');
  } else {
    skipKeys.push('updatedAt');
    delete response.objectId;
  }
  for (const key in response) {
    if (skipKeys.includes(key)) {
      continue;
    }
    const value = response[key];
    if (value == null || value.__type && value.__type === 'Pointer' || util.isDeepStrictEqual(data[key], value) || util.isDeepStrictEqual((this.originalData || {})[key], value)) {
      delete response[key];
    }
  }
  if (_lodash.default.isEmpty(this.storage.fieldsChangedByTrigger)) {
    return response;
  }
  const clientSupportsDelete = ClientSDK.supportsForwardDelete(this.clientSDK);
  this.storage.fieldsChangedByTrigger.forEach(fieldName => {
    const dataValue = data[fieldName];
    if (!Object.prototype.hasOwnProperty.call(response, fieldName)) {
      response[fieldName] = dataValue;
    }

    // Strips operations from responses
    if (response[fieldName] && response[fieldName].__op) {
      delete response[fieldName];
      if (clientSupportsDelete && dataValue.__op == 'Delete') {
        response[fieldName] = dataValue;
      }
    }
  });
  return response;
};
var _default = exports.default = RestWrite;
module.exports = RestWrite;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfUmVzdFF1ZXJ5IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfbG9kYXNoIiwiX2xvZ2dlciIsIl9TY2hlbWFDb250cm9sbGVyIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiU2NoZW1hQ29udHJvbGxlciIsImRlZXBjb3B5IiwiQXV0aCIsIlV0aWxzIiwiY3J5cHRvVXRpbHMiLCJwYXNzd29yZENyeXB0byIsIlBhcnNlIiwidHJpZ2dlcnMiLCJDbGllbnRTREsiLCJ1dGlsIiwiUmVzdFdyaXRlIiwiY29uZmlnIiwiYXV0aCIsImNsYXNzTmFtZSIsInF1ZXJ5IiwiZGF0YSIsIm9yaWdpbmFsRGF0YSIsImNsaWVudFNESyIsImNvbnRleHQiLCJhY3Rpb24iLCJpc1JlYWRPbmx5IiwiRXJyb3IiLCJPUEVSQVRJT05fRk9SQklEREVOIiwic3RvcmFnZSIsInJ1bk9wdGlvbnMiLCJhbGxvd0N1c3RvbU9iamVjdElkIiwiT2JqZWN0IiwicHJvdG90eXBlIiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwib2JqZWN0SWQiLCJNSVNTSU5HX09CSkVDVF9JRCIsIklOVkFMSURfS0VZX05BTUUiLCJpZCIsInJlc3BvbnNlIiwidXBkYXRlZEF0IiwiX2VuY29kZSIsIkRhdGUiLCJpc28iLCJ2YWxpZFNjaGVtYUNvbnRyb2xsZXIiLCJwZW5kaW5nT3BzIiwib3BlcmF0aW9ucyIsImlkZW50aWZpZXIiLCJleGVjdXRlIiwiUHJvbWlzZSIsInJlc29sdmUiLCJ0aGVuIiwiZ2V0VXNlckFuZFJvbGVBQ0wiLCJ2YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24iLCJoYW5kbGVJbnN0YWxsYXRpb24iLCJoYW5kbGVTZXNzaW9uIiwidmFsaWRhdGVBdXRoRGF0YSIsImNoZWNrUmVzdHJpY3RlZEZpZWxkcyIsInJ1bkJlZm9yZVNhdmVUcmlnZ2VyIiwiZW5zdXJlVW5pcXVlQXV0aERhdGFJZCIsImRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkIiwidmFsaWRhdGVTY2hlbWEiLCJzY2hlbWFDb250cm9sbGVyIiwic2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCIsInRyYW5zZm9ybVVzZXIiLCJleHBhbmRGaWxlc0ZvckV4aXN0aW5nT2JqZWN0cyIsImRlc3Ryb3lEdXBsaWNhdGVkU2Vzc2lvbnMiLCJydW5EYXRhYmFzZU9wZXJhdGlvbiIsImNyZWF0ZVNlc3Npb25Ub2tlbklmTmVlZGVkIiwiaGFuZGxlRm9sbG93dXAiLCJydW5BZnRlclNhdmVUcmlnZ2VyIiwiY2xlYW5Vc2VyQXV0aERhdGEiLCJhdXRoRGF0YVJlc3BvbnNlIiwicmVqZWN0U2lnbnVwIiwicHJldmVudFNpZ251cFdpdGhVbnZlcmlmaWVkRW1haWwiLCJFTUFJTF9OT1RfRk9VTkQiLCJpc01hc3RlciIsImlzTWFpbnRlbmFuY2UiLCJhY2wiLCJ1c2VyIiwiZ2V0VXNlclJvbGVzIiwicm9sZXMiLCJjb25jYXQiLCJhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24iLCJzeXN0ZW1DbGFzc2VzIiwiaW5kZXhPZiIsImRhdGFiYXNlIiwibG9hZFNjaGVtYSIsImhhc0NsYXNzIiwidmFsaWRhdGVPYmplY3QiLCJtYW55IiwidHJpZ2dlckV4aXN0cyIsIlR5cGVzIiwiYmVmb3JlU2F2ZSIsImFwcGxpY2F0aW9uSWQiLCJvcmlnaW5hbE9iamVjdCIsInVwZGF0ZWRPYmplY3QiLCJidWlsZFBhcnNlT2JqZWN0cyIsIl9nZXRTdGF0ZUlkZW50aWZpZXIiLCJzdGF0ZUNvbnRyb2xsZXIiLCJDb3JlTWFuYWdlciIsImdldE9iamVjdFN0YXRlQ29udHJvbGxlciIsInBlbmRpbmciLCJnZXRQZW5kaW5nT3BzIiwiZGF0YWJhc2VQcm9taXNlIiwidXBkYXRlIiwiY3JlYXRlIiwicmVzdWx0IiwibGVuZ3RoIiwiT0JKRUNUX05PVF9GT1VORCIsIm1heWJlUnVuVHJpZ2dlciIsIm9iamVjdCIsImZpZWxkc0NoYW5nZWRCeVRyaWdnZXIiLCJfIiwicmVkdWNlIiwidmFsdWUiLCJrZXkiLCJpc0VxdWFsIiwicHVzaCIsImNoZWNrUHJvaGliaXRlZEtleXdvcmRzIiwiZXJyb3IiLCJydW5CZWZvcmVMb2dpblRyaWdnZXIiLCJ1c2VyRGF0YSIsImJlZm9yZUxvZ2luIiwiZXh0cmFEYXRhIiwiZmlsZXNDb250cm9sbGVyIiwiZXhwYW5kRmlsZXNJbk9iamVjdCIsImluZmxhdGUiLCJnZXRBbGxDbGFzc2VzIiwiYWxsQ2xhc3NlcyIsInNjaGVtYSIsImZpbmQiLCJvbmVDbGFzcyIsInNldFJlcXVpcmVkRmllbGRJZk5lZWRlZCIsImZpZWxkTmFtZSIsInNldERlZmF1bHQiLCJ1bmRlZmluZWQiLCJfX29wIiwiZmllbGRzIiwiZGVmYXVsdFZhbHVlIiwicmVxdWlyZWQiLCJWQUxJREFUSU9OX0VSUk9SIiwiY2xhc3NMZXZlbFBlcm1pc3Npb25zIiwiQUNMIiwiSlNPTiIsInN0cmluZ2lmeSIsInJlYWQiLCJ3cml0ZSIsImN1cnJlbnRVc2VyIiwiY3JlYXRlZEF0IiwiX190eXBlIiwibmV3T2JqZWN0SWQiLCJvYmplY3RJZFNpemUiLCJrZXlzIiwiZm9yRWFjaCIsImF1dGhEYXRhIiwiaGFzVXNlcm5hbWVBbmRQYXNzd29yZCIsInVzZXJuYW1lIiwicGFzc3dvcmQiLCJpc0VtcHR5IiwiVVNFUk5BTUVfTUlTU0lORyIsIlBBU1NXT1JEX01JU1NJTkciLCJVTlNVUFBPUlRFRF9TRVJWSUNFIiwicHJvdmlkZXJzIiwiY2FuSGFuZGxlQXV0aERhdGEiLCJzb21lIiwicHJvdmlkZXIiLCJwcm92aWRlckF1dGhEYXRhIiwiZ2V0VXNlcklkIiwiaGFuZGxlQXV0aERhdGEiLCJmaWx0ZXJlZE9iamVjdHNCeUFDTCIsIm9iamVjdHMiLCJmaWx0ZXIiLCJoYXNBdXRoRGF0YUlkIiwiciIsImZpbmRVc2Vyc1dpdGhBdXRoRGF0YSIsInJlc3VsdHMiLCJBQ0NPVU5UX0FMUkVBRFlfTElOS0VEIiwidXNlcklkIiwidXNlclJlc3VsdCIsImZvdW5kVXNlcklzTm90Q3VycmVudFVzZXIiLCJoYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24iLCJ2YWxpZGF0ZWRBdXRoRGF0YSIsImF1dGhQcm92aWRlciIsImpvaW4iLCJoYXNNdXRhdGVkQXV0aERhdGEiLCJtdXRhdGVkQXV0aERhdGEiLCJpc0N1cnJlbnRVc2VyTG9nZ2VkT3JNYXN0ZXIiLCJpc0xvZ2luIiwibG9jYXRpb24iLCJjaGVja0lmVXNlckhhc1Byb3ZpZGVkQ29uZmlndXJlZFByb3ZpZGVyc0ZvckxvZ2luIiwiYWxsb3dFeHBpcmVkQXV0aERhdGFUb2tlbiIsInJlcyIsInByb21pc2UiLCJSZXN0UXVlcnkiLCJtZXRob2QiLCJNZXRob2QiLCJtYXN0ZXIiLCJydW5CZWZvcmVGaW5kIiwicmVzdFdoZXJlIiwic2Vzc2lvbiIsImNhY2hlQ29udHJvbGxlciIsImRlbCIsInNlc3Npb25Ub2tlbiIsIl92YWxpZGF0ZVBhc3N3b3JkUG9saWN5IiwiaGFzaCIsImhhc2hlZFBhc3N3b3JkIiwiX2hhc2hlZF9wYXNzd29yZCIsIl92YWxpZGF0ZVVzZXJOYW1lIiwiX3ZhbGlkYXRlRW1haWwiLCJyYW5kb21TdHJpbmciLCJyZXNwb25zZVNob3VsZEhhdmVVc2VybmFtZSIsIiRuZSIsImxpbWl0IiwiY2FzZUluc2Vuc2l0aXZlIiwiVVNFUk5BTUVfVEFLRU4iLCJlbWFpbCIsIm1hdGNoIiwicmVqZWN0IiwiSU5WQUxJRF9FTUFJTF9BRERSRVNTIiwiRU1BSUxfVEFLRU4iLCJyZXF1ZXN0Iiwib3JpZ2luYWwiLCJpcCIsImluc3RhbGxhdGlvbklkIiwidXNlckNvbnRyb2xsZXIiLCJzZXRFbWFpbFZlcmlmeVRva2VuIiwicGFzc3dvcmRQb2xpY3kiLCJfdmFsaWRhdGVQYXNzd29yZFJlcXVpcmVtZW50cyIsIl92YWxpZGF0ZVBhc3N3b3JkSGlzdG9yeSIsInBvbGljeUVycm9yIiwidmFsaWRhdGlvbkVycm9yIiwiY29udGFpbnNVc2VybmFtZUVycm9yIiwicGF0dGVyblZhbGlkYXRvciIsInZhbGlkYXRvckNhbGxiYWNrIiwiZG9Ob3RBbGxvd1VzZXJuYW1lIiwibWF4UGFzc3dvcmRIaXN0b3J5IiwibWFpbnRlbmFuY2UiLCJvbGRQYXNzd29yZHMiLCJfcGFzc3dvcmRfaGlzdG9yeSIsInRha2UiLCJuZXdQYXNzd29yZCIsInByb21pc2VzIiwibWFwIiwiY29tcGFyZSIsImFsbCIsImNhdGNoIiwiZXJyIiwidmVyaWZ5VXNlckVtYWlscyIsInByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwiLCJjcmVhdGVTZXNzaW9uVG9rZW4iLCJzZXNzaW9uRGF0YSIsImNyZWF0ZVNlc3Npb24iLCJjcmVhdGVkV2l0aCIsImFkZGl0aW9uYWxTZXNzaW9uRGF0YSIsInRva2VuIiwibmV3VG9rZW4iLCJleHBpcmVzQXQiLCJnZW5lcmF0ZVNlc3Npb25FeHBpcmVzQXQiLCJhc3NpZ24iLCJhZGRPcHMiLCJfcGVyaXNoYWJsZV90b2tlbiIsIl9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQiLCJkZXN0cm95IiwicmV2b2tlU2Vzc2lvbk9uUGFzc3dvcmRSZXNldCIsInNlc3Npb25RdWVyeSIsImJpbmQiLCJzZW5kVmVyaWZpY2F0aW9uRW1haWwiLCJJTlZBTElEX1NFU1NJT05fVE9LRU4iLCIkYW5kIiwiSU5URVJOQUxfU0VSVkVSX0VSUk9SIiwic3RhdHVzIiwiZGV2aWNlVG9rZW4iLCJ0b0xvd2VyQ2FzZSIsImRldmljZVR5cGUiLCJpZE1hdGNoIiwib2JqZWN0SWRNYXRjaCIsImluc3RhbGxhdGlvbklkTWF0Y2giLCJkZXZpY2VUb2tlbk1hdGNoZXMiLCJvclF1ZXJpZXMiLCIkb3IiLCJkZWxRdWVyeSIsImFwcElkZW50aWZpZXIiLCJjb2RlIiwib2JqSWQiLCJyb2xlIiwiY2xlYXIiLCJsaXZlUXVlcnlDb250cm9sbGVyIiwiY2xlYXJDYWNoZWRSb2xlcyIsImlzVW5hdXRoZW50aWNhdGVkIiwiU0VTU0lPTl9NSVNTSU5HIiwiZG93bmxvYWQiLCJkb3dubG9hZE5hbWUiLCJuYW1lIiwiSU5WQUxJRF9BQ0wiLCJtYXhQYXNzd29yZEFnZSIsIl9wYXNzd29yZF9jaGFuZ2VkX2F0IiwiZGVmZXIiLCJNYXRoIiwibWF4Iiwic2hpZnQiLCJfdXBkYXRlUmVzcG9uc2VXaXRoRGF0YSIsImVuZm9yY2VQcml2YXRlVXNlcnMiLCJEVVBMSUNBVEVfVkFMVUUiLCJ1c2VySW5mbyIsImR1cGxpY2F0ZWRfZmllbGQiLCJoYXNBZnRlclNhdmVIb29rIiwiYWZ0ZXJTYXZlIiwiaGFzTGl2ZVF1ZXJ5IiwiX2hhbmRsZVNhdmVSZXNwb25zZSIsInBlcm1zIiwiZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zIiwib25BZnRlclNhdmUiLCJqc29uUmV0dXJuZWQiLCJfdG9GdWxsSlNPTiIsInRvSlNPTiIsImxvZ2dlciIsIndhcm4iLCJtaWRkbGUiLCJtb3VudCIsInNlcnZlclVSTCIsInNhbml0aXplZERhdGEiLCJ0ZXN0IiwiX2RlY29kZSIsImZyb21KU09OIiwicmVhZE9ubHlBdHRyaWJ1dGVzIiwiY29uc3RydWN0b3IiLCJpc1JvbGVBZnRlclNhdmUiLCJpbmNsdWRlcyIsImF0dHJpYnV0ZSIsInNldCIsInNwbGl0dGVkS2V5Iiwic3BsaXQiLCJwYXJlbnRQcm9wIiwicGFyZW50VmFsIiwiZ2V0Iiwic2FuaXRpemVkIiwic2tpcEtleXMiLCJyZXF1aXJlZENvbHVtbnMiLCJpc0RlZXBTdHJpY3RFcXVhbCIsImNsaWVudFN1cHBvcnRzRGVsZXRlIiwic3VwcG9ydHNGb3J3YXJkRGVsZXRlIiwiZGF0YVZhbHVlIiwiX2RlZmF1bHQiLCJleHBvcnRzIiwibW9kdWxlIl0sInNvdXJjZXMiOlsiLi4vc3JjL1Jlc3RXcml0ZS5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBBIFJlc3RXcml0ZSBlbmNhcHN1bGF0ZXMgZXZlcnl0aGluZyB3ZSBuZWVkIHRvIHJ1biBhbiBvcGVyYXRpb25cbi8vIHRoYXQgd3JpdGVzIHRvIHRoZSBkYXRhYmFzZS5cbi8vIFRoaXMgY291bGQgYmUgZWl0aGVyIGEgXCJjcmVhdGVcIiBvciBhbiBcInVwZGF0ZVwiLlxuXG52YXIgU2NoZW1hQ29udHJvbGxlciA9IHJlcXVpcmUoJy4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcicpO1xudmFyIGRlZXBjb3B5ID0gcmVxdWlyZSgnZGVlcGNvcHknKTtcblxuY29uc3QgQXV0aCA9IHJlcXVpcmUoJy4vQXV0aCcpO1xuY29uc3QgVXRpbHMgPSByZXF1aXJlKCcuL1V0aWxzJyk7XG52YXIgY3J5cHRvVXRpbHMgPSByZXF1aXJlKCcuL2NyeXB0b1V0aWxzJyk7XG52YXIgcGFzc3dvcmRDcnlwdG8gPSByZXF1aXJlKCcuL3Bhc3N3b3JkJyk7XG52YXIgUGFyc2UgPSByZXF1aXJlKCdwYXJzZS9ub2RlJyk7XG52YXIgdHJpZ2dlcnMgPSByZXF1aXJlKCcuL3RyaWdnZXJzJyk7XG52YXIgQ2xpZW50U0RLID0gcmVxdWlyZSgnLi9DbGllbnRTREsnKTtcbmNvbnN0IHV0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG5pbXBvcnQgUmVzdFF1ZXJ5IGZyb20gJy4vUmVzdFF1ZXJ5JztcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG5pbXBvcnQgbG9nZ2VyIGZyb20gJy4vbG9nZ2VyJztcbmltcG9ydCB7IHJlcXVpcmVkQ29sdW1ucyB9IGZyb20gJy4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcic7XG5cbi8vIHF1ZXJ5IGFuZCBkYXRhIGFyZSBib3RoIHByb3ZpZGVkIGluIFJFU1QgQVBJIGZvcm1hdC4gU28gZGF0YVxuLy8gdHlwZXMgYXJlIGVuY29kZWQgYnkgcGxhaW4gb2xkIG9iamVjdHMuXG4vLyBJZiBxdWVyeSBpcyBudWxsLCB0aGlzIGlzIGEgXCJjcmVhdGVcIiBhbmQgdGhlIGRhdGEgaW4gZGF0YSBzaG91bGQgYmVcbi8vIGNyZWF0ZWQuXG4vLyBPdGhlcndpc2UgdGhpcyBpcyBhbiBcInVwZGF0ZVwiIC0gdGhlIG9iamVjdCBtYXRjaGluZyB0aGUgcXVlcnlcbi8vIHNob3VsZCBnZXQgdXBkYXRlZCB3aXRoIGRhdGEuXG4vLyBSZXN0V3JpdGUgd2lsbCBoYW5kbGUgb2JqZWN0SWQsIGNyZWF0ZWRBdCwgYW5kIHVwZGF0ZWRBdCBmb3Jcbi8vIGV2ZXJ5dGhpbmcuIEl0IGFsc28ga25vd3MgdG8gdXNlIHRyaWdnZXJzIGFuZCBzcGVjaWFsIG1vZGlmaWNhdGlvbnNcbi8vIGZvciB0aGUgX1VzZXIgY2xhc3MuXG5mdW5jdGlvbiBSZXN0V3JpdGUoY29uZmlnLCBhdXRoLCBjbGFzc05hbWUsIHF1ZXJ5LCBkYXRhLCBvcmlnaW5hbERhdGEsIGNsaWVudFNESywgY29udGV4dCwgYWN0aW9uKSB7XG4gIGlmIChhdXRoLmlzUmVhZE9ubHkpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgJ0Nhbm5vdCBwZXJmb3JtIGEgd3JpdGUgb3BlcmF0aW9uIHdoZW4gdXNpbmcgcmVhZE9ubHlNYXN0ZXJLZXknXG4gICAgKTtcbiAgfVxuICB0aGlzLmNvbmZpZyA9IGNvbmZpZztcbiAgdGhpcy5hdXRoID0gYXV0aDtcbiAgdGhpcy5jbGFzc05hbWUgPSBjbGFzc05hbWU7XG4gIHRoaXMuY2xpZW50U0RLID0gY2xpZW50U0RLO1xuICB0aGlzLnN0b3JhZ2UgPSB7fTtcbiAgdGhpcy5ydW5PcHRpb25zID0ge307XG4gIHRoaXMuY29udGV4dCA9IGNvbnRleHQgfHwge307XG5cbiAgaWYgKGFjdGlvbikge1xuICAgIHRoaXMucnVuT3B0aW9ucy5hY3Rpb24gPSBhY3Rpb247XG4gIH1cblxuICBpZiAoIXF1ZXJ5KSB7XG4gICAgaWYgKHRoaXMuY29uZmlnLmFsbG93Q3VzdG9tT2JqZWN0SWQpIHtcbiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoZGF0YSwgJ29iamVjdElkJykgJiYgIWRhdGEub2JqZWN0SWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLk1JU1NJTkdfT0JKRUNUX0lELFxuICAgICAgICAgICdvYmplY3RJZCBtdXN0IG5vdCBiZSBlbXB0eSwgbnVsbCBvciB1bmRlZmluZWQnXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmIChkYXRhLm9iamVjdElkKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCAnb2JqZWN0SWQgaXMgYW4gaW52YWxpZCBmaWVsZCBuYW1lLicpO1xuICAgICAgfVxuICAgICAgaWYgKGRhdGEuaWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdpZCBpcyBhbiBpbnZhbGlkIGZpZWxkIG5hbWUuJyk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gV2hlbiB0aGUgb3BlcmF0aW9uIGlzIGNvbXBsZXRlLCB0aGlzLnJlc3BvbnNlIG1heSBoYXZlIHNldmVyYWxcbiAgLy8gZmllbGRzLlxuICAvLyByZXNwb25zZTogdGhlIGFjdHVhbCBkYXRhIHRvIGJlIHJldHVybmVkXG4gIC8vIHN0YXR1czogdGhlIGh0dHAgc3RhdHVzIGNvZGUuIGlmIG5vdCBwcmVzZW50LCB0cmVhdGVkIGxpa2UgYSAyMDBcbiAgLy8gbG9jYXRpb246IHRoZSBsb2NhdGlvbiBoZWFkZXIuIGlmIG5vdCBwcmVzZW50LCBubyBsb2NhdGlvbiBoZWFkZXJcbiAgdGhpcy5yZXNwb25zZSA9IG51bGw7XG5cbiAgLy8gUHJvY2Vzc2luZyB0aGlzIG9wZXJhdGlvbiBtYXkgbXV0YXRlIG91ciBkYXRhLCBzbyB3ZSBvcGVyYXRlIG9uIGFcbiAgLy8gY29weVxuICB0aGlzLnF1ZXJ5ID0gZGVlcGNvcHkocXVlcnkpO1xuICB0aGlzLmRhdGEgPSBkZWVwY29weShkYXRhKTtcbiAgLy8gV2UgbmV2ZXIgY2hhbmdlIG9yaWdpbmFsRGF0YSwgc28gd2UgZG8gbm90IG5lZWQgYSBkZWVwIGNvcHlcbiAgdGhpcy5vcmlnaW5hbERhdGEgPSBvcmlnaW5hbERhdGE7XG5cbiAgLy8gVGhlIHRpbWVzdGFtcCB3ZSdsbCB1c2UgZm9yIHRoaXMgd2hvbGUgb3BlcmF0aW9uXG4gIHRoaXMudXBkYXRlZEF0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKS5pc287XG5cbiAgLy8gU2hhcmVkIFNjaGVtYUNvbnRyb2xsZXIgdG8gYmUgcmV1c2VkIHRvIHJlZHVjZSB0aGUgbnVtYmVyIG9mIGxvYWRTY2hlbWEoKSBjYWxscyBwZXIgcmVxdWVzdFxuICAvLyBPbmNlIHNldCB0aGUgc2NoZW1hRGF0YSBzaG91bGQgYmUgaW1tdXRhYmxlXG4gIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyID0gbnVsbDtcbiAgdGhpcy5wZW5kaW5nT3BzID0ge1xuICAgIG9wZXJhdGlvbnM6IG51bGwsXG4gICAgaWRlbnRpZmllcjogbnVsbCxcbiAgfTtcbn1cblxuLy8gQSBjb252ZW5pZW50IG1ldGhvZCB0byBwZXJmb3JtIGFsbCB0aGUgc3RlcHMgb2YgcHJvY2Vzc2luZyB0aGVcbi8vIHdyaXRlLCBpbiBvcmRlci5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhIHtyZXNwb25zZSwgc3RhdHVzLCBsb2NhdGlvbn0gb2JqZWN0LlxuLy8gc3RhdHVzIGFuZCBsb2NhdGlvbiBhcmUgb3B0aW9uYWwuXG5SZXN0V3JpdGUucHJvdG90eXBlLmV4ZWN1dGUgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmdldFVzZXJBbmRSb2xlQUNMKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUluc3RhbGxhdGlvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlU2Vzc2lvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVBdXRoRGF0YSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuY2hlY2tSZXN0cmljdGVkRmllbGRzKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5CZWZvcmVTYXZlVHJpZ2dlcigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZW5zdXJlVW5pcXVlQXV0aERhdGFJZCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZGVsZXRlRW1haWxSZXNldFRva2VuSWZOZWVkZWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlU2NoZW1hKCk7XG4gICAgfSlcbiAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHtcbiAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyID0gc2NoZW1hQ29udHJvbGxlcjtcbiAgICAgIHJldHVybiB0aGlzLnNldFJlcXVpcmVkRmllbGRzSWZOZWVkZWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnRyYW5zZm9ybVVzZXIoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmV4cGFuZEZpbGVzRm9yRXhpc3RpbmdPYmplY3RzKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5kZXN0cm95RHVwbGljYXRlZFNlc3Npb25zKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5EYXRhYmFzZU9wZXJhdGlvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlU2Vzc2lvblRva2VuSWZOZWVkZWQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUZvbGxvd3VwKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5BZnRlclNhdmVUcmlnZ2VyKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jbGVhblVzZXJBdXRoRGF0YSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gQXBwZW5kIHRoZSBhdXRoRGF0YVJlc3BvbnNlIGlmIGV4aXN0c1xuICAgICAgaWYgKHRoaXMuYXV0aERhdGFSZXNwb25zZSkge1xuICAgICAgICBpZiAodGhpcy5yZXNwb25zZSAmJiB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKSB7XG4gICAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZS5hdXRoRGF0YVJlc3BvbnNlID0gdGhpcy5hdXRoRGF0YVJlc3BvbnNlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5zdG9yYWdlLnJlamVjdFNpZ251cCAmJiB0aGlzLmNvbmZpZy5wcmV2ZW50U2lnbnVwV2l0aFVudmVyaWZpZWRFbWFpbCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRU1BSUxfTk9UX0ZPVU5ELCAnVXNlciBlbWFpbCBpcyBub3QgdmVyaWZpZWQuJyk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5yZXNwb25zZTtcbiAgICB9KTtcbn07XG5cbi8vIFVzZXMgdGhlIEF1dGggb2JqZWN0IHRvIGdldCB0aGUgbGlzdCBvZiByb2xlcywgYWRkcyB0aGUgdXNlciBpZFxuUmVzdFdyaXRlLnByb3RvdHlwZS5nZXRVc2VyQW5kUm9sZUFDTCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHRoaXMucnVuT3B0aW9ucy5hY2wgPSBbJyonXTtcblxuICBpZiAodGhpcy5hdXRoLnVzZXIpIHtcbiAgICByZXR1cm4gdGhpcy5hdXRoLmdldFVzZXJSb2xlcygpLnRoZW4ocm9sZXMgPT4ge1xuICAgICAgdGhpcy5ydW5PcHRpb25zLmFjbCA9IHRoaXMucnVuT3B0aW9ucy5hY2wuY29uY2F0KHJvbGVzLCBbdGhpcy5hdXRoLnVzZXIuaWRdKTtcbiAgICAgIHJldHVybjtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbi8vIFZhbGlkYXRlcyB0aGlzIG9wZXJhdGlvbiBhZ2FpbnN0IHRoZSBhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gY29uZmlnLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmIChcbiAgICB0aGlzLmNvbmZpZy5hbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gPT09IGZhbHNlICYmXG4gICAgIXRoaXMuYXV0aC5pc01hc3RlciAmJlxuICAgICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSAmJlxuICAgIFNjaGVtYUNvbnRyb2xsZXIuc3lzdGVtQ2xhc3Nlcy5pbmRleE9mKHRoaXMuY2xhc3NOYW1lKSA9PT0gLTFcbiAgKSB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAubG9hZFNjaGVtYSgpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuaGFzQ2xhc3ModGhpcy5jbGFzc05hbWUpKVxuICAgICAgLnRoZW4oaGFzQ2xhc3MgPT4ge1xuICAgICAgICBpZiAoaGFzQ2xhc3MgIT09IHRydWUpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICAgICAgJ1RoaXMgdXNlciBpcyBub3QgYWxsb3dlZCB0byBhY2Nlc3MgJyArICdub24tZXhpc3RlbnQgY2xhc3M6ICcgKyB0aGlzLmNsYXNzTmFtZVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxufTtcblxuLy8gVmFsaWRhdGVzIHRoaXMgb3BlcmF0aW9uIGFnYWluc3QgdGhlIHNjaGVtYS5cblJlc3RXcml0ZS5wcm90b3R5cGUudmFsaWRhdGVTY2hlbWEgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS52YWxpZGF0ZU9iamVjdChcbiAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICB0aGlzLmRhdGEsXG4gICAgdGhpcy5xdWVyeSxcbiAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2VcbiAgKTtcbn07XG5cbi8vIFJ1bnMgYW55IGJlZm9yZVNhdmUgdHJpZ2dlcnMgYWdhaW5zdCB0aGlzIG9wZXJhdGlvbi5cbi8vIEFueSBjaGFuZ2UgbGVhZHMgdG8gb3VyIGRhdGEgYmVpbmcgbXV0YXRlZC5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuQmVmb3JlU2F2ZVRyaWdnZXIgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlIHx8IHRoaXMucnVuT3B0aW9ucy5tYW55KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQXZvaWQgZG9pbmcgYW55IHNldHVwIGZvciB0cmlnZ2VycyBpZiB0aGVyZSBpcyBubyAnYmVmb3JlU2F2ZScgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgaWYgKFxuICAgICF0cmlnZ2Vycy50cmlnZ2VyRXhpc3RzKHRoaXMuY2xhc3NOYW1lLCB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVTYXZlLCB0aGlzLmNvbmZpZy5hcHBsaWNhdGlvbklkKVxuICApIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICBjb25zdCB7IG9yaWdpbmFsT2JqZWN0LCB1cGRhdGVkT2JqZWN0IH0gPSB0aGlzLmJ1aWxkUGFyc2VPYmplY3RzKCk7XG4gIGNvbnN0IGlkZW50aWZpZXIgPSB1cGRhdGVkT2JqZWN0Ll9nZXRTdGF0ZUlkZW50aWZpZXIoKTtcbiAgY29uc3Qgc3RhdGVDb250cm9sbGVyID0gUGFyc2UuQ29yZU1hbmFnZXIuZ2V0T2JqZWN0U3RhdGVDb250cm9sbGVyKCk7XG4gIGNvbnN0IFtwZW5kaW5nXSA9IHN0YXRlQ29udHJvbGxlci5nZXRQZW5kaW5nT3BzKGlkZW50aWZpZXIpO1xuICB0aGlzLnBlbmRpbmdPcHMgPSB7XG4gICAgb3BlcmF0aW9uczogeyAuLi5wZW5kaW5nIH0sXG4gICAgaWRlbnRpZmllcixcbiAgfTtcblxuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICAvLyBCZWZvcmUgY2FsbGluZyB0aGUgdHJpZ2dlciwgdmFsaWRhdGUgdGhlIHBlcm1pc3Npb25zIGZvciB0aGUgc2F2ZSBvcGVyYXRpb25cbiAgICAgIGxldCBkYXRhYmFzZVByb21pc2UgPSBudWxsO1xuICAgICAgaWYgKHRoaXMucXVlcnkpIHtcbiAgICAgICAgLy8gVmFsaWRhdGUgZm9yIHVwZGF0aW5nXG4gICAgICAgIGRhdGFiYXNlUHJvbWlzZSA9IHRoaXMuY29uZmlnLmRhdGFiYXNlLnVwZGF0ZShcbiAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICB0aGlzLnF1ZXJ5LFxuICAgICAgICAgIHRoaXMuZGF0YSxcbiAgICAgICAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICB0cnVlXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBWYWxpZGF0ZSBmb3IgY3JlYXRpbmdcbiAgICAgICAgZGF0YWJhc2VQcm9taXNlID0gdGhpcy5jb25maWcuZGF0YWJhc2UuY3JlYXRlKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgIHRoaXMuZGF0YSxcbiAgICAgICAgICB0aGlzLnJ1bk9wdGlvbnMsXG4gICAgICAgICAgdHJ1ZVxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgLy8gSW4gdGhlIGNhc2UgdGhhdCB0aGVyZSBpcyBubyBwZXJtaXNzaW9uIGZvciB0aGUgb3BlcmF0aW9uLCBpdCB0aHJvd3MgYW4gZXJyb3JcbiAgICAgIHJldHVybiBkYXRhYmFzZVByb21pc2UudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICBpZiAoIXJlc3VsdCB8fCByZXN1bHQubGVuZ3RoIDw9IDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ09iamVjdCBub3QgZm91bmQuJyk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRyaWdnZXJzLm1heWJlUnVuVHJpZ2dlcihcbiAgICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlU2F2ZSxcbiAgICAgICAgdGhpcy5hdXRoLFxuICAgICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgICBvcmlnaW5hbE9iamVjdCxcbiAgICAgICAgdGhpcy5jb25maWcsXG4gICAgICAgIHRoaXMuY29udGV4dFxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgIGlmIChyZXNwb25zZSAmJiByZXNwb25zZS5vYmplY3QpIHtcbiAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgPSBfLnJlZHVjZShcbiAgICAgICAgICByZXNwb25zZS5vYmplY3QsXG4gICAgICAgICAgKHJlc3VsdCwgdmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgaWYgKCFfLmlzRXF1YWwodGhpcy5kYXRhW2tleV0sIHZhbHVlKSkge1xuICAgICAgICAgICAgICByZXN1bHQucHVzaChrZXkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICB9LFxuICAgICAgICAgIFtdXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuZGF0YSA9IHJlc3BvbnNlLm9iamVjdDtcbiAgICAgICAgLy8gV2Ugc2hvdWxkIGRlbGV0ZSB0aGUgb2JqZWN0SWQgZm9yIGFuIHVwZGF0ZSB3cml0ZVxuICAgICAgICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5vYmplY3RJZDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgVXRpbHMuY2hlY2tQcm9oaWJpdGVkS2V5d29yZHModGhpcy5jb25maWcsIHRoaXMuZGF0YSk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgZXJyb3IpO1xuICAgICAgfVxuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5CZWZvcmVMb2dpblRyaWdnZXIgPSBhc3luYyBmdW5jdGlvbiAodXNlckRhdGEpIHtcbiAgLy8gQXZvaWQgZG9pbmcgYW55IHNldHVwIGZvciB0cmlnZ2VycyBpZiB0aGVyZSBpcyBubyAnYmVmb3JlTG9naW4nIHRyaWdnZXJcbiAgaWYgKFxuICAgICF0cmlnZ2Vycy50cmlnZ2VyRXhpc3RzKHRoaXMuY2xhc3NOYW1lLCB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVMb2dpbiwgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZClcbiAgKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQ2xvdWQgY29kZSBnZXRzIGEgYml0IG9mIGV4dHJhIGRhdGEgZm9yIGl0cyBvYmplY3RzXG4gIGNvbnN0IGV4dHJhRGF0YSA9IHsgY2xhc3NOYW1lOiB0aGlzLmNsYXNzTmFtZSB9O1xuXG4gIC8vIEV4cGFuZCBmaWxlIG9iamVjdHNcbiAgYXdhaXQgdGhpcy5jb25maWcuZmlsZXNDb250cm9sbGVyLmV4cGFuZEZpbGVzSW5PYmplY3QodGhpcy5jb25maWcsIHVzZXJEYXRhKTtcblxuICBjb25zdCB1c2VyID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHVzZXJEYXRhKTtcblxuICAvLyBubyBuZWVkIHRvIHJldHVybiBhIHJlc3BvbnNlXG4gIGF3YWl0IHRyaWdnZXJzLm1heWJlUnVuVHJpZ2dlcihcbiAgICB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVMb2dpbixcbiAgICB0aGlzLmF1dGgsXG4gICAgdXNlcixcbiAgICBudWxsLFxuICAgIHRoaXMuY29uZmlnLFxuICAgIHRoaXMuY29udGV4dFxuICApO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5zZXRSZXF1aXJlZEZpZWxkc0lmTmVlZGVkID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5kYXRhKSB7XG4gICAgcmV0dXJuIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyLmdldEFsbENsYXNzZXMoKS50aGVuKGFsbENsYXNzZXMgPT4ge1xuICAgICAgY29uc3Qgc2NoZW1hID0gYWxsQ2xhc3Nlcy5maW5kKG9uZUNsYXNzID0+IG9uZUNsYXNzLmNsYXNzTmFtZSA9PT0gdGhpcy5jbGFzc05hbWUpO1xuICAgICAgY29uc3Qgc2V0UmVxdWlyZWRGaWVsZElmTmVlZGVkID0gKGZpZWxkTmFtZSwgc2V0RGVmYXVsdCkgPT4ge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09IHVuZGVmaW5lZCB8fFxuICAgICAgICAgIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSBudWxsIHx8XG4gICAgICAgICAgdGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09ICcnIHx8XG4gICAgICAgICAgKHR5cGVvZiB0aGlzLmRhdGFbZmllbGROYW1lXSA9PT0gJ29iamVjdCcgJiYgdGhpcy5kYXRhW2ZpZWxkTmFtZV0uX19vcCA9PT0gJ0RlbGV0ZScpXG4gICAgICAgICkge1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIHNldERlZmF1bHQgJiZcbiAgICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJlxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmRlZmF1bHRWYWx1ZSAhPT0gbnVsbCAmJlxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmRlZmF1bHRWYWx1ZSAhPT0gdW5kZWZpbmVkICYmXG4gICAgICAgICAgICAodGhpcy5kYXRhW2ZpZWxkTmFtZV0gPT09IHVuZGVmaW5lZCB8fFxuICAgICAgICAgICAgICAodHlwZW9mIHRoaXMuZGF0YVtmaWVsZE5hbWVdID09PSAnb2JqZWN0JyAmJiB0aGlzLmRhdGFbZmllbGROYW1lXS5fX29wID09PSAnRGVsZXRlJykpXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICB0aGlzLmRhdGFbZmllbGROYW1lXSA9IHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5kZWZhdWx0VmFsdWU7XG4gICAgICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciA9IHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyIHx8IFtdO1xuICAgICAgICAgICAgaWYgKHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyLmluZGV4T2YoZmllbGROYW1lKSA8IDApIHtcbiAgICAgICAgICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdICYmIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5yZXF1aXJlZCA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsIGAke2ZpZWxkTmFtZX0gaXMgcmVxdWlyZWRgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIC8vIGFkZCBkZWZhdWx0IEFDTFxuICAgICAgaWYgKFxuICAgICAgICBzY2hlbWE/LmNsYXNzTGV2ZWxQZXJtaXNzaW9ucz8uQUNMICYmXG4gICAgICAgICF0aGlzLmRhdGEuQUNMICYmXG4gICAgICAgIEpTT04uc3RyaW5naWZ5KHNjaGVtYS5jbGFzc0xldmVsUGVybWlzc2lvbnMuQUNMKSAhPT1cbiAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7ICcqJzogeyByZWFkOiB0cnVlLCB3cml0ZTogdHJ1ZSB9IH0pXG4gICAgICApIHtcbiAgICAgICAgY29uc3QgYWNsID0gZGVlcGNvcHkoc2NoZW1hLmNsYXNzTGV2ZWxQZXJtaXNzaW9ucy5BQ0wpO1xuICAgICAgICBpZiAoYWNsLmN1cnJlbnRVc2VyKSB7XG4gICAgICAgICAgaWYgKHRoaXMuYXV0aC51c2VyPy5pZCkge1xuICAgICAgICAgICAgYWNsW3RoaXMuYXV0aC51c2VyPy5pZF0gPSBkZWVwY29weShhY2wuY3VycmVudFVzZXIpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBkZWxldGUgYWNsLmN1cnJlbnRVc2VyO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuZGF0YS5BQ0wgPSBhY2w7XG4gICAgICAgIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyID0gdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIgfHwgW107XG4gICAgICAgIHRoaXMuc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyLnB1c2goJ0FDTCcpO1xuICAgICAgfVxuXG4gICAgICAvLyBBZGQgZGVmYXVsdCBmaWVsZHNcbiAgICAgIGlmICghdGhpcy5xdWVyeSkge1xuICAgICAgICAvLyBhbGxvdyBjdXN0b21pemluZyBjcmVhdGVkQXQgYW5kIHVwZGF0ZWRBdCB3aGVuIHVzaW5nIG1haW50ZW5hbmNlIGtleVxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuY3JlYXRlZEF0ICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmNyZWF0ZWRBdC5fX3R5cGUgPT09ICdEYXRlJ1xuICAgICAgICApIHtcbiAgICAgICAgICB0aGlzLmRhdGEuY3JlYXRlZEF0ID0gdGhpcy5kYXRhLmNyZWF0ZWRBdC5pc287XG5cbiAgICAgICAgICBpZiAodGhpcy5kYXRhLnVwZGF0ZWRBdCAmJiB0aGlzLmRhdGEudXBkYXRlZEF0Ll9fdHlwZSA9PT0gJ0RhdGUnKSB7XG4gICAgICAgICAgICBjb25zdCBjcmVhdGVkQXQgPSBuZXcgRGF0ZSh0aGlzLmRhdGEuY3JlYXRlZEF0KTtcbiAgICAgICAgICAgIGNvbnN0IHVwZGF0ZWRBdCA9IG5ldyBEYXRlKHRoaXMuZGF0YS51cGRhdGVkQXQuaXNvKTtcblxuICAgICAgICAgICAgaWYgKHVwZGF0ZWRBdCA8IGNyZWF0ZWRBdCkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuVkFMSURBVElPTl9FUlJPUixcbiAgICAgICAgICAgICAgICAndXBkYXRlZEF0IGNhbm5vdCBvY2N1ciBiZWZvcmUgY3JlYXRlZEF0J1xuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aGlzLmRhdGEudXBkYXRlZEF0ID0gdGhpcy5kYXRhLnVwZGF0ZWRBdC5pc287XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIGlmIG5vIHVwZGF0ZWRBdCBpcyBwcm92aWRlZCwgc2V0IGl0IHRvIGNyZWF0ZWRBdCB0byBtYXRjaCBkZWZhdWx0IGJlaGF2aW9yXG4gICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmRhdGEudXBkYXRlZEF0ID0gdGhpcy5kYXRhLmNyZWF0ZWRBdDtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhpcy5kYXRhLnVwZGF0ZWRBdCA9IHRoaXMudXBkYXRlZEF0O1xuICAgICAgICAgIHRoaXMuZGF0YS5jcmVhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIE9ubHkgYXNzaWduIG5ldyBvYmplY3RJZCBpZiB3ZSBhcmUgY3JlYXRpbmcgbmV3IG9iamVjdFxuICAgICAgICBpZiAoIXRoaXMuZGF0YS5vYmplY3RJZCkge1xuICAgICAgICAgIHRoaXMuZGF0YS5vYmplY3RJZCA9IGNyeXB0b1V0aWxzLm5ld09iamVjdElkKHRoaXMuY29uZmlnLm9iamVjdElkU2l6ZSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHNjaGVtYSkge1xuICAgICAgICAgIE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgICAgICAgIHNldFJlcXVpcmVkRmllbGRJZk5lZWRlZChmaWVsZE5hbWUsIHRydWUpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKHNjaGVtYSkge1xuICAgICAgICB0aGlzLmRhdGEudXBkYXRlZEF0ID0gdGhpcy51cGRhdGVkQXQ7XG5cbiAgICAgICAgT2JqZWN0LmtleXModGhpcy5kYXRhKS5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgICAgICAgc2V0UmVxdWlyZWRGaWVsZElmTmVlZGVkKGZpZWxkTmFtZSwgZmFsc2UpO1xuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG59O1xuXG4vLyBUcmFuc2Zvcm1zIGF1dGggZGF0YSBmb3IgYSB1c2VyIG9iamVjdC5cbi8vIERvZXMgbm90aGluZyBpZiB0aGlzIGlzbid0IGEgdXNlciBvYmplY3QuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3Igd2hlbiB3ZSdyZSBkb25lIGlmIGl0IGNhbid0IGZpbmlzaCB0aGlzIHRpY2suXG5SZXN0V3JpdGUucHJvdG90eXBlLnZhbGlkYXRlQXV0aERhdGEgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGF1dGhEYXRhID0gdGhpcy5kYXRhLmF1dGhEYXRhO1xuICBjb25zdCBoYXNVc2VybmFtZUFuZFBhc3N3b3JkID1cbiAgICB0eXBlb2YgdGhpcy5kYXRhLnVzZXJuYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgdGhpcy5kYXRhLnBhc3N3b3JkID09PSAnc3RyaW5nJztcblxuICBpZiAoIXRoaXMucXVlcnkgJiYgIWF1dGhEYXRhKSB7XG4gICAgaWYgKHR5cGVvZiB0aGlzLmRhdGEudXNlcm5hbWUgIT09ICdzdHJpbmcnIHx8IF8uaXNFbXB0eSh0aGlzLmRhdGEudXNlcm5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuVVNFUk5BTUVfTUlTU0lORywgJ2JhZCBvciBtaXNzaW5nIHVzZXJuYW1lJyk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgdGhpcy5kYXRhLnBhc3N3b3JkICE9PSAnc3RyaW5nJyB8fCBfLmlzRW1wdHkodGhpcy5kYXRhLnBhc3N3b3JkKSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLlBBU1NXT1JEX01JU1NJTkcsICdwYXNzd29yZCBpcyByZXF1aXJlZCcpO1xuICAgIH1cbiAgfVxuXG4gIGlmIChcbiAgICAoYXV0aERhdGEgJiYgIU9iamVjdC5rZXlzKGF1dGhEYXRhKS5sZW5ndGgpIHx8XG4gICAgIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCh0aGlzLmRhdGEsICdhdXRoRGF0YScpXG4gICkge1xuICAgIC8vIE5vdGhpbmcgdG8gdmFsaWRhdGUgaGVyZVxuICAgIHJldHVybjtcbiAgfSBlbHNlIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwodGhpcy5kYXRhLCAnYXV0aERhdGEnKSAmJiAhdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgLy8gSGFuZGxlIHNhdmluZyBhdXRoRGF0YSB0byBudWxsXG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuVU5TVVBQT1JURURfU0VSVklDRSxcbiAgICAgICdUaGlzIGF1dGhlbnRpY2F0aW9uIG1ldGhvZCBpcyB1bnN1cHBvcnRlZC4nXG4gICAgKTtcbiAgfVxuXG4gIHZhciBwcm92aWRlcnMgPSBPYmplY3Qua2V5cyhhdXRoRGF0YSk7XG4gIGlmIChwcm92aWRlcnMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGNhbkhhbmRsZUF1dGhEYXRhID0gcHJvdmlkZXJzLnNvbWUocHJvdmlkZXIgPT4ge1xuICAgICAgY29uc3QgcHJvdmlkZXJBdXRoRGF0YSA9IGF1dGhEYXRhW3Byb3ZpZGVyXSB8fCB7fTtcbiAgICAgIHJldHVybiAhIU9iamVjdC5rZXlzKHByb3ZpZGVyQXV0aERhdGEpLmxlbmd0aDtcbiAgICB9KTtcbiAgICBpZiAoY2FuSGFuZGxlQXV0aERhdGEgfHwgaGFzVXNlcm5hbWVBbmRQYXNzd29yZCB8fCB0aGlzLmF1dGguaXNNYXN0ZXIgfHwgdGhpcy5nZXRVc2VySWQoKSkge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlQXV0aERhdGEoYXV0aERhdGEpO1xuICAgIH1cbiAgfVxuICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgUGFyc2UuRXJyb3IuVU5TVVBQT1JURURfU0VSVklDRSxcbiAgICAnVGhpcyBhdXRoZW50aWNhdGlvbiBtZXRob2QgaXMgdW5zdXBwb3J0ZWQuJ1xuICApO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5maWx0ZXJlZE9iamVjdHNCeUFDTCA9IGZ1bmN0aW9uIChvYmplY3RzKSB7XG4gIGlmICh0aGlzLmF1dGguaXNNYXN0ZXIgfHwgdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICByZXR1cm4gb2JqZWN0cztcbiAgfVxuICByZXR1cm4gb2JqZWN0cy5maWx0ZXIob2JqZWN0ID0+IHtcbiAgICBpZiAoIW9iamVjdC5BQ0wpIHtcbiAgICAgIHJldHVybiB0cnVlOyAvLyBsZWdhY3kgdXNlcnMgdGhhdCBoYXZlIG5vIEFDTCBmaWVsZCBvbiB0aGVtXG4gICAgfVxuICAgIC8vIFJlZ3VsYXIgdXNlcnMgdGhhdCBoYXZlIGJlZW4gbG9ja2VkIG91dC5cbiAgICByZXR1cm4gb2JqZWN0LkFDTCAmJiBPYmplY3Qua2V5cyhvYmplY3QuQUNMKS5sZW5ndGggPiAwO1xuICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuZ2V0VXNlcklkID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkICYmIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuIHRoaXMucXVlcnkub2JqZWN0SWQ7XG4gIH0gZWxzZSBpZiAodGhpcy5hdXRoICYmIHRoaXMuYXV0aC51c2VyICYmIHRoaXMuYXV0aC51c2VyLmlkKSB7XG4gICAgcmV0dXJuIHRoaXMuYXV0aC51c2VyLmlkO1xuICB9XG59O1xuXG4vLyBEZXZlbG9wZXJzIGFyZSBhbGxvd2VkIHRvIGNoYW5nZSBhdXRoRGF0YSB2aWEgYmVmb3JlIHNhdmUgdHJpZ2dlclxuLy8gd2UgbmVlZCBhZnRlciBiZWZvcmUgc2F2ZSB0byBlbnN1cmUgdGhhdCB0aGUgZGV2ZWxvcGVyXG4vLyBpcyBub3QgY3VycmVudGx5IGR1cGxpY2F0aW5nIGF1dGggZGF0YSBJRFxuUmVzdFdyaXRlLnByb3RvdHlwZS5lbnN1cmVVbmlxdWVBdXRoRGF0YUlkID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicgfHwgIXRoaXMuZGF0YS5hdXRoRGF0YSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGhhc0F1dGhEYXRhSWQgPSBPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLnNvbWUoXG4gICAga2V5ID0+IHRoaXMuZGF0YS5hdXRoRGF0YVtrZXldICYmIHRoaXMuZGF0YS5hdXRoRGF0YVtrZXldLmlkXG4gICk7XG5cbiAgaWYgKCFoYXNBdXRoRGF0YUlkKSB7IHJldHVybjsgfVxuXG4gIGNvbnN0IHIgPSBhd2FpdCBBdXRoLmZpbmRVc2Vyc1dpdGhBdXRoRGF0YSh0aGlzLmNvbmZpZywgdGhpcy5kYXRhLmF1dGhEYXRhKTtcbiAgY29uc3QgcmVzdWx0cyA9IHRoaXMuZmlsdGVyZWRPYmplY3RzQnlBQ0wocik7XG4gIGlmIChyZXN1bHRzLmxlbmd0aCA+IDEpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuQUNDT1VOVF9BTFJFQURZX0xJTktFRCwgJ3RoaXMgYXV0aCBpcyBhbHJlYWR5IHVzZWQnKTtcbiAgfVxuICAvLyB1c2UgZGF0YS5vYmplY3RJZCBpbiBjYXNlIG9mIGxvZ2luIHRpbWUgYW5kIGZvdW5kIHVzZXIgZHVyaW5nIGhhbmRsZSB2YWxpZGF0ZUF1dGhEYXRhXG4gIGNvbnN0IHVzZXJJZCA9IHRoaXMuZ2V0VXNlcklkKCkgfHwgdGhpcy5kYXRhLm9iamVjdElkO1xuICBpZiAocmVzdWx0cy5sZW5ndGggPT09IDEgJiYgdXNlcklkICE9PSByZXN1bHRzWzBdLm9iamVjdElkKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQsICd0aGlzIGF1dGggaXMgYWxyZWFkeSB1c2VkJyk7XG4gIH1cbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlQXV0aERhdGEgPSBhc3luYyBmdW5jdGlvbiAoYXV0aERhdGEpIHtcbiAgY29uc3QgciA9IGF3YWl0IEF1dGguZmluZFVzZXJzV2l0aEF1dGhEYXRhKHRoaXMuY29uZmlnLCBhdXRoRGF0YSwgdHJ1ZSk7XG4gIGNvbnN0IHJlc3VsdHMgPSB0aGlzLmZpbHRlcmVkT2JqZWN0c0J5QUNMKHIpO1xuXG4gIGNvbnN0IHVzZXJJZCA9IHRoaXMuZ2V0VXNlcklkKCk7XG4gIGNvbnN0IHVzZXJSZXN1bHQgPSByZXN1bHRzWzBdO1xuICBjb25zdCBmb3VuZFVzZXJJc05vdEN1cnJlbnRVc2VyID0gdXNlcklkICYmIHVzZXJSZXN1bHQgJiYgdXNlcklkICE9PSB1c2VyUmVzdWx0Lm9iamVjdElkO1xuXG4gIGlmIChyZXN1bHRzLmxlbmd0aCA+IDEgfHwgZm91bmRVc2VySXNOb3RDdXJyZW50VXNlcikge1xuICAgIC8vIFRvIGF2b2lkIGh0dHBzOi8vZ2l0aHViLmNvbS9wYXJzZS1jb21tdW5pdHkvcGFyc2Utc2VydmVyL3NlY3VyaXR5L2Fkdmlzb3JpZXMvR0hTQS04dzNqLWc5ODMtOGpoNVxuICAgIC8vIExldCdzIHJ1biBzb21lIHZhbGlkYXRpb24gYmVmb3JlIHRocm93aW5nXG4gICAgYXdhaXQgQXV0aC5oYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24oYXV0aERhdGEsIHRoaXMsIHVzZXJSZXN1bHQpO1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5BQ0NPVU5UX0FMUkVBRFlfTElOS0VELCAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCcpO1xuICB9XG5cbiAgLy8gTm8gdXNlciBmb3VuZCB3aXRoIHByb3ZpZGVkIGF1dGhEYXRhIHdlIG5lZWQgdG8gdmFsaWRhdGVcbiAgaWYgKCFyZXN1bHRzLmxlbmd0aCkge1xuICAgIGNvbnN0IHsgYXV0aERhdGE6IHZhbGlkYXRlZEF1dGhEYXRhLCBhdXRoRGF0YVJlc3BvbnNlIH0gPSBhd2FpdCBBdXRoLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbihcbiAgICAgIGF1dGhEYXRhLFxuICAgICAgdGhpc1xuICAgICk7XG4gICAgdGhpcy5hdXRoRGF0YVJlc3BvbnNlID0gYXV0aERhdGFSZXNwb25zZTtcbiAgICAvLyBSZXBsYWNlIGN1cnJlbnQgYXV0aERhdGEgYnkgdGhlIG5ldyB2YWxpZGF0ZWQgb25lXG4gICAgdGhpcy5kYXRhLmF1dGhEYXRhID0gdmFsaWRhdGVkQXV0aERhdGE7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVXNlciBmb3VuZCB3aXRoIHByb3ZpZGVkIGF1dGhEYXRhXG4gIGlmIChyZXN1bHRzLmxlbmd0aCA9PT0gMSkge1xuXG4gICAgdGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlciA9IE9iamVjdC5rZXlzKGF1dGhEYXRhKS5qb2luKCcsJyk7XG5cbiAgICBjb25zdCB7IGhhc011dGF0ZWRBdXRoRGF0YSwgbXV0YXRlZEF1dGhEYXRhIH0gPSBBdXRoLmhhc011dGF0ZWRBdXRoRGF0YShcbiAgICAgIGF1dGhEYXRhLFxuICAgICAgdXNlclJlc3VsdC5hdXRoRGF0YVxuICAgICk7XG5cbiAgICBjb25zdCBpc0N1cnJlbnRVc2VyTG9nZ2VkT3JNYXN0ZXIgPVxuICAgICAgKHRoaXMuYXV0aCAmJiB0aGlzLmF1dGgudXNlciAmJiB0aGlzLmF1dGgudXNlci5pZCA9PT0gdXNlclJlc3VsdC5vYmplY3RJZCkgfHxcbiAgICAgIHRoaXMuYXV0aC5pc01hc3RlcjtcblxuICAgIGNvbnN0IGlzTG9naW4gPSAhdXNlcklkO1xuXG4gICAgaWYgKGlzTG9naW4gfHwgaXNDdXJyZW50VXNlckxvZ2dlZE9yTWFzdGVyKSB7XG4gICAgICAvLyBubyB1c2VyIG1ha2luZyB0aGUgY2FsbFxuICAgICAgLy8gT1IgdGhlIHVzZXIgbWFraW5nIHRoZSBjYWxsIGlzIHRoZSByaWdodCBvbmVcbiAgICAgIC8vIExvZ2luIHdpdGggYXV0aCBkYXRhXG4gICAgICBkZWxldGUgcmVzdWx0c1swXS5wYXNzd29yZDtcblxuICAgICAgLy8gbmVlZCB0byBzZXQgdGhlIG9iamVjdElkIGZpcnN0IG90aGVyd2lzZSBsb2NhdGlvbiBoYXMgdHJhaWxpbmcgdW5kZWZpbmVkXG4gICAgICB0aGlzLmRhdGEub2JqZWN0SWQgPSB1c2VyUmVzdWx0Lm9iamVjdElkO1xuXG4gICAgICBpZiAoIXRoaXMucXVlcnkgfHwgIXRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAgICAgdGhpcy5yZXNwb25zZSA9IHtcbiAgICAgICAgICByZXNwb25zZTogdXNlclJlc3VsdCxcbiAgICAgICAgICBsb2NhdGlvbjogdGhpcy5sb2NhdGlvbigpLFxuICAgICAgICB9O1xuICAgICAgICAvLyBSdW4gYmVmb3JlTG9naW4gaG9vayBiZWZvcmUgc3RvcmluZyBhbnkgdXBkYXRlc1xuICAgICAgICAvLyB0byBhdXRoRGF0YSBvbiB0aGUgZGI7IGNoYW5nZXMgdG8gdXNlclJlc3VsdFxuICAgICAgICAvLyB3aWxsIGJlIGlnbm9yZWQuXG4gICAgICAgIGF3YWl0IHRoaXMucnVuQmVmb3JlTG9naW5UcmlnZ2VyKGRlZXBjb3B5KHVzZXJSZXN1bHQpKTtcblxuICAgICAgICAvLyBJZiB3ZSBhcmUgaW4gbG9naW4gb3BlcmF0aW9uIHZpYSBhdXRoRGF0YVxuICAgICAgICAvLyB3ZSBuZWVkIHRvIGJlIHN1cmUgdGhhdCB0aGUgdXNlciBoYXMgcHJvdmlkZWRcbiAgICAgICAgLy8gcmVxdWlyZWQgYXV0aERhdGFcbiAgICAgICAgQXV0aC5jaGVja0lmVXNlckhhc1Byb3ZpZGVkQ29uZmlndXJlZFByb3ZpZGVyc0ZvckxvZ2luKFxuICAgICAgICAgIHsgY29uZmlnOiB0aGlzLmNvbmZpZywgYXV0aDogdGhpcy5hdXRoIH0sXG4gICAgICAgICAgYXV0aERhdGEsXG4gICAgICAgICAgdXNlclJlc3VsdC5hdXRoRGF0YSxcbiAgICAgICAgICB0aGlzLmNvbmZpZ1xuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICAvLyBQcmV2ZW50IHZhbGlkYXRpbmcgaWYgbm8gbXV0YXRlZCBkYXRhIGRldGVjdGVkIG9uIHVwZGF0ZVxuICAgICAgaWYgKCFoYXNNdXRhdGVkQXV0aERhdGEgJiYgaXNDdXJyZW50VXNlckxvZ2dlZE9yTWFzdGVyKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgLy8gRm9yY2UgdG8gdmFsaWRhdGUgYWxsIHByb3ZpZGVkIGF1dGhEYXRhIG9uIGxvZ2luXG4gICAgICAvLyBvbiB1cGRhdGUgb25seSB2YWxpZGF0ZSBtdXRhdGVkIG9uZXNcbiAgICAgIGlmIChoYXNNdXRhdGVkQXV0aERhdGEgfHwgIXRoaXMuY29uZmlnLmFsbG93RXhwaXJlZEF1dGhEYXRhVG9rZW4pIHtcbiAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgQXV0aC5oYW5kbGVBdXRoRGF0YVZhbGlkYXRpb24oXG4gICAgICAgICAgaXNMb2dpbiA/IGF1dGhEYXRhIDogbXV0YXRlZEF1dGhEYXRhLFxuICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgdXNlclJlc3VsdFxuICAgICAgICApO1xuICAgICAgICB0aGlzLmRhdGEuYXV0aERhdGEgPSByZXMuYXV0aERhdGE7XG4gICAgICAgIHRoaXMuYXV0aERhdGFSZXNwb25zZSA9IHJlcy5hdXRoRGF0YVJlc3BvbnNlO1xuICAgICAgfVxuXG4gICAgICAvLyBJRiB3ZSBhcmUgaW4gbG9naW4gd2UnbGwgc2tpcCB0aGUgZGF0YWJhc2Ugb3BlcmF0aW9uIC8gYmVmb3JlU2F2ZSAvIGFmdGVyU2F2ZSBldGMuLi5cbiAgICAgIC8vIHdlIG5lZWQgdG8gc2V0IGl0IHVwIHRoZXJlLlxuICAgICAgLy8gV2UgYXJlIHN1cHBvc2VkIHRvIGhhdmUgYSByZXNwb25zZSBvbmx5IG9uIExPR0lOIHdpdGggYXV0aERhdGEsIHNvIHdlIHNraXAgdGhvc2VcbiAgICAgIC8vIElmIHdlJ3JlIG5vdCBsb2dnaW5nIGluLCBidXQganVzdCB1cGRhdGluZyB0aGUgY3VycmVudCB1c2VyLCB3ZSBjYW4gc2FmZWx5IHNraXAgdGhhdCBwYXJ0XG4gICAgICBpZiAodGhpcy5yZXNwb25zZSkge1xuICAgICAgICAvLyBBc3NpZ24gdGhlIG5ldyBhdXRoRGF0YSBpbiB0aGUgcmVzcG9uc2VcbiAgICAgICAgT2JqZWN0LmtleXMobXV0YXRlZEF1dGhEYXRhKS5mb3JFYWNoKHByb3ZpZGVyID0+IHtcbiAgICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlLmF1dGhEYXRhW3Byb3ZpZGVyXSA9IG11dGF0ZWRBdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFJ1biB0aGUgREIgdXBkYXRlIGRpcmVjdGx5LCBhcyAnbWFzdGVyJyBvbmx5IGlmIGF1dGhEYXRhIGNvbnRhaW5zIHNvbWUga2V5c1xuICAgICAgICAvLyBhdXRoRGF0YSBjb3VsZCBub3QgY29udGFpbnMga2V5cyBhZnRlciB2YWxpZGF0aW9uIGlmIHRoZSBhdXRoQWRhcHRlclxuICAgICAgICAvLyB1c2VzIHRoZSBgZG9Ob3RTYXZlYCBvcHRpb24uIEp1c3QgdXBkYXRlIHRoZSBhdXRoRGF0YSBwYXJ0XG4gICAgICAgIC8vIFRoZW4gd2UncmUgZ29vZCBmb3IgdGhlIHVzZXIsIGVhcmx5IGV4aXQgb2Ygc29ydHNcbiAgICAgICAgaWYgKE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkubGVuZ3RoKSB7XG4gICAgICAgICAgYXdhaXQgdGhpcy5jb25maWcuZGF0YWJhc2UudXBkYXRlKFxuICAgICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgICB7IG9iamVjdElkOiB0aGlzLmRhdGEub2JqZWN0SWQgfSxcbiAgICAgICAgICAgIHsgYXV0aERhdGE6IHRoaXMuZGF0YS5hdXRoRGF0YSB9LFxuICAgICAgICAgICAge31cbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNoZWNrUmVzdHJpY3RlZEZpZWxkcyA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCF0aGlzLmF1dGguaXNNYWludGVuYW5jZSAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyICYmICdlbWFpbFZlcmlmaWVkJyBpbiB0aGlzLmRhdGEpIHtcbiAgICBjb25zdCBlcnJvciA9IGBDbGllbnRzIGFyZW4ndCBhbGxvd2VkIHRvIG1hbnVhbGx5IHVwZGF0ZSBlbWFpbCB2ZXJpZmljYXRpb24uYDtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTiwgZXJyb3IpO1xuICB9XG59O1xuXG4vLyBUaGUgbm9uLXRoaXJkLXBhcnR5IHBhcnRzIG9mIFVzZXIgdHJhbnNmb3JtYXRpb25cblJlc3RXcml0ZS5wcm90b3R5cGUudHJhbnNmb3JtVXNlciA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgdmFyIHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cblxuICAvLyBEbyBub3QgY2xlYW51cCBzZXNzaW9uIGlmIG9iamVjdElkIGlzIG5vdCBzZXRcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5vYmplY3RJZCgpKSB7XG4gICAgLy8gSWYgd2UncmUgdXBkYXRpbmcgYSBfVXNlciBvYmplY3QsIHdlIG5lZWQgdG8gY2xlYXIgb3V0IHRoZSBjYWNoZSBmb3IgdGhhdCB1c2VyLiBGaW5kIGFsbCB0aGVpclxuICAgIC8vIHNlc3Npb24gdG9rZW5zLCBhbmQgcmVtb3ZlIHRoZW0gZnJvbSB0aGUgY2FjaGUuXG4gICAgY29uc3QgcXVlcnkgPSBhd2FpdCBSZXN0UXVlcnkoe1xuICAgICAgbWV0aG9kOiBSZXN0UXVlcnkuTWV0aG9kLmZpbmQsXG4gICAgICBjb25maWc6IHRoaXMuY29uZmlnLFxuICAgICAgYXV0aDogQXV0aC5tYXN0ZXIodGhpcy5jb25maWcpLFxuICAgICAgY2xhc3NOYW1lOiAnX1Nlc3Npb24nLFxuICAgICAgcnVuQmVmb3JlRmluZDogZmFsc2UsXG4gICAgICByZXN0V2hlcmU6IHtcbiAgICAgICAgdXNlcjoge1xuICAgICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgICBvYmplY3RJZDogdGhpcy5vYmplY3RJZCgpLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBwcm9taXNlID0gcXVlcnkuZXhlY3V0ZSgpLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICByZXN1bHRzLnJlc3VsdHMuZm9yRWFjaChzZXNzaW9uID0+XG4gICAgICAgIHRoaXMuY29uZmlnLmNhY2hlQ29udHJvbGxlci51c2VyLmRlbChzZXNzaW9uLnNlc3Npb25Ub2tlbilcbiAgICAgICk7XG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4gcHJvbWlzZVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIC8vIFRyYW5zZm9ybSB0aGUgcGFzc3dvcmRcbiAgICAgIGlmICh0aGlzLmRhdGEucGFzc3dvcmQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAvLyBpZ25vcmUgb25seSBpZiB1bmRlZmluZWQuIHNob3VsZCBwcm9jZWVkIGlmIGVtcHR5ICgnJylcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5xdWVyeSkge1xuICAgICAgICB0aGlzLnN0b3JhZ2VbJ2NsZWFyU2Vzc2lvbnMnXSA9IHRydWU7XG4gICAgICAgIC8vIEdlbmVyYXRlIGEgbmV3IHNlc3Npb24gb25seSBpZiB0aGUgdXNlciByZXF1ZXN0ZWRcbiAgICAgICAgaWYgKCF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgICAgICAgdGhpcy5zdG9yYWdlWydnZW5lcmF0ZU5ld1Nlc3Npb24nXSA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3koKS50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHBhc3N3b3JkQ3J5cHRvLmhhc2godGhpcy5kYXRhLnBhc3N3b3JkKS50aGVuKGhhc2hlZFBhc3N3b3JkID0+IHtcbiAgICAgICAgICB0aGlzLmRhdGEuX2hhc2hlZF9wYXNzd29yZCA9IGhhc2hlZFBhc3N3b3JkO1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmRhdGEucGFzc3dvcmQ7XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVVc2VyTmFtZSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlRW1haWwoKTtcbiAgICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlVXNlck5hbWUgPSBmdW5jdGlvbiAoKSB7XG4gIC8vIENoZWNrIGZvciB1c2VybmFtZSB1bmlxdWVuZXNzXG4gIGlmICghdGhpcy5kYXRhLnVzZXJuYW1lKSB7XG4gICAgaWYgKCF0aGlzLnF1ZXJ5KSB7XG4gICAgICB0aGlzLmRhdGEudXNlcm5hbWUgPSBjcnlwdG9VdGlscy5yYW5kb21TdHJpbmcoMjUpO1xuICAgICAgdGhpcy5yZXNwb25zZVNob3VsZEhhdmVVc2VybmFtZSA9IHRydWU7XG4gICAgfVxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICAvKlxuICAgIFVzZXJuYW1lcyBzaG91bGQgYmUgdW5pcXVlIHdoZW4gY29tcGFyZWQgY2FzZSBpbnNlbnNpdGl2ZWx5XG5cbiAgICBVc2VycyBzaG91bGQgYmUgYWJsZSB0byBtYWtlIGNhc2Ugc2Vuc2l0aXZlIHVzZXJuYW1lcyBhbmRcbiAgICBsb2dpbiB1c2luZyB0aGUgY2FzZSB0aGV5IGVudGVyZWQuICBJLmUuICdTbm9vcHknIHNob3VsZCBwcmVjbHVkZVxuICAgICdzbm9vcHknIGFzIGEgdmFsaWQgdXNlcm5hbWUuXG4gICovXG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5maW5kKFxuICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICB7XG4gICAgICAgIHVzZXJuYW1lOiB0aGlzLmRhdGEudXNlcm5hbWUsXG4gICAgICAgIG9iamVjdElkOiB7ICRuZTogdGhpcy5vYmplY3RJZCgpIH0sXG4gICAgICB9LFxuICAgICAgeyBsaW1pdDogMSwgY2FzZUluc2Vuc2l0aXZlOiB0cnVlIH0sXG4gICAgICB7fSxcbiAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICAgKVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuVVNFUk5BTUVfVEFLRU4sXG4gICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgdXNlcm5hbWUuJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH0pO1xufTtcblxuLypcbiAgQXMgd2l0aCB1c2VybmFtZXMsIFBhcnNlIHNob3VsZCBub3QgYWxsb3cgY2FzZSBpbnNlbnNpdGl2ZSBjb2xsaXNpb25zIG9mIGVtYWlsLlxuICB1bmxpa2Ugd2l0aCB1c2VybmFtZXMgKHdoaWNoIGNhbiBoYXZlIGNhc2UgaW5zZW5zaXRpdmUgY29sbGlzaW9ucyBpbiB0aGUgY2FzZSBvZlxuICBhdXRoIGFkYXB0ZXJzKSwgZW1haWxzIHNob3VsZCBuZXZlciBoYXZlIGEgY2FzZSBpbnNlbnNpdGl2ZSBjb2xsaXNpb24uXG5cbiAgVGhpcyBiZWhhdmlvciBjYW4gYmUgZW5mb3JjZWQgdGhyb3VnaCBhIHByb3Blcmx5IGNvbmZpZ3VyZWQgaW5kZXggc2VlOlxuICBodHRwczovL2RvY3MubW9uZ29kYi5jb20vbWFudWFsL2NvcmUvaW5kZXgtY2FzZS1pbnNlbnNpdGl2ZS8jY3JlYXRlLWEtY2FzZS1pbnNlbnNpdGl2ZS1pbmRleFxuICB3aGljaCBjb3VsZCBiZSBpbXBsZW1lbnRlZCBpbnN0ZWFkIG9mIHRoaXMgY29kZSBiYXNlZCB2YWxpZGF0aW9uLlxuXG4gIEdpdmVuIHRoYXQgdGhpcyBsb29rdXAgc2hvdWxkIGJlIGEgcmVsYXRpdmVseSBsb3cgdXNlIGNhc2UgYW5kIHRoYXQgdGhlIGNhc2Ugc2Vuc2l0aXZlXG4gIHVuaXF1ZSBpbmRleCB3aWxsIGJlIHVzZWQgYnkgdGhlIGRiIGZvciB0aGUgcXVlcnksIHRoaXMgaXMgYW4gYWRlcXVhdGUgc29sdXRpb24uXG4qL1xuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVFbWFpbCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLmRhdGEuZW1haWwgfHwgdGhpcy5kYXRhLmVtYWlsLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFZhbGlkYXRlIGJhc2ljIGVtYWlsIGFkZHJlc3MgZm9ybWF0XG4gIGlmICghdGhpcy5kYXRhLmVtYWlsLm1hdGNoKC9eLitALiskLykpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoXG4gICAgICBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9FTUFJTF9BRERSRVNTLCAnRW1haWwgYWRkcmVzcyBmb3JtYXQgaXMgaW52YWxpZC4nKVxuICAgICk7XG4gIH1cbiAgLy8gQ2FzZSBpbnNlbnNpdGl2ZSBtYXRjaCwgc2VlIG5vdGUgYWJvdmUgZnVuY3Rpb24uXG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5maW5kKFxuICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICB7XG4gICAgICAgIGVtYWlsOiB0aGlzLmRhdGEuZW1haWwsXG4gICAgICAgIG9iamVjdElkOiB7ICRuZTogdGhpcy5vYmplY3RJZCgpIH0sXG4gICAgICB9LFxuICAgICAgeyBsaW1pdDogMSwgY2FzZUluc2Vuc2l0aXZlOiB0cnVlIH0sXG4gICAgICB7fSxcbiAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICAgKVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuRU1BSUxfVEFLRU4sXG4gICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgZW1haWwgYWRkcmVzcy4nXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoXG4gICAgICAgICF0aGlzLmRhdGEuYXV0aERhdGEgfHxcbiAgICAgICAgIU9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkubGVuZ3RoIHx8XG4gICAgICAgIChPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCA9PT0gMSAmJlxuICAgICAgICAgIE9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSlbMF0gPT09ICdhbm9ueW1vdXMnKVxuICAgICAgKSB7XG4gICAgICAgIC8vIFdlIHVwZGF0ZWQgdGhlIGVtYWlsLCBzZW5kIGEgbmV3IHZhbGlkYXRpb25cbiAgICAgICAgY29uc3QgeyBvcmlnaW5hbE9iamVjdCwgdXBkYXRlZE9iamVjdCB9ID0gdGhpcy5idWlsZFBhcnNlT2JqZWN0cygpO1xuICAgICAgICBjb25zdCByZXF1ZXN0ID0ge1xuICAgICAgICAgIG9yaWdpbmFsOiBvcmlnaW5hbE9iamVjdCxcbiAgICAgICAgICBvYmplY3Q6IHVwZGF0ZWRPYmplY3QsXG4gICAgICAgICAgbWFzdGVyOiB0aGlzLmF1dGguaXNNYXN0ZXIsXG4gICAgICAgICAgaXA6IHRoaXMuY29uZmlnLmlwLFxuICAgICAgICAgIGluc3RhbGxhdGlvbklkOiB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiB0aGlzLmNvbmZpZy51c2VyQ29udHJvbGxlci5zZXRFbWFpbFZlcmlmeVRva2VuKHRoaXMuZGF0YSwgcmVxdWVzdCwgdGhpcy5zdG9yYWdlKTtcbiAgICAgIH1cbiAgICB9KTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3kgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kpIHsgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpOyB9XG4gIHJldHVybiB0aGlzLl92YWxpZGF0ZVBhc3N3b3JkUmVxdWlyZW1lbnRzKCkudGhlbigoKSA9PiB7XG4gICAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlUGFzc3dvcmRIaXN0b3J5KCk7XG4gIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVQYXNzd29yZFJlcXVpcmVtZW50cyA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gY2hlY2sgaWYgdGhlIHBhc3N3b3JkIGNvbmZvcm1zIHRvIHRoZSBkZWZpbmVkIHBhc3N3b3JkIHBvbGljeSBpZiBjb25maWd1cmVkXG4gIC8vIElmIHdlIHNwZWNpZmllZCBhIGN1c3RvbSBlcnJvciBpbiBvdXIgY29uZmlndXJhdGlvbiB1c2UgaXQuXG4gIC8vIEV4YW1wbGU6IFwiUGFzc3dvcmRzIG11c3QgaW5jbHVkZSBhIENhcGl0YWwgTGV0dGVyLCBMb3dlcmNhc2UgTGV0dGVyLCBhbmQgYSBudW1iZXIuXCJcbiAgLy9cbiAgLy8gVGhpcyBpcyBlc3BlY2lhbGx5IHVzZWZ1bCBvbiB0aGUgZ2VuZXJpYyBcInBhc3N3b3JkIHJlc2V0XCIgcGFnZSxcbiAgLy8gYXMgaXQgYWxsb3dzIHRoZSBwcm9ncmFtbWVyIHRvIGNvbW11bmljYXRlIHNwZWNpZmljIHJlcXVpcmVtZW50cyBpbnN0ZWFkIG9mOlxuICAvLyBhLiBtYWtpbmcgdGhlIHVzZXIgZ3Vlc3Mgd2hhdHMgd3JvbmdcbiAgLy8gYi4gbWFraW5nIGEgY3VzdG9tIHBhc3N3b3JkIHJlc2V0IHBhZ2UgdGhhdCBzaG93cyB0aGUgcmVxdWlyZW1lbnRzXG4gIGNvbnN0IHBvbGljeUVycm9yID0gdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdGlvbkVycm9yXG4gICAgPyB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS52YWxpZGF0aW9uRXJyb3JcbiAgICA6ICdQYXNzd29yZCBkb2VzIG5vdCBtZWV0IHRoZSBQYXNzd29yZCBQb2xpY3kgcmVxdWlyZW1lbnRzLic7XG4gIGNvbnN0IGNvbnRhaW5zVXNlcm5hbWVFcnJvciA9ICdQYXNzd29yZCBjYW5ub3QgY29udGFpbiB5b3VyIHVzZXJuYW1lLic7XG5cbiAgLy8gY2hlY2sgd2hldGhlciB0aGUgcGFzc3dvcmQgbWVldHMgdGhlIHBhc3N3b3JkIHN0cmVuZ3RoIHJlcXVpcmVtZW50c1xuICBpZiAoXG4gICAgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnBhdHRlcm5WYWxpZGF0b3IgJiZcbiAgICAgICF0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5wYXR0ZXJuVmFsaWRhdG9yKHRoaXMuZGF0YS5wYXNzd29yZCkpIHx8XG4gICAgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRvckNhbGxiYWNrICYmXG4gICAgICAhdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdG9yQ2FsbGJhY2sodGhpcy5kYXRhLnBhc3N3b3JkKSlcbiAgKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBwb2xpY3lFcnJvcikpO1xuICB9XG5cbiAgLy8gY2hlY2sgd2hldGhlciBwYXNzd29yZCBjb250YWluIHVzZXJuYW1lXG4gIGlmICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5kb05vdEFsbG93VXNlcm5hbWUgPT09IHRydWUpIHtcbiAgICBpZiAodGhpcy5kYXRhLnVzZXJuYW1lKSB7XG4gICAgICAvLyB1c2VybmFtZSBpcyBub3QgcGFzc2VkIGR1cmluZyBwYXNzd29yZCByZXNldFxuICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZC5pbmRleE9mKHRoaXMuZGF0YS51c2VybmFtZSkgPj0gMClcbiAgICAgIHsgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBjb250YWluc1VzZXJuYW1lRXJyb3IpKTsgfVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyByZXRyaWV2ZSB0aGUgVXNlciBvYmplY3QgdXNpbmcgb2JqZWN0SWQgZHVyaW5nIHBhc3N3b3JkIHJlc2V0XG4gICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZCgnX1VzZXInLCB7IG9iamVjdElkOiB0aGlzLm9iamVjdElkKCkgfSkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZC5pbmRleE9mKHJlc3VsdHNbMF0udXNlcm5hbWUpID49IDApXG4gICAgICAgIHsgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBjb250YWluc1VzZXJuYW1lRXJyb3IpXG4gICAgICAgICk7IH1cbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRIaXN0b3J5ID0gZnVuY3Rpb24gKCkge1xuICAvLyBjaGVjayB3aGV0aGVyIHBhc3N3b3JkIGlzIHJlcGVhdGluZyBmcm9tIHNwZWNpZmllZCBoaXN0b3J5XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSkge1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmZpbmQoXG4gICAgICAgICdfVXNlcicsXG4gICAgICAgIHsgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSB9LFxuICAgICAgICB7IGtleXM6IFsnX3Bhc3N3b3JkX2hpc3RvcnknLCAnX2hhc2hlZF9wYXNzd29yZCddIH0sXG4gICAgICAgIEF1dGgubWFpbnRlbmFuY2UodGhpcy5jb25maWcpXG4gICAgICApXG4gICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgdXNlciA9IHJlc3VsdHNbMF07XG4gICAgICAgIGxldCBvbGRQYXNzd29yZHMgPSBbXTtcbiAgICAgICAgaWYgKHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnkpXG4gICAgICAgIHsgb2xkUGFzc3dvcmRzID0gXy50YWtlKFxuICAgICAgICAgIHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnksXG4gICAgICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5IC0gMVxuICAgICAgICApOyB9XG4gICAgICAgIG9sZFBhc3N3b3Jkcy5wdXNoKHVzZXIucGFzc3dvcmQpO1xuICAgICAgICBjb25zdCBuZXdQYXNzd29yZCA9IHRoaXMuZGF0YS5wYXNzd29yZDtcbiAgICAgICAgLy8gY29tcGFyZSB0aGUgbmV3IHBhc3N3b3JkIGhhc2ggd2l0aCBhbGwgb2xkIHBhc3N3b3JkIGhhc2hlc1xuICAgICAgICBjb25zdCBwcm9taXNlcyA9IG9sZFBhc3N3b3Jkcy5tYXAoZnVuY3Rpb24gKGhhc2gpIHtcbiAgICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uY29tcGFyZShuZXdQYXNzd29yZCwgaGFzaCkudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKHJlc3VsdClcbiAgICAgICAgICAgIC8vIHJlamVjdCBpZiB0aGVyZSBpcyBhIG1hdGNoXG4gICAgICAgICAgICB7IHJldHVybiBQcm9taXNlLnJlamVjdCgnUkVQRUFUX1BBU1NXT1JEJyk7IH1cbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIHdhaXQgZm9yIGFsbCBjb21wYXJpc29ucyB0byBjb21wbGV0ZVxuICAgICAgICByZXR1cm4gUHJvbWlzZS5hbGwocHJvbWlzZXMpXG4gICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgICAgICBpZiAoZXJyID09PSAnUkVQRUFUX1BBU1NXT1JEJylcbiAgICAgICAgICAgIC8vIGEgbWF0Y2ggd2FzIGZvdW5kXG4gICAgICAgICAgICB7IHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgICAgICAgICAgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLlZBTElEQVRJT05fRVJST1IsXG4gICAgICAgICAgICAgICAgYE5ldyBwYXNzd29yZCBzaG91bGQgbm90IGJlIHRoZSBzYW1lIGFzIGxhc3QgJHt0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3Rvcnl9IHBhc3N3b3Jkcy5gXG4gICAgICAgICAgICAgIClcbiAgICAgICAgICAgICk7IH1cbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgICB9KTtcbiAgICAgIH0pO1xuICB9XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuY3JlYXRlU2Vzc2lvblRva2VuSWZOZWVkZWQgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJykge1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBEb24ndCBnZW5lcmF0ZSBzZXNzaW9uIGZvciB1cGRhdGluZyB1c2VyICh0aGlzLnF1ZXJ5IGlzIHNldCkgdW5sZXNzIGF1dGhEYXRhIGV4aXN0c1xuICBpZiAodGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmF1dGhEYXRhKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIERvbid0IGdlbmVyYXRlIG5ldyBzZXNzaW9uVG9rZW4gaWYgbGlua2luZyB2aWEgc2Vzc2lvblRva2VuXG4gIGlmICh0aGlzLmF1dGgudXNlciAmJiB0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gSWYgc2lnbi11cCBjYWxsXG4gIGlmICghdGhpcy5zdG9yYWdlLmF1dGhQcm92aWRlcikge1xuICAgIC8vIENyZWF0ZSByZXF1ZXN0IG9iamVjdCBmb3IgdmVyaWZpY2F0aW9uIGZ1bmN0aW9uc1xuICAgIGNvbnN0IHsgb3JpZ2luYWxPYmplY3QsIHVwZGF0ZWRPYmplY3QgfSA9IHRoaXMuYnVpbGRQYXJzZU9iamVjdHMoKTtcbiAgICBjb25zdCByZXF1ZXN0ID0ge1xuICAgICAgb3JpZ2luYWw6IG9yaWdpbmFsT2JqZWN0LFxuICAgICAgb2JqZWN0OiB1cGRhdGVkT2JqZWN0LFxuICAgICAgbWFzdGVyOiB0aGlzLmF1dGguaXNNYXN0ZXIsXG4gICAgICBpcDogdGhpcy5jb25maWcuaXAsXG4gICAgICBpbnN0YWxsYXRpb25JZDogdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkLFxuICAgIH07XG4gICAgLy8gR2V0IHZlcmlmaWNhdGlvbiBjb25kaXRpb25zIHdoaWNoIGNhbiBiZSBib29sZWFucyBvciBmdW5jdGlvbnM7IHRoZSBwdXJwb3NlIG9mIHRoaXMgYXN5bmMvYXdhaXRcbiAgICAvLyBzdHJ1Y3R1cmUgaXMgdG8gYXZvaWQgdW5uZWNlc3NhcmlseSBleGVjdXRpbmcgc3Vic2VxdWVudCBmdW5jdGlvbnMgaWYgcHJldmlvdXMgb25lcyBmYWlsIGluIHRoZVxuICAgIC8vIGNvbmRpdGlvbmFsIHN0YXRlbWVudCBiZWxvdywgYXMgYSBkZXZlbG9wZXIgbWF5IGRlY2lkZSB0byBleGVjdXRlIGV4cGVuc2l2ZSBvcGVyYXRpb25zIGluIHRoZW1cbiAgICBjb25zdCB2ZXJpZnlVc2VyRW1haWxzID0gYXN5bmMgKCkgPT4gdGhpcy5jb25maWcudmVyaWZ5VXNlckVtYWlscyA9PT0gdHJ1ZSB8fCAodHlwZW9mIHRoaXMuY29uZmlnLnZlcmlmeVVzZXJFbWFpbHMgPT09ICdmdW5jdGlvbicgJiYgYXdhaXQgUHJvbWlzZS5yZXNvbHZlKHRoaXMuY29uZmlnLnZlcmlmeVVzZXJFbWFpbHMocmVxdWVzdCkpID09PSB0cnVlKTtcbiAgICBjb25zdCBwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsID0gYXN5bmMgKCkgPT4gdGhpcy5jb25maWcucHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCA9PT0gdHJ1ZSB8fCAodHlwZW9mIHRoaXMuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgPT09ICdmdW5jdGlvbicgJiYgYXdhaXQgUHJvbWlzZS5yZXNvbHZlKHRoaXMuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwocmVxdWVzdCkpID09PSB0cnVlKTtcbiAgICAvLyBJZiB2ZXJpZmljYXRpb24gaXMgcmVxdWlyZWRcbiAgICBpZiAoYXdhaXQgdmVyaWZ5VXNlckVtYWlscygpICYmIGF3YWl0IHByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwoKSkge1xuICAgICAgdGhpcy5zdG9yYWdlLnJlamVjdFNpZ251cCA9IHRydWU7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9XG4gIHJldHVybiB0aGlzLmNyZWF0ZVNlc3Npb25Ub2tlbigpO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5jcmVhdGVTZXNzaW9uVG9rZW4gPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIC8vIGNsb3VkIGluc3RhbGxhdGlvbklkIGZyb20gQ2xvdWQgQ29kZSxcbiAgLy8gbmV2ZXIgY3JlYXRlIHNlc3Npb24gdG9rZW5zIGZyb20gdGhlcmUuXG4gIGlmICh0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQgJiYgdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkID09PSAnY2xvdWQnKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHRoaXMuc3RvcmFnZS5hdXRoUHJvdmlkZXIgPT0gbnVsbCAmJiB0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICB0aGlzLnN0b3JhZ2UuYXV0aFByb3ZpZGVyID0gT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5qb2luKCcsJyk7XG4gIH1cblxuICBjb25zdCB7IHNlc3Npb25EYXRhLCBjcmVhdGVTZXNzaW9uIH0gPSBSZXN0V3JpdGUuY3JlYXRlU2Vzc2lvbih0aGlzLmNvbmZpZywge1xuICAgIHVzZXJJZDogdGhpcy5vYmplY3RJZCgpLFxuICAgIGNyZWF0ZWRXaXRoOiB7XG4gICAgICBhY3Rpb246IHRoaXMuc3RvcmFnZS5hdXRoUHJvdmlkZXIgPyAnbG9naW4nIDogJ3NpZ251cCcsXG4gICAgICBhdXRoUHJvdmlkZXI6IHRoaXMuc3RvcmFnZS5hdXRoUHJvdmlkZXIgfHwgJ3Bhc3N3b3JkJyxcbiAgICB9LFxuICAgIGluc3RhbGxhdGlvbklkOiB0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQsXG4gIH0pO1xuXG4gIGlmICh0aGlzLnJlc3BvbnNlICYmIHRoaXMucmVzcG9uc2UucmVzcG9uc2UpIHtcbiAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlLnNlc3Npb25Ub2tlbiA9IHNlc3Npb25EYXRhLnNlc3Npb25Ub2tlbjtcbiAgfVxuXG4gIHJldHVybiBjcmVhdGVTZXNzaW9uKCk7XG59O1xuXG5SZXN0V3JpdGUuY3JlYXRlU2Vzc2lvbiA9IGZ1bmN0aW9uIChcbiAgY29uZmlnLFxuICB7IHVzZXJJZCwgY3JlYXRlZFdpdGgsIGluc3RhbGxhdGlvbklkLCBhZGRpdGlvbmFsU2Vzc2lvbkRhdGEgfVxuKSB7XG4gIGNvbnN0IHRva2VuID0gJ3I6JyArIGNyeXB0b1V0aWxzLm5ld1Rva2VuKCk7XG4gIGNvbnN0IGV4cGlyZXNBdCA9IGNvbmZpZy5nZW5lcmF0ZVNlc3Npb25FeHBpcmVzQXQoKTtcbiAgY29uc3Qgc2Vzc2lvbkRhdGEgPSB7XG4gICAgc2Vzc2lvblRva2VuOiB0b2tlbixcbiAgICB1c2VyOiB7XG4gICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgIG9iamVjdElkOiB1c2VySWQsXG4gICAgfSxcbiAgICBjcmVhdGVkV2l0aCxcbiAgICBleHBpcmVzQXQ6IFBhcnNlLl9lbmNvZGUoZXhwaXJlc0F0KSxcbiAgfTtcblxuICBpZiAoaW5zdGFsbGF0aW9uSWQpIHtcbiAgICBzZXNzaW9uRGF0YS5pbnN0YWxsYXRpb25JZCA9IGluc3RhbGxhdGlvbklkO1xuICB9XG5cbiAgT2JqZWN0LmFzc2lnbihzZXNzaW9uRGF0YSwgYWRkaXRpb25hbFNlc3Npb25EYXRhKTtcblxuICByZXR1cm4ge1xuICAgIHNlc3Npb25EYXRhLFxuICAgIGNyZWF0ZVNlc3Npb246ICgpID0+XG4gICAgICBuZXcgUmVzdFdyaXRlKGNvbmZpZywgQXV0aC5tYXN0ZXIoY29uZmlnKSwgJ19TZXNzaW9uJywgbnVsbCwgc2Vzc2lvbkRhdGEpLmV4ZWN1dGUoKSxcbiAgfTtcbn07XG5cbi8vIERlbGV0ZSBlbWFpbCByZXNldCB0b2tlbnMgaWYgdXNlciBpcyBjaGFuZ2luZyBwYXNzd29yZCBvciBlbWFpbC5cblJlc3RXcml0ZS5wcm90b3R5cGUuZGVsZXRlRW1haWxSZXNldFRva2VuSWZOZWVkZWQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJyB8fCB0aGlzLnF1ZXJ5ID09PSBudWxsKSB7XG4gICAgLy8gbnVsbCBxdWVyeSBtZWFucyBjcmVhdGVcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoJ3Bhc3N3b3JkJyBpbiB0aGlzLmRhdGEgfHwgJ2VtYWlsJyBpbiB0aGlzLmRhdGEpIHtcbiAgICBjb25zdCBhZGRPcHMgPSB7XG4gICAgICBfcGVyaXNoYWJsZV90b2tlbjogeyBfX29wOiAnRGVsZXRlJyB9LFxuICAgICAgX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdDogeyBfX29wOiAnRGVsZXRlJyB9LFxuICAgIH07XG4gICAgdGhpcy5kYXRhID0gT2JqZWN0LmFzc2lnbih0aGlzLmRhdGEsIGFkZE9wcyk7XG4gIH1cbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuZGVzdHJveUR1cGxpY2F0ZWRTZXNzaW9ucyA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gT25seSBmb3IgX1Nlc3Npb24sIGFuZCBhdCBjcmVhdGlvbiB0aW1lXG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPSAnX1Nlc3Npb24nIHx8IHRoaXMucXVlcnkpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gRGVzdHJveSB0aGUgc2Vzc2lvbnMgaW4gJ0JhY2tncm91bmQnXG4gIGNvbnN0IHsgdXNlciwgaW5zdGFsbGF0aW9uSWQsIHNlc3Npb25Ub2tlbiB9ID0gdGhpcy5kYXRhO1xuICBpZiAoIXVzZXIgfHwgIWluc3RhbGxhdGlvbklkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghdXNlci5vYmplY3RJZCkge1xuICAgIHJldHVybjtcbiAgfVxuICB0aGlzLmNvbmZpZy5kYXRhYmFzZS5kZXN0cm95KFxuICAgICdfU2Vzc2lvbicsXG4gICAge1xuICAgICAgdXNlcixcbiAgICAgIGluc3RhbGxhdGlvbklkLFxuICAgICAgc2Vzc2lvblRva2VuOiB7ICRuZTogc2Vzc2lvblRva2VuIH0sXG4gICAgfSxcbiAgICB7fSxcbiAgICB0aGlzLnZhbGlkU2NoZW1hQ29udHJvbGxlclxuICApO1xufTtcblxuLy8gSGFuZGxlcyBhbnkgZm9sbG93dXAgbG9naWNcblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlRm9sbG93dXAgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnN0b3JhZ2UgJiYgdGhpcy5zdG9yYWdlWydjbGVhclNlc3Npb25zJ10gJiYgdGhpcy5jb25maWcucmV2b2tlU2Vzc2lvbk9uUGFzc3dvcmRSZXNldCkge1xuICAgIHZhciBzZXNzaW9uUXVlcnkgPSB7XG4gICAgICB1c2VyOiB7XG4gICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgIG9iamVjdElkOiB0aGlzLm9iamVjdElkKCksXG4gICAgICB9LFxuICAgIH07XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnY2xlYXJTZXNzaW9ucyddO1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmRlc3Ryb3koJ19TZXNzaW9uJywgc2Vzc2lvblF1ZXJ5KVxuICAgICAgLnRoZW4odGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpKTtcbiAgfVxuXG4gIGlmICh0aGlzLnN0b3JhZ2UgJiYgdGhpcy5zdG9yYWdlWydnZW5lcmF0ZU5ld1Nlc3Npb24nXSkge1xuICAgIGRlbGV0ZSB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddO1xuICAgIHJldHVybiB0aGlzLmNyZWF0ZVNlc3Npb25Ub2tlbigpLnRoZW4odGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpKTtcbiAgfVxuXG4gIGlmICh0aGlzLnN0b3JhZ2UgJiYgdGhpcy5zdG9yYWdlWydzZW5kVmVyaWZpY2F0aW9uRW1haWwnXSkge1xuICAgIGRlbGV0ZSB0aGlzLnN0b3JhZ2VbJ3NlbmRWZXJpZmljYXRpb25FbWFpbCddO1xuICAgIC8vIEZpcmUgYW5kIGZvcmdldCFcbiAgICB0aGlzLmNvbmZpZy51c2VyQ29udHJvbGxlci5zZW5kVmVyaWZpY2F0aW9uRW1haWwodGhpcy5kYXRhLCB7IGF1dGg6IHRoaXMuYXV0aCB9KTtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpO1xuICB9XG59O1xuXG4vLyBIYW5kbGVzIHRoZSBfU2Vzc2lvbiBjbGFzcyBzcGVjaWFsbmVzcy5cbi8vIERvZXMgbm90aGluZyBpZiB0aGlzIGlzbid0IGFuIF9TZXNzaW9uIG9iamVjdC5cblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlU2Vzc2lvbiA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgfHwgdGhpcy5jbGFzc05hbWUgIT09ICdfU2Vzc2lvbicpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoIXRoaXMuYXV0aC51c2VyICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfU0VTU0lPTl9UT0tFTiwgJ1Nlc3Npb24gdG9rZW4gcmVxdWlyZWQuJyk7XG4gIH1cblxuICAvLyBUT0RPOiBWZXJpZnkgcHJvcGVyIGVycm9yIHRvIHRocm93XG4gIGlmICh0aGlzLmRhdGEuQUNMKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsICdDYW5ub3Qgc2V0ICcgKyAnQUNMIG9uIGEgU2Vzc2lvbi4nKTtcbiAgfVxuXG4gIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgaWYgKHRoaXMuZGF0YS51c2VyICYmICF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgdGhpcy5kYXRhLnVzZXIub2JqZWN0SWQgIT0gdGhpcy5hdXRoLnVzZXIuaWQpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5kYXRhLnNlc3Npb25Ub2tlbikge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUpO1xuICAgIH1cbiAgICBpZiAoIXRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgICAgdGhpcy5xdWVyeSA9IHtcbiAgICAgICAgJGFuZDogW1xuICAgICAgICAgIHRoaXMucXVlcnksXG4gICAgICAgICAge1xuICAgICAgICAgICAgdXNlcjoge1xuICAgICAgICAgICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgICAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICAgICAgICBvYmplY3RJZDogdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIGlmICghdGhpcy5xdWVyeSAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyICYmICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIGNvbnN0IGFkZGl0aW9uYWxTZXNzaW9uRGF0YSA9IHt9O1xuICAgIGZvciAodmFyIGtleSBpbiB0aGlzLmRhdGEpIHtcbiAgICAgIGlmIChrZXkgPT09ICdvYmplY3RJZCcgfHwga2V5ID09PSAndXNlcicpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBhZGRpdGlvbmFsU2Vzc2lvbkRhdGFba2V5XSA9IHRoaXMuZGF0YVtrZXldO1xuICAgIH1cblxuICAgIGNvbnN0IHsgc2Vzc2lvbkRhdGEsIGNyZWF0ZVNlc3Npb24gfSA9IFJlc3RXcml0ZS5jcmVhdGVTZXNzaW9uKHRoaXMuY29uZmlnLCB7XG4gICAgICB1c2VySWQ6IHRoaXMuYXV0aC51c2VyLmlkLFxuICAgICAgY3JlYXRlZFdpdGg6IHtcbiAgICAgICAgYWN0aW9uOiAnY3JlYXRlJyxcbiAgICAgIH0sXG4gICAgICBhZGRpdGlvbmFsU2Vzc2lvbkRhdGEsXG4gICAgfSk7XG5cbiAgICByZXR1cm4gY3JlYXRlU2Vzc2lvbigpLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICBpZiAoIXJlc3VsdHMucmVzcG9uc2UpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUiwgJ0Vycm9yIGNyZWF0aW5nIHNlc3Npb24uJyk7XG4gICAgICB9XG4gICAgICBzZXNzaW9uRGF0YVsnb2JqZWN0SWQnXSA9IHJlc3VsdHMucmVzcG9uc2VbJ29iamVjdElkJ107XG4gICAgICB0aGlzLnJlc3BvbnNlID0ge1xuICAgICAgICBzdGF0dXM6IDIwMSxcbiAgICAgICAgbG9jYXRpb246IHJlc3VsdHMubG9jYXRpb24sXG4gICAgICAgIHJlc3BvbnNlOiBzZXNzaW9uRGF0YSxcbiAgICAgIH07XG4gICAgfSk7XG4gIH1cbn07XG5cbi8vIEhhbmRsZXMgdGhlIF9JbnN0YWxsYXRpb24gY2xhc3Mgc3BlY2lhbG5lc3MuXG4vLyBEb2VzIG5vdGhpbmcgaWYgdGhpcyBpc24ndCBhbiBpbnN0YWxsYXRpb24gb2JqZWN0LlxuLy8gSWYgYW4gaW5zdGFsbGF0aW9uIGlzIGZvdW5kLCB0aGlzIGNhbiBtdXRhdGUgdGhpcy5xdWVyeSBhbmQgdHVybiBhIGNyZWF0ZVxuLy8gaW50byBhbiB1cGRhdGUuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3Igd2hlbiB3ZSdyZSBkb25lIGlmIGl0IGNhbid0IGZpbmlzaCB0aGlzIHRpY2suXG5SZXN0V3JpdGUucHJvdG90eXBlLmhhbmRsZUluc3RhbGxhdGlvbiA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgfHwgdGhpcy5jbGFzc05hbWUgIT09ICdfSW5zdGFsbGF0aW9uJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChcbiAgICAhdGhpcy5xdWVyeSAmJlxuICAgICF0aGlzLmRhdGEuZGV2aWNlVG9rZW4gJiZcbiAgICAhdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICYmXG4gICAgIXRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZFxuICApIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAxMzUsXG4gICAgICAnYXQgbGVhc3Qgb25lIElEIGZpZWxkIChkZXZpY2VUb2tlbiwgaW5zdGFsbGF0aW9uSWQpICcgKyAnbXVzdCBiZSBzcGVjaWZpZWQgaW4gdGhpcyBvcGVyYXRpb24nXG4gICAgKTtcbiAgfVxuXG4gIC8vIElmIHRoZSBkZXZpY2UgdG9rZW4gaXMgNjQgY2hhcmFjdGVycyBsb25nLCB3ZSBhc3N1bWUgaXQgaXMgZm9yIGlPU1xuICAvLyBhbmQgbG93ZXJjYXNlIGl0LlxuICBpZiAodGhpcy5kYXRhLmRldmljZVRva2VuICYmIHRoaXMuZGF0YS5kZXZpY2VUb2tlbi5sZW5ndGggPT0gNjQpIHtcbiAgICB0aGlzLmRhdGEuZGV2aWNlVG9rZW4gPSB0aGlzLmRhdGEuZGV2aWNlVG9rZW4udG9Mb3dlckNhc2UoKTtcbiAgfVxuXG4gIC8vIFdlIGxvd2VyY2FzZSB0aGUgaW5zdGFsbGF0aW9uSWQgaWYgcHJlc2VudFxuICBpZiAodGhpcy5kYXRhLmluc3RhbGxhdGlvbklkKSB7XG4gICAgdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkID0gdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkLnRvTG93ZXJDYXNlKCk7XG4gIH1cblxuICBsZXQgaW5zdGFsbGF0aW9uSWQgPSB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQ7XG5cbiAgLy8gSWYgZGF0YS5pbnN0YWxsYXRpb25JZCBpcyBub3Qgc2V0IGFuZCB3ZSdyZSBub3QgbWFzdGVyLCB3ZSBjYW4gbG9va3VwIGluIGF1dGhcbiAgaWYgKCFpbnN0YWxsYXRpb25JZCAmJiAhdGhpcy5hdXRoLmlzTWFzdGVyICYmICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIGluc3RhbGxhdGlvbklkID0gdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkO1xuICB9XG5cbiAgaWYgKGluc3RhbGxhdGlvbklkKSB7XG4gICAgaW5zdGFsbGF0aW9uSWQgPSBpbnN0YWxsYXRpb25JZC50b0xvd2VyQ2FzZSgpO1xuICB9XG5cbiAgLy8gVXBkYXRpbmcgX0luc3RhbGxhdGlvbiBidXQgbm90IHVwZGF0aW5nIGFueXRoaW5nIGNyaXRpY2FsXG4gIGlmICh0aGlzLnF1ZXJ5ICYmICF0aGlzLmRhdGEuZGV2aWNlVG9rZW4gJiYgIWluc3RhbGxhdGlvbklkICYmICF0aGlzLmRhdGEuZGV2aWNlVHlwZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHZhciBwcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5cbiAgdmFyIGlkTWF0Y2g7IC8vIFdpbGwgYmUgYSBtYXRjaCBvbiBlaXRoZXIgb2JqZWN0SWQgb3IgaW5zdGFsbGF0aW9uSWRcbiAgdmFyIG9iamVjdElkTWF0Y2g7XG4gIHZhciBpbnN0YWxsYXRpb25JZE1hdGNoO1xuICB2YXIgZGV2aWNlVG9rZW5NYXRjaGVzID0gW107XG5cbiAgLy8gSW5zdGVhZCBvZiBpc3N1aW5nIDMgcmVhZHMsIGxldCdzIGRvIGl0IHdpdGggb25lIE9SLlxuICBjb25zdCBvclF1ZXJpZXMgPSBbXTtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgIG9yUXVlcmllcy5wdXNoKHtcbiAgICAgIG9iamVjdElkOiB0aGlzLnF1ZXJ5Lm9iamVjdElkLFxuICAgIH0pO1xuICB9XG4gIGlmIChpbnN0YWxsYXRpb25JZCkge1xuICAgIG9yUXVlcmllcy5wdXNoKHtcbiAgICAgIGluc3RhbGxhdGlvbklkOiBpbnN0YWxsYXRpb25JZCxcbiAgICB9KTtcbiAgfVxuICBpZiAodGhpcy5kYXRhLmRldmljZVRva2VuKSB7XG4gICAgb3JRdWVyaWVzLnB1c2goeyBkZXZpY2VUb2tlbjogdGhpcy5kYXRhLmRldmljZVRva2VuIH0pO1xuICB9XG5cbiAgaWYgKG9yUXVlcmllcy5sZW5ndGggPT0gMCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHByb21pc2UgPSBwcm9taXNlXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQoXG4gICAgICAgICdfSW5zdGFsbGF0aW9uJyxcbiAgICAgICAge1xuICAgICAgICAgICRvcjogb3JRdWVyaWVzLFxuICAgICAgICB9LFxuICAgICAgICB7fVxuICAgICAgKTtcbiAgICB9KVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgcmVzdWx0cy5mb3JFYWNoKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQgJiYgcmVzdWx0Lm9iamVjdElkID09IHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAgICAgICBvYmplY3RJZE1hdGNoID0gcmVzdWx0O1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXN1bHQuaW5zdGFsbGF0aW9uSWQgPT0gaW5zdGFsbGF0aW9uSWQpIHtcbiAgICAgICAgICBpbnN0YWxsYXRpb25JZE1hdGNoID0gcmVzdWx0O1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXN1bHQuZGV2aWNlVG9rZW4gPT0gdGhpcy5kYXRhLmRldmljZVRva2VuKSB7XG4gICAgICAgICAgZGV2aWNlVG9rZW5NYXRjaGVzLnB1c2gocmVzdWx0KTtcbiAgICAgICAgfVxuICAgICAgfSk7XG5cbiAgICAgIC8vIFNhbml0eSBjaGVja3Mgd2hlbiBydW5uaW5nIGEgcXVlcnlcbiAgICAgIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAgICAgaWYgKCFvYmplY3RJZE1hdGNoKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdPYmplY3Qgbm90IGZvdW5kIGZvciB1cGRhdGUuJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAmJlxuICAgICAgICAgIG9iamVjdElkTWF0Y2guaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgIT09IG9iamVjdElkTWF0Y2guaW5zdGFsbGF0aW9uSWRcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKDEzNiwgJ2luc3RhbGxhdGlvbklkIG1heSBub3QgYmUgY2hhbmdlZCBpbiB0aGlzICcgKyAnb3BlcmF0aW9uJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgIG9iamVjdElkTWF0Y2guZGV2aWNlVG9rZW4gJiZcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVG9rZW4gIT09IG9iamVjdElkTWF0Y2guZGV2aWNlVG9rZW4gJiZcbiAgICAgICAgICAhdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICYmXG4gICAgICAgICAgIW9iamVjdElkTWF0Y2guaW5zdGFsbGF0aW9uSWRcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKDEzNiwgJ2RldmljZVRva2VuIG1heSBub3QgYmUgY2hhbmdlZCBpbiB0aGlzICcgKyAnb3BlcmF0aW9uJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUeXBlICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVR5cGUgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVHlwZSAhPT0gb2JqZWN0SWRNYXRjaC5kZXZpY2VUeXBlXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigxMzYsICdkZXZpY2VUeXBlIG1heSBub3QgYmUgY2hhbmdlZCBpbiB0aGlzICcgKyAnb3BlcmF0aW9uJyk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCAmJiBvYmplY3RJZE1hdGNoKSB7XG4gICAgICAgIGlkTWF0Y2ggPSBvYmplY3RJZE1hdGNoO1xuICAgICAgfVxuXG4gICAgICBpZiAoaW5zdGFsbGF0aW9uSWQgJiYgaW5zdGFsbGF0aW9uSWRNYXRjaCkge1xuICAgICAgICBpZE1hdGNoID0gaW5zdGFsbGF0aW9uSWRNYXRjaDtcbiAgICAgIH1cbiAgICAgIC8vIG5lZWQgdG8gc3BlY2lmeSBkZXZpY2VUeXBlIG9ubHkgaWYgaXQncyBuZXdcbiAgICAgIGlmICghdGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmRldmljZVR5cGUgJiYgIWlkTWF0Y2gpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKDEzNSwgJ2RldmljZVR5cGUgbXVzdCBiZSBzcGVjaWZpZWQgaW4gdGhpcyBvcGVyYXRpb24nKTtcbiAgICAgIH1cbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIGlmICghaWRNYXRjaCkge1xuICAgICAgICBpZiAoIWRldmljZVRva2VuTWF0Y2hlcy5sZW5ndGgpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgICAgZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCA9PSAxICYmXG4gICAgICAgICAgKCFkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ2luc3RhbGxhdGlvbklkJ10gfHwgIWluc3RhbGxhdGlvbklkKVxuICAgICAgICApIHtcbiAgICAgICAgICAvLyBTaW5nbGUgbWF0Y2ggb24gZGV2aWNlIHRva2VuIGJ1dCBub25lIG9uIGluc3RhbGxhdGlvbklkLCBhbmQgZWl0aGVyXG4gICAgICAgICAgLy8gdGhlIHBhc3NlZCBvYmplY3Qgb3IgdGhlIG1hdGNoIGlzIG1pc3NpbmcgYW4gaW5zdGFsbGF0aW9uSWQsIHNvIHdlXG4gICAgICAgICAgLy8gY2FuIGp1c3QgcmV0dXJuIHRoZSBtYXRjaC5cbiAgICAgICAgICByZXR1cm4gZGV2aWNlVG9rZW5NYXRjaGVzWzBdWydvYmplY3RJZCddO1xuICAgICAgICB9IGVsc2UgaWYgKCF0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAxMzIsXG4gICAgICAgICAgICAnTXVzdCBzcGVjaWZ5IGluc3RhbGxhdGlvbklkIHdoZW4gZGV2aWNlVG9rZW4gJyArXG4gICAgICAgICAgICAgICdtYXRjaGVzIG11bHRpcGxlIEluc3RhbGxhdGlvbiBvYmplY3RzJ1xuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gTXVsdGlwbGUgZGV2aWNlIHRva2VuIG1hdGNoZXMgYW5kIHdlIHNwZWNpZmllZCBhbiBpbnN0YWxsYXRpb24gSUQsXG4gICAgICAgICAgLy8gb3IgYSBzaW5nbGUgbWF0Y2ggd2hlcmUgYm90aCB0aGUgcGFzc2VkIGFuZCBtYXRjaGluZyBvYmplY3RzIGhhdmVcbiAgICAgICAgICAvLyBhbiBpbnN0YWxsYXRpb24gSUQuIFRyeSBjbGVhbmluZyBvdXQgb2xkIGluc3RhbGxhdGlvbnMgdGhhdCBtYXRjaFxuICAgICAgICAgIC8vIHRoZSBkZXZpY2VUb2tlbiwgYW5kIHJldHVybiBuaWwgdG8gc2lnbmFsIHRoYXQgYSBuZXcgb2JqZWN0IHNob3VsZFxuICAgICAgICAgIC8vIGJlIGNyZWF0ZWQuXG4gICAgICAgICAgdmFyIGRlbFF1ZXJ5ID0ge1xuICAgICAgICAgICAgZGV2aWNlVG9rZW46IHRoaXMuZGF0YS5kZXZpY2VUb2tlbixcbiAgICAgICAgICAgIGluc3RhbGxhdGlvbklkOiB7XG4gICAgICAgICAgICAgICRuZTogaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH07XG4gICAgICAgICAgaWYgKHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyKSB7XG4gICAgICAgICAgICBkZWxRdWVyeVsnYXBwSWRlbnRpZmllciddID0gdGhpcy5kYXRhLmFwcElkZW50aWZpZXI7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRoaXMuY29uZmlnLmRhdGFiYXNlLmRlc3Ryb3koJ19JbnN0YWxsYXRpb24nLCBkZWxRdWVyeSkuY2F0Y2goZXJyID0+IHtcbiAgICAgICAgICAgIGlmIChlcnIuY29kZSA9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgICAgIC8vIG5vIGRlbGV0aW9ucyB3ZXJlIG1hZGUuIENhbiBiZSBpZ25vcmVkLlxuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyByZXRocm93IHRoZSBlcnJvclxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKGRldmljZVRva2VuTWF0Y2hlcy5sZW5ndGggPT0gMSAmJiAhZGV2aWNlVG9rZW5NYXRjaGVzWzBdWydpbnN0YWxsYXRpb25JZCddKSB7XG4gICAgICAgICAgLy8gRXhhY3RseSBvbmUgZGV2aWNlIHRva2VuIG1hdGNoIGFuZCBpdCBkb2Vzbid0IGhhdmUgYW4gaW5zdGFsbGF0aW9uXG4gICAgICAgICAgLy8gSUQuIFRoaXMgaXMgdGhlIG9uZSBjYXNlIHdoZXJlIHdlIHdhbnQgdG8gbWVyZ2Ugd2l0aCB0aGUgZXhpc3RpbmdcbiAgICAgICAgICAvLyBvYmplY3QuXG4gICAgICAgICAgY29uc3QgZGVsUXVlcnkgPSB7IG9iamVjdElkOiBpZE1hdGNoLm9iamVjdElkIH07XG4gICAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgICAgICAuZGVzdHJveSgnX0luc3RhbGxhdGlvbicsIGRlbFF1ZXJ5KVxuICAgICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICByZXR1cm4gZGV2aWNlVG9rZW5NYXRjaGVzWzBdWydvYmplY3RJZCddO1xuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIC5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgICBpZiAoZXJyLmNvZGUgPT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgICAgICAgICAgIC8vIG5vIGRlbGV0aW9ucyB3ZXJlIG1hZGUuIENhbiBiZSBpZ25vcmVkXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIC8vIHJldGhyb3cgdGhlIGVycm9yXG4gICAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGlmICh0aGlzLmRhdGEuZGV2aWNlVG9rZW4gJiYgaWRNYXRjaC5kZXZpY2VUb2tlbiAhPSB0aGlzLmRhdGEuZGV2aWNlVG9rZW4pIHtcbiAgICAgICAgICAgIC8vIFdlJ3JlIHNldHRpbmcgdGhlIGRldmljZSB0b2tlbiBvbiBhbiBleGlzdGluZyBpbnN0YWxsYXRpb24sIHNvXG4gICAgICAgICAgICAvLyB3ZSBzaG91bGQgdHJ5IGNsZWFuaW5nIG91dCBvbGQgaW5zdGFsbGF0aW9ucyB0aGF0IG1hdGNoIHRoaXNcbiAgICAgICAgICAgIC8vIGRldmljZSB0b2tlbi5cbiAgICAgICAgICAgIGNvbnN0IGRlbFF1ZXJ5ID0ge1xuICAgICAgICAgICAgICBkZXZpY2VUb2tlbjogdGhpcy5kYXRhLmRldmljZVRva2VuLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIC8vIFdlIGhhdmUgYSB1bmlxdWUgaW5zdGFsbCBJZCwgdXNlIHRoYXQgdG8gcHJlc2VydmVcbiAgICAgICAgICAgIC8vIHRoZSBpbnRlcmVzdGluZyBpbnN0YWxsYXRpb25cbiAgICAgICAgICAgIGlmICh0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQpIHtcbiAgICAgICAgICAgICAgZGVsUXVlcnlbJ2luc3RhbGxhdGlvbklkJ10gPSB7XG4gICAgICAgICAgICAgICAgJG5lOiB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgICAgICBpZE1hdGNoLm9iamVjdElkICYmXG4gICAgICAgICAgICAgIHRoaXMuZGF0YS5vYmplY3RJZCAmJlxuICAgICAgICAgICAgICBpZE1hdGNoLm9iamVjdElkID09IHRoaXMuZGF0YS5vYmplY3RJZFxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgIC8vIHdlIHBhc3NlZCBhbiBvYmplY3RJZCwgcHJlc2VydmUgdGhhdCBpbnN0YWxhdGlvblxuICAgICAgICAgICAgICBkZWxRdWVyeVsnb2JqZWN0SWQnXSA9IHtcbiAgICAgICAgICAgICAgICAkbmU6IGlkTWF0Y2gub2JqZWN0SWQsXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAvLyBXaGF0IHRvIGRvIGhlcmU/IGNhbid0IHJlYWxseSBjbGVhbiB1cCBldmVyeXRoaW5nLi4uXG4gICAgICAgICAgICAgIHJldHVybiBpZE1hdGNoLm9iamVjdElkO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyKSB7XG4gICAgICAgICAgICAgIGRlbFF1ZXJ5WydhcHBJZGVudGlmaWVyJ10gPSB0aGlzLmRhdGEuYXBwSWRlbnRpZmllcjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuY29uZmlnLmRhdGFiYXNlLmRlc3Ryb3koJ19JbnN0YWxsYXRpb24nLCBkZWxRdWVyeSkuY2F0Y2goZXJyID0+IHtcbiAgICAgICAgICAgICAgaWYgKGVyci5jb2RlID09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQpIHtcbiAgICAgICAgICAgICAgICAvLyBubyBkZWxldGlvbnMgd2VyZSBtYWRlLiBDYW4gYmUgaWdub3JlZC5cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgLy8gcmV0aHJvdyB0aGUgZXJyb3JcbiAgICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIEluIG5vbi1tZXJnZSBzY2VuYXJpb3MsIGp1c3QgcmV0dXJuIHRoZSBpbnN0YWxsYXRpb24gbWF0Y2ggaWRcbiAgICAgICAgICByZXR1cm4gaWRNYXRjaC5vYmplY3RJZDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pXG4gICAgLnRoZW4ob2JqSWQgPT4ge1xuICAgICAgaWYgKG9iaklkKSB7XG4gICAgICAgIHRoaXMucXVlcnkgPSB7IG9iamVjdElkOiBvYmpJZCB9O1xuICAgICAgICBkZWxldGUgdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICBkZWxldGUgdGhpcy5kYXRhLmNyZWF0ZWRBdDtcbiAgICAgIH1cbiAgICAgIC8vIFRPRE86IFZhbGlkYXRlIG9wcyAoYWRkL3JlbW92ZSBvbiBjaGFubmVscywgJGluYyBvbiBiYWRnZSwgZXRjLilcbiAgICB9KTtcbiAgcmV0dXJuIHByb21pc2U7XG59O1xuXG4vLyBJZiB3ZSBzaG9ydC1jaXJjdWl0ZWQgdGhlIG9iamVjdCByZXNwb25zZSAtIHRoZW4gd2UgbmVlZCB0byBtYWtlIHN1cmUgd2UgZXhwYW5kIGFsbCB0aGUgZmlsZXMsXG4vLyBzaW5jZSB0aGlzIG1pZ2h0IG5vdCBoYXZlIGEgcXVlcnksIG1lYW5pbmcgaXQgd29uJ3QgcmV0dXJuIHRoZSBmdWxsIHJlc3VsdCBiYWNrLlxuLy8gVE9ETzogKG5sdXRzZW5rbykgVGhpcyBzaG91bGQgZGllIHdoZW4gd2UgbW92ZSB0byBwZXItY2xhc3MgYmFzZWQgY29udHJvbGxlcnMgb24gX1Nlc3Npb24vX1VzZXJcblJlc3RXcml0ZS5wcm90b3R5cGUuZXhwYW5kRmlsZXNGb3JFeGlzdGluZ09iamVjdHMgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIC8vIENoZWNrIHdoZXRoZXIgd2UgaGF2ZSBhIHNob3J0LWNpcmN1aXRlZCByZXNwb25zZSAtIG9ubHkgdGhlbiBydW4gZXhwYW5zaW9uLlxuICBpZiAodGhpcy5yZXNwb25zZSAmJiB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlKSB7XG4gICAgYXdhaXQgdGhpcy5jb25maWcuZmlsZXNDb250cm9sbGVyLmV4cGFuZEZpbGVzSW5PYmplY3QodGhpcy5jb25maWcsIHRoaXMucmVzcG9uc2UucmVzcG9uc2UpO1xuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkRhdGFiYXNlT3BlcmF0aW9uID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Sb2xlJykge1xuICAgIHRoaXMuY29uZmlnLmNhY2hlQ29udHJvbGxlci5yb2xlLmNsZWFyKCk7XG4gICAgaWYgKHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIpIHtcbiAgICAgIHRoaXMuY29uZmlnLmxpdmVRdWVyeUNvbnRyb2xsZXIuY2xlYXJDYWNoZWRSb2xlcyh0aGlzLmF1dGgudXNlcik7XG4gICAgfVxuICB9XG5cbiAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmIHRoaXMucXVlcnkgJiYgdGhpcy5hdXRoLmlzVW5hdXRoZW50aWNhdGVkKCkpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5TRVNTSU9OX01JU1NJTkcsXG4gICAgICBgQ2Fubm90IG1vZGlmeSB1c2VyICR7dGhpcy5xdWVyeS5vYmplY3RJZH0uYFxuICAgICk7XG4gIH1cblxuICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfUHJvZHVjdCcgJiYgdGhpcy5kYXRhLmRvd25sb2FkKSB7XG4gICAgdGhpcy5kYXRhLmRvd25sb2FkTmFtZSA9IHRoaXMuZGF0YS5kb3dubG9hZC5uYW1lO1xuICB9XG5cbiAgLy8gVE9ETzogQWRkIGJldHRlciBkZXRlY3Rpb24gZm9yIEFDTCwgZW5zdXJpbmcgYSB1c2VyIGNhbid0IGJlIGxvY2tlZCBmcm9tXG4gIC8vICAgICAgIHRoZWlyIG93biB1c2VyIHJlY29yZC5cbiAgaWYgKHRoaXMuZGF0YS5BQ0wgJiYgdGhpcy5kYXRhLkFDTFsnKnVucmVzb2x2ZWQnXSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0FDTCwgJ0ludmFsaWQgQUNMLicpO1xuICB9XG5cbiAgaWYgKHRoaXMucXVlcnkpIHtcbiAgICAvLyBGb3JjZSB0aGUgdXNlciB0byBub3QgbG9ja291dFxuICAgIC8vIE1hdGNoZWQgd2l0aCBwYXJzZS5jb21cbiAgICBpZiAoXG4gICAgICB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJlxuICAgICAgdGhpcy5kYXRhLkFDTCAmJlxuICAgICAgdGhpcy5hdXRoLmlzTWFzdGVyICE9PSB0cnVlICYmXG4gICAgICB0aGlzLmF1dGguaXNNYWludGVuYW5jZSAhPT0gdHJ1ZVxuICAgICkge1xuICAgICAgdGhpcy5kYXRhLkFDTFt0aGlzLnF1ZXJ5Lm9iamVjdElkXSA9IHsgcmVhZDogdHJ1ZSwgd3JpdGU6IHRydWUgfTtcbiAgICB9XG4gICAgLy8gdXBkYXRlIHBhc3N3b3JkIHRpbWVzdGFtcCBpZiB1c2VyIHBhc3N3b3JkIGlzIGJlaW5nIGNoYW5nZWRcbiAgICBpZiAoXG4gICAgICB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJlxuICAgICAgdGhpcy5kYXRhLl9oYXNoZWRfcGFzc3dvcmQgJiZcbiAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEFnZVxuICAgICkge1xuICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9jaGFuZ2VkX2F0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKTtcbiAgICB9XG4gICAgLy8gSWdub3JlIGNyZWF0ZWRBdCB3aGVuIHVwZGF0ZVxuICAgIGRlbGV0ZSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuXG4gICAgbGV0IGRlZmVyID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgLy8gaWYgcGFzc3dvcmQgaGlzdG9yeSBpcyBlbmFibGVkIHRoZW4gc2F2ZSB0aGUgY3VycmVudCBwYXNzd29yZCB0byBoaXN0b3J5XG4gICAgaWYgKFxuICAgICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5XG4gICAgKSB7XG4gICAgICBkZWZlciA9IHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgIC5maW5kKFxuICAgICAgICAgICdfVXNlcicsXG4gICAgICAgICAgeyBvYmplY3RJZDogdGhpcy5vYmplY3RJZCgpIH0sXG4gICAgICAgICAgeyBrZXlzOiBbJ19wYXNzd29yZF9oaXN0b3J5JywgJ19oYXNoZWRfcGFzc3dvcmQnXSB9LFxuICAgICAgICAgIEF1dGgubWFpbnRlbmFuY2UodGhpcy5jb25maWcpXG4gICAgICAgIClcbiAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICAgIHRocm93IHVuZGVmaW5lZDtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgdXNlciA9IHJlc3VsdHNbMF07XG4gICAgICAgICAgbGV0IG9sZFBhc3N3b3JkcyA9IFtdO1xuICAgICAgICAgIGlmICh1c2VyLl9wYXNzd29yZF9oaXN0b3J5KSB7XG4gICAgICAgICAgICBvbGRQYXNzd29yZHMgPSBfLnRha2UoXG4gICAgICAgICAgICAgIHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnksXG4gICAgICAgICAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy9uLTEgcGFzc3dvcmRzIGdvIGludG8gaGlzdG9yeSBpbmNsdWRpbmcgbGFzdCBwYXNzd29yZFxuICAgICAgICAgIHdoaWxlIChcbiAgICAgICAgICAgIG9sZFBhc3N3b3Jkcy5sZW5ndGggPiBNYXRoLm1heCgwLCB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgLSAyKVxuICAgICAgICAgICkge1xuICAgICAgICAgICAgb2xkUGFzc3dvcmRzLnNoaWZ0KCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIG9sZFBhc3N3b3Jkcy5wdXNoKHVzZXIucGFzc3dvcmQpO1xuICAgICAgICAgIHRoaXMuZGF0YS5fcGFzc3dvcmRfaGlzdG9yeSA9IG9sZFBhc3N3b3JkcztcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGRlZmVyLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gUnVuIGFuIHVwZGF0ZVxuICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgIC51cGRhdGUoXG4gICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgdGhpcy5xdWVyeSxcbiAgICAgICAgICB0aGlzLmRhdGEsXG4gICAgICAgICAgdGhpcy5ydW5PcHRpb25zLFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyXG4gICAgICAgIClcbiAgICAgICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgICAgICAgIHJlc3BvbnNlLnVwZGF0ZWRBdCA9IHRoaXMudXBkYXRlZEF0O1xuICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEocmVzcG9uc2UsIHRoaXMuZGF0YSk7XG4gICAgICAgICAgdGhpcy5yZXNwb25zZSA9IHsgcmVzcG9uc2UgfTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgLy8gU2V0IHRoZSBkZWZhdWx0IEFDTCBhbmQgcGFzc3dvcmQgdGltZXN0YW1wIGZvciB0aGUgbmV3IF9Vc2VyXG4gICAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgICB2YXIgQUNMID0gdGhpcy5kYXRhLkFDTDtcbiAgICAgIC8vIGRlZmF1bHQgcHVibGljIHIvdyBBQ0xcbiAgICAgIGlmICghQUNMKSB7XG4gICAgICAgIEFDTCA9IHt9O1xuICAgICAgICBpZiAoIXRoaXMuY29uZmlnLmVuZm9yY2VQcml2YXRlVXNlcnMpIHtcbiAgICAgICAgICBBQ0xbJyonXSA9IHsgcmVhZDogdHJ1ZSwgd3JpdGU6IGZhbHNlIH07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIG1ha2Ugc3VyZSB0aGUgdXNlciBpcyBub3QgbG9ja2VkIGRvd25cbiAgICAgIEFDTFt0aGlzLmRhdGEub2JqZWN0SWRdID0geyByZWFkOiB0cnVlLCB3cml0ZTogdHJ1ZSB9O1xuICAgICAgdGhpcy5kYXRhLkFDTCA9IEFDTDtcbiAgICAgIC8vIHBhc3N3b3JkIHRpbWVzdGFtcCB0byBiZSB1c2VkIHdoZW4gcGFzc3dvcmQgZXhwaXJ5IHBvbGljeSBpcyBlbmZvcmNlZFxuICAgICAgaWYgKHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkQWdlKSB7XG4gICAgICAgIHRoaXMuZGF0YS5fcGFzc3dvcmRfY2hhbmdlZF9hdCA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gUnVuIGEgY3JlYXRlXG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAuY3JlYXRlKHRoaXMuY2xhc3NOYW1lLCB0aGlzLmRhdGEsIHRoaXMucnVuT3B0aW9ucywgZmFsc2UsIHRoaXMudmFsaWRTY2hlbWFDb250cm9sbGVyKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInIHx8IGVycm9yLmNvZGUgIT09IFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSkge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gUXVpY2sgY2hlY2ssIGlmIHdlIHdlcmUgYWJsZSB0byBpbmZlciB0aGUgZHVwbGljYXRlZCBmaWVsZCBuYW1lXG4gICAgICAgIGlmIChlcnJvciAmJiBlcnJvci51c2VySW5mbyAmJiBlcnJvci51c2VySW5mby5kdXBsaWNhdGVkX2ZpZWxkID09PSAndXNlcm5hbWUnKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuVVNFUk5BTUVfVEFLRU4sXG4gICAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyB1c2VybmFtZS4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChlcnJvciAmJiBlcnJvci51c2VySW5mbyAmJiBlcnJvci51c2VySW5mby5kdXBsaWNhdGVkX2ZpZWxkID09PSAnZW1haWwnKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuRU1BSUxfVEFLRU4sXG4gICAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBlbWFpbCBhZGRyZXNzLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gSWYgdGhpcyB3YXMgYSBmYWlsZWQgdXNlciBjcmVhdGlvbiBkdWUgdG8gdXNlcm5hbWUgb3IgZW1haWwgYWxyZWFkeSB0YWtlbiwgd2UgbmVlZCB0b1xuICAgICAgICAvLyBjaGVjayB3aGV0aGVyIGl0IHdhcyB1c2VybmFtZSBvciBlbWFpbCBhbmQgcmV0dXJuIHRoZSBhcHByb3ByaWF0ZSBlcnJvci5cbiAgICAgICAgLy8gRmFsbGJhY2sgdG8gdGhlIG9yaWdpbmFsIG1ldGhvZFxuICAgICAgICAvLyBUT0RPOiBTZWUgaWYgd2UgY2FuIGxhdGVyIGRvIHRoaXMgd2l0aG91dCBhZGRpdGlvbmFsIHF1ZXJpZXMgYnkgdXNpbmcgbmFtZWQgaW5kZXhlcy5cbiAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgICAgLmZpbmQoXG4gICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdXNlcm5hbWU6IHRoaXMuZGF0YS51c2VybmFtZSxcbiAgICAgICAgICAgICAgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7IGxpbWl0OiAxIH1cbiAgICAgICAgICApXG4gICAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyB1c2VybmFtZS4nXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZChcbiAgICAgICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgICAgIHsgZW1haWw6IHRoaXMuZGF0YS5lbWFpbCwgb2JqZWN0SWQ6IHsgJG5lOiB0aGlzLm9iamVjdElkKCkgfSB9LFxuICAgICAgICAgICAgICB7IGxpbWl0OiAxIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLkVNQUlMX1RBS0VOLFxuICAgICAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIGVtYWlsIGFkZHJlc3MuJ1xuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsXG4gICAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9KTtcbiAgICAgIH0pXG4gICAgICAudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgIHJlc3BvbnNlLm9iamVjdElkID0gdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICByZXNwb25zZS5jcmVhdGVkQXQgPSB0aGlzLmRhdGEuY3JlYXRlZEF0O1xuXG4gICAgICAgIGlmICh0aGlzLnJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lKSB7XG4gICAgICAgICAgcmVzcG9uc2UudXNlcm5hbWUgPSB0aGlzLmRhdGEudXNlcm5hbWU7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5fdXBkYXRlUmVzcG9uc2VXaXRoRGF0YShyZXNwb25zZSwgdGhpcy5kYXRhKTtcbiAgICAgICAgdGhpcy5yZXNwb25zZSA9IHtcbiAgICAgICAgICBzdGF0dXM6IDIwMSxcbiAgICAgICAgICByZXNwb25zZSxcbiAgICAgICAgICBsb2NhdGlvbjogdGhpcy5sb2NhdGlvbigpLFxuICAgICAgICB9O1xuICAgICAgfSk7XG4gIH1cbn07XG5cbi8vIFJldHVybnMgbm90aGluZyAtIGRvZXNuJ3Qgd2FpdCBmb3IgdGhlIHRyaWdnZXIuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkFmdGVyU2F2ZVRyaWdnZXIgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5yZXNwb25zZSB8fCAhdGhpcy5yZXNwb25zZS5yZXNwb25zZSB8fCB0aGlzLnJ1bk9wdGlvbnMubWFueSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2FmdGVyU2F2ZScgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgY29uc3QgaGFzQWZ0ZXJTYXZlSG9vayA9IHRyaWdnZXJzLnRyaWdnZXJFeGlzdHMoXG4gICAgdGhpcy5jbGFzc05hbWUsXG4gICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJTYXZlLFxuICAgIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWRcbiAgKTtcbiAgY29uc3QgaGFzTGl2ZVF1ZXJ5ID0gdGhpcy5jb25maWcubGl2ZVF1ZXJ5Q29udHJvbGxlci5oYXNMaXZlUXVlcnkodGhpcy5jbGFzc05hbWUpO1xuICBpZiAoIWhhc0FmdGVyU2F2ZUhvb2sgJiYgIWhhc0xpdmVRdWVyeSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIGNvbnN0IHsgb3JpZ2luYWxPYmplY3QsIHVwZGF0ZWRPYmplY3QgfSA9IHRoaXMuYnVpbGRQYXJzZU9iamVjdHMoKTtcbiAgdXBkYXRlZE9iamVjdC5faGFuZGxlU2F2ZVJlc3BvbnNlKHRoaXMucmVzcG9uc2UucmVzcG9uc2UsIHRoaXMucmVzcG9uc2Uuc3RhdHVzIHx8IDIwMCk7XG5cbiAgaWYgKGhhc0xpdmVRdWVyeSkge1xuICAgIHRoaXMuY29uZmlnLmRhdGFiYXNlLmxvYWRTY2hlbWEoKS50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4ge1xuICAgICAgLy8gTm90aWZ5IExpdmVRdWVyeVNlcnZlciBpZiBwb3NzaWJsZVxuICAgICAgY29uc3QgcGVybXMgPSBzY2hlbWFDb250cm9sbGVyLmdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyh1cGRhdGVkT2JqZWN0LmNsYXNzTmFtZSk7XG4gICAgICB0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyLm9uQWZ0ZXJTYXZlKFxuICAgICAgICB1cGRhdGVkT2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgdXBkYXRlZE9iamVjdCxcbiAgICAgICAgb3JpZ2luYWxPYmplY3QsXG4gICAgICAgIHBlcm1zXG4gICAgICApO1xuICAgIH0pO1xuICB9XG4gIGlmICghaGFzQWZ0ZXJTYXZlSG9vaykge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICAvLyBSdW4gYWZ0ZXJTYXZlIHRyaWdnZXJcbiAgcmV0dXJuIHRyaWdnZXJzXG4gICAgLm1heWJlUnVuVHJpZ2dlcihcbiAgICAgIHRyaWdnZXJzLlR5cGVzLmFmdGVyU2F2ZSxcbiAgICAgIHRoaXMuYXV0aCxcbiAgICAgIHVwZGF0ZWRPYmplY3QsXG4gICAgICBvcmlnaW5hbE9iamVjdCxcbiAgICAgIHRoaXMuY29uZmlnLFxuICAgICAgdGhpcy5jb250ZXh0XG4gICAgKVxuICAgIC50aGVuKHJlc3VsdCA9PiB7XG4gICAgICBjb25zdCBqc29uUmV0dXJuZWQgPSByZXN1bHQgJiYgIXJlc3VsdC5fdG9GdWxsSlNPTjtcbiAgICAgIGlmIChqc29uUmV0dXJuZWQpIHtcbiAgICAgICAgdGhpcy5wZW5kaW5nT3BzLm9wZXJhdGlvbnMgPSB7fTtcbiAgICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZSA9IHJlc3VsdDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2UgPSB0aGlzLl91cGRhdGVSZXNwb25zZVdpdGhEYXRhKFxuICAgICAgICAgIChyZXN1bHQgfHwgdXBkYXRlZE9iamVjdCkudG9KU09OKCksXG4gICAgICAgICAgdGhpcy5kYXRhXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSlcbiAgICAuY2F0Y2goZnVuY3Rpb24gKGVycikge1xuICAgICAgbG9nZ2VyLndhcm4oJ2FmdGVyU2F2ZSBjYXVnaHQgYW4gZXJyb3InLCBlcnIpO1xuICAgIH0pO1xufTtcblxuLy8gQSBoZWxwZXIgdG8gZmlndXJlIG91dCB3aGF0IGxvY2F0aW9uIHRoaXMgb3BlcmF0aW9uIGhhcHBlbnMgYXQuXG5SZXN0V3JpdGUucHJvdG90eXBlLmxvY2F0aW9uID0gZnVuY3Rpb24gKCkge1xuICB2YXIgbWlkZGxlID0gdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgPyAnL3VzZXJzLycgOiAnL2NsYXNzZXMvJyArIHRoaXMuY2xhc3NOYW1lICsgJy8nO1xuICBjb25zdCBtb3VudCA9IHRoaXMuY29uZmlnLm1vdW50IHx8IHRoaXMuY29uZmlnLnNlcnZlclVSTDtcbiAgcmV0dXJuIG1vdW50ICsgbWlkZGxlICsgdGhpcy5kYXRhLm9iamVjdElkO1xufTtcblxuLy8gQSBoZWxwZXIgdG8gZ2V0IHRoZSBvYmplY3QgaWQgZm9yIHRoaXMgb3BlcmF0aW9uLlxuLy8gQmVjYXVzZSBpdCBjb3VsZCBiZSBlaXRoZXIgb24gdGhlIHF1ZXJ5IG9yIG9uIHRoZSBkYXRhXG5SZXN0V3JpdGUucHJvdG90eXBlLm9iamVjdElkID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gdGhpcy5kYXRhLm9iamVjdElkIHx8IHRoaXMucXVlcnkub2JqZWN0SWQ7XG59O1xuXG4vLyBSZXR1cm5zIGEgY29weSBvZiB0aGUgZGF0YSBhbmQgZGVsZXRlIGJhZCBrZXlzIChfYXV0aF9kYXRhLCBfaGFzaGVkX3Bhc3N3b3JkLi4uKVxuUmVzdFdyaXRlLnByb3RvdHlwZS5zYW5pdGl6ZWREYXRhID0gZnVuY3Rpb24gKCkge1xuICBjb25zdCBkYXRhID0gT2JqZWN0LmtleXModGhpcy5kYXRhKS5yZWR1Y2UoKGRhdGEsIGtleSkgPT4ge1xuICAgIC8vIFJlZ2V4cCBjb21lcyBmcm9tIFBhcnNlLk9iamVjdC5wcm90b3R5cGUudmFsaWRhdGVcbiAgICBpZiAoIS9eW0EtWmEtel1bMC05QS1aYS16X10qJC8udGVzdChrZXkpKSB7XG4gICAgICBkZWxldGUgZGF0YVtrZXldO1xuICAgIH1cbiAgICByZXR1cm4gZGF0YTtcbiAgfSwgZGVlcGNvcHkodGhpcy5kYXRhKSk7XG4gIHJldHVybiBQYXJzZS5fZGVjb2RlKHVuZGVmaW5lZCwgZGF0YSk7XG59O1xuXG4vLyBSZXR1cm5zIGFuIHVwZGF0ZWQgY29weSBvZiB0aGUgb2JqZWN0XG5SZXN0V3JpdGUucHJvdG90eXBlLmJ1aWxkUGFyc2VPYmplY3RzID0gZnVuY3Rpb24gKCkge1xuICBjb25zdCBleHRyYURhdGEgPSB7IGNsYXNzTmFtZTogdGhpcy5jbGFzc05hbWUsIG9iamVjdElkOiB0aGlzLnF1ZXJ5Py5vYmplY3RJZCB9O1xuICBsZXQgb3JpZ2luYWxPYmplY3Q7XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBvcmlnaW5hbE9iamVjdCA9IHRyaWdnZXJzLmluZmxhdGUoZXh0cmFEYXRhLCB0aGlzLm9yaWdpbmFsRGF0YSk7XG4gIH1cblxuICBjb25zdCBjbGFzc05hbWUgPSBQYXJzZS5PYmplY3QuZnJvbUpTT04oZXh0cmFEYXRhKTtcbiAgY29uc3QgcmVhZE9ubHlBdHRyaWJ1dGVzID0gY2xhc3NOYW1lLmNvbnN0cnVjdG9yLnJlYWRPbmx5QXR0cmlidXRlc1xuICAgID8gY2xhc3NOYW1lLmNvbnN0cnVjdG9yLnJlYWRPbmx5QXR0cmlidXRlcygpXG4gICAgOiBbXTtcblxuICAvLyBGb3IgX1JvbGUgY2xhc3MsICduYW1lJyBjYW5ub3QgYmUgc2V0IGFmdGVyIHRoZSByb2xlIGhhcyBhbiBvYmplY3RJZC5cbiAgLy8gSW4gYWZ0ZXJTYXZlIGNvbnRleHQsIF9oYW5kbGVTYXZlUmVzcG9uc2UgaGFzIGFscmVhZHkgc2V0IHRoZSBvYmplY3RJZCxcbiAgLy8gc28gd2UgdHJlYXQgJ25hbWUnIGFzIHJlYWQtb25seSB0byBhdm9pZCBQYXJzZSBTREsgdmFsaWRhdGlvbiBlcnJvcnMuXG4gIGNvbnN0IGlzUm9sZUFmdGVyU2F2ZSA9IHRoaXMuY2xhc3NOYW1lID09PSAnX1JvbGUnICYmIHRoaXMucmVzcG9uc2UgJiYgIXRoaXMucXVlcnk7XG4gIGlmIChpc1JvbGVBZnRlclNhdmUgJiYgdGhpcy5kYXRhLm5hbWUgJiYgIXJlYWRPbmx5QXR0cmlidXRlcy5pbmNsdWRlcygnbmFtZScpKSB7XG4gICAgcmVhZE9ubHlBdHRyaWJ1dGVzLnB1c2goJ25hbWUnKTtcbiAgfVxuICBpZiAoIXRoaXMub3JpZ2luYWxEYXRhKSB7XG4gICAgZm9yIChjb25zdCBhdHRyaWJ1dGUgb2YgcmVhZE9ubHlBdHRyaWJ1dGVzKSB7XG4gICAgICBleHRyYURhdGFbYXR0cmlidXRlXSA9IHRoaXMuZGF0YVthdHRyaWJ1dGVdO1xuICAgIH1cbiAgfVxuICBjb25zdCB1cGRhdGVkT2JqZWN0ID0gdHJpZ2dlcnMuaW5mbGF0ZShleHRyYURhdGEsIHRoaXMub3JpZ2luYWxEYXRhKTtcbiAgT2JqZWN0LmtleXModGhpcy5kYXRhKS5yZWR1Y2UoZnVuY3Rpb24gKGRhdGEsIGtleSkge1xuICAgIGlmIChrZXkuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgaWYgKHR5cGVvZiBkYXRhW2tleV0uX19vcCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgaWYgKCFyZWFkT25seUF0dHJpYnV0ZXMuaW5jbHVkZXMoa2V5KSkge1xuICAgICAgICAgIHVwZGF0ZWRPYmplY3Quc2V0KGtleSwgZGF0YVtrZXldKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gc3ViZG9jdW1lbnQga2V5IHdpdGggZG90IG5vdGF0aW9uIHsgJ3gueSc6IHYgfSA9PiB7ICd4JzogeyAneScgOiB2IH0gfSlcbiAgICAgICAgY29uc3Qgc3BsaXR0ZWRLZXkgPSBrZXkuc3BsaXQoJy4nKTtcbiAgICAgICAgY29uc3QgcGFyZW50UHJvcCA9IHNwbGl0dGVkS2V5WzBdO1xuICAgICAgICBsZXQgcGFyZW50VmFsID0gdXBkYXRlZE9iamVjdC5nZXQocGFyZW50UHJvcCk7XG4gICAgICAgIGlmICh0eXBlb2YgcGFyZW50VmFsICE9PSAnb2JqZWN0Jykge1xuICAgICAgICAgIHBhcmVudFZhbCA9IHt9O1xuICAgICAgICB9XG4gICAgICAgIHBhcmVudFZhbFtzcGxpdHRlZEtleVsxXV0gPSBkYXRhW2tleV07XG4gICAgICAgIHVwZGF0ZWRPYmplY3Quc2V0KHBhcmVudFByb3AsIHBhcmVudFZhbCk7XG4gICAgICB9XG4gICAgICBkZWxldGUgZGF0YVtrZXldO1xuICAgIH1cbiAgICByZXR1cm4gZGF0YTtcbiAgfSwgZGVlcGNvcHkodGhpcy5kYXRhKSk7XG5cbiAgY29uc3Qgc2FuaXRpemVkID0gdGhpcy5zYW5pdGl6ZWREYXRhKCk7XG4gIGZvciAoY29uc3QgYXR0cmlidXRlIG9mIHJlYWRPbmx5QXR0cmlidXRlcykge1xuICAgIGRlbGV0ZSBzYW5pdGl6ZWRbYXR0cmlidXRlXTtcbiAgfVxuICB1cGRhdGVkT2JqZWN0LnNldChzYW5pdGl6ZWQpO1xuICByZXR1cm4geyB1cGRhdGVkT2JqZWN0LCBvcmlnaW5hbE9iamVjdCB9O1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5jbGVhblVzZXJBdXRoRGF0YSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSAmJiB0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIGNvbnN0IHVzZXIgPSB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlO1xuICAgIGlmICh1c2VyLmF1dGhEYXRhKSB7XG4gICAgICBPYmplY3Qua2V5cyh1c2VyLmF1dGhEYXRhKS5mb3JFYWNoKHByb3ZpZGVyID0+IHtcbiAgICAgICAgaWYgKHVzZXIuYXV0aERhdGFbcHJvdmlkZXJdID09PSBudWxsKSB7XG4gICAgICAgICAgZGVsZXRlIHVzZXIuYXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIGlmIChPYmplY3Qua2V5cyh1c2VyLmF1dGhEYXRhKS5sZW5ndGggPT0gMCkge1xuICAgICAgICBkZWxldGUgdXNlci5hdXRoRGF0YTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEgPSBmdW5jdGlvbiAocmVzcG9uc2UsIGRhdGEpIHtcbiAgY29uc3Qgc3RhdGVDb250cm9sbGVyID0gUGFyc2UuQ29yZU1hbmFnZXIuZ2V0T2JqZWN0U3RhdGVDb250cm9sbGVyKCk7XG4gIGNvbnN0IFtwZW5kaW5nXSA9IHN0YXRlQ29udHJvbGxlci5nZXRQZW5kaW5nT3BzKHRoaXMucGVuZGluZ09wcy5pZGVudGlmaWVyKTtcbiAgZm9yIChjb25zdCBrZXkgaW4gdGhpcy5wZW5kaW5nT3BzLm9wZXJhdGlvbnMpIHtcbiAgICBpZiAoIXBlbmRpbmdba2V5XSkge1xuICAgICAgZGF0YVtrZXldID0gdGhpcy5vcmlnaW5hbERhdGEgPyB0aGlzLm9yaWdpbmFsRGF0YVtrZXldIDogeyBfX29wOiAnRGVsZXRlJyB9O1xuICAgICAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIucHVzaChrZXkpO1xuICAgIH1cbiAgfVxuICBjb25zdCBza2lwS2V5cyA9IFsuLi4ocmVxdWlyZWRDb2x1bW5zLnJlYWRbdGhpcy5jbGFzc05hbWVdIHx8IFtdKV07XG4gIGlmICghdGhpcy5xdWVyeSkge1xuICAgIHNraXBLZXlzLnB1c2goJ29iamVjdElkJywgJ2NyZWF0ZWRBdCcpO1xuICB9IGVsc2Uge1xuICAgIHNraXBLZXlzLnB1c2goJ3VwZGF0ZWRBdCcpO1xuICAgIGRlbGV0ZSByZXNwb25zZS5vYmplY3RJZDtcbiAgfVxuICBmb3IgKGNvbnN0IGtleSBpbiByZXNwb25zZSkge1xuICAgIGlmIChza2lwS2V5cy5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgdmFsdWUgPSByZXNwb25zZVtrZXldO1xuICAgIGlmIChcbiAgICAgIHZhbHVlID09IG51bGwgfHxcbiAgICAgICh2YWx1ZS5fX3R5cGUgJiYgdmFsdWUuX190eXBlID09PSAnUG9pbnRlcicpIHx8XG4gICAgICB1dGlsLmlzRGVlcFN0cmljdEVxdWFsKGRhdGFba2V5XSwgdmFsdWUpIHx8XG4gICAgICB1dGlsLmlzRGVlcFN0cmljdEVxdWFsKCh0aGlzLm9yaWdpbmFsRGF0YSB8fCB7fSlba2V5XSwgdmFsdWUpXG4gICAgKSB7XG4gICAgICBkZWxldGUgcmVzcG9uc2Vba2V5XTtcbiAgICB9XG4gIH1cbiAgaWYgKF8uaXNFbXB0eSh0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlcikpIHtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH1cbiAgY29uc3QgY2xpZW50U3VwcG9ydHNEZWxldGUgPSBDbGllbnRTREsuc3VwcG9ydHNGb3J3YXJkRGVsZXRlKHRoaXMuY2xpZW50U0RLKTtcbiAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgIGNvbnN0IGRhdGFWYWx1ZSA9IGRhdGFbZmllbGROYW1lXTtcblxuICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlc3BvbnNlLCBmaWVsZE5hbWUpKSB7XG4gICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgIH1cblxuICAgIC8vIFN0cmlwcyBvcGVyYXRpb25zIGZyb20gcmVzcG9uc2VzXG4gICAgaWYgKHJlc3BvbnNlW2ZpZWxkTmFtZV0gJiYgcmVzcG9uc2VbZmllbGROYW1lXS5fX29wKSB7XG4gICAgICBkZWxldGUgcmVzcG9uc2VbZmllbGROYW1lXTtcbiAgICAgIGlmIChjbGllbnRTdXBwb3J0c0RlbGV0ZSAmJiBkYXRhVmFsdWUuX19vcCA9PSAnRGVsZXRlJykge1xuICAgICAgICByZXNwb25zZVtmaWVsZE5hbWVdID0gZGF0YVZhbHVlO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG4gIHJldHVybiByZXNwb25zZTtcbn07XG5cbmV4cG9ydCBkZWZhdWx0IFJlc3RXcml0ZTtcbm1vZHVsZS5leHBvcnRzID0gUmVzdFdyaXRlO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFlQSxJQUFBQSxVQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBQyxPQUFBLEdBQUFGLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRSxPQUFBLEdBQUFILHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRyxpQkFBQSxHQUFBSCxPQUFBO0FB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