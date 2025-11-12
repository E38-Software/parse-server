"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.UsersRouter = void 0;
var _node = _interopRequireDefault(require("parse/node"));
var _Config = _interopRequireDefault(require("../Config"));
var _AccountLockout = _interopRequireDefault(require("../AccountLockout"));
var _ClassesRouter = _interopRequireDefault(require("./ClassesRouter"));
var _rest = _interopRequireDefault(require("../rest"));
var _Auth = _interopRequireDefault(require("../Auth"));
var _password = _interopRequireDefault(require("../password"));
var _triggers = require("../triggers");
var _middlewares = require("../middlewares");
var _RestWrite = _interopRequireDefault(require("../RestWrite"));
var _logger = require("../logger");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// These methods handle the User-related routes.

class UsersRouter extends _ClassesRouter.default {
  className() {
    return '_User';
  }

  /**
   * Removes all "_" prefixed properties from an object, except "__type"
   * @param {Object} obj An object.
   */
  static removeHiddenProperties(obj) {
    for (var key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        // Regexp comes from Parse.Object.prototype.validate
        if (key !== '__type' && !/^[A-Za-z][0-9A-Za-z_]*$/.test(key)) {
          delete obj[key];
        }
      }
    }
  }

  /**
   * After retrieving a user directly from the database, we need to remove the
   * password from the object (for security), and fix an issue some SDKs have
   * with null values
   */
  _sanitizeAuthData(user) {
    delete user.password;

    // Sometimes the authData still has null on that keys
    // https://github.com/parse-community/parse-server/issues/935
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

  /**
   * Validates a password request in login and verifyPassword
   * @param {Object} req The request
   * @returns {Object} User object
   * @private
   */
  _authenticateUserFromRequest(req) {
    return new Promise((resolve, reject) => {
      // Use query parameters instead if provided in url
      let payload = req.body || {};
      if (!payload.username && req.query && req.query.username || !payload.email && req.query && req.query.email) {
        payload = req.query;
      }
      const {
        username,
        email,
        password,
        ignoreEmailVerification
      } = payload;

      // TODO: use the right error codes / descriptions.
      if (!username && !email) {
        throw new _node.default.Error(_node.default.Error.USERNAME_MISSING, 'username/email is required.');
      }
      if (!password) {
        throw new _node.default.Error(_node.default.Error.PASSWORD_MISSING, 'password is required.');
      }
      if (typeof password !== 'string' || email && typeof email !== 'string' || username && typeof username !== 'string') {
        throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Invalid username/password.');
      }
      let user;
      let isValidPassword = false;
      let query;
      if (email && username) {
        query = {
          email,
          username
        };
      } else if (email) {
        query = {
          email
        };
      } else {
        query = {
          $or: [{
            username
          }, {
            email: username
          }]
        };
      }
      return req.config.database.find('_User', query, {}, _Auth.default.maintenance(req.config)).then(results => {
        if (!results.length) {
          throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Invalid username/password.');
        }
        if (results.length > 1) {
          // corner case where user1 has username == user2 email
          req.config.loggerController.warn("There is a user which email is the same as another user's username, logging in based on username");
          user = results.filter(user => user.username === username)[0];
        } else {
          user = results[0];
        }
        return _password.default.compare(password, user.password);
      }).then(correct => {
        isValidPassword = correct;
        const accountLockoutPolicy = new _AccountLockout.default(user, req.config);
        return accountLockoutPolicy.handleLoginAttempt(isValidPassword);
      }).then(async () => {
        if (!isValidPassword) {
          throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Invalid username/password.');
        }
        // Ensure the user isn't locked out
        // A locked out user won't be able to login
        // To lock a user out, just set the ACL to `masterKey` only  ({}).
        // Empty ACL is OK
        if (!req.auth.isMaster && user.ACL && Object.keys(user.ACL).length == 0) {
          throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Invalid username/password.');
        }
        // Create request object for verification functions
        const request = {
          master: req.auth.isMaster,
          ip: req.config.ip,
          installationId: req.auth.installationId,
          object: _node.default.User.fromJSON(Object.assign({
            className: '_User'
          }, user))
        };

        // If request doesn't use master or maintenance key with ignoring email verification
        if (!((req.auth.isMaster || req.auth.isMaintenance) && ignoreEmailVerification)) {
          // Get verification conditions which can be booleans or functions; the purpose of this async/await
          // structure is to avoid unnecessarily executing subsequent functions if previous ones fail in the
          // conditional statement below, as a developer may decide to execute expensive operations in them
          const verifyUserEmails = async () => req.config.verifyUserEmails === true || typeof req.config.verifyUserEmails === 'function' && (await Promise.resolve(req.config.verifyUserEmails(request))) === true;
          const preventLoginWithUnverifiedEmail = async () => req.config.preventLoginWithUnverifiedEmail === true || typeof req.config.preventLoginWithUnverifiedEmail === 'function' && (await Promise.resolve(req.config.preventLoginWithUnverifiedEmail(request))) === true;
          if ((await verifyUserEmails()) && (await preventLoginWithUnverifiedEmail()) && !user.emailVerified) {
            throw new _node.default.Error(_node.default.Error.EMAIL_NOT_FOUND, 'User email is not verified.');
          }
        }
        this._sanitizeAuthData(user);
        return resolve(user);
      }).catch(error => {
        return reject(error);
      });
    });
  }
  handleMe(req) {
    if (!req.info || !req.info.sessionToken) {
      throw new _node.default.Error(_node.default.Error.INVALID_SESSION_TOKEN, 'Invalid session token');
    }
    const sessionToken = req.info.sessionToken;
    return _rest.default.find(req.config, _Auth.default.master(req.config), '_Session', {
      sessionToken
    }, {
      include: 'user'
    }, req.info.clientSDK, req.info.context).then(response => {
      if (!response.results || response.results.length == 0 || !response.results[0].user) {
        throw new _node.default.Error(_node.default.Error.INVALID_SESSION_TOKEN, 'Invalid session token');
      } else {
        const user = response.results[0].user;
        // Send token back on the login, because SDKs expect that.
        user.sessionToken = sessionToken;

        // Remove hidden properties.
        UsersRouter.removeHiddenProperties(user);
        return {
          response: user
        };
      }
    });
  }
  async handleLogIn(req) {
    const user = await this._authenticateUserFromRequest(req);
    const authData = req.body && req.body.authData;
    // Check if user has provided their required auth providers
    _Auth.default.checkIfUserHasProvidedConfiguredProvidersForLogin(req, authData, user.authData, req.config);
    let authDataResponse;
    let validatedAuthData;
    if (authData) {
      const res = await _Auth.default.handleAuthDataValidation(authData, new _RestWrite.default(req.config, req.auth, '_User', {
        objectId: user.objectId
      }, req.body || {}, user, req.info.clientSDK, req.info.context), user);
      authDataResponse = res.authDataResponse;
      validatedAuthData = res.authData;
    }

    // handle password expiry policy
    if (req.config.passwordPolicy && req.config.passwordPolicy.maxPasswordAge) {
      let changedAt = user._password_changed_at;
      if (!changedAt) {
        // password was created before expiry policy was enabled.
        // simply update _User object so that it will start enforcing from now
        changedAt = new Date();
        req.config.database.update('_User', {
          username: user.username
        }, {
          _password_changed_at: _node.default._encode(changedAt)
        });
      } else {
        // check whether the password has expired
        if (changedAt.__type == 'Date') {
          changedAt = new Date(changedAt.iso);
        }
        // Calculate the expiry time.
        const expiresAt = new Date(changedAt.getTime() + 86400000 * req.config.passwordPolicy.maxPasswordAge);
        if (expiresAt < new Date())
          // fail of current time is past password expiry time
          {
            throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Your password has expired. Please reset your password.');
          }
      }
    }

    // Remove hidden properties.
    UsersRouter.removeHiddenProperties(user);
    await req.config.filesController.expandFilesInObject(req.config, user);

    // Before login trigger; throws if failure
    await (0, _triggers.maybeRunTrigger)(_triggers.Types.beforeLogin, req.auth, _node.default.User.fromJSON(Object.assign({
      className: '_User'
    }, user)), null, req.config, req.info.context);

    // If we have some new validated authData update directly
    if (validatedAuthData && Object.keys(validatedAuthData).length) {
      await req.config.database.update('_User', {
        objectId: user.objectId
      }, {
        authData: validatedAuthData
      }, {});
    }
    const {
      sessionData,
      createSession
    } = _RestWrite.default.createSession(req.config, {
      userId: user.objectId,
      createdWith: {
        action: 'login',
        authProvider: 'password'
      },
      installationId: req.info.installationId
    });
    user.sessionToken = sessionData.sessionToken;
    await createSession();
    const afterLoginUser = _node.default.User.fromJSON(Object.assign({
      className: '_User'
    }, user));
    await (0, _triggers.maybeRunTrigger)(_triggers.Types.afterLogin, {
      ...req.auth,
      user: afterLoginUser
    }, afterLoginUser, null, req.config, req.info.context);
    if (authDataResponse) {
      user.authDataResponse = authDataResponse;
    }
    await req.config.authDataManager.runAfterFind(req, user.authData);
    return {
      response: user
    };
  }

  /**
   * This allows master-key clients to create user sessions without access to
   * user credentials. This enables systems that can authenticate access another
   * way (API key, app administrators) to act on a user's behalf.
   *
   * We create a new session rather than looking for an existing session; we
   * want this to work in situations where the user is logged out on all
   * devices, since this can be used by automated systems acting on the user's
   * behalf.
   *
   * For the moment, we're omitting event hooks and lockout checks, since
   * immediate use cases suggest /loginAs could be used for semantically
   * different reasons from /login
   */
  async handleLogInAs(req) {
    if (!req.auth.isMaster) {
      throw new _node.default.Error(_node.default.Error.OPERATION_FORBIDDEN, 'master key is required');
    }
    const userId = req.body?.userId || req.query.userId;
    if (!userId) {
      throw new _node.default.Error(_node.default.Error.INVALID_VALUE, 'userId must not be empty, null, or undefined');
    }
    const queryResults = await req.config.database.find('_User', {
      objectId: userId
    });
    const user = queryResults[0];
    if (!user) {
      throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'user not found');
    }
    this._sanitizeAuthData(user);
    const {
      sessionData,
      createSession
    } = _RestWrite.default.createSession(req.config, {
      userId,
      createdWith: {
        action: 'login',
        authProvider: 'masterkey'
      },
      installationId: req.info.installationId
    });
    user.sessionToken = sessionData.sessionToken;
    await createSession();
    return {
      response: user
    };
  }
  handleVerifyPassword(req) {
    return this._authenticateUserFromRequest(req).then(user => {
      // Remove hidden properties.
      UsersRouter.removeHiddenProperties(user);
      return {
        response: user
      };
    }).catch(error => {
      throw error;
    });
  }
  async handleLogOut(req) {
    const success = {
      response: {}
    };
    if (req.info && req.info.sessionToken) {
      const records = await _rest.default.find(req.config, _Auth.default.master(req.config), '_Session', {
        sessionToken: req.info.sessionToken
      }, undefined, req.info.clientSDK, req.info.context);
      if (records.results && records.results.length) {
        await _rest.default.del(req.config, _Auth.default.master(req.config), '_Session', records.results[0].objectId, req.info.context);
        await (0, _triggers.maybeRunTrigger)(_triggers.Types.afterLogout, req.auth, _node.default.Session.fromJSON(Object.assign({
          className: '_Session'
        }, records.results[0])), null, req.config);
      }
    }
    return success;
  }
  _throwOnBadEmailConfig(req) {
    try {
      _Config.default.validateEmailConfiguration({
        emailAdapter: req.config.userController.adapter,
        appName: req.config.appName,
        publicServerURL: req.config.publicServerURL || req.config._publicServerURL,
        emailVerifyTokenValidityDuration: req.config.emailVerifyTokenValidityDuration,
        emailVerifyTokenReuseIfValid: req.config.emailVerifyTokenReuseIfValid
      });
    } catch (e) {
      if (typeof e === 'string') {
        // Maybe we need a Bad Configuration error, but the SDKs won't understand it. For now, Internal Server Error.
        throw new _node.default.Error(_node.default.Error.INTERNAL_SERVER_ERROR, 'An appName, publicServerURL, and emailAdapter are required for password reset and email verification functionality.');
      } else {
        throw e;
      }
    }
  }
  async handleResetRequest(req) {
    this._throwOnBadEmailConfig(req);
    let email = req.body?.email;
    const token = req.body?.token;
    if (!email && !token) {
      throw new _node.default.Error(_node.default.Error.EMAIL_MISSING, 'you must provide an email');
    }
    if (token) {
      const results = await req.config.database.find('_User', {
        _perishable_token: token,
        _perishable_token_expires_at: {
          $lt: _node.default._encode(new Date())
        }
      });
      if (results && results[0] && results[0].email) {
        email = results[0].email;
      }
    }
    if (typeof email !== 'string') {
      throw new _node.default.Error(_node.default.Error.INVALID_EMAIL_ADDRESS, 'you must provide a valid email string');
    }
    const userController = req.config.userController;
    try {
      await userController.sendPasswordResetEmail(email);
      return {
        response: {}
      };
    } catch (err) {
      if (err.code === _node.default.Error.OBJECT_NOT_FOUND) {
        if (req.config.passwordPolicy?.resetPasswordSuccessOnInvalidEmail ?? true) {
          return {
            response: {}
          };
        }
        err.message = `A user with that email does not exist.`;
      }
      throw err;
    }
  }
  async handleVerificationEmailRequest(req) {
    this._throwOnBadEmailConfig(req);
    const {
      email
    } = req.body || {};
    if (!email) {
      throw new _node.default.Error(_node.default.Error.EMAIL_MISSING, 'you must provide an email');
    }
    if (typeof email !== 'string') {
      throw new _node.default.Error(_node.default.Error.INVALID_EMAIL_ADDRESS, 'you must provide a valid email string');
    }
    const results = await req.config.database.find('_User', {
      email: email
    }, {}, _Auth.default.maintenance(req.config));
    if (!results.length || results.length < 1) {
      throw new _node.default.Error(_node.default.Error.EMAIL_NOT_FOUND, `No user found with email ${email}`);
    }
    const user = results[0];

    // remove password field, messes with saving on postgres
    delete user.password;
    if (user.emailVerified) {
      throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, `Email ${email} is already verified.`);
    }
    const userController = req.config.userController;
    const send = await userController.regenerateEmailVerifyToken(user, req.auth.isMaster, req.auth.installationId, req.ip);
    if (send) {
      userController.sendVerificationEmail(user, req);
    }
    return {
      response: {}
    };
  }
  async handleChallenge(req) {
    const {
      username,
      email,
      password,
      authData,
      challengeData
    } = req.body || {};

    // if username or email provided with password try to authenticate the user by username
    let user;
    if (username || email) {
      if (!password) {
        throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, 'You provided username or email, you need to also provide password.');
      }
      user = await this._authenticateUserFromRequest(req);
    }
    if (!challengeData) {
      throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, 'Nothing to challenge.');
    }
    if (typeof challengeData !== 'object') {
      throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, 'challengeData should be an object.');
    }
    let request;
    let parseUser;

    // Try to find user by authData
    if (authData) {
      if (typeof authData !== 'object') {
        throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, 'authData should be an object.');
      }
      if (user) {
        throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, 'You cannot provide username/email and authData, only use one identification method.');
      }
      if (Object.keys(authData).filter(key => authData[key].id).length > 1) {
        throw new _node.default.Error(_node.default.Error.OTHER_CAUSE, 'You cannot provide more than one authData provider with an id.');
      }
      const results = await _Auth.default.findUsersWithAuthData(req.config, authData);
      try {
        if (!results[0] || results.length > 1) {
          throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'User not found.');
        }
        // Find the provider used to find the user
        const provider = Object.keys(authData).find(key => authData[key].id);
        parseUser = _node.default.User.fromJSON({
          className: '_User',
          ...results[0]
        });
        request = (0, _triggers.getRequestObject)(undefined, req.auth, parseUser, parseUser, req.config);
        request.isChallenge = true;
        // Validate authData used to identify the user to avoid brute-force attack on `id`
        const {
          validator
        } = req.config.authDataManager.getValidatorForProvider(provider);
        const validatorResponse = await validator(authData[provider], req, parseUser, request);
        if (validatorResponse && validatorResponse.validator) {
          await validatorResponse.validator();
        }
      } catch (e) {
        // Rewrite the error to avoid guess id attack
        _logger.logger.error(e);
        throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'User not found.');
      }
    }
    if (!parseUser) {
      parseUser = user ? _node.default.User.fromJSON({
        className: '_User',
        ...user
      }) : undefined;
    }
    if (!request) {
      request = (0, _triggers.getRequestObject)(undefined, req.auth, parseUser, parseUser, req.config);
      request.isChallenge = true;
    }
    const acc = {};
    // Execute challenge step-by-step with consistent order for better error feedback
    // and to avoid to trigger others challenges if one of them fails
    for (const provider of Object.keys(challengeData).sort()) {
      try {
        const authAdapter = req.config.authDataManager.getValidatorForProvider(provider);
        if (!authAdapter) {
          continue;
        }
        const {
          adapter: {
            challenge
          }
        } = authAdapter;
        if (typeof challenge === 'function') {
          const providerChallengeResponse = await challenge(challengeData[provider], authData && authData[provider], req.config.auth[provider], request);
          acc[provider] = providerChallengeResponse || true;
        }
      } catch (err) {
        const e = (0, _triggers.resolveError)(err, {
          code: _node.default.Error.SCRIPT_FAILED,
          message: 'Challenge failed. Unknown error.'
        });
        const userString = req.auth && req.auth.user ? req.auth.user.id : undefined;
        _logger.logger.error(`Failed running auth step challenge for ${provider} for user ${userString} with Error: ` + JSON.stringify(e), {
          authenticationStep: 'challenge',
          error: e,
          user: userString,
          provider
        });
        throw e;
      }
    }
    return {
      response: {
        challengeData: acc
      }
    };
  }
  mountRoutes() {
    this.route('GET', '/users', req => {
      return this.handleFind(req);
    });
    this.route('POST', '/users', _middlewares.promiseEnsureIdempotency, req => {
      return this.handleCreate(req);
    });
    this.route('GET', '/users/me', req => {
      return this.handleMe(req);
    });
    this.route('GET', '/users/:objectId', req => {
      return this.handleGet(req);
    });
    this.route('PUT', '/users/:objectId', _middlewares.promiseEnsureIdempotency, req => {
      return this.handleUpdate(req);
    });
    this.route('DELETE', '/users/:objectId', req => {
      return this.handleDelete(req);
    });
    this.route('GET', '/login', req => {
      return this.handleLogIn(req);
    });
    this.route('POST', '/login', req => {
      return this.handleLogIn(req);
    });
    this.route('POST', '/loginAs', req => {
      return this.handleLogInAs(req);
    });
    this.route('POST', '/logout', req => {
      return this.handleLogOut(req);
    });
    this.route('POST', '/requestPasswordReset', req => {
      return this.handleResetRequest(req);
    });
    this.route('POST', '/verificationEmailRequest', req => {
      return this.handleVerificationEmailRequest(req);
    });
    this.route('GET', '/verifyPassword', req => {
      return this.handleVerifyPassword(req);
    });
    this.route('POST', '/verifyPassword', req => {
      return this.handleVerifyPassword(req);
    });
    this.route('POST', '/challenge', req => {
      return this.handleChallenge(req);
    });
  }
}
exports.UsersRouter = UsersRouter;
var _default = exports.default = UsersRouter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbm9kZSIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX0NvbmZpZyIsIl9BY2NvdW50TG9ja291dCIsIl9DbGFzc2VzUm91dGVyIiwiX3Jlc3QiLCJfQXV0aCIsIl9wYXNzd29yZCIsIl90cmlnZ2VycyIsIl9taWRkbGV3YXJlcyIsIl9SZXN0V3JpdGUiLCJfbG9nZ2VyIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiVXNlcnNSb3V0ZXIiLCJDbGFzc2VzUm91dGVyIiwiY2xhc3NOYW1lIiwicmVtb3ZlSGlkZGVuUHJvcGVydGllcyIsIm9iaiIsImtleSIsIk9iamVjdCIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsInRlc3QiLCJfc2FuaXRpemVBdXRoRGF0YSIsInVzZXIiLCJwYXNzd29yZCIsImF1dGhEYXRhIiwia2V5cyIsImZvckVhY2giLCJwcm92aWRlciIsImxlbmd0aCIsIl9hdXRoZW50aWNhdGVVc2VyRnJvbVJlcXVlc3QiLCJyZXEiLCJQcm9taXNlIiwicmVzb2x2ZSIsInJlamVjdCIsInBheWxvYWQiLCJib2R5IiwidXNlcm5hbWUiLCJxdWVyeSIsImVtYWlsIiwiaWdub3JlRW1haWxWZXJpZmljYXRpb24iLCJQYXJzZSIsIkVycm9yIiwiVVNFUk5BTUVfTUlTU0lORyIsIlBBU1NXT1JEX01JU1NJTkciLCJPQkpFQ1RfTk9UX0ZPVU5EIiwiaXNWYWxpZFBhc3N3b3JkIiwiJG9yIiwiY29uZmlnIiwiZGF0YWJhc2UiLCJmaW5kIiwiQXV0aCIsIm1haW50ZW5hbmNlIiwidGhlbiIsInJlc3VsdHMiLCJsb2dnZXJDb250cm9sbGVyIiwid2FybiIsImZpbHRlciIsInBhc3N3b3JkQ3J5cHRvIiwiY29tcGFyZSIsImNvcnJlY3QiLCJhY2NvdW50TG9ja291dFBvbGljeSIsIkFjY291bnRMb2Nrb3V0IiwiaGFuZGxlTG9naW5BdHRlbXB0IiwiYXV0aCIsImlzTWFzdGVyIiwiQUNMIiwicmVxdWVzdCIsIm1hc3RlciIsImlwIiwiaW5zdGFsbGF0aW9uSWQiLCJvYmplY3QiLCJVc2VyIiwiZnJvbUpTT04iLCJhc3NpZ24iLCJpc01haW50ZW5hbmNlIiwidmVyaWZ5VXNlckVtYWlscyIsInByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwiLCJlbWFpbFZlcmlmaWVkIiwiRU1BSUxfTk9UX0ZPVU5EIiwiY2F0Y2giLCJlcnJvciIsImhhbmRsZU1lIiwiaW5mbyIsInNlc3Npb25Ub2tlbiIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsInJlc3QiLCJpbmNsdWRlIiwiY2xpZW50U0RLIiwiY29udGV4dCIsInJlc3BvbnNlIiwiaGFuZGxlTG9nSW4iLCJjaGVja0lmVXNlckhhc1Byb3ZpZGVkQ29uZmlndXJlZFByb3ZpZGVyc0ZvckxvZ2luIiwiYXV0aERhdGFSZXNwb25zZSIsInZhbGlkYXRlZEF1dGhEYXRhIiwicmVzIiwiaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uIiwiUmVzdFdyaXRlIiwib2JqZWN0SWQiLCJwYXNzd29yZFBvbGljeSIsIm1heFBhc3N3b3JkQWdlIiwiY2hhbmdlZEF0IiwiX3Bhc3N3b3JkX2NoYW5nZWRfYXQiLCJEYXRlIiwidXBkYXRlIiwiX2VuY29kZSIsIl9fdHlwZSIsImlzbyIsImV4cGlyZXNBdCIsImdldFRpbWUiLCJmaWxlc0NvbnRyb2xsZXIiLCJleHBhbmRGaWxlc0luT2JqZWN0IiwibWF5YmVSdW5UcmlnZ2VyIiwiVHJpZ2dlclR5cGVzIiwiYmVmb3JlTG9naW4iLCJzZXNzaW9uRGF0YSIsImNyZWF0ZVNlc3Npb24iLCJ1c2VySWQiLCJjcmVhdGVkV2l0aCIsImFjdGlvbiIsImF1dGhQcm92aWRlciIsImFmdGVyTG9naW5Vc2VyIiwiYWZ0ZXJMb2dpbiIsImF1dGhEYXRhTWFuYWdlciIsInJ1bkFmdGVyRmluZCIsImhhbmRsZUxvZ0luQXMiLCJPUEVSQVRJT05fRk9SQklEREVOIiwiSU5WQUxJRF9WQUxVRSIsInF1ZXJ5UmVzdWx0cyIsImhhbmRsZVZlcmlmeVBhc3N3b3JkIiwiaGFuZGxlTG9nT3V0Iiwic3VjY2VzcyIsInJlY29yZHMiLCJ1bmRlZmluZWQiLCJkZWwiLCJhZnRlckxvZ291dCIsIlNlc3Npb24iLCJfdGhyb3dPbkJhZEVtYWlsQ29uZmlnIiwiQ29uZmlnIiwidmFsaWRhdGVFbWFpbENvbmZpZ3VyYXRpb24iLCJlbWFpbEFkYXB0ZXIiLCJ1c2VyQ29udHJvbGxlciIsImFkYXB0ZXIiLCJhcHBOYW1lIiwicHVibGljU2VydmVyVVJMIiwiX3B1YmxpY1NlcnZlclVSTCIsImVtYWlsVmVyaWZ5VG9rZW5WYWxpZGl0eUR1cmF0aW9uIiwiZW1haWxWZXJpZnlUb2tlblJldXNlSWZWYWxpZCIsIklOVEVSTkFMX1NFUlZFUl9FUlJPUiIsImhhbmRsZVJlc2V0UmVxdWVzdCIsInRva2VuIiwiRU1BSUxfTUlTU0lORyIsIl9wZXJpc2hhYmxlX3Rva2VuIiwiX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCIsIiRsdCIsIklOVkFMSURfRU1BSUxfQUREUkVTUyIsInNlbmRQYXNzd29yZFJlc2V0RW1haWwiLCJlcnIiLCJjb2RlIiwicmVzZXRQYXNzd29yZFN1Y2Nlc3NPbkludmFsaWRFbWFpbCIsIm1lc3NhZ2UiLCJoYW5kbGVWZXJpZmljYXRpb25FbWFpbFJlcXVlc3QiLCJPVEhFUl9DQVVTRSIsInNlbmQiLCJyZWdlbmVyYXRlRW1haWxWZXJpZnlUb2tlbiIsInNlbmRWZXJpZmljYXRpb25FbWFpbCIsImhhbmRsZUNoYWxsZW5nZSIsImNoYWxsZW5nZURhdGEiLCJwYXJzZVVzZXIiLCJpZCIsImZpbmRVc2Vyc1dpdGhBdXRoRGF0YSIsImdldFJlcXVlc3RPYmplY3QiLCJpc0NoYWxsZW5nZSIsInZhbGlkYXRvciIsImdldFZhbGlkYXRvckZvclByb3ZpZGVyIiwidmFsaWRhdG9yUmVzcG9uc2UiLCJsb2dnZXIiLCJhY2MiLCJzb3J0IiwiYXV0aEFkYXB0ZXIiLCJjaGFsbGVuZ2UiLCJwcm92aWRlckNoYWxsZW5nZVJlc3BvbnNlIiwicmVzb2x2ZUVycm9yIiwiU0NSSVBUX0ZBSUxFRCIsInVzZXJTdHJpbmciLCJKU09OIiwic3RyaW5naWZ5IiwiYXV0aGVudGljYXRpb25TdGVwIiwibW91bnRSb3V0ZXMiLCJyb3V0ZSIsImhhbmRsZUZpbmQiLCJwcm9taXNlRW5zdXJlSWRlbXBvdGVuY3kiLCJoYW5kbGVDcmVhdGUiLCJoYW5kbGVHZXQiLCJoYW5kbGVVcGRhdGUiLCJoYW5kbGVEZWxldGUiLCJleHBvcnRzIiwiX2RlZmF1bHQiXSwic291cmNlcyI6WyIuLi8uLi9zcmMvUm91dGVycy9Vc2Vyc1JvdXRlci5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBUaGVzZSBtZXRob2RzIGhhbmRsZSB0aGUgVXNlci1yZWxhdGVkIHJvdXRlcy5cblxuaW1wb3J0IFBhcnNlIGZyb20gJ3BhcnNlL25vZGUnO1xuaW1wb3J0IENvbmZpZyBmcm9tICcuLi9Db25maWcnO1xuaW1wb3J0IEFjY291bnRMb2Nrb3V0IGZyb20gJy4uL0FjY291bnRMb2Nrb3V0JztcbmltcG9ydCBDbGFzc2VzUm91dGVyIGZyb20gJy4vQ2xhc3Nlc1JvdXRlcic7XG5pbXBvcnQgcmVzdCBmcm9tICcuLi9yZXN0JztcbmltcG9ydCBBdXRoIGZyb20gJy4uL0F1dGgnO1xuaW1wb3J0IHBhc3N3b3JkQ3J5cHRvIGZyb20gJy4uL3Bhc3N3b3JkJztcbmltcG9ydCB7XG4gIG1heWJlUnVuVHJpZ2dlcixcbiAgVHlwZXMgYXMgVHJpZ2dlclR5cGVzLFxuICBnZXRSZXF1ZXN0T2JqZWN0LFxuICByZXNvbHZlRXJyb3IsXG59IGZyb20gJy4uL3RyaWdnZXJzJztcbmltcG9ydCB7IHByb21pc2VFbnN1cmVJZGVtcG90ZW5jeSB9IGZyb20gJy4uL21pZGRsZXdhcmVzJztcbmltcG9ydCBSZXN0V3JpdGUgZnJvbSAnLi4vUmVzdFdyaXRlJztcbmltcG9ydCB7IGxvZ2dlciB9IGZyb20gJy4uL2xvZ2dlcic7XG5cbmV4cG9ydCBjbGFzcyBVc2Vyc1JvdXRlciBleHRlbmRzIENsYXNzZXNSb3V0ZXIge1xuICBjbGFzc05hbWUoKSB7XG4gICAgcmV0dXJuICdfVXNlcic7XG4gIH1cblxuICAvKipcbiAgICogUmVtb3ZlcyBhbGwgXCJfXCIgcHJlZml4ZWQgcHJvcGVydGllcyBmcm9tIGFuIG9iamVjdCwgZXhjZXB0IFwiX190eXBlXCJcbiAgICogQHBhcmFtIHtPYmplY3R9IG9iaiBBbiBvYmplY3QuXG4gICAqL1xuICBzdGF0aWMgcmVtb3ZlSGlkZGVuUHJvcGVydGllcyhvYmopIHtcbiAgICBmb3IgKHZhciBrZXkgaW4gb2JqKSB7XG4gICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG9iaiwga2V5KSkge1xuICAgICAgICAvLyBSZWdleHAgY29tZXMgZnJvbSBQYXJzZS5PYmplY3QucHJvdG90eXBlLnZhbGlkYXRlXG4gICAgICAgIGlmIChrZXkgIT09ICdfX3R5cGUnICYmICEvXltBLVphLXpdWzAtOUEtWmEtel9dKiQvLnRlc3Qoa2V5KSkge1xuICAgICAgICAgIGRlbGV0ZSBvYmpba2V5XTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBBZnRlciByZXRyaWV2aW5nIGEgdXNlciBkaXJlY3RseSBmcm9tIHRoZSBkYXRhYmFzZSwgd2UgbmVlZCB0byByZW1vdmUgdGhlXG4gICAqIHBhc3N3b3JkIGZyb20gdGhlIG9iamVjdCAoZm9yIHNlY3VyaXR5KSwgYW5kIGZpeCBhbiBpc3N1ZSBzb21lIFNES3MgaGF2ZVxuICAgKiB3aXRoIG51bGwgdmFsdWVzXG4gICAqL1xuICBfc2FuaXRpemVBdXRoRGF0YSh1c2VyKSB7XG4gICAgZGVsZXRlIHVzZXIucGFzc3dvcmQ7XG5cbiAgICAvLyBTb21ldGltZXMgdGhlIGF1dGhEYXRhIHN0aWxsIGhhcyBudWxsIG9uIHRoYXQga2V5c1xuICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9wYXJzZS1jb21tdW5pdHkvcGFyc2Utc2VydmVyL2lzc3Vlcy85MzVcbiAgICBpZiAodXNlci5hdXRoRGF0YSkge1xuICAgICAgT2JqZWN0LmtleXModXNlci5hdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICAgIGlmICh1c2VyLmF1dGhEYXRhW3Byb3ZpZGVyXSA9PT0gbnVsbCkge1xuICAgICAgICAgIGRlbGV0ZSB1c2VyLmF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBpZiAoT2JqZWN0LmtleXModXNlci5hdXRoRGF0YSkubGVuZ3RoID09IDApIHtcbiAgICAgICAgZGVsZXRlIHVzZXIuYXV0aERhdGE7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFZhbGlkYXRlcyBhIHBhc3N3b3JkIHJlcXVlc3QgaW4gbG9naW4gYW5kIHZlcmlmeVBhc3N3b3JkXG4gICAqIEBwYXJhbSB7T2JqZWN0fSByZXEgVGhlIHJlcXVlc3RcbiAgICogQHJldHVybnMge09iamVjdH0gVXNlciBvYmplY3RcbiAgICogQHByaXZhdGVcbiAgICovXG4gIF9hdXRoZW50aWNhdGVVc2VyRnJvbVJlcXVlc3QocmVxKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIC8vIFVzZSBxdWVyeSBwYXJhbWV0ZXJzIGluc3RlYWQgaWYgcHJvdmlkZWQgaW4gdXJsXG4gICAgICBsZXQgcGF5bG9hZCA9IHJlcS5ib2R5IHx8IHt9O1xuICAgICAgaWYgKFxuICAgICAgICAoIXBheWxvYWQudXNlcm5hbWUgJiYgcmVxLnF1ZXJ5ICYmIHJlcS5xdWVyeS51c2VybmFtZSkgfHxcbiAgICAgICAgKCFwYXlsb2FkLmVtYWlsICYmIHJlcS5xdWVyeSAmJiByZXEucXVlcnkuZW1haWwpXG4gICAgICApIHtcbiAgICAgICAgcGF5bG9hZCA9IHJlcS5xdWVyeTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHsgdXNlcm5hbWUsIGVtYWlsLCBwYXNzd29yZCwgaWdub3JlRW1haWxWZXJpZmljYXRpb24gfSA9IHBheWxvYWQ7XG5cbiAgICAgIC8vIFRPRE86IHVzZSB0aGUgcmlnaHQgZXJyb3IgY29kZXMgLyBkZXNjcmlwdGlvbnMuXG4gICAgICBpZiAoIXVzZXJuYW1lICYmICFlbWFpbCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuVVNFUk5BTUVfTUlTU0lORywgJ3VzZXJuYW1lL2VtYWlsIGlzIHJlcXVpcmVkLicpO1xuICAgICAgfVxuICAgICAgaWYgKCFwYXNzd29yZCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuUEFTU1dPUkRfTUlTU0lORywgJ3Bhc3N3b3JkIGlzIHJlcXVpcmVkLicpO1xuICAgICAgfVxuICAgICAgaWYgKFxuICAgICAgICB0eXBlb2YgcGFzc3dvcmQgIT09ICdzdHJpbmcnIHx8XG4gICAgICAgIChlbWFpbCAmJiB0eXBlb2YgZW1haWwgIT09ICdzdHJpbmcnKSB8fFxuICAgICAgICAodXNlcm5hbWUgJiYgdHlwZW9mIHVzZXJuYW1lICE9PSAnc3RyaW5nJylcbiAgICAgICkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ0ludmFsaWQgdXNlcm5hbWUvcGFzc3dvcmQuJyk7XG4gICAgICB9XG5cbiAgICAgIGxldCB1c2VyO1xuICAgICAgbGV0IGlzVmFsaWRQYXNzd29yZCA9IGZhbHNlO1xuICAgICAgbGV0IHF1ZXJ5O1xuICAgICAgaWYgKGVtYWlsICYmIHVzZXJuYW1lKSB7XG4gICAgICAgIHF1ZXJ5ID0geyBlbWFpbCwgdXNlcm5hbWUgfTtcbiAgICAgIH0gZWxzZSBpZiAoZW1haWwpIHtcbiAgICAgICAgcXVlcnkgPSB7IGVtYWlsIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBxdWVyeSA9IHsgJG9yOiBbeyB1c2VybmFtZSB9LCB7IGVtYWlsOiB1c2VybmFtZSB9XSB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlcS5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgLmZpbmQoJ19Vc2VyJywgcXVlcnksIHt9LCBBdXRoLm1haW50ZW5hbmNlKHJlcS5jb25maWcpKVxuICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICBpZiAoIXJlc3VsdHMubGVuZ3RoKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ0ludmFsaWQgdXNlcm5hbWUvcGFzc3dvcmQuJyk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgLy8gY29ybmVyIGNhc2Ugd2hlcmUgdXNlcjEgaGFzIHVzZXJuYW1lID09IHVzZXIyIGVtYWlsXG4gICAgICAgICAgICByZXEuY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIud2FybihcbiAgICAgICAgICAgICAgXCJUaGVyZSBpcyBhIHVzZXIgd2hpY2ggZW1haWwgaXMgdGhlIHNhbWUgYXMgYW5vdGhlciB1c2VyJ3MgdXNlcm5hbWUsIGxvZ2dpbmcgaW4gYmFzZWQgb24gdXNlcm5hbWVcIlxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHVzZXIgPSByZXN1bHRzLmZpbHRlcih1c2VyID0+IHVzZXIudXNlcm5hbWUgPT09IHVzZXJuYW1lKVswXTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdXNlciA9IHJlc3VsdHNbMF07XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIHBhc3N3b3JkQ3J5cHRvLmNvbXBhcmUocGFzc3dvcmQsIHVzZXIucGFzc3dvcmQpO1xuICAgICAgICB9KVxuICAgICAgICAudGhlbihjb3JyZWN0ID0+IHtcbiAgICAgICAgICBpc1ZhbGlkUGFzc3dvcmQgPSBjb3JyZWN0O1xuICAgICAgICAgIGNvbnN0IGFjY291bnRMb2Nrb3V0UG9saWN5ID0gbmV3IEFjY291bnRMb2Nrb3V0KHVzZXIsIHJlcS5jb25maWcpO1xuICAgICAgICAgIHJldHVybiBhY2NvdW50TG9ja291dFBvbGljeS5oYW5kbGVMb2dpbkF0dGVtcHQoaXNWYWxpZFBhc3N3b3JkKTtcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIGlmICghaXNWYWxpZFBhc3N3b3JkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ0ludmFsaWQgdXNlcm5hbWUvcGFzc3dvcmQuJyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIEVuc3VyZSB0aGUgdXNlciBpc24ndCBsb2NrZWQgb3V0XG4gICAgICAgICAgLy8gQSBsb2NrZWQgb3V0IHVzZXIgd29uJ3QgYmUgYWJsZSB0byBsb2dpblxuICAgICAgICAgIC8vIFRvIGxvY2sgYSB1c2VyIG91dCwganVzdCBzZXQgdGhlIEFDTCB0byBgbWFzdGVyS2V5YCBvbmx5ICAoe30pLlxuICAgICAgICAgIC8vIEVtcHR5IEFDTCBpcyBPS1xuICAgICAgICAgIGlmICghcmVxLmF1dGguaXNNYXN0ZXIgJiYgdXNlci5BQ0wgJiYgT2JqZWN0LmtleXModXNlci5BQ0wpLmxlbmd0aCA9PSAwKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ0ludmFsaWQgdXNlcm5hbWUvcGFzc3dvcmQuJyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIENyZWF0ZSByZXF1ZXN0IG9iamVjdCBmb3IgdmVyaWZpY2F0aW9uIGZ1bmN0aW9uc1xuICAgICAgICAgIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgICAgICAgICBtYXN0ZXI6IHJlcS5hdXRoLmlzTWFzdGVyLFxuICAgICAgICAgICAgaXA6IHJlcS5jb25maWcuaXAsXG4gICAgICAgICAgICBpbnN0YWxsYXRpb25JZDogcmVxLmF1dGguaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgICAgICBvYmplY3Q6IFBhcnNlLlVzZXIuZnJvbUpTT04oT2JqZWN0LmFzc2lnbih7IGNsYXNzTmFtZTogJ19Vc2VyJyB9LCB1c2VyKSksXG4gICAgICAgICAgfTtcblxuICAgICAgICAgIC8vIElmIHJlcXVlc3QgZG9lc24ndCB1c2UgbWFzdGVyIG9yIG1haW50ZW5hbmNlIGtleSB3aXRoIGlnbm9yaW5nIGVtYWlsIHZlcmlmaWNhdGlvblxuICAgICAgICAgIGlmICghKChyZXEuYXV0aC5pc01hc3RlciB8fCByZXEuYXV0aC5pc01haW50ZW5hbmNlKSAmJiBpZ25vcmVFbWFpbFZlcmlmaWNhdGlvbikpIHtcblxuICAgICAgICAgICAgLy8gR2V0IHZlcmlmaWNhdGlvbiBjb25kaXRpb25zIHdoaWNoIGNhbiBiZSBib29sZWFucyBvciBmdW5jdGlvbnM7IHRoZSBwdXJwb3NlIG9mIHRoaXMgYXN5bmMvYXdhaXRcbiAgICAgICAgICAgIC8vIHN0cnVjdHVyZSBpcyB0byBhdm9pZCB1bm5lY2Vzc2FyaWx5IGV4ZWN1dGluZyBzdWJzZXF1ZW50IGZ1bmN0aW9ucyBpZiBwcmV2aW91cyBvbmVzIGZhaWwgaW4gdGhlXG4gICAgICAgICAgICAvLyBjb25kaXRpb25hbCBzdGF0ZW1lbnQgYmVsb3csIGFzIGEgZGV2ZWxvcGVyIG1heSBkZWNpZGUgdG8gZXhlY3V0ZSBleHBlbnNpdmUgb3BlcmF0aW9ucyBpbiB0aGVtXG4gICAgICAgICAgICBjb25zdCB2ZXJpZnlVc2VyRW1haWxzID0gYXN5bmMgKCkgPT4gcmVxLmNvbmZpZy52ZXJpZnlVc2VyRW1haWxzID09PSB0cnVlIHx8ICh0eXBlb2YgcmVxLmNvbmZpZy52ZXJpZnlVc2VyRW1haWxzID09PSAnZnVuY3Rpb24nICYmIGF3YWl0IFByb21pc2UucmVzb2x2ZShyZXEuY29uZmlnLnZlcmlmeVVzZXJFbWFpbHMocmVxdWVzdCkpID09PSB0cnVlKTtcbiAgICAgICAgICAgIGNvbnN0IHByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgPSBhc3luYyAoKSA9PiByZXEuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgPT09IHRydWUgfHwgKHR5cGVvZiByZXEuY29uZmlnLnByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwgPT09ICdmdW5jdGlvbicgJiYgYXdhaXQgUHJvbWlzZS5yZXNvbHZlKHJlcS5jb25maWcucHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbChyZXF1ZXN0KSkgPT09IHRydWUpO1xuICAgICAgICAgICAgaWYgKGF3YWl0IHZlcmlmeVVzZXJFbWFpbHMoKSAmJiBhd2FpdCBwcmV2ZW50TG9naW5XaXRoVW52ZXJpZmllZEVtYWlsKCkgJiYgIXVzZXIuZW1haWxWZXJpZmllZCkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRU1BSUxfTk9UX0ZPVU5ELCAnVXNlciBlbWFpbCBpcyBub3QgdmVyaWZpZWQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgdGhpcy5fc2FuaXRpemVBdXRoRGF0YSh1c2VyKTtcblxuICAgICAgICAgIHJldHVybiByZXNvbHZlKHVzZXIpO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgIHJldHVybiByZWplY3QoZXJyb3IpO1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIGhhbmRsZU1lKHJlcSkge1xuICAgIGlmICghcmVxLmluZm8gfHwgIXJlcS5pbmZvLnNlc3Npb25Ub2tlbikge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfU0VTU0lPTl9UT0tFTiwgJ0ludmFsaWQgc2Vzc2lvbiB0b2tlbicpO1xuICAgIH1cbiAgICBjb25zdCBzZXNzaW9uVG9rZW4gPSByZXEuaW5mby5zZXNzaW9uVG9rZW47XG4gICAgcmV0dXJuIHJlc3RcbiAgICAgIC5maW5kKFxuICAgICAgICByZXEuY29uZmlnLFxuICAgICAgICBBdXRoLm1hc3RlcihyZXEuY29uZmlnKSxcbiAgICAgICAgJ19TZXNzaW9uJyxcbiAgICAgICAgeyBzZXNzaW9uVG9rZW4gfSxcbiAgICAgICAgeyBpbmNsdWRlOiAndXNlcicgfSxcbiAgICAgICAgcmVxLmluZm8uY2xpZW50U0RLLFxuICAgICAgICByZXEuaW5mby5jb250ZXh0XG4gICAgICApXG4gICAgICAudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgIGlmICghcmVzcG9uc2UucmVzdWx0cyB8fCByZXNwb25zZS5yZXN1bHRzLmxlbmd0aCA9PSAwIHx8ICFyZXNwb25zZS5yZXN1bHRzWzBdLnVzZXIpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLCAnSW52YWxpZCBzZXNzaW9uIHRva2VuJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3QgdXNlciA9IHJlc3BvbnNlLnJlc3VsdHNbMF0udXNlcjtcbiAgICAgICAgICAvLyBTZW5kIHRva2VuIGJhY2sgb24gdGhlIGxvZ2luLCBiZWNhdXNlIFNES3MgZXhwZWN0IHRoYXQuXG4gICAgICAgICAgdXNlci5zZXNzaW9uVG9rZW4gPSBzZXNzaW9uVG9rZW47XG5cbiAgICAgICAgICAvLyBSZW1vdmUgaGlkZGVuIHByb3BlcnRpZXMuXG4gICAgICAgICAgVXNlcnNSb3V0ZXIucmVtb3ZlSGlkZGVuUHJvcGVydGllcyh1c2VyKTtcbiAgICAgICAgICByZXR1cm4geyByZXNwb25zZTogdXNlciB9O1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGhhbmRsZUxvZ0luKHJlcSkge1xuICAgIGNvbnN0IHVzZXIgPSBhd2FpdCB0aGlzLl9hdXRoZW50aWNhdGVVc2VyRnJvbVJlcXVlc3QocmVxKTtcbiAgICBjb25zdCBhdXRoRGF0YSA9IHJlcS5ib2R5ICYmIHJlcS5ib2R5LmF1dGhEYXRhO1xuICAgIC8vIENoZWNrIGlmIHVzZXIgaGFzIHByb3ZpZGVkIHRoZWlyIHJlcXVpcmVkIGF1dGggcHJvdmlkZXJzXG4gICAgQXV0aC5jaGVja0lmVXNlckhhc1Byb3ZpZGVkQ29uZmlndXJlZFByb3ZpZGVyc0ZvckxvZ2luKFxuICAgICAgcmVxLFxuICAgICAgYXV0aERhdGEsXG4gICAgICB1c2VyLmF1dGhEYXRhLFxuICAgICAgcmVxLmNvbmZpZ1xuICAgICk7XG5cbiAgICBsZXQgYXV0aERhdGFSZXNwb25zZTtcbiAgICBsZXQgdmFsaWRhdGVkQXV0aERhdGE7XG4gICAgaWYgKGF1dGhEYXRhKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBBdXRoLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbihcbiAgICAgICAgYXV0aERhdGEsXG4gICAgICAgIG5ldyBSZXN0V3JpdGUoXG4gICAgICAgICAgcmVxLmNvbmZpZyxcbiAgICAgICAgICByZXEuYXV0aCxcbiAgICAgICAgICAnX1VzZXInLFxuICAgICAgICAgIHsgb2JqZWN0SWQ6IHVzZXIub2JqZWN0SWQgfSxcbiAgICAgICAgICByZXEuYm9keSB8fCB7fSxcbiAgICAgICAgICB1c2VyLFxuICAgICAgICAgIHJlcS5pbmZvLmNsaWVudFNESyxcbiAgICAgICAgICByZXEuaW5mby5jb250ZXh0XG4gICAgICAgICksXG4gICAgICAgIHVzZXJcbiAgICAgICk7XG4gICAgICBhdXRoRGF0YVJlc3BvbnNlID0gcmVzLmF1dGhEYXRhUmVzcG9uc2U7XG4gICAgICB2YWxpZGF0ZWRBdXRoRGF0YSA9IHJlcy5hdXRoRGF0YTtcbiAgICB9XG5cbiAgICAvLyBoYW5kbGUgcGFzc3dvcmQgZXhwaXJ5IHBvbGljeVxuICAgIGlmIChyZXEuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmIHJlcS5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2UpIHtcbiAgICAgIGxldCBjaGFuZ2VkQXQgPSB1c2VyLl9wYXNzd29yZF9jaGFuZ2VkX2F0O1xuXG4gICAgICBpZiAoIWNoYW5nZWRBdCkge1xuICAgICAgICAvLyBwYXNzd29yZCB3YXMgY3JlYXRlZCBiZWZvcmUgZXhwaXJ5IHBvbGljeSB3YXMgZW5hYmxlZC5cbiAgICAgICAgLy8gc2ltcGx5IHVwZGF0ZSBfVXNlciBvYmplY3Qgc28gdGhhdCBpdCB3aWxsIHN0YXJ0IGVuZm9yY2luZyBmcm9tIG5vd1xuICAgICAgICBjaGFuZ2VkQXQgPSBuZXcgRGF0ZSgpO1xuICAgICAgICByZXEuY29uZmlnLmRhdGFiYXNlLnVwZGF0ZShcbiAgICAgICAgICAnX1VzZXInLFxuICAgICAgICAgIHsgdXNlcm5hbWU6IHVzZXIudXNlcm5hbWUgfSxcbiAgICAgICAgICB7IF9wYXNzd29yZF9jaGFuZ2VkX2F0OiBQYXJzZS5fZW5jb2RlKGNoYW5nZWRBdCkgfVxuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gY2hlY2sgd2hldGhlciB0aGUgcGFzc3dvcmQgaGFzIGV4cGlyZWRcbiAgICAgICAgaWYgKGNoYW5nZWRBdC5fX3R5cGUgPT0gJ0RhdGUnKSB7XG4gICAgICAgICAgY2hhbmdlZEF0ID0gbmV3IERhdGUoY2hhbmdlZEF0Lmlzbyk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gQ2FsY3VsYXRlIHRoZSBleHBpcnkgdGltZS5cbiAgICAgICAgY29uc3QgZXhwaXJlc0F0ID0gbmV3IERhdGUoXG4gICAgICAgICAgY2hhbmdlZEF0LmdldFRpbWUoKSArIDg2NDAwMDAwICogcmVxLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEFnZVxuICAgICAgICApO1xuICAgICAgICBpZiAoZXhwaXJlc0F0IDwgbmV3IERhdGUoKSlcbiAgICAgICAgLy8gZmFpbCBvZiBjdXJyZW50IHRpbWUgaXMgcGFzdCBwYXNzd29yZCBleHBpcnkgdGltZVxuICAgICAgICB7IHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELFxuICAgICAgICAgICdZb3VyIHBhc3N3b3JkIGhhcyBleHBpcmVkLiBQbGVhc2UgcmVzZXQgeW91ciBwYXNzd29yZC4nXG4gICAgICAgICk7IH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSZW1vdmUgaGlkZGVuIHByb3BlcnRpZXMuXG4gICAgVXNlcnNSb3V0ZXIucmVtb3ZlSGlkZGVuUHJvcGVydGllcyh1c2VyKTtcblxuICAgIGF3YWl0IHJlcS5jb25maWcuZmlsZXNDb250cm9sbGVyLmV4cGFuZEZpbGVzSW5PYmplY3QocmVxLmNvbmZpZywgdXNlcik7XG5cbiAgICAvLyBCZWZvcmUgbG9naW4gdHJpZ2dlcjsgdGhyb3dzIGlmIGZhaWx1cmVcbiAgICBhd2FpdCBtYXliZVJ1blRyaWdnZXIoXG4gICAgICBUcmlnZ2VyVHlwZXMuYmVmb3JlTG9naW4sXG4gICAgICByZXEuYXV0aCxcbiAgICAgIFBhcnNlLlVzZXIuZnJvbUpTT04oT2JqZWN0LmFzc2lnbih7IGNsYXNzTmFtZTogJ19Vc2VyJyB9LCB1c2VyKSksXG4gICAgICBudWxsLFxuICAgICAgcmVxLmNvbmZpZyxcbiAgICAgIHJlcS5pbmZvLmNvbnRleHRcbiAgICApO1xuXG4gICAgLy8gSWYgd2UgaGF2ZSBzb21lIG5ldyB2YWxpZGF0ZWQgYXV0aERhdGEgdXBkYXRlIGRpcmVjdGx5XG4gICAgaWYgKHZhbGlkYXRlZEF1dGhEYXRhICYmIE9iamVjdC5rZXlzKHZhbGlkYXRlZEF1dGhEYXRhKS5sZW5ndGgpIHtcbiAgICAgIGF3YWl0IHJlcS5jb25maWcuZGF0YWJhc2UudXBkYXRlKFxuICAgICAgICAnX1VzZXInLFxuICAgICAgICB7IG9iamVjdElkOiB1c2VyLm9iamVjdElkIH0sXG4gICAgICAgIHsgYXV0aERhdGE6IHZhbGlkYXRlZEF1dGhEYXRhIH0sXG4gICAgICAgIHt9XG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHsgc2Vzc2lvbkRhdGEsIGNyZWF0ZVNlc3Npb24gfSA9IFJlc3RXcml0ZS5jcmVhdGVTZXNzaW9uKHJlcS5jb25maWcsIHtcbiAgICAgIHVzZXJJZDogdXNlci5vYmplY3RJZCxcbiAgICAgIGNyZWF0ZWRXaXRoOiB7XG4gICAgICAgIGFjdGlvbjogJ2xvZ2luJyxcbiAgICAgICAgYXV0aFByb3ZpZGVyOiAncGFzc3dvcmQnLFxuICAgICAgfSxcbiAgICAgIGluc3RhbGxhdGlvbklkOiByZXEuaW5mby5pbnN0YWxsYXRpb25JZCxcbiAgICB9KTtcblxuICAgIHVzZXIuc2Vzc2lvblRva2VuID0gc2Vzc2lvbkRhdGEuc2Vzc2lvblRva2VuO1xuXG4gICAgYXdhaXQgY3JlYXRlU2Vzc2lvbigpO1xuXG4gICAgY29uc3QgYWZ0ZXJMb2dpblVzZXIgPSBQYXJzZS5Vc2VyLmZyb21KU09OKE9iamVjdC5hc3NpZ24oeyBjbGFzc05hbWU6ICdfVXNlcicgfSwgdXNlcikpO1xuICAgIGF3YWl0IG1heWJlUnVuVHJpZ2dlcihcbiAgICAgIFRyaWdnZXJUeXBlcy5hZnRlckxvZ2luLFxuICAgICAgeyAuLi5yZXEuYXV0aCwgdXNlcjogYWZ0ZXJMb2dpblVzZXIgfSxcbiAgICAgIGFmdGVyTG9naW5Vc2VyLFxuICAgICAgbnVsbCxcbiAgICAgIHJlcS5jb25maWcsXG4gICAgICByZXEuaW5mby5jb250ZXh0XG4gICAgKTtcblxuICAgIGlmIChhdXRoRGF0YVJlc3BvbnNlKSB7XG4gICAgICB1c2VyLmF1dGhEYXRhUmVzcG9uc2UgPSBhdXRoRGF0YVJlc3BvbnNlO1xuICAgIH1cbiAgICBhd2FpdCByZXEuY29uZmlnLmF1dGhEYXRhTWFuYWdlci5ydW5BZnRlckZpbmQocmVxLCB1c2VyLmF1dGhEYXRhKTtcblxuICAgIHJldHVybiB7IHJlc3BvbnNlOiB1c2VyIH07XG4gIH1cblxuICAvKipcbiAgICogVGhpcyBhbGxvd3MgbWFzdGVyLWtleSBjbGllbnRzIHRvIGNyZWF0ZSB1c2VyIHNlc3Npb25zIHdpdGhvdXQgYWNjZXNzIHRvXG4gICAqIHVzZXIgY3JlZGVudGlhbHMuIFRoaXMgZW5hYmxlcyBzeXN0ZW1zIHRoYXQgY2FuIGF1dGhlbnRpY2F0ZSBhY2Nlc3MgYW5vdGhlclxuICAgKiB3YXkgKEFQSSBrZXksIGFwcCBhZG1pbmlzdHJhdG9ycykgdG8gYWN0IG9uIGEgdXNlcidzIGJlaGFsZi5cbiAgICpcbiAgICogV2UgY3JlYXRlIGEgbmV3IHNlc3Npb24gcmF0aGVyIHRoYW4gbG9va2luZyBmb3IgYW4gZXhpc3Rpbmcgc2Vzc2lvbjsgd2VcbiAgICogd2FudCB0aGlzIHRvIHdvcmsgaW4gc2l0dWF0aW9ucyB3aGVyZSB0aGUgdXNlciBpcyBsb2dnZWQgb3V0IG9uIGFsbFxuICAgKiBkZXZpY2VzLCBzaW5jZSB0aGlzIGNhbiBiZSB1c2VkIGJ5IGF1dG9tYXRlZCBzeXN0ZW1zIGFjdGluZyBvbiB0aGUgdXNlcidzXG4gICAqIGJlaGFsZi5cbiAgICpcbiAgICogRm9yIHRoZSBtb21lbnQsIHdlJ3JlIG9taXR0aW5nIGV2ZW50IGhvb2tzIGFuZCBsb2Nrb3V0IGNoZWNrcywgc2luY2VcbiAgICogaW1tZWRpYXRlIHVzZSBjYXNlcyBzdWdnZXN0IC9sb2dpbkFzIGNvdWxkIGJlIHVzZWQgZm9yIHNlbWFudGljYWxseVxuICAgKiBkaWZmZXJlbnQgcmVhc29ucyBmcm9tIC9sb2dpblxuICAgKi9cbiAgYXN5bmMgaGFuZGxlTG9nSW5BcyhyZXEpIHtcbiAgICBpZiAoIXJlcS5hdXRoLmlzTWFzdGVyKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTiwgJ21hc3RlciBrZXkgaXMgcmVxdWlyZWQnKTtcbiAgICB9XG5cbiAgICBjb25zdCB1c2VySWQgPSByZXEuYm9keT8udXNlcklkIHx8IHJlcS5xdWVyeS51c2VySWQ7XG4gICAgaWYgKCF1c2VySWQpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9WQUxVRSxcbiAgICAgICAgJ3VzZXJJZCBtdXN0IG5vdCBiZSBlbXB0eSwgbnVsbCwgb3IgdW5kZWZpbmVkJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBxdWVyeVJlc3VsdHMgPSBhd2FpdCByZXEuY29uZmlnLmRhdGFiYXNlLmZpbmQoJ19Vc2VyJywgeyBvYmplY3RJZDogdXNlcklkIH0pO1xuICAgIGNvbnN0IHVzZXIgPSBxdWVyeVJlc3VsdHNbMF07XG4gICAgaWYgKCF1c2VyKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ3VzZXIgbm90IGZvdW5kJyk7XG4gICAgfVxuXG4gICAgdGhpcy5fc2FuaXRpemVBdXRoRGF0YSh1c2VyKTtcblxuICAgIGNvbnN0IHsgc2Vzc2lvbkRhdGEsIGNyZWF0ZVNlc3Npb24gfSA9IFJlc3RXcml0ZS5jcmVhdGVTZXNzaW9uKHJlcS5jb25maWcsIHtcbiAgICAgIHVzZXJJZCxcbiAgICAgIGNyZWF0ZWRXaXRoOiB7XG4gICAgICAgIGFjdGlvbjogJ2xvZ2luJyxcbiAgICAgICAgYXV0aFByb3ZpZGVyOiAnbWFzdGVya2V5JyxcbiAgICAgIH0sXG4gICAgICBpbnN0YWxsYXRpb25JZDogcmVxLmluZm8uaW5zdGFsbGF0aW9uSWQsXG4gICAgfSk7XG5cbiAgICB1c2VyLnNlc3Npb25Ub2tlbiA9IHNlc3Npb25EYXRhLnNlc3Npb25Ub2tlbjtcblxuICAgIGF3YWl0IGNyZWF0ZVNlc3Npb24oKTtcblxuICAgIHJldHVybiB7IHJlc3BvbnNlOiB1c2VyIH07XG4gIH1cblxuICBoYW5kbGVWZXJpZnlQYXNzd29yZChyZXEpIHtcbiAgICByZXR1cm4gdGhpcy5fYXV0aGVudGljYXRlVXNlckZyb21SZXF1ZXN0KHJlcSlcbiAgICAgIC50aGVuKHVzZXIgPT4ge1xuICAgICAgICAvLyBSZW1vdmUgaGlkZGVuIHByb3BlcnRpZXMuXG4gICAgICAgIFVzZXJzUm91dGVyLnJlbW92ZUhpZGRlblByb3BlcnRpZXModXNlcik7XG5cbiAgICAgICAgcmV0dXJuIHsgcmVzcG9uc2U6IHVzZXIgfTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgaGFuZGxlTG9nT3V0KHJlcSkge1xuICAgIGNvbnN0IHN1Y2Nlc3MgPSB7IHJlc3BvbnNlOiB7fSB9O1xuICAgIGlmIChyZXEuaW5mbyAmJiByZXEuaW5mby5zZXNzaW9uVG9rZW4pIHtcbiAgICAgIGNvbnN0IHJlY29yZHMgPSBhd2FpdCByZXN0LmZpbmQoXG4gICAgICAgIHJlcS5jb25maWcsXG4gICAgICAgIEF1dGgubWFzdGVyKHJlcS5jb25maWcpLFxuICAgICAgICAnX1Nlc3Npb24nLFxuICAgICAgICB7IHNlc3Npb25Ub2tlbjogcmVxLmluZm8uc2Vzc2lvblRva2VuIH0sXG4gICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgcmVxLmluZm8uY2xpZW50U0RLLFxuICAgICAgICByZXEuaW5mby5jb250ZXh0XG4gICAgICApO1xuICAgICAgaWYgKHJlY29yZHMucmVzdWx0cyAmJiByZWNvcmRzLnJlc3VsdHMubGVuZ3RoKSB7XG4gICAgICAgIGF3YWl0IHJlc3QuZGVsKFxuICAgICAgICAgIHJlcS5jb25maWcsXG4gICAgICAgICAgQXV0aC5tYXN0ZXIocmVxLmNvbmZpZyksXG4gICAgICAgICAgJ19TZXNzaW9uJyxcbiAgICAgICAgICByZWNvcmRzLnJlc3VsdHNbMF0ub2JqZWN0SWQsXG4gICAgICAgICAgcmVxLmluZm8uY29udGV4dFxuICAgICAgICApO1xuICAgICAgICBhd2FpdCBtYXliZVJ1blRyaWdnZXIoXG4gICAgICAgICAgVHJpZ2dlclR5cGVzLmFmdGVyTG9nb3V0LFxuICAgICAgICAgIHJlcS5hdXRoLFxuICAgICAgICAgIFBhcnNlLlNlc3Npb24uZnJvbUpTT04oT2JqZWN0LmFzc2lnbih7IGNsYXNzTmFtZTogJ19TZXNzaW9uJyB9LCByZWNvcmRzLnJlc3VsdHNbMF0pKSxcbiAgICAgICAgICBudWxsLFxuICAgICAgICAgIHJlcS5jb25maWdcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHN1Y2Nlc3M7XG4gIH1cblxuICBfdGhyb3dPbkJhZEVtYWlsQ29uZmlnKHJlcSkge1xuICAgIHRyeSB7XG4gICAgICBDb25maWcudmFsaWRhdGVFbWFpbENvbmZpZ3VyYXRpb24oe1xuICAgICAgICBlbWFpbEFkYXB0ZXI6IHJlcS5jb25maWcudXNlckNvbnRyb2xsZXIuYWRhcHRlcixcbiAgICAgICAgYXBwTmFtZTogcmVxLmNvbmZpZy5hcHBOYW1lLFxuICAgICAgICBwdWJsaWNTZXJ2ZXJVUkw6IHJlcS5jb25maWcucHVibGljU2VydmVyVVJMIHx8IHJlcS5jb25maWcuX3B1YmxpY1NlcnZlclVSTCxcbiAgICAgICAgZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb246IHJlcS5jb25maWcuZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24sXG4gICAgICAgIGVtYWlsVmVyaWZ5VG9rZW5SZXVzZUlmVmFsaWQ6IHJlcS5jb25maWcuZW1haWxWZXJpZnlUb2tlblJldXNlSWZWYWxpZCxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmICh0eXBlb2YgZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgLy8gTWF5YmUgd2UgbmVlZCBhIEJhZCBDb25maWd1cmF0aW9uIGVycm9yLCBidXQgdGhlIFNES3Mgd29uJ3QgdW5kZXJzdGFuZCBpdC4gRm9yIG5vdywgSW50ZXJuYWwgU2VydmVyIEVycm9yLlxuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLFxuICAgICAgICAgICdBbiBhcHBOYW1lLCBwdWJsaWNTZXJ2ZXJVUkwsIGFuZCBlbWFpbEFkYXB0ZXIgYXJlIHJlcXVpcmVkIGZvciBwYXNzd29yZCByZXNldCBhbmQgZW1haWwgdmVyaWZpY2F0aW9uIGZ1bmN0aW9uYWxpdHkuJ1xuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBhc3luYyBoYW5kbGVSZXNldFJlcXVlc3QocmVxKSB7XG4gICAgdGhpcy5fdGhyb3dPbkJhZEVtYWlsQ29uZmlnKHJlcSk7XG5cbiAgICBsZXQgZW1haWwgPSByZXEuYm9keT8uZW1haWw7XG4gICAgY29uc3QgdG9rZW4gPSByZXEuYm9keT8udG9rZW47XG5cbiAgICBpZiAoIWVtYWlsICYmICF0b2tlbikge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkVNQUlMX01JU1NJTkcsICd5b3UgbXVzdCBwcm92aWRlIGFuIGVtYWlsJyk7XG4gICAgfVxuICAgIGlmICh0b2tlbikge1xuICAgICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IHJlcS5jb25maWcuZGF0YWJhc2UuZmluZCgnX1VzZXInLCB7XG4gICAgICAgIF9wZXJpc2hhYmxlX3Rva2VuOiB0b2tlbixcbiAgICAgICAgX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdDogeyAkbHQ6IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSkgfSxcbiAgICAgIH0pO1xuICAgICAgaWYgKHJlc3VsdHMgJiYgcmVzdWx0c1swXSAmJiByZXN1bHRzWzBdLmVtYWlsKSB7XG4gICAgICAgIGVtYWlsID0gcmVzdWx0c1swXS5lbWFpbDtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHR5cGVvZiBlbWFpbCAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9FTUFJTF9BRERSRVNTLFxuICAgICAgICAneW91IG11c3QgcHJvdmlkZSBhIHZhbGlkIGVtYWlsIHN0cmluZydcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHVzZXJDb250cm9sbGVyID0gcmVxLmNvbmZpZy51c2VyQ29udHJvbGxlcjtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgdXNlckNvbnRyb2xsZXIuc2VuZFBhc3N3b3JkUmVzZXRFbWFpbChlbWFpbCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICByZXNwb25zZToge30sXG4gICAgICB9O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgaWYgKGVyci5jb2RlID09PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgIGlmIChyZXEuY29uZmlnLnBhc3N3b3JkUG9saWN5Py5yZXNldFBhc3N3b3JkU3VjY2Vzc09uSW52YWxpZEVtYWlsID8/IHRydWUpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgcmVzcG9uc2U6IHt9LFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgZXJyLm1lc3NhZ2UgPSBgQSB1c2VyIHdpdGggdGhhdCBlbWFpbCBkb2VzIG5vdCBleGlzdC5gO1xuICAgICAgfVxuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIGhhbmRsZVZlcmlmaWNhdGlvbkVtYWlsUmVxdWVzdChyZXEpIHtcbiAgICB0aGlzLl90aHJvd09uQmFkRW1haWxDb25maWcocmVxKTtcblxuICAgIGNvbnN0IHsgZW1haWwgfSA9IHJlcS5ib2R5IHx8IHt9O1xuICAgIGlmICghZW1haWwpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5FTUFJTF9NSVNTSU5HLCAneW91IG11c3QgcHJvdmlkZSBhbiBlbWFpbCcpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGVtYWlsICE9PSAnc3RyaW5nJykge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0VNQUlMX0FERFJFU1MsXG4gICAgICAgICd5b3UgbXVzdCBwcm92aWRlIGEgdmFsaWQgZW1haWwgc3RyaW5nJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXN1bHRzID0gYXdhaXQgcmVxLmNvbmZpZy5kYXRhYmFzZS5maW5kKCdfVXNlcicsIHsgZW1haWw6IGVtYWlsIH0sIHt9LCBBdXRoLm1haW50ZW5hbmNlKHJlcS5jb25maWcpKTtcbiAgICBpZiAoIXJlc3VsdHMubGVuZ3RoIHx8IHJlc3VsdHMubGVuZ3RoIDwgMSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkVNQUlMX05PVF9GT1VORCwgYE5vIHVzZXIgZm91bmQgd2l0aCBlbWFpbCAke2VtYWlsfWApO1xuICAgIH1cbiAgICBjb25zdCB1c2VyID0gcmVzdWx0c1swXTtcblxuICAgIC8vIHJlbW92ZSBwYXNzd29yZCBmaWVsZCwgbWVzc2VzIHdpdGggc2F2aW5nIG9uIHBvc3RncmVzXG4gICAgZGVsZXRlIHVzZXIucGFzc3dvcmQ7XG5cbiAgICBpZiAodXNlci5lbWFpbFZlcmlmaWVkKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1RIRVJfQ0FVU0UsIGBFbWFpbCAke2VtYWlsfSBpcyBhbHJlYWR5IHZlcmlmaWVkLmApO1xuICAgIH1cblxuICAgIGNvbnN0IHVzZXJDb250cm9sbGVyID0gcmVxLmNvbmZpZy51c2VyQ29udHJvbGxlcjtcbiAgICBjb25zdCBzZW5kID0gYXdhaXQgdXNlckNvbnRyb2xsZXIucmVnZW5lcmF0ZUVtYWlsVmVyaWZ5VG9rZW4odXNlciwgcmVxLmF1dGguaXNNYXN0ZXIsIHJlcS5hdXRoLmluc3RhbGxhdGlvbklkLCByZXEuaXApO1xuICAgIGlmIChzZW5kKSB7XG4gICAgICB1c2VyQ29udHJvbGxlci5zZW5kVmVyaWZpY2F0aW9uRW1haWwodXNlciwgcmVxKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgcmVzcG9uc2U6IHt9IH07XG4gIH1cblxuICBhc3luYyBoYW5kbGVDaGFsbGVuZ2UocmVxKSB7XG4gICAgY29uc3QgeyB1c2VybmFtZSwgZW1haWwsIHBhc3N3b3JkLCBhdXRoRGF0YSwgY2hhbGxlbmdlRGF0YSB9ID0gcmVxLmJvZHkgfHwge307XG5cbiAgICAvLyBpZiB1c2VybmFtZSBvciBlbWFpbCBwcm92aWRlZCB3aXRoIHBhc3N3b3JkIHRyeSB0byBhdXRoZW50aWNhdGUgdGhlIHVzZXIgYnkgdXNlcm5hbWVcbiAgICBsZXQgdXNlcjtcbiAgICBpZiAodXNlcm5hbWUgfHwgZW1haWwpIHtcbiAgICAgIGlmICghcGFzc3dvcmQpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLk9USEVSX0NBVVNFLFxuICAgICAgICAgICdZb3UgcHJvdmlkZWQgdXNlcm5hbWUgb3IgZW1haWwsIHlvdSBuZWVkIHRvIGFsc28gcHJvdmlkZSBwYXNzd29yZC4nXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICB1c2VyID0gYXdhaXQgdGhpcy5fYXV0aGVudGljYXRlVXNlckZyb21SZXF1ZXN0KHJlcSk7XG4gICAgfVxuXG4gICAgaWYgKCFjaGFsbGVuZ2VEYXRhKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1RIRVJfQ0FVU0UsICdOb3RoaW5nIHRvIGNoYWxsZW5nZS4nKTtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIGNoYWxsZW5nZURhdGEgIT09ICdvYmplY3QnKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1RIRVJfQ0FVU0UsICdjaGFsbGVuZ2VEYXRhIHNob3VsZCBiZSBhbiBvYmplY3QuJyk7XG4gICAgfVxuXG4gICAgbGV0IHJlcXVlc3Q7XG4gICAgbGV0IHBhcnNlVXNlcjtcblxuICAgIC8vIFRyeSB0byBmaW5kIHVzZXIgYnkgYXV0aERhdGFcbiAgICBpZiAoYXV0aERhdGEpIHtcbiAgICAgIGlmICh0eXBlb2YgYXV0aERhdGEgIT09ICdvYmplY3QnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PVEhFUl9DQVVTRSwgJ2F1dGhEYXRhIHNob3VsZCBiZSBhbiBvYmplY3QuJyk7XG4gICAgICB9XG4gICAgICBpZiAodXNlcikge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuT1RIRVJfQ0FVU0UsXG4gICAgICAgICAgJ1lvdSBjYW5ub3QgcHJvdmlkZSB1c2VybmFtZS9lbWFpbCBhbmQgYXV0aERhdGEsIG9ubHkgdXNlIG9uZSBpZGVudGlmaWNhdGlvbiBtZXRob2QuJ1xuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBpZiAoT2JqZWN0LmtleXMoYXV0aERhdGEpLmZpbHRlcihrZXkgPT4gYXV0aERhdGFba2V5XS5pZCkubGVuZ3RoID4gMSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuT1RIRVJfQ0FVU0UsXG4gICAgICAgICAgJ1lvdSBjYW5ub3QgcHJvdmlkZSBtb3JlIHRoYW4gb25lIGF1dGhEYXRhIHByb3ZpZGVyIHdpdGggYW4gaWQuJ1xuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBjb25zdCByZXN1bHRzID0gYXdhaXQgQXV0aC5maW5kVXNlcnNXaXRoQXV0aERhdGEocmVxLmNvbmZpZywgYXV0aERhdGEpO1xuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAoIXJlc3VsdHNbMF0gfHwgcmVzdWx0cy5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdVc2VyIG5vdCBmb3VuZC4nKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBGaW5kIHRoZSBwcm92aWRlciB1c2VkIHRvIGZpbmQgdGhlIHVzZXJcbiAgICAgICAgY29uc3QgcHJvdmlkZXIgPSBPYmplY3Qua2V5cyhhdXRoRGF0YSkuZmluZChrZXkgPT4gYXV0aERhdGFba2V5XS5pZCk7XG5cbiAgICAgICAgcGFyc2VVc2VyID0gUGFyc2UuVXNlci5mcm9tSlNPTih7IGNsYXNzTmFtZTogJ19Vc2VyJywgLi4ucmVzdWx0c1swXSB9KTtcbiAgICAgICAgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QodW5kZWZpbmVkLCByZXEuYXV0aCwgcGFyc2VVc2VyLCBwYXJzZVVzZXIsIHJlcS5jb25maWcpO1xuICAgICAgICByZXF1ZXN0LmlzQ2hhbGxlbmdlID0gdHJ1ZTtcbiAgICAgICAgLy8gVmFsaWRhdGUgYXV0aERhdGEgdXNlZCB0byBpZGVudGlmeSB0aGUgdXNlciB0byBhdm9pZCBicnV0ZS1mb3JjZSBhdHRhY2sgb24gYGlkYFxuICAgICAgICBjb25zdCB7IHZhbGlkYXRvciB9ID0gcmVxLmNvbmZpZy5hdXRoRGF0YU1hbmFnZXIuZ2V0VmFsaWRhdG9yRm9yUHJvdmlkZXIocHJvdmlkZXIpO1xuICAgICAgICBjb25zdCB2YWxpZGF0b3JSZXNwb25zZSA9IGF3YWl0IHZhbGlkYXRvcihhdXRoRGF0YVtwcm92aWRlcl0sIHJlcSwgcGFyc2VVc2VyLCByZXF1ZXN0KTtcbiAgICAgICAgaWYgKHZhbGlkYXRvclJlc3BvbnNlICYmIHZhbGlkYXRvclJlc3BvbnNlLnZhbGlkYXRvcikge1xuICAgICAgICAgIGF3YWl0IHZhbGlkYXRvclJlc3BvbnNlLnZhbGlkYXRvcigpO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIC8vIFJld3JpdGUgdGhlIGVycm9yIHRvIGF2b2lkIGd1ZXNzIGlkIGF0dGFja1xuICAgICAgICBsb2dnZXIuZXJyb3IoZSk7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnVXNlciBub3QgZm91bmQuJyk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFwYXJzZVVzZXIpIHtcbiAgICAgIHBhcnNlVXNlciA9IHVzZXIgPyBQYXJzZS5Vc2VyLmZyb21KU09OKHsgY2xhc3NOYW1lOiAnX1VzZXInLCAuLi51c2VyIH0pIDogdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGlmICghcmVxdWVzdCkge1xuICAgICAgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QodW5kZWZpbmVkLCByZXEuYXV0aCwgcGFyc2VVc2VyLCBwYXJzZVVzZXIsIHJlcS5jb25maWcpO1xuICAgICAgcmVxdWVzdC5pc0NoYWxsZW5nZSA9IHRydWU7XG4gICAgfVxuICAgIGNvbnN0IGFjYyA9IHt9O1xuICAgIC8vIEV4ZWN1dGUgY2hhbGxlbmdlIHN0ZXAtYnktc3RlcCB3aXRoIGNvbnNpc3RlbnQgb3JkZXIgZm9yIGJldHRlciBlcnJvciBmZWVkYmFja1xuICAgIC8vIGFuZCB0byBhdm9pZCB0byB0cmlnZ2VyIG90aGVycyBjaGFsbGVuZ2VzIGlmIG9uZSBvZiB0aGVtIGZhaWxzXG4gICAgZm9yIChjb25zdCBwcm92aWRlciBvZiBPYmplY3Qua2V5cyhjaGFsbGVuZ2VEYXRhKS5zb3J0KCkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGF1dGhBZGFwdGVyID0gcmVxLmNvbmZpZy5hdXRoRGF0YU1hbmFnZXIuZ2V0VmFsaWRhdG9yRm9yUHJvdmlkZXIocHJvdmlkZXIpO1xuICAgICAgICBpZiAoIWF1dGhBZGFwdGVyKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qge1xuICAgICAgICAgIGFkYXB0ZXI6IHsgY2hhbGxlbmdlIH0sXG4gICAgICAgIH0gPSBhdXRoQWRhcHRlcjtcbiAgICAgICAgaWYgKHR5cGVvZiBjaGFsbGVuZ2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICBjb25zdCBwcm92aWRlckNoYWxsZW5nZVJlc3BvbnNlID0gYXdhaXQgY2hhbGxlbmdlKFxuICAgICAgICAgICAgY2hhbGxlbmdlRGF0YVtwcm92aWRlcl0sXG4gICAgICAgICAgICBhdXRoRGF0YSAmJiBhdXRoRGF0YVtwcm92aWRlcl0sXG4gICAgICAgICAgICByZXEuY29uZmlnLmF1dGhbcHJvdmlkZXJdLFxuICAgICAgICAgICAgcmVxdWVzdFxuICAgICAgICAgICk7XG4gICAgICAgICAgYWNjW3Byb3ZpZGVyXSA9IHByb3ZpZGVyQ2hhbGxlbmdlUmVzcG9uc2UgfHwgdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnN0IGUgPSByZXNvbHZlRXJyb3IoZXJyLCB7XG4gICAgICAgICAgY29kZTogUGFyc2UuRXJyb3IuU0NSSVBUX0ZBSUxFRCxcbiAgICAgICAgICBtZXNzYWdlOiAnQ2hhbGxlbmdlIGZhaWxlZC4gVW5rbm93biBlcnJvci4nLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgdXNlclN0cmluZyA9IHJlcS5hdXRoICYmIHJlcS5hdXRoLnVzZXIgPyByZXEuYXV0aC51c2VyLmlkIDogdW5kZWZpbmVkO1xuICAgICAgICBsb2dnZXIuZXJyb3IoXG4gICAgICAgICAgYEZhaWxlZCBydW5uaW5nIGF1dGggc3RlcCBjaGFsbGVuZ2UgZm9yICR7cHJvdmlkZXJ9IGZvciB1c2VyICR7dXNlclN0cmluZ30gd2l0aCBFcnJvcjogYCArXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeShlKSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBhdXRoZW50aWNhdGlvblN0ZXA6ICdjaGFsbGVuZ2UnLFxuICAgICAgICAgICAgZXJyb3I6IGUsXG4gICAgICAgICAgICB1c2VyOiB1c2VyU3RyaW5nLFxuICAgICAgICAgICAgcHJvdmlkZXIsXG4gICAgICAgICAgfVxuICAgICAgICApO1xuICAgICAgICB0aHJvdyBlO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4geyByZXNwb25zZTogeyBjaGFsbGVuZ2VEYXRhOiBhY2MgfSB9O1xuICB9XG5cbiAgbW91bnRSb3V0ZXMoKSB7XG4gICAgdGhpcy5yb3V0ZSgnR0VUJywgJy91c2VycycsIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVGaW5kKHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnUE9TVCcsICcvdXNlcnMnLCBwcm9taXNlRW5zdXJlSWRlbXBvdGVuY3ksIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVDcmVhdGUocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdHRVQnLCAnL3VzZXJzL21lJywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZU1lKHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnR0VUJywgJy91c2Vycy86b2JqZWN0SWQnLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlR2V0KHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnUFVUJywgJy91c2Vycy86b2JqZWN0SWQnLCBwcm9taXNlRW5zdXJlSWRlbXBvdGVuY3ksIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVVcGRhdGUocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdERUxFVEUnLCAnL3VzZXJzLzpvYmplY3RJZCcsIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVEZWxldGUocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdHRVQnLCAnL2xvZ2luJywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUxvZ0luKHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnUE9TVCcsICcvbG9naW4nLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlTG9nSW4ocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdQT1NUJywgJy9sb2dpbkFzJywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUxvZ0luQXMocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdQT1NUJywgJy9sb2dvdXQnLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlTG9nT3V0KHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnUE9TVCcsICcvcmVxdWVzdFBhc3N3b3JkUmVzZXQnLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlUmVzZXRSZXF1ZXN0KHJlcSk7XG4gICAgfSk7XG4gICAgdGhpcy5yb3V0ZSgnUE9TVCcsICcvdmVyaWZpY2F0aW9uRW1haWxSZXF1ZXN0JywgcmVxID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZVZlcmlmaWNhdGlvbkVtYWlsUmVxdWVzdChyZXEpO1xuICAgIH0pO1xuICAgIHRoaXMucm91dGUoJ0dFVCcsICcvdmVyaWZ5UGFzc3dvcmQnLCByZXEgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlVmVyaWZ5UGFzc3dvcmQocmVxKTtcbiAgICB9KTtcbiAgICB0aGlzLnJvdXRlKCdQT1NUJywgJy92ZXJpZnlQYXNzd29yZCcsIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVWZXJpZnlQYXNzd29yZChyZXEpO1xuICAgIH0pO1xuICAgIHRoaXMucm91dGUoJ1BPU1QnLCAnL2NoYWxsZW5nZScsIHJlcSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVDaGFsbGVuZ2UocmVxKTtcbiAgICB9KTtcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBVc2Vyc1JvdXRlcjtcbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FBRUEsSUFBQUEsS0FBQSxHQUFBQyxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUMsT0FBQSxHQUFBRixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUUsZUFBQSxHQUFBSCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUcsY0FBQSxHQUFBSixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUksS0FBQSxHQUFBTCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUssS0FBQSxHQUFBTixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQU0sU0FBQSxHQUFBUCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQU8sU0FBQSxHQUFBUCxPQUFBO0FBTUEsSUFBQVEsWUFBQSxHQUFBUixPQUFBO0FBQ0EsSUFBQVMsVUFBQSxHQUFBVixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQVUsT0FBQSxHQUFBVixPQUFBO0FBQW1DLFNBQUFELHVCQUFBWSxDQUFBLFdBQUFBLENBQUEsSUFBQUEsQ0FBQSxDQUFBQyxVQUFBLEdBQUFELENB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QzRELFdBQVcsQ0FBQzVELEdBQUcsQ0FBQztJQUM5QixDQUFDLENBQUM7SUFDRixJQUFJLENBQUM4SixLQUFLLENBQUMsTUFBTSxFQUFFLFFBQVEsRUFBRTlKLEdBQUcsSUFBSTtNQUNsQyxPQUFPLElBQUksQ0FBQzRELFdBQVcsQ0FBQzVELEdBQUcsQ0FBQztJQUM5QixDQUFDLENBQUM7SUFDRixJQUFJLENBQUM4SixLQUFLLENBQUMsTUFBTSxFQUFFLFVBQVUsRUFBRTlKLEdBQUcsSUFBSTtNQUNwQyxPQUFPLElBQUksQ0FBQzhGLGFBQWEsQ0FBQzlGLEdBQUcsQ0FBQztJQUNoQyxDQUFDLENBQUM7SUFDRixJQUFJLENBQUM4SixLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsRUFBRTlKLEdBQUcsSUFBSTtNQUNuQyxPQUFPLElBQUksQ0FBQ21HLFlBQVksQ0FBQ25HLEdBQUcsQ0FBQztJQUMvQixDQUFDLENBQUM7SUFDRixJQUFJLENBQUM4SixLQUFLLENBQUMsTUFBTSxFQUFFLHVCQUF1QixFQUFFOUosR0FBRyxJQUFJO01BQ2pELE9BQU8sSUFBSSxDQUFDc0gsa0JBQWtCLENBQUN0SCxHQUFHLENBQUM7SUFDckMsQ0FBQyxDQUFDO0lBQ0YsSUFBSSxDQUFDOEosS0FBSyxDQUFDLE1BQU0sRUFBRSwyQkFBMkIsRUFBRTlKLEdBQUcsSUFBSTtNQUNyRCxPQUFPLElBQUksQ0FBQ2tJLDhCQUE4QixDQUFDbEksR0FBRyxDQUFDO0lBQ2pELENBQUMsQ0FBQztJQUNGLElBQUksQ0FBQzhKLEtBQUssQ0FBQyxLQUFLLEVBQUUsaUJBQWlCLEVBQUU5SixHQUFHLElBQUk7TUFDMUMsT0FBTyxJQUFJLENBQUNrRyxvQkFBb0IsQ0FBQ2xHLEdBQUcsQ0FBQztJQUN2QyxDQUFDLENBQUM7SUFDRixJQUFJLENBQUM4SixLQUFLLENBQUMsTUFBTSxFQUFFLGlCQUFpQixFQUFFOUosR0FBRyxJQUFJO01BQzNDLE9BQU8sSUFBSSxDQUFDa0csb0JBQW9CLENBQUNsRyxHQUFHLENBQUM7SUFDdkMsQ0FBQyxDQUFDO0lBQ0YsSUFBSSxDQUFDOEosS0FBSyxDQUFDLE1BQU0sRUFBRSxZQUFZLEVBQUU5SixHQUFHLElBQUk7TUFDdEMsT0FBTyxJQUFJLENBQUN1SSxlQUFlLENBQUN2SSxHQUFHLENBQUM7SUFDbEMsQ0FBQyxDQUFDO0VBQ0o7QUFDRjtBQUFDcUssT0FBQSxDQUFBekwsV0FBQSxHQUFBQSxXQUFBO0FBQUEsSUFBQTBMLFFBQUEsR0FBQUQsT0FBQSxDQUFBMUwsT0FBQSxHQUVjQyxXQUFXIiwiaWdub3JlTGlzdCI6W119