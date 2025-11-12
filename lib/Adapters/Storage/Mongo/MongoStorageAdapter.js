"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.MongoStorageAdapter = void 0;
var _mongodbUrl = require("../../../vendor/mongodbUrl");
var _StorageAdapter = require("../StorageAdapter");
var _MongoCollection = _interopRequireDefault(require("./MongoCollection"));
var _MongoSchemaCollection = _interopRequireDefault(require("./MongoSchemaCollection"));
var _MongoTransform = require("./MongoTransform");
var _node = _interopRequireDefault(require("parse/node"));
var _lodash = _interopRequireDefault(require("lodash"));
var _defaults = _interopRequireWildcard(require("../../../defaults"));
var _logger = _interopRequireDefault(require("../../../logger"));
var _Utils = _interopRequireDefault(require("../../../Utils"));
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// -disable-next
// -disable-next
// -disable-next
const mongodb = require('mongodb');
const MongoClient = mongodb.MongoClient;
const ReadPreference = mongodb.ReadPreference;
const MongoSchemaCollectionName = '_SCHEMA';
const storageAdapterAllCollections = mongoAdapter => {
  return mongoAdapter.connect().then(() => mongoAdapter.database.collections()).then(collections => {
    return collections.filter(collection => {
      if (collection.namespace.match(/\.system\./)) {
        return false;
      }
      // TODO: If you have one app with a collection prefix that happens to be a prefix of another
      // apps prefix, this will go very very badly. We should fix that somehow.
      return collection.collectionName.indexOf(mongoAdapter._collectionPrefix) == 0;
    });
  });
};
const convertParseSchemaToMongoSchema = ({
  ...schema
}) => {
  delete schema.fields._rperm;
  delete schema.fields._wperm;
  if (schema.className === '_User') {
    // Legacy mongo adapter knows about the difference between password and _hashed_password.
    // Future database adapters will only know about _hashed_password.
    // Note: Parse Server will bring back password with injectDefaultSchema, so we don't need
    // to add _hashed_password back ever.
    delete schema.fields._hashed_password;
  }
  return schema;
};

// Returns { code, error } if invalid, or { result }, an object
// suitable for inserting into _SCHEMA collection, otherwise.
const mongoSchemaFromFieldsAndClassNameAndCLP = (fields, className, classLevelPermissions, indexes) => {
  const mongoObject = {
    _id: className,
    objectId: 'string',
    updatedAt: 'string',
    createdAt: 'string',
    _metadata: undefined
  };
  for (const fieldName in fields) {
    const {
      type,
      targetClass,
      ...fieldOptions
    } = fields[fieldName];
    mongoObject[fieldName] = _MongoSchemaCollection.default.parseFieldTypeToMongoFieldType({
      type,
      targetClass
    });
    if (fieldOptions && Object.keys(fieldOptions).length > 0) {
      mongoObject._metadata = mongoObject._metadata || {};
      mongoObject._metadata.fields_options = mongoObject._metadata.fields_options || {};
      mongoObject._metadata.fields_options[fieldName] = fieldOptions;
    }
  }
  if (typeof classLevelPermissions !== 'undefined') {
    mongoObject._metadata = mongoObject._metadata || {};
    if (!classLevelPermissions) {
      delete mongoObject._metadata.class_permissions;
    } else {
      mongoObject._metadata.class_permissions = classLevelPermissions;
    }
  }
  if (indexes && typeof indexes === 'object' && Object.keys(indexes).length > 0) {
    mongoObject._metadata = mongoObject._metadata || {};
    mongoObject._metadata.indexes = indexes;
  }
  if (!mongoObject._metadata) {
    // cleanup the unused _metadata
    delete mongoObject._metadata;
  }
  return mongoObject;
};
function validateExplainValue(explain) {
  if (explain) {
    // The list of allowed explain values is from node-mongodb-native/lib/explain.js
    const explainAllowedValues = ['queryPlanner', 'queryPlannerExtended', 'executionStats', 'allPlansExecution', false, true];
    if (!explainAllowedValues.includes(explain)) {
      throw new _node.default.Error(_node.default.Error.INVALID_QUERY, 'Invalid value for explain');
    }
  }
}
class MongoStorageAdapter {
  // Private

  // Public

  constructor({
    uri = _defaults.default.DefaultMongoURI,
    collectionPrefix = '',
    mongoOptions = {}
  }) {
    this._uri = uri;
    this._collectionPrefix = collectionPrefix;
    this._onchange = () => {};

    // MaxTimeMS is not a global MongoDB client option, it is applied per operation.
    this._maxTimeMS = mongoOptions.maxTimeMS;
    this.canSortOnJoinTables = true;
    this.enableSchemaHooks = !!mongoOptions.enableSchemaHooks;
    this.schemaCacheTtl = mongoOptions.schemaCacheTtl;
    this.disableIndexFieldValidation = !!mongoOptions.disableIndexFieldValidation;
    this._logClientEvents = mongoOptions.logClientEvents;

    // Create a copy of mongoOptions and remove Parse Server-specific options that should not
    // be passed to MongoDB client. Note: We only delete from this._mongoOptions, not from the
    // original mongoOptions object, because other components (like DatabaseController) need
    // access to these options.
    this._mongoOptions = {
      ...mongoOptions
    };
    for (const key of _defaults.ParseServerDatabaseOptions) {
      delete this._mongoOptions[key];
    }
  }
  watch(callback) {
    this._onchange = callback;
  }
  connect() {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    // parsing and re-formatting causes the auth value (if there) to get URI
    // encoded
    const encodedUri = (0, _mongodbUrl.format)((0, _mongodbUrl.parse)(this._uri));
    this.connectionPromise = MongoClient.connect(encodedUri, this._mongoOptions).then(client => {
      // Starting mongoDB 3.0, the MongoClient.connect don't return a DB anymore but a client
      // Fortunately, we can get back the options and use them to select the proper DB.
      // https://github.com/mongodb/node-mongodb-native/blob/2c35d76f08574225b8db02d7bef687123e6bb018/lib/mongo_client.js#L885
      const options = client.s.options;
      const database = client.db(options.dbName);
      if (!database) {
        delete this.connectionPromise;
        return;
      }
      client.on('error', () => {
        delete this.connectionPromise;
      });
      client.on('close', () => {
        delete this.connectionPromise;
      });

      // Set up client event logging if configured
      if (this._logClientEvents && Array.isArray(this._logClientEvents)) {
        this._logClientEvents.forEach(eventConfig => {
          client.on(eventConfig.name, event => {
            let logData = {};
            if (!eventConfig.keys || eventConfig.keys.length === 0) {
              logData = event;
            } else {
              eventConfig.keys.forEach(keyPath => {
                logData[keyPath] = _lodash.default.get(event, keyPath);
              });
            }

            // Validate log level exists, fallback to 'info'
            const logLevel = typeof _logger.default[eventConfig.logLevel] === 'function' ? eventConfig.logLevel : 'info';

            // Safe JSON serialization with Map/Set and circular reference support
            const logMessage = `MongoDB client event ${eventConfig.name}: ${JSON.stringify(logData, _Utils.default.getCircularReplacer())}`;
            _logger.default[logLevel](logMessage);
          });
        });
      }
      this.client = client;
      this.database = database;
    }).catch(err => {
      delete this.connectionPromise;
      return Promise.reject(err);
    });
    return this.connectionPromise;
  }
  handleError(error) {
    if (error && error.code === 13) {
      // Unauthorized error
      delete this.client;
      delete this.database;
      delete this.connectionPromise;
      _logger.default.error('Received unauthorized error', {
        error: error
      });
    }
    throw error;
  }
  async handleShutdown() {
    if (!this.client) {
      return;
    }
    await this.client.close(false);
    delete this.connectionPromise;
  }
  _adaptiveCollection(name) {
    return this.connect().then(() => this.database.collection(this._collectionPrefix + name)).then(rawCollection => new _MongoCollection.default(rawCollection)).catch(err => this.handleError(err));
  }
  _schemaCollection() {
    return this.connect().then(() => this._adaptiveCollection(MongoSchemaCollectionName)).then(collection => {
      if (!this._stream && this.enableSchemaHooks) {
        this._stream = collection._mongoCollection.watch();
        this._stream.on('change', () => this._onchange());
      }
      return new _MongoSchemaCollection.default(collection);
    });
  }
  classExists(name) {
    return this.connect().then(() => {
      return this.database.listCollections({
        name: this._collectionPrefix + name
      }).toArray();
    }).then(collections => {
      return collections.length > 0;
    }).catch(err => this.handleError(err));
  }
  setClassLevelPermissions(className, CLPs) {
    return this._schemaCollection().then(schemaCollection => schemaCollection.updateSchema(className, {
      $set: {
        '_metadata.class_permissions': CLPs
      }
    })).catch(err => this.handleError(err));
  }
  setIndexesWithSchemaFormat(className, submittedIndexes, existingIndexes = {}, fields) {
    if (submittedIndexes === undefined) {
      return Promise.resolve();
    }
    if (Object.keys(existingIndexes).length === 0) {
      existingIndexes = {
        _id_: {
          _id: 1
        }
      };
    }
    const deletePromises = [];
    const insertedIndexes = [];
    Object.keys(submittedIndexes).forEach(name => {
      const field = submittedIndexes[name];
      if (existingIndexes[name] && field.__op !== 'Delete') {
        throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Index ${name} exists, cannot update.`);
      }
      if (!existingIndexes[name] && field.__op === 'Delete') {
        throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Index ${name} does not exist, cannot delete.`);
      }
      if (field.__op === 'Delete') {
        const promise = this.dropIndex(className, name);
        deletePromises.push(promise);
        delete existingIndexes[name];
      } else {
        Object.keys(field).forEach(key => {
          if (!this.disableIndexFieldValidation && !Object.prototype.hasOwnProperty.call(fields, key.indexOf('_p_') === 0 ? key.replace('_p_', '') : key)) {
            throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Field ${key} does not exist, cannot add index.`);
          }
        });
        existingIndexes[name] = field;
        insertedIndexes.push({
          key: field,
          name
        });
      }
    });
    let insertPromise = Promise.resolve();
    if (insertedIndexes.length > 0) {
      insertPromise = this.createIndexes(className, insertedIndexes);
    }
    return Promise.all(deletePromises).then(() => insertPromise).then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.updateSchema(className, {
      $set: {
        '_metadata.indexes': existingIndexes
      }
    })).catch(err => this.handleError(err));
  }
  setIndexesFromMongo(className) {
    return this.getIndexes(className).then(indexes => {
      indexes = indexes.reduce((obj, index) => {
        if (index.key._fts) {
          delete index.key._fts;
          delete index.key._ftsx;
          for (const field in index.weights) {
            index.key[field] = 'text';
          }
        }
        obj[index.name] = index.key;
        return obj;
      }, {});
      return this._schemaCollection().then(schemaCollection => schemaCollection.updateSchema(className, {
        $set: {
          '_metadata.indexes': indexes
        }
      }));
    }).catch(err => this.handleError(err)).catch(() => {
      // Ignore if collection not found
      return Promise.resolve();
    });
  }
  createClass(className, schema) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoObject = mongoSchemaFromFieldsAndClassNameAndCLP(schema.fields, className, schema.classLevelPermissions, schema.indexes);
    mongoObject._id = className;
    return this.setIndexesWithSchemaFormat(className, schema.indexes, {}, schema.fields).then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.insertSchema(mongoObject)).catch(err => this.handleError(err));
  }
  async updateFieldOptions(className, fieldName, type) {
    const schemaCollection = await this._schemaCollection();
    await schemaCollection.updateFieldOptions(className, fieldName, type);
  }
  addFieldIfNotExists(className, fieldName, type) {
    return this._schemaCollection().then(schemaCollection => schemaCollection.addFieldIfNotExists(className, fieldName, type)).then(() => this.createIndexesIfNeeded(className, fieldName, type)).catch(err => this.handleError(err));
  }

  // Drops a collection. Resolves with true if it was a Parse Schema (eg. _User, Custom, etc.)
  // and resolves with false if it wasn't (eg. a join table). Rejects if deletion was impossible.
  deleteClass(className) {
    return this._adaptiveCollection(className).then(collection => collection.drop()).catch(error => {
      // 'ns not found' means collection was already gone. Ignore deletion attempt.
      if (error.message == 'ns not found') {
        return;
      }
      throw error;
    })
    // We've dropped the collection, now remove the _SCHEMA document
    .then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.findAndDeleteSchema(className)).catch(err => this.handleError(err));
  }
  deleteAllClasses(fast) {
    return storageAdapterAllCollections(this).then(collections => Promise.all(collections.map(collection => fast ? collection.deleteMany({}) : collection.drop())));
  }

  // Remove the column and all the data. For Relations, the _Join collection is handled
  // specially, this function does not delete _Join columns. It should, however, indicate
  // that the relation fields does not exist anymore. In mongo, this means removing it from
  // the _SCHEMA collection.  There should be no actual data in the collection under the same name
  // as the relation column, so it's fine to attempt to delete it. If the fields listed to be
  // deleted do not exist, this function should return successfully anyways. Checking for
  // attempts to delete non-existent fields is the responsibility of Parse Server.

  // Pointer field names are passed for legacy reasons: the original mongo
  // format stored pointer field names differently in the database, and therefore
  // needed to know the type of the field before it could delete it. Future database
  // adapters should ignore the pointerFieldNames argument. All the field names are in
  // fieldNames, they show up additionally in the pointerFieldNames database for use
  // by the mongo adapter, which deals with the legacy mongo format.

  // This function is not obligated to delete fields atomically. It is given the field
  // names in a list so that databases that are capable of deleting fields atomically
  // may do so.

  // Returns a Promise.
  deleteFields(className, schema, fieldNames) {
    const mongoFormatNames = fieldNames.map(fieldName => {
      if (schema.fields[fieldName].type === 'Pointer') {
        return `_p_${fieldName}`;
      } else {
        return fieldName;
      }
    });
    const collectionUpdate = {
      $unset: {}
    };
    mongoFormatNames.forEach(name => {
      collectionUpdate['$unset'][name] = null;
    });
    const collectionFilter = {
      $or: []
    };
    mongoFormatNames.forEach(name => {
      collectionFilter['$or'].push({
        [name]: {
          $exists: true
        }
      });
    });
    const schemaUpdate = {
      $unset: {}
    };
    fieldNames.forEach(name => {
      schemaUpdate['$unset'][name] = null;
      schemaUpdate['$unset'][`_metadata.fields_options.${name}`] = null;
    });
    return this._adaptiveCollection(className).then(collection => collection.updateMany(collectionFilter, collectionUpdate)).then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.updateSchema(className, schemaUpdate)).catch(err => this.handleError(err));
  }

  // Return a promise for all schemas known to this adapter, in Parse format. In case the
  // schemas cannot be retrieved, returns a promise that rejects. Requirements for the
  // rejection reason are TBD.
  getAllClasses() {
    return this._schemaCollection().then(schemasCollection => schemasCollection._fetchAllSchemasFrom_SCHEMA()).catch(err => this.handleError(err));
  }

  // Return a promise for the schema with the given name, in Parse format. If
  // this adapter doesn't know about the schema, return a promise that rejects with
  // undefined as the reason.
  getClass(className) {
    return this._schemaCollection().then(schemasCollection => schemasCollection._fetchOneSchemaFrom_SCHEMA(className)).catch(err => this.handleError(err));
  }

  // TODO: As yet not particularly well specified. Creates an object. Maybe shouldn't even need the schema,
  // and should infer from the type. Or maybe does need the schema for validations. Or maybe needs
  // the schema only for the legacy mongo format. We'll figure that out later.
  createObject(className, schema, object, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoObject = (0, _MongoTransform.parseObjectToMongoObjectForCreate)(className, object, schema);
    return this._adaptiveCollection(className).then(collection => collection.insertOne(mongoObject, transactionalSession)).then(() => ({
      ops: [mongoObject]
    })).catch(error => {
      if (error.code === 11000) {
        // Duplicate value
        const err = new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        err.underlyingError = error;
        if (error.message) {
          const matches = error.message.match(/index:[\sa-zA-Z0-9_\-\.]+\$?([a-zA-Z_-]+)_1/);
          if (matches && Array.isArray(matches)) {
            err.userInfo = {
              duplicated_field: matches[1]
            };
          }
        }
        throw err;
      }
      throw error;
    }).catch(err => this.handleError(err));
  }

  // Remove all objects that match the given Parse Query.
  // If no objects match, reject with OBJECT_NOT_FOUND. If objects are found and deleted, resolve with undefined.
  // If there is some other error, reject with INTERNAL_SERVER_ERROR.
  deleteObjectsByQuery(className, schema, query, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    return this._adaptiveCollection(className).then(collection => {
      const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
      return collection.deleteMany(mongoWhere, transactionalSession);
    }).catch(err => this.handleError(err)).then(({
      deletedCount
    }) => {
      if (deletedCount === 0) {
        throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Object not found.');
      }
      return Promise.resolve();
    }, () => {
      throw new _node.default.Error(_node.default.Error.INTERNAL_SERVER_ERROR, 'Database adapter error');
    });
  }

  // Apply the update to all objects that match the given Parse Query.
  updateObjectsByQuery(className, schema, query, update, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection.updateMany(mongoWhere, mongoUpdate, transactionalSession)).catch(err => this.handleError(err));
  }

  // Atomically finds and updates an object based on query.
  // Return value not currently well specified.
  findOneAndUpdate(className, schema, query, update, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.findOneAndUpdate(mongoWhere, mongoUpdate, {
      returnDocument: 'after',
      session: transactionalSession || undefined
    })).then(result => (0, _MongoTransform.mongoObjectToParseObject)(className, result, schema)).catch(error => {
      if (error.code === 11000) {
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      }
      throw error;
    }).catch(err => this.handleError(err));
  }

  // Hopefully we can get rid of this. It's only used for config and hooks.
  upsertOneObject(className, schema, query, update, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection.upsertOne(mongoWhere, mongoUpdate, transactionalSession)).catch(err => this.handleError(err));
  }

  // Executes a find. Accepts: className, query in Parse format, and { skip, limit, sort }.
  find(className, schema, query, {
    skip,
    limit,
    sort,
    keys,
    readPreference,
    hint,
    caseInsensitive,
    explain,
    comment
  }) {
    validateExplainValue(explain);
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    const mongoSort = _lodash.default.mapKeys(sort, (value, fieldName) => (0, _MongoTransform.transformKey)(className, fieldName, schema));
    const mongoKeys = _lodash.default.reduce(keys, (memo, key) => {
      if (key === 'ACL') {
        memo['_rperm'] = 1;
        memo['_wperm'] = 1;
      } else {
        memo[(0, _MongoTransform.transformKey)(className, key, schema)] = 1;
      }
      return memo;
    }, {});

    // If we aren't requesting the `_id` field, we need to explicitly opt out
    // of it. Doing so in parse-server is unusual, but it can allow us to
    // optimize some queries with covering indexes.
    if (keys && !mongoKeys._id) {
      mongoKeys._id = 0;
    }
    readPreference = this._parseReadPreference(readPreference);
    return this.createTextIndexesIfNeeded(className, query, schema).then(() => this._adaptiveCollection(className)).then(collection => collection.find(mongoWhere, {
      skip,
      limit,
      sort: mongoSort,
      keys: mongoKeys,
      maxTimeMS: this._maxTimeMS,
      readPreference,
      hint,
      caseInsensitive,
      explain,
      comment
    })).then(objects => {
      if (explain) {
        return objects;
      }
      return objects.map(object => (0, _MongoTransform.mongoObjectToParseObject)(className, object, schema));
    }).catch(err => this.handleError(err));
  }
  ensureIndex(className, schema, fieldNames, indexName, caseInsensitive = false, options = {}) {
    schema = convertParseSchemaToMongoSchema(schema);
    const indexCreationRequest = {};
    const mongoFieldNames = fieldNames.map(fieldName => (0, _MongoTransform.transformKey)(className, fieldName, schema));
    mongoFieldNames.forEach(fieldName => {
      indexCreationRequest[fieldName] = options.indexType !== undefined ? options.indexType : 1;
    });
    const defaultOptions = {
      background: true,
      sparse: true
    };
    const indexNameOptions = indexName ? {
      name: indexName
    } : {};
    const ttlOptions = options.ttl !== undefined ? {
      expireAfterSeconds: options.ttl
    } : {};
    const sparseOptions = options.sparse !== undefined ? {
      sparse: options.sparse
    } : {};
    const caseInsensitiveOptions = caseInsensitive ? {
      collation: _MongoCollection.default.caseInsensitiveCollation()
    } : {};
    const indexOptions = {
      ...defaultOptions,
      ...caseInsensitiveOptions,
      ...indexNameOptions,
      ...ttlOptions,
      ...sparseOptions
    };
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.createIndex(indexCreationRequest, indexOptions)).catch(err => this.handleError(err));
  }

  // Create a unique index. Unique indexes on nullable fields are not allowed. Since we don't
  // currently know which fields are nullable and which aren't, we ignore that criteria.
  // As such, we shouldn't expose this function to users of parse until we have an out-of-band
  // Way of determining if a field is nullable. Undefined doesn't count against uniqueness,
  // which is why we use sparse indexes.
  ensureUniqueness(className, schema, fieldNames) {
    schema = convertParseSchemaToMongoSchema(schema);
    const indexCreationRequest = {};
    const mongoFieldNames = fieldNames.map(fieldName => (0, _MongoTransform.transformKey)(className, fieldName, schema));
    mongoFieldNames.forEach(fieldName => {
      indexCreationRequest[fieldName] = 1;
    });
    return this._adaptiveCollection(className).then(collection => collection._ensureSparseUniqueIndexInBackground(indexCreationRequest)).catch(error => {
      if (error.code === 11000) {
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'Tried to ensure field uniqueness for a class that already has duplicates.');
      }
      throw error;
    }).catch(err => this.handleError(err));
  }

  // Used in tests
  _rawFind(className, query) {
    return this._adaptiveCollection(className).then(collection => collection.find(query, {
      maxTimeMS: this._maxTimeMS
    })).catch(err => this.handleError(err));
  }

  // Executes a count.
  count(className, schema, query, readPreference, _estimate, hint, comment) {
    schema = convertParseSchemaToMongoSchema(schema);
    readPreference = this._parseReadPreference(readPreference);
    return this._adaptiveCollection(className).then(collection => collection.count((0, _MongoTransform.transformWhere)(className, query, schema, true), {
      maxTimeMS: this._maxTimeMS,
      readPreference,
      hint,
      comment
    })).catch(err => this.handleError(err));
  }
  distinct(className, schema, query, fieldName) {
    schema = convertParseSchemaToMongoSchema(schema);
    const isPointerField = schema.fields[fieldName] && schema.fields[fieldName].type === 'Pointer';
    const transformField = (0, _MongoTransform.transformKey)(className, fieldName, schema);
    return this._adaptiveCollection(className).then(collection => collection.distinct(transformField, (0, _MongoTransform.transformWhere)(className, query, schema))).then(objects => {
      objects = objects.filter(obj => obj != null);
      return objects.map(object => {
        if (isPointerField) {
          return (0, _MongoTransform.transformPointerString)(schema, fieldName, object);
        }
        return (0, _MongoTransform.mongoObjectToParseObject)(className, object, schema);
      });
    }).catch(err => this.handleError(err));
  }
  aggregate(className, schema, pipeline, readPreference, hint, explain, comment) {
    validateExplainValue(explain);
    let isPointerField = false;
    pipeline = pipeline.map(stage => {
      if (stage.$group) {
        stage.$group = this._parseAggregateGroupArgs(schema, stage.$group);
        if (stage.$group._id && typeof stage.$group._id === 'string' && stage.$group._id.indexOf('$_p_') >= 0) {
          isPointerField = true;
        }
      }
      if (stage.$match) {
        stage.$match = this._parseAggregateArgs(schema, stage.$match);
      }
      if (stage.$project) {
        stage.$project = this._parseAggregateProjectArgs(schema, stage.$project);
      }
      if (stage.$geoNear && stage.$geoNear.query) {
        stage.$geoNear.query = this._parseAggregateArgs(schema, stage.$geoNear.query);
      }
      return stage;
    });
    readPreference = this._parseReadPreference(readPreference);
    return this._adaptiveCollection(className).then(collection => collection.aggregate(pipeline, {
      readPreference,
      maxTimeMS: this._maxTimeMS,
      hint,
      explain,
      comment
    })).then(results => {
      results.forEach(result => {
        if (Object.prototype.hasOwnProperty.call(result, '_id')) {
          if (isPointerField && result._id) {
            result._id = result._id.split('$')[1];
          }
          if (result._id == null || result._id == undefined || ['object', 'string'].includes(typeof result._id) && _lodash.default.isEmpty(result._id)) {
            result._id = null;
          }
          result.objectId = result._id;
          delete result._id;
        }
      });
      return results;
    }).then(objects => objects.map(object => (0, _MongoTransform.mongoObjectToParseObject)(className, object, schema))).catch(err => this.handleError(err));
  }

  // This function will recursively traverse the pipeline and convert any Pointer or Date columns.
  // If we detect a pointer column we will rename the column being queried for to match the column
  // in the database. We also modify the value to what we expect the value to be in the database
  // as well.
  // For dates, the driver expects a Date object, but we have a string coming in. So we'll convert
  // the string to a Date so the driver can perform the necessary comparison.
  //
  // The goal of this method is to look for the "leaves" of the pipeline and determine if it needs
  // to be converted. The pipeline can have a few different forms. For more details, see:
  //     https://docs.mongodb.com/manual/reference/operator/aggregation/
  //
  // If the pipeline is an array, it means we are probably parsing an '$and' or '$or' operator. In
  // that case we need to loop through all of it's children to find the columns being operated on.
  // If the pipeline is an object, then we'll loop through the keys checking to see if the key name
  // matches one of the schema columns. If it does match a column and the column is a Pointer or
  // a Date, then we'll convert the value as described above.
  //
  // As much as I hate recursion...this seemed like a good fit for it. We're essentially traversing
  // down a tree to find a "leaf node" and checking to see if it needs to be converted.
  _parseAggregateArgs(schema, pipeline) {
    if (pipeline === null) {
      return null;
    } else if (Array.isArray(pipeline)) {
      return pipeline.map(value => this._parseAggregateArgs(schema, value));
    } else if (typeof pipeline === 'object') {
      const returnValue = {};
      for (const field in pipeline) {
        if (schema.fields[field] && schema.fields[field].type === 'Pointer') {
          if (typeof pipeline[field] === 'object') {
            // Pass objects down to MongoDB...this is more than likely an $exists operator.
            returnValue[`_p_${field}`] = pipeline[field];
          } else {
            returnValue[`_p_${field}`] = `${schema.fields[field].targetClass}$${pipeline[field]}`;
          }
        } else if (schema.fields[field] && schema.fields[field].type === 'Date') {
          returnValue[field] = this._convertToDate(pipeline[field]);
        } else {
          returnValue[field] = this._parseAggregateArgs(schema, pipeline[field]);
        }
        if (field === 'objectId') {
          returnValue['_id'] = returnValue[field];
          delete returnValue[field];
        } else if (field === 'createdAt') {
          returnValue['_created_at'] = returnValue[field];
          delete returnValue[field];
        } else if (field === 'updatedAt') {
          returnValue['_updated_at'] = returnValue[field];
          delete returnValue[field];
        }
      }
      return returnValue;
    }
    return pipeline;
  }

  // This function is slightly different than the one above. Rather than trying to combine these
  // two functions and making the code even harder to understand, I decided to split it up. The
  // difference with this function is we are not transforming the values, only the keys of the
  // pipeline.
  _parseAggregateProjectArgs(schema, pipeline) {
    const returnValue = {};
    for (const field in pipeline) {
      if (schema.fields[field] && schema.fields[field].type === 'Pointer') {
        returnValue[`_p_${field}`] = pipeline[field];
      } else {
        returnValue[field] = this._parseAggregateArgs(schema, pipeline[field]);
      }
      if (field === 'objectId') {
        returnValue['_id'] = returnValue[field];
        delete returnValue[field];
      } else if (field === 'createdAt') {
        returnValue['_created_at'] = returnValue[field];
        delete returnValue[field];
      } else if (field === 'updatedAt') {
        returnValue['_updated_at'] = returnValue[field];
        delete returnValue[field];
      }
    }
    return returnValue;
  }

  // This function is slightly different than the two above. MongoDB $group aggregate looks like:
  //     { $group: { _id: <expression>, <field1>: { <accumulator1> : <expression1> }, ... } }
  // The <expression> could be a column name, prefixed with the '$' character. We'll look for
  // these <expression> and check to see if it is a 'Pointer' or if it's one of createdAt,
  // updatedAt or objectId and change it accordingly.
  _parseAggregateGroupArgs(schema, pipeline) {
    if (Array.isArray(pipeline)) {
      return pipeline.map(value => this._parseAggregateGroupArgs(schema, value));
    } else if (typeof pipeline === 'object') {
      const returnValue = {};
      for (const field in pipeline) {
        returnValue[field] = this._parseAggregateGroupArgs(schema, pipeline[field]);
      }
      return returnValue;
    } else if (typeof pipeline === 'string') {
      const field = pipeline.substring(1);
      if (schema.fields[field] && schema.fields[field].type === 'Pointer') {
        return `$_p_${field}`;
      } else if (field == 'createdAt') {
        return '$_created_at';
      } else if (field == 'updatedAt') {
        return '$_updated_at';
      }
    }
    return pipeline;
  }

  /**
   * Recursively converts values to Date objects. Since the passed object is part of an aggregation
   * pipeline and can contain various logic operators (like $gt, $lt, etc), this function will
   * traverse the object and convert any strings that can be parsed as dates into Date objects.
   * @param {any} value The value to convert.
   * @returns {any} The original value if not convertible to Date, or a Date object if it is.
   */
  _convertToDate(value) {
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === 'string') {
      return isNaN(Date.parse(value)) ? value : new Date(value);
    }
    if (typeof value === 'object') {
      const returnValue = {};
      for (const field in value) {
        returnValue[field] = this._convertToDate(value[field]);
      }
      return returnValue;
    }
    return value;
  }
  _parseReadPreference(readPreference) {
    if (readPreference) {
      readPreference = readPreference.toUpperCase();
    }
    switch (readPreference) {
      case 'PRIMARY':
        readPreference = ReadPreference.PRIMARY;
        break;
      case 'PRIMARY_PREFERRED':
        readPreference = ReadPreference.PRIMARY_PREFERRED;
        break;
      case 'SECONDARY':
        readPreference = ReadPreference.SECONDARY;
        break;
      case 'SECONDARY_PREFERRED':
        readPreference = ReadPreference.SECONDARY_PREFERRED;
        break;
      case 'NEAREST':
        readPreference = ReadPreference.NEAREST;
        break;
      case undefined:
      case null:
      case '':
        break;
      default:
        throw new _node.default.Error(_node.default.Error.INVALID_QUERY, 'Not supported read preference.');
    }
    return readPreference;
  }
  performInitialization() {
    return Promise.resolve();
  }
  createIndex(className, index) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.createIndex(index)).catch(err => this.handleError(err));
  }
  createIndexes(className, indexes) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.createIndexes(indexes)).catch(err => this.handleError(err));
  }
  createIndexesIfNeeded(className, fieldName, type) {
    if (type && type.type === 'Polygon') {
      const index = {
        [fieldName]: '2dsphere'
      };
      return this.createIndex(className, index);
    }
    return Promise.resolve();
  }
  createTextIndexesIfNeeded(className, query, schema) {
    for (const fieldName in query) {
      if (!query[fieldName] || !query[fieldName].$text) {
        continue;
      }
      const existingIndexes = schema.indexes;
      for (const key in existingIndexes) {
        const index = existingIndexes[key];
        if (Object.prototype.hasOwnProperty.call(index, fieldName)) {
          return Promise.resolve();
        }
      }
      const indexName = `${fieldName}_text`;
      const textIndex = {
        [indexName]: {
          [fieldName]: 'text'
        }
      };
      return this.setIndexesWithSchemaFormat(className, textIndex, existingIndexes, schema.fields).catch(error => {
        if (error.code === 85) {
          // Index exist with different options
          return this.setIndexesFromMongo(className);
        }
        throw error;
      });
    }
    return Promise.resolve();
  }
  getIndexes(className) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.indexes()).catch(err => this.handleError(err));
  }
  dropIndex(className, index) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.dropIndex(index)).catch(err => this.handleError(err));
  }
  dropAllIndexes(className) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.dropIndexes()).catch(err => this.handleError(err));
  }
  updateSchemaWithIndexes() {
    return this.getAllClasses().then(classes => {
      const promises = classes.map(schema => {
        return this.setIndexesFromMongo(schema.className);
      });
      return Promise.all(promises);
    }).catch(err => this.handleError(err));
  }
  createTransactionalSession() {
    const transactionalSection = this.client.startSession();
    transactionalSection.startTransaction();
    return Promise.resolve(transactionalSection);
  }
  commitTransactionalSession(transactionalSection) {
    const commit = retries => {
      return transactionalSection.commitTransaction().catch(error => {
        if (error && error.hasErrorLabel('TransientTransactionError') && retries > 0) {
          return commit(retries - 1);
        }
        throw error;
      }).then(() => {
        transactionalSection.endSession();
      });
    };
    return commit(5);
  }
  abortTransactionalSession(transactionalSection) {
    return transactionalSection.abortTransaction().then(() => {
      transactionalSection.endSession();
    });
  }
}
exports.MongoStorageAdapter = MongoStorageAdapter;
var _default = exports.default = MongoStorageAdapter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbW9uZ29kYlVybCIsInJlcXVpcmUiLCJfU3RvcmFnZUFkYXB0ZXIiLCJfTW9uZ29Db2xsZWN0aW9uIiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsIl9Nb25nb1NjaGVtYUNvbGxlY3Rpb24iLCJfTW9uZ29UcmFuc2Zvcm0iLCJfbm9kZSIsIl9sb2Rhc2giLCJfZGVmYXVsdHMiLCJfaW50ZXJvcFJlcXVpcmVXaWxkY2FyZCIsIl9sb2dnZXIiLCJfVXRpbHMiLCJlIiwidCIsIldlYWtNYXAiLCJyIiwibiIsIl9fZXNNb2R1bGUiLCJvIiwiaSIsImYiLCJfX3Byb3RvX18iLCJkZWZhdWx0IiwiaGFzIiwiZ2V0Iiwic2V0IiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwiT2JqZWN0IiwiZGVmaW5lUHJvcGVydHkiLCJnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IiLCJtb25nb2RiIiwiTW9uZ29DbGllbnQiLCJSZWFkUHJlZmVyZW5jZSIsIk1vbmdvU2NoZW1hQ29sbGVjdGlvbk5hbWUiLCJzdG9yYWdlQWRhcHRlckFsbENvbGxlY3Rpb25zIiwibW9uZ29BZGFwdGVyIiwiY29ubmVjdCIsInRoZW4iLCJkYXRhYmFzZSIsImNvbGxlY3Rpb25zIiwiZmlsdGVyIiwiY29sbGVjdGlvbiIsIm5hbWVzcGFjZSIsIm1hdGNoIiwiY29sbGVjdGlvbk5hbWUiLCJpbmRleE9mIiwiX2NvbGxlY3Rpb25QcmVmaXgiLCJjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hIiwic2NoZW1hIiwiZmllbGRzIiwiX3JwZXJtIiwiX3dwZXJtIiwiY2xhc3NOYW1lIiwiX2hhc2hlZF9wYXNzd29yZCIsIm1vbmdvU2NoZW1hRnJvbUZpZWxkc0FuZENsYXNzTmFtZUFuZENMUCIsImNsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsImluZGV4ZXMiLCJtb25nb09iamVjdCIsIl9pZCIsIm9iamVjdElkIiwidXBkYXRlZEF0IiwiY3JlYXRlZEF0IiwiX21ldGFkYXRhIiwidW5kZWZpbmVkIiwiZmllbGROYW1lIiwidHlwZSIsInRhcmdldENsYXNzIiwiZmllbGRPcHRpb25zIiwiTW9uZ29TY2hlbWFDb2xsZWN0aW9uIiwicGFyc2VGaWVsZFR5cGVUb01vbmdvRmllbGRUeXBlIiwia2V5cyIsImxlbmd0aCIsImZpZWxkc19vcHRpb25zIiwiY2xhc3NfcGVybWlzc2lvbnMiLCJ2YWxpZGF0ZUV4cGxhaW5WYWx1ZSIsImV4cGxhaW4iLCJleHBsYWluQWxsb3dlZFZhbHVlcyIsImluY2x1ZGVzIiwiUGFyc2UiLCJFcnJvciIsIklOVkFMSURfUVVFUlkiLCJNb25nb1N0b3JhZ2VBZGFwdGVyIiwiY29uc3RydWN0b3IiLCJ1cmkiLCJkZWZhdWx0cyIsIkRlZmF1bHRNb25nb1VSSSIsImNvbGxlY3Rpb25QcmVmaXgiLCJtb25nb09wdGlvbnMiLCJfdXJpIiwiX29uY2hhbmdlIiwiX21heFRpbWVNUyIsIm1heFRpbWVNUyIsImNhblNvcnRPbkpvaW5UYWJsZXMiLCJlbmFibGVTY2hlbWFIb29rcyIsInNjaGVtYUNhY2hlVHRsIiwiZGlzYWJsZUluZGV4RmllbGRWYWxpZGF0aW9uIiwiX2xvZ0NsaWVudEV2ZW50cyIsImxvZ0NsaWVudEV2ZW50cyIsIl9tb25nb09wdGlvbnMiLCJrZXkiLCJQYXJzZVNlcnZlckRhdGFiYXNlT3B0aW9ucyIsIndhdGNoIiwiY2FsbGJhY2siLCJjb25uZWN0aW9uUHJvbWlzZSIsImVuY29kZWRVcmkiLCJmb3JtYXRVcmwiLCJwYXJzZVVybCIsImNsaWVudCIsIm9wdGlvbnMiLCJzIiwiZGIiLCJkYk5hbWUiLCJvbiIsIkFycmF5IiwiaXNBcnJheSIsImZvckVhY2giLCJldmVudENvbmZpZyIsIm5hbWUiLCJldmVudCIsImxvZ0RhdGEiLCJrZXlQYXRoIiwiXyIsImxvZ0xldmVsIiwibG9nZ2VyIiwibG9nTWVzc2FnZSIsIkpTT04iLCJzdHJpbmdpZnkiLCJVdGlscyIsImdldENpcmN1bGFyUmVwbGFjZXIiLCJjYXRjaCIsImVyciIsIlByb21pc2UiLCJyZWplY3QiLCJoYW5kbGVFcnJvciIsImVycm9yIiwiY29kZSIsImhhbmRsZVNodXRkb3duIiwiY2xvc2UiLCJfYWRhcHRpdmVDb2xsZWN0aW9uIiwicmF3Q29sbGVjdGlvbiIsIk1vbmdvQ29sbGVjdGlvbiIsIl9zY2hlbWFDb2xsZWN0aW9uIiwiX3N0cmVhbSIsIl9tb25nb0NvbGxlY3Rpb24iLCJjbGFzc0V4aXN0cyIsImxpc3RDb2xsZWN0aW9ucyIsInRvQXJyYXkiLCJzZXRDbGFzc0xldmVsUGVybWlzc2lvbnMiLCJDTFBzIiwic2NoZW1hQ29sbGVjdGlvbiIsInVwZGF0ZVNjaGVtYSIsIiRzZXQiLCJzZXRJbmRleGVzV2l0aFNjaGVtYUZvcm1hdCIsInN1Ym1pdHRlZEluZGV4ZXMiLCJleGlzdGluZ0luZGV4ZXMiLCJyZXNvbHZlIiwiX2lkXyIsImRlbGV0ZVByb21pc2VzIiwiaW5zZXJ0ZWRJbmRleGVzIiwiZmllbGQiLCJfX29wIiwicHJvbWlzZSIsImRyb3BJbmRleCIsInB1c2giLCJwcm90b3R5cGUiLCJyZXBsYWNlIiwiaW5zZXJ0UHJvbWlzZSIsImNyZWF0ZUluZGV4ZXMiLCJhbGwiLCJzZXRJbmRleGVzRnJvbU1vbmdvIiwiZ2V0SW5kZXhlcyIsInJlZHVjZSIsIm9iaiIsImluZGV4IiwiX2Z0cyIsIl9mdHN4Iiwid2VpZ2h0cyIsImNyZWF0ZUNsYXNzIiwiaW5zZXJ0U2NoZW1hIiwidXBkYXRlRmllbGRPcHRpb25zIiwiYWRkRmllbGRJZk5vdEV4aXN0cyIsImNyZWF0ZUluZGV4ZXNJZk5lZWRlZCIsImRlbGV0ZUNsYXNzIiwiZHJvcCIsIm1lc3NhZ2UiLCJmaW5kQW5kRGVsZXRlU2NoZW1hIiwiZGVsZXRlQWxsQ2xhc3NlcyIsImZhc3QiLCJtYXAiLCJkZWxldGVNYW55IiwiZGVsZXRlRmllbGRzIiwiZmllbGROYW1lcyIsIm1vbmdvRm9ybWF0TmFtZXMiLCJjb2xsZWN0aW9uVXBkYXRlIiwiJHVuc2V0IiwiY29sbGVjdGlvbkZpbHRlciIsIiRvciIsIiRleGlzdHMiLCJzY2hlbWFVcGRhdGUiLCJ1cGRhdGVNYW55IiwiZ2V0QWxsQ2xhc3NlcyIsInNjaGVtYXNDb2xsZWN0aW9uIiwiX2ZldGNoQWxsU2NoZW1hc0Zyb21fU0NIRU1BIiwiZ2V0Q2xhc3MiLCJfZmV0Y2hPbmVTY2hlbWFGcm9tX1NDSEVNQSIsImNyZWF0ZU9iamVjdCIsIm9iamVjdCIsInRyYW5zYWN0aW9uYWxTZXNzaW9uIiwicGFyc2VPYmplY3RUb01vbmdvT2JqZWN0Rm9yQ3JlYXRlIiwiaW5zZXJ0T25lIiwib3BzIiwiRFVQTElDQVRFX1ZBTFVFIiwidW5kZXJseWluZ0Vycm9yIiwibWF0Y2hlcyIsInVzZXJJbmZvIiwiZHVwbGljYXRlZF9maWVsZCIsImRlbGV0ZU9iamVjdHNCeVF1ZXJ5IiwicXVlcnkiLCJtb25nb1doZXJlIiwidHJhbnNmb3JtV2hlcmUiLCJkZWxldGVkQ291bnQiLCJPQkpFQ1RfTk9UX0ZPVU5EIiwiSU5URVJOQUxfU0VSVkVSX0VSUk9SIiwidXBkYXRlT2JqZWN0c0J5UXVlcnkiLCJ1cGRhdGUiLCJtb25nb1VwZGF0ZSIsInRyYW5zZm9ybVVwZGF0ZSIsImZpbmRPbmVBbmRVcGRhdGUiLCJyZXR1cm5Eb2N1bWVudCIsInNlc3Npb24iLCJyZXN1bHQiLCJtb25nb09iamVjdFRvUGFyc2VPYmplY3QiLCJ1cHNlcnRPbmVPYmplY3QiLCJ1cHNlcnRPbmUiLCJmaW5kIiwic2tpcCIsImxpbWl0Iiwic29ydCIsInJlYWRQcmVmZXJlbmNlIiwiaGludCIsImNhc2VJbnNlbnNpdGl2ZSIsImNvbW1lbnQiLCJtb25nb1NvcnQiLCJtYXBLZXlzIiwidmFsdWUiLCJ0cmFuc2Zvcm1LZXkiLCJtb25nb0tleXMiLCJtZW1vIiwiX3BhcnNlUmVhZFByZWZlcmVuY2UiLCJjcmVhdGVUZXh0SW5kZXhlc0lmTmVlZGVkIiwib2JqZWN0cyIsImVuc3VyZUluZGV4IiwiaW5kZXhOYW1lIiwiaW5kZXhDcmVhdGlvblJlcXVlc3QiLCJtb25nb0ZpZWxkTmFtZXMiLCJpbmRleFR5cGUiLCJkZWZhdWx0T3B0aW9ucyIsImJhY2tncm91bmQiLCJzcGFyc2UiLCJpbmRleE5hbWVPcHRpb25zIiwidHRsT3B0aW9ucyIsInR0bCIsImV4cGlyZUFmdGVyU2Vjb25kcyIsInNwYXJzZU9wdGlvbnMiLCJjYXNlSW5zZW5zaXRpdmVPcHRpb25zIiwiY29sbGF0aW9uIiwiY2FzZUluc2Vuc2l0aXZlQ29sbGF0aW9uIiwiaW5kZXhPcHRpb25zIiwiY3JlYXRlSW5kZXgiLCJlbnN1cmVVbmlxdWVuZXNzIiwiX2Vuc3VyZVNwYXJzZVVuaXF1ZUluZGV4SW5CYWNrZ3JvdW5kIiwiX3Jhd0ZpbmQiLCJjb3VudCIsIl9lc3RpbWF0ZSIsImRpc3RpbmN0IiwiaXNQb2ludGVyRmllbGQiLCJ0cmFuc2Zvcm1GaWVsZCIsInRyYW5zZm9ybVBvaW50ZXJTdHJpbmciLCJhZ2dyZWdhdGUiLCJwaXBlbGluZSIsInN0YWdlIiwiJGdyb3VwIiwiX3BhcnNlQWdncmVnYXRlR3JvdXBBcmdzIiwiJG1hdGNoIiwiX3BhcnNlQWdncmVnYXRlQXJncyIsIiRwcm9qZWN0IiwiX3BhcnNlQWdncmVnYXRlUHJvamVjdEFyZ3MiLCIkZ2VvTmVhciIsInJlc3VsdHMiLCJzcGxpdCIsImlzRW1wdHkiLCJyZXR1cm5WYWx1ZSIsIl9jb252ZXJ0VG9EYXRlIiwic3Vic3RyaW5nIiwiRGF0ZSIsImlzTmFOIiwicGFyc2UiLCJ0b1VwcGVyQ2FzZSIsIlBSSU1BUlkiLCJQUklNQVJZX1BSRUZFUlJFRCIsIlNFQ09OREFSWSIsIlNFQ09OREFSWV9QUkVGRVJSRUQiLCJORUFSRVNUIiwicGVyZm9ybUluaXRpYWxpemF0aW9uIiwiJHRleHQiLCJ0ZXh0SW5kZXgiLCJkcm9wQWxsSW5kZXhlcyIsImRyb3BJbmRleGVzIiwidXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMiLCJjbGFzc2VzIiwicHJvbWlzZXMiLCJjcmVhdGVUcmFuc2FjdGlvbmFsU2Vzc2lvbiIsInRyYW5zYWN0aW9uYWxTZWN0aW9uIiwic3RhcnRTZXNzaW9uIiwic3RhcnRUcmFuc2FjdGlvbiIsImNvbW1pdFRyYW5zYWN0aW9uYWxTZXNzaW9uIiwiY29tbWl0IiwicmV0cmllcyIsImNvbW1pdFRyYW5zYWN0aW9uIiwiaGFzRXJyb3JMYWJlbCIsImVuZFNlc3Npb24iLCJhYm9ydFRyYW5zYWN0aW9uYWxTZXNzaW9uIiwiYWJvcnRUcmFuc2FjdGlvbiIsImV4cG9ydHMiLCJfZGVmYXVsdCJdLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9BZGFwdGVycy9TdG9yYWdlL01vbmdvL01vbmdvU3RvcmFnZUFkYXB0ZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQGZsb3dcbmltcG9ydCB7IGZvcm1hdCBhcyBmb3JtYXRVcmwsIHBhcnNlIGFzIHBhcnNlVXJsIH0gZnJvbSAnLi4vLi4vLi4vdmVuZG9yL21vbmdvZGJVcmwnO1xuaW1wb3J0IHR5cGUgeyBRdWVyeU9wdGlvbnMsIFF1ZXJ5VHlwZSwgU2NoZW1hVHlwZSwgU3RvcmFnZUNsYXNzIH0gZnJvbSAnLi4vU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IHsgU3RvcmFnZUFkYXB0ZXIgfSBmcm9tICcuLi9TdG9yYWdlQWRhcHRlcic7XG5pbXBvcnQgTW9uZ29Db2xsZWN0aW9uIGZyb20gJy4vTW9uZ29Db2xsZWN0aW9uJztcbmltcG9ydCBNb25nb1NjaGVtYUNvbGxlY3Rpb24gZnJvbSAnLi9Nb25nb1NjaGVtYUNvbGxlY3Rpb24nO1xuaW1wb3J0IHtcbiAgbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0LFxuICBwYXJzZU9iamVjdFRvTW9uZ29PYmplY3RGb3JDcmVhdGUsXG4gIHRyYW5zZm9ybUtleSxcbiAgdHJhbnNmb3JtUG9pbnRlclN0cmluZyxcbiAgdHJhbnNmb3JtVXBkYXRlLFxuICB0cmFuc2Zvcm1XaGVyZSxcbn0gZnJvbSAnLi9Nb25nb1RyYW5zZm9ybSc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCBQYXJzZSBmcm9tICdwYXJzZS9ub2RlJztcbi8vIEBmbG93LWRpc2FibGUtbmV4dFxuaW1wb3J0IF8gZnJvbSAnbG9kYXNoJztcbmltcG9ydCBkZWZhdWx0cywgeyBQYXJzZVNlcnZlckRhdGFiYXNlT3B0aW9ucyB9IGZyb20gJy4uLy4uLy4uL2RlZmF1bHRzJztcbmltcG9ydCBsb2dnZXIgZnJvbSAnLi4vLi4vLi4vbG9nZ2VyJztcbmltcG9ydCBVdGlscyBmcm9tICcuLi8uLi8uLi9VdGlscyc7XG5cbi8vIEBmbG93LWRpc2FibGUtbmV4dFxuY29uc3QgbW9uZ29kYiA9IHJlcXVpcmUoJ21vbmdvZGInKTtcbmNvbnN0IE1vbmdvQ2xpZW50ID0gbW9uZ29kYi5Nb25nb0NsaWVudDtcbmNvbnN0IFJlYWRQcmVmZXJlbmNlID0gbW9uZ29kYi5SZWFkUHJlZmVyZW5jZTtcblxuY29uc3QgTW9uZ29TY2hlbWFDb2xsZWN0aW9uTmFtZSA9ICdfU0NIRU1BJztcblxuY29uc3Qgc3RvcmFnZUFkYXB0ZXJBbGxDb2xsZWN0aW9ucyA9IG1vbmdvQWRhcHRlciA9PiB7XG4gIHJldHVybiBtb25nb0FkYXB0ZXJcbiAgICAuY29ubmVjdCgpXG4gICAgLnRoZW4oKCkgPT4gbW9uZ29BZGFwdGVyLmRhdGFiYXNlLmNvbGxlY3Rpb25zKCkpXG4gICAgLnRoZW4oY29sbGVjdGlvbnMgPT4ge1xuICAgICAgcmV0dXJuIGNvbGxlY3Rpb25zLmZpbHRlcihjb2xsZWN0aW9uID0+IHtcbiAgICAgICAgaWYgKGNvbGxlY3Rpb24ubmFtZXNwYWNlLm1hdGNoKC9cXC5zeXN0ZW1cXC4vKSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICAvLyBUT0RPOiBJZiB5b3UgaGF2ZSBvbmUgYXBwIHdpdGggYSBjb2xsZWN0aW9uIHByZWZpeCB0aGF0IGhhcHBlbnMgdG8gYmUgYSBwcmVmaXggb2YgYW5vdGhlclxuICAgICAgICAvLyBhcHBzIHByZWZpeCwgdGhpcyB3aWxsIGdvIHZlcnkgdmVyeSBiYWRseS4gV2Ugc2hvdWxkIGZpeCB0aGF0IHNvbWVob3cuXG4gICAgICAgIHJldHVybiBjb2xsZWN0aW9uLmNvbGxlY3Rpb25OYW1lLmluZGV4T2YobW9uZ29BZGFwdGVyLl9jb2xsZWN0aW9uUHJlZml4KSA9PSAwO1xuICAgICAgfSk7XG4gICAgfSk7XG59O1xuXG5jb25zdCBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hID0gKHsgLi4uc2NoZW1hIH0pID0+IHtcbiAgZGVsZXRlIHNjaGVtYS5maWVsZHMuX3JwZXJtO1xuICBkZWxldGUgc2NoZW1hLmZpZWxkcy5fd3Blcm07XG5cbiAgaWYgKHNjaGVtYS5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICAvLyBMZWdhY3kgbW9uZ28gYWRhcHRlciBrbm93cyBhYm91dCB0aGUgZGlmZmVyZW5jZSBiZXR3ZWVuIHBhc3N3b3JkIGFuZCBfaGFzaGVkX3Bhc3N3b3JkLlxuICAgIC8vIEZ1dHVyZSBkYXRhYmFzZSBhZGFwdGVycyB3aWxsIG9ubHkga25vdyBhYm91dCBfaGFzaGVkX3Bhc3N3b3JkLlxuICAgIC8vIE5vdGU6IFBhcnNlIFNlcnZlciB3aWxsIGJyaW5nIGJhY2sgcGFzc3dvcmQgd2l0aCBpbmplY3REZWZhdWx0U2NoZW1hLCBzbyB3ZSBkb24ndCBuZWVkXG4gICAgLy8gdG8gYWRkIF9oYXNoZWRfcGFzc3dvcmQgYmFjayBldmVyLlxuICAgIGRlbGV0ZSBzY2hlbWEuZmllbGRzLl9oYXNoZWRfcGFzc3dvcmQ7XG4gIH1cblxuICByZXR1cm4gc2NoZW1hO1xufTtcblxuLy8gUmV0dXJucyB7IGNvZGUsIGVycm9yIH0gaWYgaW52YWxpZCwgb3IgeyByZXN1bHQgfSwgYW4gb2JqZWN0XG4vLyBzdWl0YWJsZSBmb3IgaW5zZXJ0aW5nIGludG8gX1NDSEVNQSBjb2xsZWN0aW9uLCBvdGhlcndpc2UuXG5jb25zdCBtb25nb1NjaGVtYUZyb21GaWVsZHNBbmRDbGFzc05hbWVBbmRDTFAgPSAoXG4gIGZpZWxkcyxcbiAgY2xhc3NOYW1lLFxuICBjbGFzc0xldmVsUGVybWlzc2lvbnMsXG4gIGluZGV4ZXNcbikgPT4ge1xuICBjb25zdCBtb25nb09iamVjdCA9IHtcbiAgICBfaWQ6IGNsYXNzTmFtZSxcbiAgICBvYmplY3RJZDogJ3N0cmluZycsXG4gICAgdXBkYXRlZEF0OiAnc3RyaW5nJyxcbiAgICBjcmVhdGVkQXQ6ICdzdHJpbmcnLFxuICAgIF9tZXRhZGF0YTogdW5kZWZpbmVkLFxuICB9O1xuXG4gIGZvciAoY29uc3QgZmllbGROYW1lIGluIGZpZWxkcykge1xuICAgIGNvbnN0IHsgdHlwZSwgdGFyZ2V0Q2xhc3MsIC4uLmZpZWxkT3B0aW9ucyB9ID0gZmllbGRzW2ZpZWxkTmFtZV07XG4gICAgbW9uZ29PYmplY3RbZmllbGROYW1lXSA9IE1vbmdvU2NoZW1hQ29sbGVjdGlvbi5wYXJzZUZpZWxkVHlwZVRvTW9uZ29GaWVsZFR5cGUoe1xuICAgICAgdHlwZSxcbiAgICAgIHRhcmdldENsYXNzLFxuICAgIH0pO1xuICAgIGlmIChmaWVsZE9wdGlvbnMgJiYgT2JqZWN0LmtleXMoZmllbGRPcHRpb25zKS5sZW5ndGggPiAwKSB7XG4gICAgICBtb25nb09iamVjdC5fbWV0YWRhdGEgPSBtb25nb09iamVjdC5fbWV0YWRhdGEgfHwge307XG4gICAgICBtb25nb09iamVjdC5fbWV0YWRhdGEuZmllbGRzX29wdGlvbnMgPSBtb25nb09iamVjdC5fbWV0YWRhdGEuZmllbGRzX29wdGlvbnMgfHwge307XG4gICAgICBtb25nb09iamVjdC5fbWV0YWRhdGEuZmllbGRzX29wdGlvbnNbZmllbGROYW1lXSA9IGZpZWxkT3B0aW9ucztcbiAgICB9XG4gIH1cblxuICBpZiAodHlwZW9mIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICBtb25nb09iamVjdC5fbWV0YWRhdGEgPSBtb25nb09iamVjdC5fbWV0YWRhdGEgfHwge307XG4gICAgaWYgKCFjbGFzc0xldmVsUGVybWlzc2lvbnMpIHtcbiAgICAgIGRlbGV0ZSBtb25nb09iamVjdC5fbWV0YWRhdGEuY2xhc3NfcGVybWlzc2lvbnM7XG4gICAgfSBlbHNlIHtcbiAgICAgIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YS5jbGFzc19wZXJtaXNzaW9ucyA9IGNsYXNzTGV2ZWxQZXJtaXNzaW9ucztcbiAgICB9XG4gIH1cblxuICBpZiAoaW5kZXhlcyAmJiB0eXBlb2YgaW5kZXhlcyA9PT0gJ29iamVjdCcgJiYgT2JqZWN0LmtleXMoaW5kZXhlcykubGVuZ3RoID4gMCkge1xuICAgIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YSA9IG1vbmdvT2JqZWN0Ll9tZXRhZGF0YSB8fCB7fTtcbiAgICBtb25nb09iamVjdC5fbWV0YWRhdGEuaW5kZXhlcyA9IGluZGV4ZXM7XG4gIH1cblxuICBpZiAoIW1vbmdvT2JqZWN0Ll9tZXRhZGF0YSkge1xuICAgIC8vIGNsZWFudXAgdGhlIHVudXNlZCBfbWV0YWRhdGFcbiAgICBkZWxldGUgbW9uZ29PYmplY3QuX21ldGFkYXRhO1xuICB9XG5cbiAgcmV0dXJuIG1vbmdvT2JqZWN0O1xufTtcblxuZnVuY3Rpb24gdmFsaWRhdGVFeHBsYWluVmFsdWUoZXhwbGFpbikge1xuICBpZiAoZXhwbGFpbikge1xuICAgIC8vIFRoZSBsaXN0IG9mIGFsbG93ZWQgZXhwbGFpbiB2YWx1ZXMgaXMgZnJvbSBub2RlLW1vbmdvZGItbmF0aXZlL2xpYi9leHBsYWluLmpzXG4gICAgY29uc3QgZXhwbGFpbkFsbG93ZWRWYWx1ZXMgPSBbXG4gICAgICAncXVlcnlQbGFubmVyJyxcbiAgICAgICdxdWVyeVBsYW5uZXJFeHRlbmRlZCcsXG4gICAgICAnZXhlY3V0aW9uU3RhdHMnLFxuICAgICAgJ2FsbFBsYW5zRXhlY3V0aW9uJyxcbiAgICAgIGZhbHNlLFxuICAgICAgdHJ1ZSxcbiAgICBdO1xuICAgIGlmICghZXhwbGFpbkFsbG93ZWRWYWx1ZXMuaW5jbHVkZXMoZXhwbGFpbikpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLCAnSW52YWxpZCB2YWx1ZSBmb3IgZXhwbGFpbicpO1xuICAgIH1cbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgTW9uZ29TdG9yYWdlQWRhcHRlciBpbXBsZW1lbnRzIFN0b3JhZ2VBZGFwdGVyIHtcbiAgLy8gUHJpdmF0ZVxuICBfdXJpOiBzdHJpbmc7XG4gIF9jb2xsZWN0aW9uUHJlZml4OiBzdHJpbmc7XG4gIF9tb25nb09wdGlvbnM6IE9iamVjdDtcbiAgX29uY2hhbmdlOiBhbnk7XG4gIF9zdHJlYW06IGFueTtcbiAgX2xvZ0NsaWVudEV2ZW50czogP0FycmF5PGFueT47XG4gIC8vIFB1YmxpY1xuICBjb25uZWN0aW9uUHJvbWlzZTogP1Byb21pc2U8YW55PjtcbiAgZGF0YWJhc2U6IGFueTtcbiAgY2xpZW50OiBNb25nb0NsaWVudDtcbiAgX21heFRpbWVNUzogP251bWJlcjtcbiAgY2FuU29ydE9uSm9pblRhYmxlczogYm9vbGVhbjtcbiAgZW5hYmxlU2NoZW1hSG9va3M6IGJvb2xlYW47XG4gIHNjaGVtYUNhY2hlVHRsOiA/bnVtYmVyO1xuICBkaXNhYmxlSW5kZXhGaWVsZFZhbGlkYXRpb246IGJvb2xlYW47XG5cbiAgY29uc3RydWN0b3IoeyB1cmkgPSBkZWZhdWx0cy5EZWZhdWx0TW9uZ29VUkksIGNvbGxlY3Rpb25QcmVmaXggPSAnJywgbW9uZ29PcHRpb25zID0ge30gfTogYW55KSB7XG4gICAgdGhpcy5fdXJpID0gdXJpO1xuICAgIHRoaXMuX2NvbGxlY3Rpb25QcmVmaXggPSBjb2xsZWN0aW9uUHJlZml4O1xuICAgIHRoaXMuX29uY2hhbmdlID0gKCkgPT4ge307XG5cbiAgICAvLyBNYXhUaW1lTVMgaXMgbm90IGEgZ2xvYmFsIE1vbmdvREIgY2xpZW50IG9wdGlvbiwgaXQgaXMgYXBwbGllZCBwZXIgb3BlcmF0aW9uLlxuICAgIHRoaXMuX21heFRpbWVNUyA9IG1vbmdvT3B0aW9ucy5tYXhUaW1lTVM7XG4gICAgdGhpcy5jYW5Tb3J0T25Kb2luVGFibGVzID0gdHJ1ZTtcbiAgICB0aGlzLmVuYWJsZVNjaGVtYUhvb2tzID0gISFtb25nb09wdGlvbnMuZW5hYmxlU2NoZW1hSG9va3M7XG4gICAgdGhpcy5zY2hlbWFDYWNoZVR0bCA9IG1vbmdvT3B0aW9ucy5zY2hlbWFDYWNoZVR0bDtcbiAgICB0aGlzLmRpc2FibGVJbmRleEZpZWxkVmFsaWRhdGlvbiA9ICEhbW9uZ29PcHRpb25zLmRpc2FibGVJbmRleEZpZWxkVmFsaWRhdGlvbjtcbiAgICB0aGlzLl9sb2dDbGllbnRFdmVudHMgPSBtb25nb09wdGlvbnMubG9nQ2xpZW50RXZlbnRzO1xuXG4gICAgLy8gQ3JlYXRlIGEgY29weSBvZiBtb25nb09wdGlvbnMgYW5kIHJlbW92ZSBQYXJzZSBTZXJ2ZXItc3BlY2lmaWMgb3B0aW9ucyB0aGF0IHNob3VsZCBub3RcbiAgICAvLyBiZSBwYXNzZWQgdG8gTW9uZ29EQiBjbGllbnQuIE5vdGU6IFdlIG9ubHkgZGVsZXRlIGZyb20gdGhpcy5fbW9uZ29PcHRpb25zLCBub3QgZnJvbSB0aGVcbiAgICAvLyBvcmlnaW5hbCBtb25nb09wdGlvbnMgb2JqZWN0LCBiZWNhdXNlIG90aGVyIGNvbXBvbmVudHMgKGxpa2UgRGF0YWJhc2VDb250cm9sbGVyKSBuZWVkXG4gICAgLy8gYWNjZXNzIHRvIHRoZXNlIG9wdGlvbnMuXG4gICAgdGhpcy5fbW9uZ29PcHRpb25zID0geyAuLi5tb25nb09wdGlvbnMgfTtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBQYXJzZVNlcnZlckRhdGFiYXNlT3B0aW9ucykge1xuICAgICAgZGVsZXRlIHRoaXMuX21vbmdvT3B0aW9uc1trZXldO1xuICAgIH1cbiAgfVxuXG4gIHdhdGNoKGNhbGxiYWNrOiAoKSA9PiB2b2lkKTogdm9pZCB7XG4gICAgdGhpcy5fb25jaGFuZ2UgPSBjYWxsYmFjaztcbiAgfVxuXG4gIGNvbm5lY3QoKSB7XG4gICAgaWYgKHRoaXMuY29ubmVjdGlvblByb21pc2UpIHtcbiAgICAgIHJldHVybiB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgIH1cblxuICAgIC8vIHBhcnNpbmcgYW5kIHJlLWZvcm1hdHRpbmcgY2F1c2VzIHRoZSBhdXRoIHZhbHVlIChpZiB0aGVyZSkgdG8gZ2V0IFVSSVxuICAgIC8vIGVuY29kZWRcbiAgICBjb25zdCBlbmNvZGVkVXJpID0gZm9ybWF0VXJsKHBhcnNlVXJsKHRoaXMuX3VyaSkpO1xuICAgIHRoaXMuY29ubmVjdGlvblByb21pc2UgPSBNb25nb0NsaWVudC5jb25uZWN0KGVuY29kZWRVcmksIHRoaXMuX21vbmdvT3B0aW9ucylcbiAgICAgIC50aGVuKGNsaWVudCA9PiB7XG4gICAgICAgIC8vIFN0YXJ0aW5nIG1vbmdvREIgMy4wLCB0aGUgTW9uZ29DbGllbnQuY29ubmVjdCBkb24ndCByZXR1cm4gYSBEQiBhbnltb3JlIGJ1dCBhIGNsaWVudFxuICAgICAgICAvLyBGb3J0dW5hdGVseSwgd2UgY2FuIGdldCBiYWNrIHRoZSBvcHRpb25zIGFuZCB1c2UgdGhlbSB0byBzZWxlY3QgdGhlIHByb3BlciBEQi5cbiAgICAgICAgLy8gaHR0cHM6Ly9naXRodWIuY29tL21vbmdvZGIvbm9kZS1tb25nb2RiLW5hdGl2ZS9ibG9iLzJjMzVkNzZmMDg1NzQyMjViOGRiMDJkN2JlZjY4NzEyM2U2YmIwMTgvbGliL21vbmdvX2NsaWVudC5qcyNMODg1XG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSBjbGllbnQucy5vcHRpb25zO1xuICAgICAgICBjb25zdCBkYXRhYmFzZSA9IGNsaWVudC5kYihvcHRpb25zLmRiTmFtZSk7XG4gICAgICAgIGlmICghZGF0YWJhc2UpIHtcbiAgICAgICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY2xpZW50Lm9uKCdlcnJvcicsICgpID0+IHtcbiAgICAgICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgICAgfSk7XG4gICAgICAgIGNsaWVudC5vbignY2xvc2UnLCAoKSA9PiB7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuY29ubmVjdGlvblByb21pc2U7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFNldCB1cCBjbGllbnQgZXZlbnQgbG9nZ2luZyBpZiBjb25maWd1cmVkXG4gICAgICAgIGlmICh0aGlzLl9sb2dDbGllbnRFdmVudHMgJiYgQXJyYXkuaXNBcnJheSh0aGlzLl9sb2dDbGllbnRFdmVudHMpKSB7XG4gICAgICAgICAgdGhpcy5fbG9nQ2xpZW50RXZlbnRzLmZvckVhY2goZXZlbnRDb25maWcgPT4ge1xuICAgICAgICAgICAgY2xpZW50Lm9uKGV2ZW50Q29uZmlnLm5hbWUsIGV2ZW50ID0+IHtcbiAgICAgICAgICAgICAgbGV0IGxvZ0RhdGEgPSB7fTtcbiAgICAgICAgICAgICAgaWYgKCFldmVudENvbmZpZy5rZXlzIHx8IGV2ZW50Q29uZmlnLmtleXMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgbG9nRGF0YSA9IGV2ZW50O1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGV2ZW50Q29uZmlnLmtleXMuZm9yRWFjaChrZXlQYXRoID0+IHtcbiAgICAgICAgICAgICAgICAgIGxvZ0RhdGFba2V5UGF0aF0gPSBfLmdldChldmVudCwga2V5UGF0aCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAvLyBWYWxpZGF0ZSBsb2cgbGV2ZWwgZXhpc3RzLCBmYWxsYmFjayB0byAnaW5mbydcbiAgICAgICAgICAgICAgY29uc3QgbG9nTGV2ZWwgPSB0eXBlb2YgbG9nZ2VyW2V2ZW50Q29uZmlnLmxvZ0xldmVsXSA9PT0gJ2Z1bmN0aW9uJyA/IGV2ZW50Q29uZmlnLmxvZ0xldmVsIDogJ2luZm8nO1xuXG4gICAgICAgICAgICAgIC8vIFNhZmUgSlNPTiBzZXJpYWxpemF0aW9uIHdpdGggTWFwL1NldCBhbmQgY2lyY3VsYXIgcmVmZXJlbmNlIHN1cHBvcnRcbiAgICAgICAgICAgICAgY29uc3QgbG9nTWVzc2FnZSA9IGBNb25nb0RCIGNsaWVudCBldmVudCAke2V2ZW50Q29uZmlnLm5hbWV9OiAke0pTT04uc3RyaW5naWZ5KGxvZ0RhdGEsIFV0aWxzLmdldENpcmN1bGFyUmVwbGFjZXIoKSl9YDtcblxuICAgICAgICAgICAgICBsb2dnZXJbbG9nTGV2ZWxdKGxvZ01lc3NhZ2UpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmNsaWVudCA9IGNsaWVudDtcbiAgICAgICAgdGhpcy5kYXRhYmFzZSA9IGRhdGFiYXNlO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4ge1xuICAgICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KGVycik7XG4gICAgICB9KTtcblxuICAgIHJldHVybiB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICB9XG5cbiAgaGFuZGxlRXJyb3I8VD4oZXJyb3I6ID8oRXJyb3IgfCBQYXJzZS5FcnJvcikpOiBQcm9taXNlPFQ+IHtcbiAgICBpZiAoZXJyb3IgJiYgZXJyb3IuY29kZSA9PT0gMTMpIHtcbiAgICAgIC8vIFVuYXV0aG9yaXplZCBlcnJvclxuICAgICAgZGVsZXRlIHRoaXMuY2xpZW50O1xuICAgICAgZGVsZXRlIHRoaXMuZGF0YWJhc2U7XG4gICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgIGxvZ2dlci5lcnJvcignUmVjZWl2ZWQgdW5hdXRob3JpemVkIGVycm9yJywgeyBlcnJvcjogZXJyb3IgfSk7XG4gICAgfVxuICAgIHRocm93IGVycm9yO1xuICB9XG5cbiAgYXN5bmMgaGFuZGxlU2h1dGRvd24oKSB7XG4gICAgaWYgKCF0aGlzLmNsaWVudCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLmNsaWVudC5jbG9zZShmYWxzZSk7XG4gICAgZGVsZXRlIHRoaXMuY29ubmVjdGlvblByb21pc2U7XG4gIH1cblxuICBfYWRhcHRpdmVDb2xsZWN0aW9uKG5hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLmNvbm5lY3QoKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5kYXRhYmFzZS5jb2xsZWN0aW9uKHRoaXMuX2NvbGxlY3Rpb25QcmVmaXggKyBuYW1lKSlcbiAgICAgIC50aGVuKHJhd0NvbGxlY3Rpb24gPT4gbmV3IE1vbmdvQ29sbGVjdGlvbihyYXdDb2xsZWN0aW9uKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIF9zY2hlbWFDb2xsZWN0aW9uKCk6IFByb21pc2U8TW9uZ29TY2hlbWFDb2xsZWN0aW9uPiB7XG4gICAgcmV0dXJuIHRoaXMuY29ubmVjdCgpXG4gICAgICAudGhlbigoKSA9PiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oTW9uZ29TY2hlbWFDb2xsZWN0aW9uTmFtZSkpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IHtcbiAgICAgICAgaWYgKCF0aGlzLl9zdHJlYW0gJiYgdGhpcy5lbmFibGVTY2hlbWFIb29rcykge1xuICAgICAgICAgIHRoaXMuX3N0cmVhbSA9IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi53YXRjaCgpO1xuICAgICAgICAgIHRoaXMuX3N0cmVhbS5vbignY2hhbmdlJywgKCkgPT4gdGhpcy5fb25jaGFuZ2UoKSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG5ldyBNb25nb1NjaGVtYUNvbGxlY3Rpb24oY29sbGVjdGlvbik7XG4gICAgICB9KTtcbiAgfVxuXG4gIGNsYXNzRXhpc3RzKG5hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLmNvbm5lY3QoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gdGhpcy5kYXRhYmFzZS5saXN0Q29sbGVjdGlvbnMoeyBuYW1lOiB0aGlzLl9jb2xsZWN0aW9uUHJlZml4ICsgbmFtZSB9KS50b0FycmF5KCk7XG4gICAgICB9KVxuICAgICAgLnRoZW4oY29sbGVjdGlvbnMgPT4ge1xuICAgICAgICByZXR1cm4gY29sbGVjdGlvbnMubGVuZ3RoID4gMDtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBzZXRDbGFzc0xldmVsUGVybWlzc2lvbnMoY2xhc3NOYW1lOiBzdHJpbmcsIENMUHM6IGFueSk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKClcbiAgICAgIC50aGVuKHNjaGVtYUNvbGxlY3Rpb24gPT5cbiAgICAgICAgc2NoZW1hQ29sbGVjdGlvbi51cGRhdGVTY2hlbWEoY2xhc3NOYW1lLCB7XG4gICAgICAgICAgJHNldDogeyAnX21ldGFkYXRhLmNsYXNzX3Blcm1pc3Npb25zJzogQ0xQcyB9LFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgc2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc3VibWl0dGVkSW5kZXhlczogYW55LFxuICAgIGV4aXN0aW5nSW5kZXhlczogYW55ID0ge30sXG4gICAgZmllbGRzOiBhbnlcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHN1Ym1pdHRlZEluZGV4ZXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cbiAgICBpZiAoT2JqZWN0LmtleXMoZXhpc3RpbmdJbmRleGVzKS5sZW5ndGggPT09IDApIHtcbiAgICAgIGV4aXN0aW5nSW5kZXhlcyA9IHsgX2lkXzogeyBfaWQ6IDEgfSB9O1xuICAgIH1cbiAgICBjb25zdCBkZWxldGVQcm9taXNlcyA9IFtdO1xuICAgIGNvbnN0IGluc2VydGVkSW5kZXhlcyA9IFtdO1xuICAgIE9iamVjdC5rZXlzKHN1Ym1pdHRlZEluZGV4ZXMpLmZvckVhY2gobmFtZSA9PiB7XG4gICAgICBjb25zdCBmaWVsZCA9IHN1Ym1pdHRlZEluZGV4ZXNbbmFtZV07XG4gICAgICBpZiAoZXhpc3RpbmdJbmRleGVzW25hbWVdICYmIGZpZWxkLl9fb3AgIT09ICdEZWxldGUnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLCBgSW5kZXggJHtuYW1lfSBleGlzdHMsIGNhbm5vdCB1cGRhdGUuYCk7XG4gICAgICB9XG4gICAgICBpZiAoIWV4aXN0aW5nSW5kZXhlc1tuYW1lXSAmJiBmaWVsZC5fX29wID09PSAnRGVsZXRlJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgICBgSW5kZXggJHtuYW1lfSBkb2VzIG5vdCBleGlzdCwgY2Fubm90IGRlbGV0ZS5gXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoZmllbGQuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgY29uc3QgcHJvbWlzZSA9IHRoaXMuZHJvcEluZGV4KGNsYXNzTmFtZSwgbmFtZSk7XG4gICAgICAgIGRlbGV0ZVByb21pc2VzLnB1c2gocHJvbWlzZSk7XG4gICAgICAgIGRlbGV0ZSBleGlzdGluZ0luZGV4ZXNbbmFtZV07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBPYmplY3Qua2V5cyhmaWVsZCkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICF0aGlzLmRpc2FibGVJbmRleEZpZWxkVmFsaWRhdGlvbiAmJlxuICAgICAgICAgICAgIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChcbiAgICAgICAgICAgICAgZmllbGRzLFxuICAgICAgICAgICAgICBrZXkuaW5kZXhPZignX3BfJykgPT09IDAgPyBrZXkucmVwbGFjZSgnX3BfJywgJycpIDoga2V5XG4gICAgICAgICAgICApXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgICAgIGBGaWVsZCAke2tleX0gZG9lcyBub3QgZXhpc3QsIGNhbm5vdCBhZGQgaW5kZXguYFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICBleGlzdGluZ0luZGV4ZXNbbmFtZV0gPSBmaWVsZDtcbiAgICAgICAgaW5zZXJ0ZWRJbmRleGVzLnB1c2goe1xuICAgICAgICAgIGtleTogZmllbGQsXG4gICAgICAgICAgbmFtZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgbGV0IGluc2VydFByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBpZiAoaW5zZXJ0ZWRJbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgIGluc2VydFByb21pc2UgPSB0aGlzLmNyZWF0ZUluZGV4ZXMoY2xhc3NOYW1lLCBpbnNlcnRlZEluZGV4ZXMpO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwoZGVsZXRlUHJvbWlzZXMpXG4gICAgICAudGhlbigoKSA9PiBpbnNlcnRQcm9taXNlKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PlxuICAgICAgICBzY2hlbWFDb2xsZWN0aW9uLnVwZGF0ZVNjaGVtYShjbGFzc05hbWUsIHtcbiAgICAgICAgICAkc2V0OiB7ICdfbWV0YWRhdGEuaW5kZXhlcyc6IGV4aXN0aW5nSW5kZXhlcyB9LFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgc2V0SW5kZXhlc0Zyb21Nb25nbyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLmdldEluZGV4ZXMoY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oaW5kZXhlcyA9PiB7XG4gICAgICAgIGluZGV4ZXMgPSBpbmRleGVzLnJlZHVjZSgob2JqLCBpbmRleCkgPT4ge1xuICAgICAgICAgIGlmIChpbmRleC5rZXkuX2Z0cykge1xuICAgICAgICAgICAgZGVsZXRlIGluZGV4LmtleS5fZnRzO1xuICAgICAgICAgICAgZGVsZXRlIGluZGV4LmtleS5fZnRzeDtcbiAgICAgICAgICAgIGZvciAoY29uc3QgZmllbGQgaW4gaW5kZXgud2VpZ2h0cykge1xuICAgICAgICAgICAgICBpbmRleC5rZXlbZmllbGRdID0gJ3RleHQnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBvYmpbaW5kZXgubmFtZV0gPSBpbmRleC5rZXk7XG4gICAgICAgICAgcmV0dXJuIG9iajtcbiAgICAgICAgfSwge30pO1xuICAgICAgICByZXR1cm4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PlxuICAgICAgICAgIHNjaGVtYUNvbGxlY3Rpb24udXBkYXRlU2NoZW1hKGNsYXNzTmFtZSwge1xuICAgICAgICAgICAgJHNldDogeyAnX21ldGFkYXRhLmluZGV4ZXMnOiBpbmRleGVzIH0sXG4gICAgICAgICAgfSlcbiAgICAgICAgKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSlcbiAgICAgIC5jYXRjaCgoKSA9PiB7XG4gICAgICAgIC8vIElnbm9yZSBpZiBjb2xsZWN0aW9uIG5vdCBmb3VuZFxuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICB9KTtcbiAgfVxuXG4gIGNyZWF0ZUNsYXNzKGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29PYmplY3QgPSBtb25nb1NjaGVtYUZyb21GaWVsZHNBbmRDbGFzc05hbWVBbmRDTFAoXG4gICAgICBzY2hlbWEuZmllbGRzLFxuICAgICAgY2xhc3NOYW1lLFxuICAgICAgc2NoZW1hLmNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgIHNjaGVtYS5pbmRleGVzXG4gICAgKTtcbiAgICBtb25nb09iamVjdC5faWQgPSBjbGFzc05hbWU7XG4gICAgcmV0dXJuIHRoaXMuc2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQoY2xhc3NOYW1lLCBzY2hlbWEuaW5kZXhlcywge30sIHNjaGVtYS5maWVsZHMpXG4gICAgICAudGhlbigoKSA9PiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKCkpXG4gICAgICAudGhlbihzY2hlbWFDb2xsZWN0aW9uID0+IHNjaGVtYUNvbGxlY3Rpb24uaW5zZXJ0U2NoZW1hKG1vbmdvT2JqZWN0KSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGFzeW5jIHVwZGF0ZUZpZWxkT3B0aW9ucyhjbGFzc05hbWU6IHN0cmluZywgZmllbGROYW1lOiBzdHJpbmcsIHR5cGU6IGFueSkge1xuICAgIGNvbnN0IHNjaGVtYUNvbGxlY3Rpb24gPSBhd2FpdCB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKCk7XG4gICAgYXdhaXQgc2NoZW1hQ29sbGVjdGlvbi51cGRhdGVGaWVsZE9wdGlvbnMoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHR5cGUpO1xuICB9XG5cbiAgYWRkRmllbGRJZk5vdEV4aXN0cyhjbGFzc05hbWU6IHN0cmluZywgZmllbGROYW1lOiBzdHJpbmcsIHR5cGU6IGFueSk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKClcbiAgICAgIC50aGVuKHNjaGVtYUNvbGxlY3Rpb24gPT4gc2NoZW1hQ29sbGVjdGlvbi5hZGRGaWVsZElmTm90RXhpc3RzKGNsYXNzTmFtZSwgZmllbGROYW1lLCB0eXBlKSlcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuY3JlYXRlSW5kZXhlc0lmTmVlZGVkKGNsYXNzTmFtZSwgZmllbGROYW1lLCB0eXBlKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIERyb3BzIGEgY29sbGVjdGlvbi4gUmVzb2x2ZXMgd2l0aCB0cnVlIGlmIGl0IHdhcyBhIFBhcnNlIFNjaGVtYSAoZWcuIF9Vc2VyLCBDdXN0b20sIGV0Yy4pXG4gIC8vIGFuZCByZXNvbHZlcyB3aXRoIGZhbHNlIGlmIGl0IHdhc24ndCAoZWcuIGEgam9pbiB0YWJsZSkuIFJlamVjdHMgaWYgZGVsZXRpb24gd2FzIGltcG9zc2libGUuXG4gIGRlbGV0ZUNsYXNzKGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5kcm9wKCkpXG4gICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgLy8gJ25zIG5vdCBmb3VuZCcgbWVhbnMgY29sbGVjdGlvbiB3YXMgYWxyZWFkeSBnb25lLiBJZ25vcmUgZGVsZXRpb24gYXR0ZW1wdC5cbiAgICAgICAgICBpZiAoZXJyb3IubWVzc2FnZSA9PSAnbnMgbm90IGZvdW5kJykge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSlcbiAgICAgICAgLy8gV2UndmUgZHJvcHBlZCB0aGUgY29sbGVjdGlvbiwgbm93IHJlbW92ZSB0aGUgX1NDSEVNQSBkb2N1bWVudFxuICAgICAgICAudGhlbigoKSA9PiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKCkpXG4gICAgICAgIC50aGVuKHNjaGVtYUNvbGxlY3Rpb24gPT4gc2NoZW1hQ29sbGVjdGlvbi5maW5kQW5kRGVsZXRlU2NoZW1hKGNsYXNzTmFtZSkpXG4gICAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKVxuICAgICk7XG4gIH1cblxuICBkZWxldGVBbGxDbGFzc2VzKGZhc3Q6IGJvb2xlYW4pIHtcbiAgICByZXR1cm4gc3RvcmFnZUFkYXB0ZXJBbGxDb2xsZWN0aW9ucyh0aGlzKS50aGVuKGNvbGxlY3Rpb25zID0+XG4gICAgICBQcm9taXNlLmFsbChcbiAgICAgICAgY29sbGVjdGlvbnMubWFwKGNvbGxlY3Rpb24gPT4gKGZhc3QgPyBjb2xsZWN0aW9uLmRlbGV0ZU1hbnkoe30pIDogY29sbGVjdGlvbi5kcm9wKCkpKVxuICAgICAgKVxuICAgICk7XG4gIH1cblxuICAvLyBSZW1vdmUgdGhlIGNvbHVtbiBhbmQgYWxsIHRoZSBkYXRhLiBGb3IgUmVsYXRpb25zLCB0aGUgX0pvaW4gY29sbGVjdGlvbiBpcyBoYW5kbGVkXG4gIC8vIHNwZWNpYWxseSwgdGhpcyBmdW5jdGlvbiBkb2VzIG5vdCBkZWxldGUgX0pvaW4gY29sdW1ucy4gSXQgc2hvdWxkLCBob3dldmVyLCBpbmRpY2F0ZVxuICAvLyB0aGF0IHRoZSByZWxhdGlvbiBmaWVsZHMgZG9lcyBub3QgZXhpc3QgYW55bW9yZS4gSW4gbW9uZ28sIHRoaXMgbWVhbnMgcmVtb3ZpbmcgaXQgZnJvbVxuICAvLyB0aGUgX1NDSEVNQSBjb2xsZWN0aW9uLiAgVGhlcmUgc2hvdWxkIGJlIG5vIGFjdHVhbCBkYXRhIGluIHRoZSBjb2xsZWN0aW9uIHVuZGVyIHRoZSBzYW1lIG5hbWVcbiAgLy8gYXMgdGhlIHJlbGF0aW9uIGNvbHVtbiwgc28gaXQncyBmaW5lIHRvIGF0dGVtcHQgdG8gZGVsZXRlIGl0LiBJZiB0aGUgZmllbGRzIGxpc3RlZCB0byBiZVxuICAvLyBkZWxldGVkIGRvIG5vdCBleGlzdCwgdGhpcyBmdW5jdGlvbiBzaG91bGQgcmV0dXJuIHN1Y2Nlc3NmdWxseSBhbnl3YXlzLiBDaGVja2luZyBmb3JcbiAgLy8gYXR0ZW1wdHMgdG8gZGVsZXRlIG5vbi1leGlzdGVudCBmaWVsZHMgaXMgdGhlIHJlc3BvbnNpYmlsaXR5IG9mIFBhcnNlIFNlcnZlci5cblxuICAvLyBQb2ludGVyIGZpZWxkIG5hbWVzIGFyZSBwYXNzZWQgZm9yIGxlZ2FjeSByZWFzb25zOiB0aGUgb3JpZ2luYWwgbW9uZ29cbiAgLy8gZm9ybWF0IHN0b3JlZCBwb2ludGVyIGZpZWxkIG5hbWVzIGRpZmZlcmVudGx5IGluIHRoZSBkYXRhYmFzZSwgYW5kIHRoZXJlZm9yZVxuICAvLyBuZWVkZWQgdG8ga25vdyB0aGUgdHlwZSBvZiB0aGUgZmllbGQgYmVmb3JlIGl0IGNvdWxkIGRlbGV0ZSBpdC4gRnV0dXJlIGRhdGFiYXNlXG4gIC8vIGFkYXB0ZXJzIHNob3VsZCBpZ25vcmUgdGhlIHBvaW50ZXJGaWVsZE5hbWVzIGFyZ3VtZW50LiBBbGwgdGhlIGZpZWxkIG5hbWVzIGFyZSBpblxuICAvLyBmaWVsZE5hbWVzLCB0aGV5IHNob3cgdXAgYWRkaXRpb25hbGx5IGluIHRoZSBwb2ludGVyRmllbGROYW1lcyBkYXRhYmFzZSBmb3IgdXNlXG4gIC8vIGJ5IHRoZSBtb25nbyBhZGFwdGVyLCB3aGljaCBkZWFscyB3aXRoIHRoZSBsZWdhY3kgbW9uZ28gZm9ybWF0LlxuXG4gIC8vIFRoaXMgZnVuY3Rpb24gaXMgbm90IG9ibGlnYXRlZCB0byBkZWxldGUgZmllbGRzIGF0b21pY2FsbHkuIEl0IGlzIGdpdmVuIHRoZSBmaWVsZFxuICAvLyBuYW1lcyBpbiBhIGxpc3Qgc28gdGhhdCBkYXRhYmFzZXMgdGhhdCBhcmUgY2FwYWJsZSBvZiBkZWxldGluZyBmaWVsZHMgYXRvbWljYWxseVxuICAvLyBtYXkgZG8gc28uXG5cbiAgLy8gUmV0dXJucyBhIFByb21pc2UuXG4gIGRlbGV0ZUZpZWxkcyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBmaWVsZE5hbWVzOiBzdHJpbmdbXSkge1xuICAgIGNvbnN0IG1vbmdvRm9ybWF0TmFtZXMgPSBmaWVsZE5hbWVzLm1hcChmaWVsZE5hbWUgPT4ge1xuICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgcmV0dXJuIGBfcF8ke2ZpZWxkTmFtZX1gO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIGZpZWxkTmFtZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBjb25zdCBjb2xsZWN0aW9uVXBkYXRlID0geyAkdW5zZXQ6IHt9IH07XG4gICAgbW9uZ29Gb3JtYXROYW1lcy5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgY29sbGVjdGlvblVwZGF0ZVsnJHVuc2V0J11bbmFtZV0gPSBudWxsO1xuICAgIH0pO1xuXG4gICAgY29uc3QgY29sbGVjdGlvbkZpbHRlciA9IHsgJG9yOiBbXSB9O1xuICAgIG1vbmdvRm9ybWF0TmFtZXMuZm9yRWFjaChuYW1lID0+IHtcbiAgICAgIGNvbGxlY3Rpb25GaWx0ZXJbJyRvciddLnB1c2goeyBbbmFtZV06IHsgJGV4aXN0czogdHJ1ZSB9IH0pO1xuICAgIH0pO1xuXG4gICAgY29uc3Qgc2NoZW1hVXBkYXRlID0geyAkdW5zZXQ6IHt9IH07XG4gICAgZmllbGROYW1lcy5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgc2NoZW1hVXBkYXRlWyckdW5zZXQnXVtuYW1lXSA9IG51bGw7XG4gICAgICBzY2hlbWFVcGRhdGVbJyR1bnNldCddW2BfbWV0YWRhdGEuZmllbGRzX29wdGlvbnMuJHtuYW1lfWBdID0gbnVsbDtcbiAgICB9KTtcblxuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLnVwZGF0ZU1hbnkoY29sbGVjdGlvbkZpbHRlciwgY29sbGVjdGlvblVwZGF0ZSkpXG4gICAgICAudGhlbigoKSA9PiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKCkpXG4gICAgICAudGhlbihzY2hlbWFDb2xsZWN0aW9uID0+IHNjaGVtYUNvbGxlY3Rpb24udXBkYXRlU2NoZW1hKGNsYXNzTmFtZSwgc2NoZW1hVXBkYXRlKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFJldHVybiBhIHByb21pc2UgZm9yIGFsbCBzY2hlbWFzIGtub3duIHRvIHRoaXMgYWRhcHRlciwgaW4gUGFyc2UgZm9ybWF0LiBJbiBjYXNlIHRoZVxuICAvLyBzY2hlbWFzIGNhbm5vdCBiZSByZXRyaWV2ZWQsIHJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVqZWN0cy4gUmVxdWlyZW1lbnRzIGZvciB0aGVcbiAgLy8gcmVqZWN0aW9uIHJlYXNvbiBhcmUgVEJELlxuICBnZXRBbGxDbGFzc2VzKCk6IFByb21pc2U8U3RvcmFnZUNsYXNzW10+IHtcbiAgICByZXR1cm4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpXG4gICAgICAudGhlbihzY2hlbWFzQ29sbGVjdGlvbiA9PiBzY2hlbWFzQ29sbGVjdGlvbi5fZmV0Y2hBbGxTY2hlbWFzRnJvbV9TQ0hFTUEoKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFJldHVybiBhIHByb21pc2UgZm9yIHRoZSBzY2hlbWEgd2l0aCB0aGUgZ2l2ZW4gbmFtZSwgaW4gUGFyc2UgZm9ybWF0LiBJZlxuICAvLyB0aGlzIGFkYXB0ZXIgZG9lc24ndCBrbm93IGFib3V0IHRoZSBzY2hlbWEsIHJldHVybiBhIHByb21pc2UgdGhhdCByZWplY3RzIHdpdGhcbiAgLy8gdW5kZWZpbmVkIGFzIHRoZSByZWFzb24uXG4gIGdldENsYXNzKGNsYXNzTmFtZTogc3RyaW5nKTogUHJvbWlzZTxTdG9yYWdlQ2xhc3M+IHtcbiAgICByZXR1cm4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpXG4gICAgICAudGhlbihzY2hlbWFzQ29sbGVjdGlvbiA9PiBzY2hlbWFzQ29sbGVjdGlvbi5fZmV0Y2hPbmVTY2hlbWFGcm9tX1NDSEVNQShjbGFzc05hbWUpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gVE9ETzogQXMgeWV0IG5vdCBwYXJ0aWN1bGFybHkgd2VsbCBzcGVjaWZpZWQuIENyZWF0ZXMgYW4gb2JqZWN0LiBNYXliZSBzaG91bGRuJ3QgZXZlbiBuZWVkIHRoZSBzY2hlbWEsXG4gIC8vIGFuZCBzaG91bGQgaW5mZXIgZnJvbSB0aGUgdHlwZS4gT3IgbWF5YmUgZG9lcyBuZWVkIHRoZSBzY2hlbWEgZm9yIHZhbGlkYXRpb25zLiBPciBtYXliZSBuZWVkc1xuICAvLyB0aGUgc2NoZW1hIG9ubHkgZm9yIHRoZSBsZWdhY3kgbW9uZ28gZm9ybWF0LiBXZSdsbCBmaWd1cmUgdGhhdCBvdXQgbGF0ZXIuXG4gIGNyZWF0ZU9iamVjdChjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBvYmplY3Q6IGFueSwgdHJhbnNhY3Rpb25hbFNlc3Npb246ID9hbnkpIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29PYmplY3QgPSBwYXJzZU9iamVjdFRvTW9uZ29PYmplY3RGb3JDcmVhdGUoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uaW5zZXJ0T25lKG1vbmdvT2JqZWN0LCB0cmFuc2FjdGlvbmFsU2Vzc2lvbikpXG4gICAgICAudGhlbigoKSA9PiAoeyBvcHM6IFttb25nb09iamVjdF0gfSkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gMTEwMDApIHtcbiAgICAgICAgICAvLyBEdXBsaWNhdGUgdmFsdWVcbiAgICAgICAgICBjb25zdCBlcnIgPSBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsXG4gICAgICAgICAgICAnQSBkdXBsaWNhdGUgdmFsdWUgZm9yIGEgZmllbGQgd2l0aCB1bmlxdWUgdmFsdWVzIHdhcyBwcm92aWRlZCdcbiAgICAgICAgICApO1xuICAgICAgICAgIGVyci51bmRlcmx5aW5nRXJyb3IgPSBlcnJvcjtcbiAgICAgICAgICBpZiAoZXJyb3IubWVzc2FnZSkge1xuICAgICAgICAgICAgY29uc3QgbWF0Y2hlcyA9IGVycm9yLm1lc3NhZ2UubWF0Y2goL2luZGV4OltcXHNhLXpBLVowLTlfXFwtXFwuXStcXCQ/KFthLXpBLVpfLV0rKV8xLyk7XG4gICAgICAgICAgICBpZiAobWF0Y2hlcyAmJiBBcnJheS5pc0FycmF5KG1hdGNoZXMpKSB7XG4gICAgICAgICAgICAgIGVyci51c2VySW5mbyA9IHsgZHVwbGljYXRlZF9maWVsZDogbWF0Y2hlc1sxXSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gUmVtb3ZlIGFsbCBvYmplY3RzIHRoYXQgbWF0Y2ggdGhlIGdpdmVuIFBhcnNlIFF1ZXJ5LlxuICAvLyBJZiBubyBvYmplY3RzIG1hdGNoLCByZWplY3Qgd2l0aCBPQkpFQ1RfTk9UX0ZPVU5ELiBJZiBvYmplY3RzIGFyZSBmb3VuZCBhbmQgZGVsZXRlZCwgcmVzb2x2ZSB3aXRoIHVuZGVmaW5lZC5cbiAgLy8gSWYgdGhlcmUgaXMgc29tZSBvdGhlciBlcnJvciwgcmVqZWN0IHdpdGggSU5URVJOQUxfU0VSVkVSX0VSUk9SLlxuICBkZWxldGVPYmplY3RzQnlRdWVyeShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbjogP2FueVxuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IHtcbiAgICAgICAgY29uc3QgbW9uZ29XaGVyZSA9IHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSk7XG4gICAgICAgIHJldHVybiBjb2xsZWN0aW9uLmRlbGV0ZU1hbnkobW9uZ29XaGVyZSwgdHJhbnNhY3Rpb25hbFNlc3Npb24pO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKVxuICAgICAgLnRoZW4oXG4gICAgICAgICh7IGRlbGV0ZWRDb3VudCB9KSA9PiB7XG4gICAgICAgICAgaWYgKGRlbGV0ZWRDb3VudCA9PT0gMCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdPYmplY3Qgbm90IGZvdW5kLicpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH0sXG4gICAgICAgICgpID0+IHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLCAnRGF0YWJhc2UgYWRhcHRlciBlcnJvcicpO1xuICAgICAgICB9XG4gICAgICApO1xuICB9XG5cbiAgLy8gQXBwbHkgdGhlIHVwZGF0ZSB0byBhbGwgb2JqZWN0cyB0aGF0IG1hdGNoIHRoZSBnaXZlbiBQYXJzZSBRdWVyeS5cbiAgdXBkYXRlT2JqZWN0c0J5UXVlcnkoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgdXBkYXRlOiBhbnksXG4gICAgdHJhbnNhY3Rpb25hbFNlc3Npb246ID9hbnlcbiAgKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvVXBkYXRlID0gdHJhbnNmb3JtVXBkYXRlKGNsYXNzTmFtZSwgdXBkYXRlLCBzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvV2hlcmUgPSB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLnVwZGF0ZU1hbnkobW9uZ29XaGVyZSwgbW9uZ29VcGRhdGUsIHRyYW5zYWN0aW9uYWxTZXNzaW9uKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIEF0b21pY2FsbHkgZmluZHMgYW5kIHVwZGF0ZXMgYW4gb2JqZWN0IGJhc2VkIG9uIHF1ZXJ5LlxuICAvLyBSZXR1cm4gdmFsdWUgbm90IGN1cnJlbnRseSB3ZWxsIHNwZWNpZmllZC5cbiAgZmluZE9uZUFuZFVwZGF0ZShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB1cGRhdGU6IGFueSxcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbjogP2FueVxuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29VcGRhdGUgPSB0cmFuc2Zvcm1VcGRhdGUoY2xhc3NOYW1lLCB1cGRhdGUsIHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29XaGVyZSA9IHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5maW5kT25lQW5kVXBkYXRlKG1vbmdvV2hlcmUsIG1vbmdvVXBkYXRlLCB7XG4gICAgICAgICAgcmV0dXJuRG9jdW1lbnQ6ICdhZnRlcicsXG4gICAgICAgICAgc2Vzc2lvbjogdHJhbnNhY3Rpb25hbFNlc3Npb24gfHwgdW5kZWZpbmVkLFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLnRoZW4ocmVzdWx0ID0+IG1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIHJlc3VsdCwgc2NoZW1hKSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSAxMTAwMCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gSG9wZWZ1bGx5IHdlIGNhbiBnZXQgcmlkIG9mIHRoaXMuIEl0J3Mgb25seSB1c2VkIGZvciBjb25maWcgYW5kIGhvb2tzLlxuICB1cHNlcnRPbmVPYmplY3QoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgdXBkYXRlOiBhbnksXG4gICAgdHJhbnNhY3Rpb25hbFNlc3Npb246ID9hbnlcbiAgKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvVXBkYXRlID0gdHJhbnNmb3JtVXBkYXRlKGNsYXNzTmFtZSwgdXBkYXRlLCBzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvV2hlcmUgPSB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLnVwc2VydE9uZShtb25nb1doZXJlLCBtb25nb1VwZGF0ZSwgdHJhbnNhY3Rpb25hbFNlc3Npb24pKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gRXhlY3V0ZXMgYSBmaW5kLiBBY2NlcHRzOiBjbGFzc05hbWUsIHF1ZXJ5IGluIFBhcnNlIGZvcm1hdCwgYW5kIHsgc2tpcCwgbGltaXQsIHNvcnQgfS5cbiAgZmluZChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB7XG4gICAgICBza2lwLFxuICAgICAgbGltaXQsXG4gICAgICBzb3J0LFxuICAgICAga2V5cyxcbiAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgICAgaGludCxcbiAgICAgIGNhc2VJbnNlbnNpdGl2ZSxcbiAgICAgIGV4cGxhaW4sXG4gICAgICBjb21tZW50LFxuICAgIH06IFF1ZXJ5T3B0aW9uc1xuICApOiBQcm9taXNlPGFueT4ge1xuICAgIHZhbGlkYXRlRXhwbGFpblZhbHVlKGV4cGxhaW4pO1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1doZXJlID0gdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1NvcnQgPSBfLm1hcEtleXMoc29ydCwgKHZhbHVlLCBmaWVsZE5hbWUpID0+XG4gICAgICB0cmFuc2Zvcm1LZXkoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHNjaGVtYSlcbiAgICApO1xuICAgIGNvbnN0IG1vbmdvS2V5cyA9IF8ucmVkdWNlKFxuICAgICAga2V5cyxcbiAgICAgIChtZW1vLCBrZXkpID0+IHtcbiAgICAgICAgaWYgKGtleSA9PT0gJ0FDTCcpIHtcbiAgICAgICAgICBtZW1vWydfcnBlcm0nXSA9IDE7XG4gICAgICAgICAgbWVtb1snX3dwZXJtJ10gPSAxO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG1lbW9bdHJhbnNmb3JtS2V5KGNsYXNzTmFtZSwga2V5LCBzY2hlbWEpXSA9IDE7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG1lbW87XG4gICAgICB9LFxuICAgICAge31cbiAgICApO1xuXG4gICAgLy8gSWYgd2UgYXJlbid0IHJlcXVlc3RpbmcgdGhlIGBfaWRgIGZpZWxkLCB3ZSBuZWVkIHRvIGV4cGxpY2l0bHkgb3B0IG91dFxuICAgIC8vIG9mIGl0LiBEb2luZyBzbyBpbiBwYXJzZS1zZXJ2ZXIgaXMgdW51c3VhbCwgYnV0IGl0IGNhbiBhbGxvdyB1cyB0b1xuICAgIC8vIG9wdGltaXplIHNvbWUgcXVlcmllcyB3aXRoIGNvdmVyaW5nIGluZGV4ZXMuXG4gICAgaWYgKGtleXMgJiYgIW1vbmdvS2V5cy5faWQpIHtcbiAgICAgIG1vbmdvS2V5cy5faWQgPSAwO1xuICAgIH1cblxuICAgIHJlYWRQcmVmZXJlbmNlID0gdGhpcy5fcGFyc2VSZWFkUHJlZmVyZW5jZShyZWFkUHJlZmVyZW5jZSk7XG4gICAgcmV0dXJuIHRoaXMuY3JlYXRlVGV4dEluZGV4ZXNJZk5lZWRlZChjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpXG4gICAgICAudGhlbigoKSA9PiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT5cbiAgICAgICAgY29sbGVjdGlvbi5maW5kKG1vbmdvV2hlcmUsIHtcbiAgICAgICAgICBza2lwLFxuICAgICAgICAgIGxpbWl0LFxuICAgICAgICAgIHNvcnQ6IG1vbmdvU29ydCxcbiAgICAgICAgICBrZXlzOiBtb25nb0tleXMsXG4gICAgICAgICAgbWF4VGltZU1TOiB0aGlzLl9tYXhUaW1lTVMsXG4gICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgaGludCxcbiAgICAgICAgICBjYXNlSW5zZW5zaXRpdmUsXG4gICAgICAgICAgZXhwbGFpbixcbiAgICAgICAgICBjb21tZW50LFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLnRoZW4ob2JqZWN0cyA9PiB7XG4gICAgICAgIGlmIChleHBsYWluKSB7XG4gICAgICAgICAgcmV0dXJuIG9iamVjdHM7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG9iamVjdHMubWFwKG9iamVjdCA9PiBtb25nb09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSkpO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGVuc3VyZUluZGV4KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBmaWVsZE5hbWVzOiBzdHJpbmdbXSxcbiAgICBpbmRleE5hbWU6ID9zdHJpbmcsXG4gICAgY2FzZUluc2Vuc2l0aXZlOiBib29sZWFuID0gZmFsc2UsXG4gICAgb3B0aW9ucz86IE9iamVjdCA9IHt9XG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IGluZGV4Q3JlYXRpb25SZXF1ZXN0ID0ge307XG4gICAgY29uc3QgbW9uZ29GaWVsZE5hbWVzID0gZmllbGROYW1lcy5tYXAoZmllbGROYW1lID0+IHRyYW5zZm9ybUtleShjbGFzc05hbWUsIGZpZWxkTmFtZSwgc2NoZW1hKSk7XG4gICAgbW9uZ29GaWVsZE5hbWVzLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgIGluZGV4Q3JlYXRpb25SZXF1ZXN0W2ZpZWxkTmFtZV0gPSBvcHRpb25zLmluZGV4VHlwZSAhPT0gdW5kZWZpbmVkID8gb3B0aW9ucy5pbmRleFR5cGUgOiAxO1xuICAgIH0pO1xuXG4gICAgY29uc3QgZGVmYXVsdE9wdGlvbnM6IE9iamVjdCA9IHsgYmFja2dyb3VuZDogdHJ1ZSwgc3BhcnNlOiB0cnVlIH07XG4gICAgY29uc3QgaW5kZXhOYW1lT3B0aW9uczogT2JqZWN0ID0gaW5kZXhOYW1lID8geyBuYW1lOiBpbmRleE5hbWUgfSA6IHt9O1xuICAgIGNvbnN0IHR0bE9wdGlvbnM6IE9iamVjdCA9IG9wdGlvbnMudHRsICE9PSB1bmRlZmluZWQgPyB7IGV4cGlyZUFmdGVyU2Vjb25kczogb3B0aW9ucy50dGwgfSA6IHt9O1xuICAgIGNvbnN0IHNwYXJzZU9wdGlvbnM6IE9iamVjdCA9IG9wdGlvbnMuc3BhcnNlICE9PSB1bmRlZmluZWQgPyB7IHNwYXJzZTogb3B0aW9ucy5zcGFyc2UgfSA6IHt9O1xuICAgIGNvbnN0IGNhc2VJbnNlbnNpdGl2ZU9wdGlvbnM6IE9iamVjdCA9IGNhc2VJbnNlbnNpdGl2ZVxuICAgICAgPyB7IGNvbGxhdGlvbjogTW9uZ29Db2xsZWN0aW9uLmNhc2VJbnNlbnNpdGl2ZUNvbGxhdGlvbigpIH1cbiAgICAgIDoge307XG4gICAgY29uc3QgaW5kZXhPcHRpb25zOiBPYmplY3QgPSB7XG4gICAgICAuLi5kZWZhdWx0T3B0aW9ucyxcbiAgICAgIC4uLmNhc2VJbnNlbnNpdGl2ZU9wdGlvbnMsXG4gICAgICAuLi5pbmRleE5hbWVPcHRpb25zLFxuICAgICAgLi4udHRsT3B0aW9ucyxcbiAgICAgIC4uLnNwYXJzZU9wdGlvbnMsXG4gICAgfTtcblxuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uY3JlYXRlSW5kZXgoaW5kZXhDcmVhdGlvblJlcXVlc3QsIGluZGV4T3B0aW9ucylcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIENyZWF0ZSBhIHVuaXF1ZSBpbmRleC4gVW5pcXVlIGluZGV4ZXMgb24gbnVsbGFibGUgZmllbGRzIGFyZSBub3QgYWxsb3dlZC4gU2luY2Ugd2UgZG9uJ3RcbiAgLy8gY3VycmVudGx5IGtub3cgd2hpY2ggZmllbGRzIGFyZSBudWxsYWJsZSBhbmQgd2hpY2ggYXJlbid0LCB3ZSBpZ25vcmUgdGhhdCBjcml0ZXJpYS5cbiAgLy8gQXMgc3VjaCwgd2Ugc2hvdWxkbid0IGV4cG9zZSB0aGlzIGZ1bmN0aW9uIHRvIHVzZXJzIG9mIHBhcnNlIHVudGlsIHdlIGhhdmUgYW4gb3V0LW9mLWJhbmRcbiAgLy8gV2F5IG9mIGRldGVybWluaW5nIGlmIGEgZmllbGQgaXMgbnVsbGFibGUuIFVuZGVmaW5lZCBkb2Vzbid0IGNvdW50IGFnYWluc3QgdW5pcXVlbmVzcyxcbiAgLy8gd2hpY2ggaXMgd2h5IHdlIHVzZSBzcGFyc2UgaW5kZXhlcy5cbiAgZW5zdXJlVW5pcXVlbmVzcyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBmaWVsZE5hbWVzOiBzdHJpbmdbXSkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBpbmRleENyZWF0aW9uUmVxdWVzdCA9IHt9O1xuICAgIGNvbnN0IG1vbmdvRmllbGROYW1lcyA9IGZpZWxkTmFtZXMubWFwKGZpZWxkTmFtZSA9PiB0cmFuc2Zvcm1LZXkoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHNjaGVtYSkpO1xuICAgIG1vbmdvRmllbGROYW1lcy5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgICBpbmRleENyZWF0aW9uUmVxdWVzdFtmaWVsZE5hbWVdID0gMTtcbiAgICB9KTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5fZW5zdXJlU3BhcnNlVW5pcXVlSW5kZXhJbkJhY2tncm91bmQoaW5kZXhDcmVhdGlvblJlcXVlc3QpKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDExMDAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICAgJ1RyaWVkIHRvIGVuc3VyZSBmaWVsZCB1bmlxdWVuZXNzIGZvciBhIGNsYXNzIHRoYXQgYWxyZWFkeSBoYXMgZHVwbGljYXRlcy4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBVc2VkIGluIHRlc3RzXG4gIF9yYXdGaW5kKGNsYXNzTmFtZTogc3RyaW5nLCBxdWVyeTogUXVlcnlUeXBlKSB7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24uZmluZChxdWVyeSwge1xuICAgICAgICAgIG1heFRpbWVNUzogdGhpcy5fbWF4VGltZU1TLFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gRXhlY3V0ZXMgYSBjb3VudC5cbiAgY291bnQoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgcmVhZFByZWZlcmVuY2U6ID9zdHJpbmcsXG4gICAgX2VzdGltYXRlOiA/Ym9vbGVhbixcbiAgICBoaW50OiA/bWl4ZWQsXG4gICAgY29tbWVudDogP3N0cmluZ1xuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgcmVhZFByZWZlcmVuY2UgPSB0aGlzLl9wYXJzZVJlYWRQcmVmZXJlbmNlKHJlYWRQcmVmZXJlbmNlKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT5cbiAgICAgICAgY29sbGVjdGlvbi5jb3VudCh0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEsIHRydWUpLCB7XG4gICAgICAgICAgbWF4VGltZU1TOiB0aGlzLl9tYXhUaW1lTVMsXG4gICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgaGludCxcbiAgICAgICAgICBjb21tZW50LFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgZGlzdGluY3QoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgcXVlcnk6IFF1ZXJ5VHlwZSwgZmllbGROYW1lOiBzdHJpbmcpIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgaXNQb2ludGVyRmllbGQgPSBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdQb2ludGVyJztcbiAgICBjb25zdCB0cmFuc2Zvcm1GaWVsZCA9IHRyYW5zZm9ybUtleShjbGFzc05hbWUsIGZpZWxkTmFtZSwgc2NoZW1hKTtcblxuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLmRpc3RpbmN0KHRyYW5zZm9ybUZpZWxkLCB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpKVxuICAgICAgKVxuICAgICAgLnRoZW4ob2JqZWN0cyA9PiB7XG4gICAgICAgIG9iamVjdHMgPSBvYmplY3RzLmZpbHRlcihvYmogPT4gb2JqICE9IG51bGwpO1xuICAgICAgICByZXR1cm4gb2JqZWN0cy5tYXAob2JqZWN0ID0+IHtcbiAgICAgICAgICBpZiAoaXNQb2ludGVyRmllbGQpIHtcbiAgICAgICAgICAgIHJldHVybiB0cmFuc2Zvcm1Qb2ludGVyU3RyaW5nKHNjaGVtYSwgZmllbGROYW1lLCBvYmplY3QpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0KGNsYXNzTmFtZSwgb2JqZWN0LCBzY2hlbWEpO1xuICAgICAgICB9KTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBhZ2dyZWdhdGUoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBhbnksXG4gICAgcGlwZWxpbmU6IGFueSxcbiAgICByZWFkUHJlZmVyZW5jZTogP3N0cmluZyxcbiAgICBoaW50OiA/bWl4ZWQsXG4gICAgZXhwbGFpbj86IGJvb2xlYW4sXG4gICAgY29tbWVudDogP3N0cmluZ1xuICApIHtcbiAgICB2YWxpZGF0ZUV4cGxhaW5WYWx1ZShleHBsYWluKTtcbiAgICBsZXQgaXNQb2ludGVyRmllbGQgPSBmYWxzZTtcbiAgICBwaXBlbGluZSA9IHBpcGVsaW5lLm1hcChzdGFnZSA9PiB7XG4gICAgICBpZiAoc3RhZ2UuJGdyb3VwKSB7XG4gICAgICAgIHN0YWdlLiRncm91cCA9IHRoaXMuX3BhcnNlQWdncmVnYXRlR3JvdXBBcmdzKHNjaGVtYSwgc3RhZ2UuJGdyb3VwKTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHN0YWdlLiRncm91cC5faWQgJiZcbiAgICAgICAgICB0eXBlb2Ygc3RhZ2UuJGdyb3VwLl9pZCA9PT0gJ3N0cmluZycgJiZcbiAgICAgICAgICBzdGFnZS4kZ3JvdXAuX2lkLmluZGV4T2YoJyRfcF8nKSA+PSAwXG4gICAgICAgICkge1xuICAgICAgICAgIGlzUG9pbnRlckZpZWxkID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHN0YWdlLiRtYXRjaCkge1xuICAgICAgICBzdGFnZS4kbWF0Y2ggPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUFyZ3Moc2NoZW1hLCBzdGFnZS4kbWF0Y2gpO1xuICAgICAgfVxuICAgICAgaWYgKHN0YWdlLiRwcm9qZWN0KSB7XG4gICAgICAgIHN0YWdlLiRwcm9qZWN0ID0gdGhpcy5fcGFyc2VBZ2dyZWdhdGVQcm9qZWN0QXJncyhzY2hlbWEsIHN0YWdlLiRwcm9qZWN0KTtcbiAgICAgIH1cbiAgICAgIGlmIChzdGFnZS4kZ2VvTmVhciAmJiBzdGFnZS4kZ2VvTmVhci5xdWVyeSkge1xuICAgICAgICBzdGFnZS4kZ2VvTmVhci5xdWVyeSA9IHRoaXMuX3BhcnNlQWdncmVnYXRlQXJncyhzY2hlbWEsIHN0YWdlLiRnZW9OZWFyLnF1ZXJ5KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBzdGFnZTtcbiAgICB9KTtcbiAgICByZWFkUHJlZmVyZW5jZSA9IHRoaXMuX3BhcnNlUmVhZFByZWZlcmVuY2UocmVhZFByZWZlcmVuY2UpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLmFnZ3JlZ2F0ZShwaXBlbGluZSwge1xuICAgICAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgICAgICAgIG1heFRpbWVNUzogdGhpcy5fbWF4VGltZU1TLFxuICAgICAgICAgIGhpbnQsXG4gICAgICAgICAgZXhwbGFpbixcbiAgICAgICAgICBjb21tZW50LFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIHJlc3VsdHMuZm9yRWFjaChyZXN1bHQgPT4ge1xuICAgICAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocmVzdWx0LCAnX2lkJykpIHtcbiAgICAgICAgICAgIGlmIChpc1BvaW50ZXJGaWVsZCAmJiByZXN1bHQuX2lkKSB7XG4gICAgICAgICAgICAgIHJlc3VsdC5faWQgPSByZXN1bHQuX2lkLnNwbGl0KCckJylbMV07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgIHJlc3VsdC5faWQgPT0gbnVsbCB8fFxuICAgICAgICAgICAgICByZXN1bHQuX2lkID09IHVuZGVmaW5lZCB8fFxuICAgICAgICAgICAgICAoWydvYmplY3QnLCAnc3RyaW5nJ10uaW5jbHVkZXModHlwZW9mIHJlc3VsdC5faWQpICYmIF8uaXNFbXB0eShyZXN1bHQuX2lkKSlcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICByZXN1bHQuX2lkID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJlc3VsdC5vYmplY3RJZCA9IHJlc3VsdC5faWQ7XG4gICAgICAgICAgICBkZWxldGUgcmVzdWx0Ll9pZDtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gcmVzdWx0cztcbiAgICAgIH0pXG4gICAgICAudGhlbihvYmplY3RzID0+IG9iamVjdHMubWFwKG9iamVjdCA9PiBtb25nb09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSkpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gVGhpcyBmdW5jdGlvbiB3aWxsIHJlY3Vyc2l2ZWx5IHRyYXZlcnNlIHRoZSBwaXBlbGluZSBhbmQgY29udmVydCBhbnkgUG9pbnRlciBvciBEYXRlIGNvbHVtbnMuXG4gIC8vIElmIHdlIGRldGVjdCBhIHBvaW50ZXIgY29sdW1uIHdlIHdpbGwgcmVuYW1lIHRoZSBjb2x1bW4gYmVpbmcgcXVlcmllZCBmb3IgdG8gbWF0Y2ggdGhlIGNvbHVtblxuICAvLyBpbiB0aGUgZGF0YWJhc2UuIFdlIGFsc28gbW9kaWZ5IHRoZSB2YWx1ZSB0byB3aGF0IHdlIGV4cGVjdCB0aGUgdmFsdWUgdG8gYmUgaW4gdGhlIGRhdGFiYXNlXG4gIC8vIGFzIHdlbGwuXG4gIC8vIEZvciBkYXRlcywgdGhlIGRyaXZlciBleHBlY3RzIGEgRGF0ZSBvYmplY3QsIGJ1dCB3ZSBoYXZlIGEgc3RyaW5nIGNvbWluZyBpbi4gU28gd2UnbGwgY29udmVydFxuICAvLyB0aGUgc3RyaW5nIHRvIGEgRGF0ZSBzbyB0aGUgZHJpdmVyIGNhbiBwZXJmb3JtIHRoZSBuZWNlc3NhcnkgY29tcGFyaXNvbi5cbiAgLy9cbiAgLy8gVGhlIGdvYWwgb2YgdGhpcyBtZXRob2QgaXMgdG8gbG9vayBmb3IgdGhlIFwibGVhdmVzXCIgb2YgdGhlIHBpcGVsaW5lIGFuZCBkZXRlcm1pbmUgaWYgaXQgbmVlZHNcbiAgLy8gdG8gYmUgY29udmVydGVkLiBUaGUgcGlwZWxpbmUgY2FuIGhhdmUgYSBmZXcgZGlmZmVyZW50IGZvcm1zLiBGb3IgbW9yZSBkZXRhaWxzLCBzZWU6XG4gIC8vICAgICBodHRwczovL2RvY3MubW9uZ29kYi5jb20vbWFudWFsL3JlZmVyZW5jZS9vcGVyYXRvci9hZ2dyZWdhdGlvbi9cbiAgLy9cbiAgLy8gSWYgdGhlIHBpcGVsaW5lIGlzIGFuIGFycmF5LCBpdCBtZWFucyB3ZSBhcmUgcHJvYmFibHkgcGFyc2luZyBhbiAnJGFuZCcgb3IgJyRvcicgb3BlcmF0b3IuIEluXG4gIC8vIHRoYXQgY2FzZSB3ZSBuZWVkIHRvIGxvb3AgdGhyb3VnaCBhbGwgb2YgaXQncyBjaGlsZHJlbiB0byBmaW5kIHRoZSBjb2x1bW5zIGJlaW5nIG9wZXJhdGVkIG9uLlxuICAvLyBJZiB0aGUgcGlwZWxpbmUgaXMgYW4gb2JqZWN0LCB0aGVuIHdlJ2xsIGxvb3AgdGhyb3VnaCB0aGUga2V5cyBjaGVja2luZyB0byBzZWUgaWYgdGhlIGtleSBuYW1lXG4gIC8vIG1hdGNoZXMgb25lIG9mIHRoZSBzY2hlbWEgY29sdW1ucy4gSWYgaXQgZG9lcyBtYXRjaCBhIGNvbHVtbiBhbmQgdGhlIGNvbHVtbiBpcyBhIFBvaW50ZXIgb3JcbiAgLy8gYSBEYXRlLCB0aGVuIHdlJ2xsIGNvbnZlcnQgdGhlIHZhbHVlIGFzIGRlc2NyaWJlZCBhYm92ZS5cbiAgLy9cbiAgLy8gQXMgbXVjaCBhcyBJIGhhdGUgcmVjdXJzaW9uLi4udGhpcyBzZWVtZWQgbGlrZSBhIGdvb2QgZml0IGZvciBpdC4gV2UncmUgZXNzZW50aWFsbHkgdHJhdmVyc2luZ1xuICAvLyBkb3duIGEgdHJlZSB0byBmaW5kIGEgXCJsZWFmIG5vZGVcIiBhbmQgY2hlY2tpbmcgdG8gc2VlIGlmIGl0IG5lZWRzIHRvIGJlIGNvbnZlcnRlZC5cbiAgX3BhcnNlQWdncmVnYXRlQXJncyhzY2hlbWE6IGFueSwgcGlwZWxpbmU6IGFueSk6IGFueSB7XG4gICAgaWYgKHBpcGVsaW5lID09PSBudWxsKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkocGlwZWxpbmUpKSB7XG4gICAgICByZXR1cm4gcGlwZWxpbmUubWFwKHZhbHVlID0+IHRoaXMuX3BhcnNlQWdncmVnYXRlQXJncyhzY2hlbWEsIHZhbHVlKSk7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgcGlwZWxpbmUgPT09ICdvYmplY3QnKSB7XG4gICAgICBjb25zdCByZXR1cm5WYWx1ZSA9IHt9O1xuICAgICAgZm9yIChjb25zdCBmaWVsZCBpbiBwaXBlbGluZSkge1xuICAgICAgICBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZF0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSA9PT0gJ1BvaW50ZXInKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBwaXBlbGluZVtmaWVsZF0gPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICAvLyBQYXNzIG9iamVjdHMgZG93biB0byBNb25nb0RCLi4udGhpcyBpcyBtb3JlIHRoYW4gbGlrZWx5IGFuICRleGlzdHMgb3BlcmF0b3IuXG4gICAgICAgICAgICByZXR1cm5WYWx1ZVtgX3BfJHtmaWVsZH1gXSA9IHBpcGVsaW5lW2ZpZWxkXTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuVmFsdWVbYF9wXyR7ZmllbGR9YF0gPSBgJHtzY2hlbWEuZmllbGRzW2ZpZWxkXS50YXJnZXRDbGFzc30kJHtwaXBlbGluZVtmaWVsZF19YDtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZF0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSA9PT0gJ0RhdGUnKSB7XG4gICAgICAgICAgcmV0dXJuVmFsdWVbZmllbGRdID0gdGhpcy5fY29udmVydFRvRGF0ZShwaXBlbGluZVtmaWVsZF0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJldHVyblZhbHVlW2ZpZWxkXSA9IHRoaXMuX3BhcnNlQWdncmVnYXRlQXJncyhzY2hlbWEsIHBpcGVsaW5lW2ZpZWxkXSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZmllbGQgPT09ICdvYmplY3RJZCcpIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVsnX2lkJ10gPSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgICAgZGVsZXRlIHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gJ2NyZWF0ZWRBdCcpIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVsnX2NyZWF0ZWRfYXQnXSA9IHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgICBkZWxldGUgcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICB9IGVsc2UgaWYgKGZpZWxkID09PSAndXBkYXRlZEF0Jykge1xuICAgICAgICAgIHJldHVyblZhbHVlWydfdXBkYXRlZF9hdCddID0gcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICAgIGRlbGV0ZSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiByZXR1cm5WYWx1ZTtcbiAgICB9XG4gICAgcmV0dXJuIHBpcGVsaW5lO1xuICB9XG5cbiAgLy8gVGhpcyBmdW5jdGlvbiBpcyBzbGlnaHRseSBkaWZmZXJlbnQgdGhhbiB0aGUgb25lIGFib3ZlLiBSYXRoZXIgdGhhbiB0cnlpbmcgdG8gY29tYmluZSB0aGVzZVxuICAvLyB0d28gZnVuY3Rpb25zIGFuZCBtYWtpbmcgdGhlIGNvZGUgZXZlbiBoYXJkZXIgdG8gdW5kZXJzdGFuZCwgSSBkZWNpZGVkIHRvIHNwbGl0IGl0IHVwLiBUaGVcbiAgLy8gZGlmZmVyZW5jZSB3aXRoIHRoaXMgZnVuY3Rpb24gaXMgd2UgYXJlIG5vdCB0cmFuc2Zvcm1pbmcgdGhlIHZhbHVlcywgb25seSB0aGUga2V5cyBvZiB0aGVcbiAgLy8gcGlwZWxpbmUuXG4gIF9wYXJzZUFnZ3JlZ2F0ZVByb2plY3RBcmdzKHNjaGVtYTogYW55LCBwaXBlbGluZTogYW55KTogYW55IHtcbiAgICBjb25zdCByZXR1cm5WYWx1ZSA9IHt9O1xuICAgIGZvciAoY29uc3QgZmllbGQgaW4gcGlwZWxpbmUpIHtcbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbYF9wXyR7ZmllbGR9YF0gPSBwaXBlbGluZVtmaWVsZF07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUFyZ3Moc2NoZW1hLCBwaXBlbGluZVtmaWVsZF0pO1xuICAgICAgfVxuXG4gICAgICBpZiAoZmllbGQgPT09ICdvYmplY3RJZCcpIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbJ19pZCddID0gcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICBkZWxldGUgcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gJ2NyZWF0ZWRBdCcpIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbJ19jcmVhdGVkX2F0J10gPSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgIGRlbGV0ZSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkID09PSAndXBkYXRlZEF0Jykge1xuICAgICAgICByZXR1cm5WYWx1ZVsnX3VwZGF0ZWRfYXQnXSA9IHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgZGVsZXRlIHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJldHVyblZhbHVlO1xuICB9XG5cbiAgLy8gVGhpcyBmdW5jdGlvbiBpcyBzbGlnaHRseSBkaWZmZXJlbnQgdGhhbiB0aGUgdHdvIGFib3ZlLiBNb25nb0RCICRncm91cCBhZ2dyZWdhdGUgbG9va3MgbGlrZTpcbiAgLy8gICAgIHsgJGdyb3VwOiB7IF9pZDogPGV4cHJlc3Npb24+LCA8ZmllbGQxPjogeyA8YWNjdW11bGF0b3IxPiA6IDxleHByZXNzaW9uMT4gfSwgLi4uIH0gfVxuICAvLyBUaGUgPGV4cHJlc3Npb24+IGNvdWxkIGJlIGEgY29sdW1uIG5hbWUsIHByZWZpeGVkIHdpdGggdGhlICckJyBjaGFyYWN0ZXIuIFdlJ2xsIGxvb2sgZm9yXG4gIC8vIHRoZXNlIDxleHByZXNzaW9uPiBhbmQgY2hlY2sgdG8gc2VlIGlmIGl0IGlzIGEgJ1BvaW50ZXInIG9yIGlmIGl0J3Mgb25lIG9mIGNyZWF0ZWRBdCxcbiAgLy8gdXBkYXRlZEF0IG9yIG9iamVjdElkIGFuZCBjaGFuZ2UgaXQgYWNjb3JkaW5nbHkuXG4gIF9wYXJzZUFnZ3JlZ2F0ZUdyb3VwQXJncyhzY2hlbWE6IGFueSwgcGlwZWxpbmU6IGFueSk6IGFueSB7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkocGlwZWxpbmUpKSB7XG4gICAgICByZXR1cm4gcGlwZWxpbmUubWFwKHZhbHVlID0+IHRoaXMuX3BhcnNlQWdncmVnYXRlR3JvdXBBcmdzKHNjaGVtYSwgdmFsdWUpKTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBwaXBlbGluZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgIGNvbnN0IHJldHVyblZhbHVlID0ge307XG4gICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHBpcGVsaW5lKSB7XG4gICAgICAgIHJldHVyblZhbHVlW2ZpZWxkXSA9IHRoaXMuX3BhcnNlQWdncmVnYXRlR3JvdXBBcmdzKHNjaGVtYSwgcGlwZWxpbmVbZmllbGRdKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXR1cm5WYWx1ZTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBwaXBlbGluZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIGNvbnN0IGZpZWxkID0gcGlwZWxpbmUuc3Vic3RyaW5nKDEpO1xuICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGRdICYmIHNjaGVtYS5maWVsZHNbZmllbGRdLnR5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgICByZXR1cm4gYCRfcF8ke2ZpZWxkfWA7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkID09ICdjcmVhdGVkQXQnKSB7XG4gICAgICAgIHJldHVybiAnJF9jcmVhdGVkX2F0JztcbiAgICAgIH0gZWxzZSBpZiAoZmllbGQgPT0gJ3VwZGF0ZWRBdCcpIHtcbiAgICAgICAgcmV0dXJuICckX3VwZGF0ZWRfYXQnO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcGlwZWxpbmU7XG4gIH1cblxuICAvKipcbiAgICogUmVjdXJzaXZlbHkgY29udmVydHMgdmFsdWVzIHRvIERhdGUgb2JqZWN0cy4gU2luY2UgdGhlIHBhc3NlZCBvYmplY3QgaXMgcGFydCBvZiBhbiBhZ2dyZWdhdGlvblxuICAgKiBwaXBlbGluZSBhbmQgY2FuIGNvbnRhaW4gdmFyaW91cyBsb2dpYyBvcGVyYXRvcnMgKGxpa2UgJGd0LCAkbHQsIGV0YyksIHRoaXMgZnVuY3Rpb24gd2lsbFxuICAgKiB0cmF2ZXJzZSB0aGUgb2JqZWN0IGFuZCBjb252ZXJ0IGFueSBzdHJpbmdzIHRoYXQgY2FuIGJlIHBhcnNlZCBhcyBkYXRlcyBpbnRvIERhdGUgb2JqZWN0cy5cbiAgICogQHBhcmFtIHthbnl9IHZhbHVlIFRoZSB2YWx1ZSB0byBjb252ZXJ0LlxuICAgKiBAcmV0dXJucyB7YW55fSBUaGUgb3JpZ2luYWwgdmFsdWUgaWYgbm90IGNvbnZlcnRpYmxlIHRvIERhdGUsIG9yIGEgRGF0ZSBvYmplY3QgaWYgaXQgaXMuXG4gICAqL1xuICBfY29udmVydFRvRGF0ZSh2YWx1ZTogYW55KTogYW55IHtcbiAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBEYXRlKSB7XG4gICAgICByZXR1cm4gdmFsdWU7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICByZXR1cm4gaXNOYU4oRGF0ZS5wYXJzZSh2YWx1ZSkpID8gdmFsdWUgOiBuZXcgRGF0ZSh2YWx1ZSk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICBjb25zdCByZXR1cm5WYWx1ZSA9IHt9O1xuICAgICAgZm9yIChjb25zdCBmaWVsZCBpbiB2YWx1ZSkge1xuICAgICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9jb252ZXJ0VG9EYXRlKHZhbHVlW2ZpZWxkXSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gcmV0dXJuVmFsdWU7XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxuXG4gIF9wYXJzZVJlYWRQcmVmZXJlbmNlKHJlYWRQcmVmZXJlbmNlOiA/c3RyaW5nKTogP3N0cmluZyB7XG4gICAgaWYgKHJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICByZWFkUHJlZmVyZW5jZSA9IHJlYWRQcmVmZXJlbmNlLnRvVXBwZXJDYXNlKCk7XG4gICAgfVxuICAgIHN3aXRjaCAocmVhZFByZWZlcmVuY2UpIHtcbiAgICAgIGNhc2UgJ1BSSU1BUlknOlxuICAgICAgICByZWFkUHJlZmVyZW5jZSA9IFJlYWRQcmVmZXJlbmNlLlBSSU1BUlk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnUFJJTUFSWV9QUkVGRVJSRUQnOlxuICAgICAgICByZWFkUHJlZmVyZW5jZSA9IFJlYWRQcmVmZXJlbmNlLlBSSU1BUllfUFJFRkVSUkVEO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ1NFQ09OREFSWSc6XG4gICAgICAgIHJlYWRQcmVmZXJlbmNlID0gUmVhZFByZWZlcmVuY2UuU0VDT05EQVJZO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ1NFQ09OREFSWV9QUkVGRVJSRUQnOlxuICAgICAgICByZWFkUHJlZmVyZW5jZSA9IFJlYWRQcmVmZXJlbmNlLlNFQ09OREFSWV9QUkVGRVJSRUQ7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnTkVBUkVTVCc6XG4gICAgICAgIHJlYWRQcmVmZXJlbmNlID0gUmVhZFByZWZlcmVuY2UuTkVBUkVTVDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIHVuZGVmaW5lZDpcbiAgICAgIGNhc2UgbnVsbDpcbiAgICAgIGNhc2UgJyc6XG4gICAgICAgIGJyZWFrO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksICdOb3Qgc3VwcG9ydGVkIHJlYWQgcHJlZmVyZW5jZS4nKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgcGVyZm9ybUluaXRpYWxpemF0aW9uKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIGNyZWF0ZUluZGV4KGNsYXNzTmFtZTogc3RyaW5nLCBpbmRleDogYW55KSB7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5jcmVhdGVJbmRleChpbmRleCkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBjcmVhdGVJbmRleGVzKGNsYXNzTmFtZTogc3RyaW5nLCBpbmRleGVzOiBhbnkpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmNyZWF0ZUluZGV4ZXMoaW5kZXhlcykpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBjcmVhdGVJbmRleGVzSWZOZWVkZWQoY2xhc3NOYW1lOiBzdHJpbmcsIGZpZWxkTmFtZTogc3RyaW5nLCB0eXBlOiBhbnkpIHtcbiAgICBpZiAodHlwZSAmJiB0eXBlLnR5cGUgPT09ICdQb2x5Z29uJykge1xuICAgICAgY29uc3QgaW5kZXggPSB7XG4gICAgICAgIFtmaWVsZE5hbWVdOiAnMmRzcGhlcmUnLFxuICAgICAgfTtcbiAgICAgIHJldHVybiB0aGlzLmNyZWF0ZUluZGV4KGNsYXNzTmFtZSwgaW5kZXgpO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICBjcmVhdGVUZXh0SW5kZXhlc0lmTmVlZGVkKGNsYXNzTmFtZTogc3RyaW5nLCBxdWVyeTogUXVlcnlUeXBlLCBzY2hlbWE6IGFueSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGZvciAoY29uc3QgZmllbGROYW1lIGluIHF1ZXJ5KSB7XG4gICAgICBpZiAoIXF1ZXJ5W2ZpZWxkTmFtZV0gfHwgIXF1ZXJ5W2ZpZWxkTmFtZV0uJHRleHQpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBleGlzdGluZ0luZGV4ZXMgPSBzY2hlbWEuaW5kZXhlcztcbiAgICAgIGZvciAoY29uc3Qga2V5IGluIGV4aXN0aW5nSW5kZXhlcykge1xuICAgICAgICBjb25zdCBpbmRleCA9IGV4aXN0aW5nSW5kZXhlc1trZXldO1xuICAgICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGluZGV4LCBmaWVsZE5hbWUpKSB7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBjb25zdCBpbmRleE5hbWUgPSBgJHtmaWVsZE5hbWV9X3RleHRgO1xuICAgICAgY29uc3QgdGV4dEluZGV4ID0ge1xuICAgICAgICBbaW5kZXhOYW1lXTogeyBbZmllbGROYW1lXTogJ3RleHQnIH0sXG4gICAgICB9O1xuICAgICAgcmV0dXJuIHRoaXMuc2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQoXG4gICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgdGV4dEluZGV4LFxuICAgICAgICBleGlzdGluZ0luZGV4ZXMsXG4gICAgICAgIHNjaGVtYS5maWVsZHNcbiAgICAgICkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gODUpIHtcbiAgICAgICAgICAvLyBJbmRleCBleGlzdCB3aXRoIGRpZmZlcmVudCBvcHRpb25zXG4gICAgICAgICAgcmV0dXJuIHRoaXMuc2V0SW5kZXhlc0Zyb21Nb25nbyhjbGFzc05hbWUpO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIGdldEluZGV4ZXMoY2xhc3NOYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmluZGV4ZXMoKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGRyb3BJbmRleChjbGFzc05hbWU6IHN0cmluZywgaW5kZXg6IGFueSkge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uZHJvcEluZGV4KGluZGV4KSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGRyb3BBbGxJbmRleGVzKGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5kcm9wSW5kZXhlcygpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgdXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMoKTogUHJvbWlzZTxhbnk+IHtcbiAgICByZXR1cm4gdGhpcy5nZXRBbGxDbGFzc2VzKClcbiAgICAgIC50aGVuKGNsYXNzZXMgPT4ge1xuICAgICAgICBjb25zdCBwcm9taXNlcyA9IGNsYXNzZXMubWFwKHNjaGVtYSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMuc2V0SW5kZXhlc0Zyb21Nb25nbyhzY2hlbWEuY2xhc3NOYW1lKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiBQcm9taXNlLmFsbChwcm9taXNlcyk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgY3JlYXRlVHJhbnNhY3Rpb25hbFNlc3Npb24oKTogUHJvbWlzZTxhbnk+IHtcbiAgICBjb25zdCB0cmFuc2FjdGlvbmFsU2VjdGlvbiA9IHRoaXMuY2xpZW50LnN0YXJ0U2Vzc2lvbigpO1xuICAgIHRyYW5zYWN0aW9uYWxTZWN0aW9uLnN0YXJ0VHJhbnNhY3Rpb24oKTtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHRyYW5zYWN0aW9uYWxTZWN0aW9uKTtcbiAgfVxuXG4gIGNvbW1pdFRyYW5zYWN0aW9uYWxTZXNzaW9uKHRyYW5zYWN0aW9uYWxTZWN0aW9uOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBjb21taXQgPSByZXRyaWVzID0+IHtcbiAgICAgIHJldHVybiB0cmFuc2FjdGlvbmFsU2VjdGlvblxuICAgICAgICAuY29tbWl0VHJhbnNhY3Rpb24oKVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgIGlmIChlcnJvciAmJiBlcnJvci5oYXNFcnJvckxhYmVsKCdUcmFuc2llbnRUcmFuc2FjdGlvbkVycm9yJykgJiYgcmV0cmllcyA+IDApIHtcbiAgICAgICAgICAgIHJldHVybiBjb21taXQocmV0cmllcyAtIDEpO1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIHRyYW5zYWN0aW9uYWxTZWN0aW9uLmVuZFNlc3Npb24oKTtcbiAgICAgICAgfSk7XG4gICAgfTtcbiAgICByZXR1cm4gY29tbWl0KDUpO1xuICB9XG5cbiAgYWJvcnRUcmFuc2FjdGlvbmFsU2Vzc2lvbih0cmFuc2FjdGlvbmFsU2VjdGlvbjogYW55KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIHRyYW5zYWN0aW9uYWxTZWN0aW9uLmFib3J0VHJhbnNhY3Rpb24oKS50aGVuKCgpID0+IHtcbiAgICAgIHRyYW5zYWN0aW9uYWxTZWN0aW9uLmVuZFNlc3Npb24oKTtcbiAgICB9KTtcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBNb25nb1N0b3JhZ2VBZGFwdGVyO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFDQSxJQUFBQSxXQUFBLEdBQUFDLE9BQUE7QUFFQSxJQUFBQyxlQUFBLEdBQUFELE9BQUE7QUFDQSxJQUFBRSxnQkFBQSxHQUFBQyxzQkFBQSxDQUFBSCxPQUFBO0FBQ0EsSUFBQUksc0JBQUEsR0FBQUQsc0JBQUEsQ0FBQUgsT0FBQTtBQUNBLElBQUFLLGVBQUEsR0FBQUwsT0FBQTtBQVNBLElBQUFNLEtBQUEsR0FBQUgsc0JBQUEsQ0FBQUgsT0FBQTtBQUVBLElBQUFPLE9BQUEsR0FBQUosc0JBQUEsQ0FBQUgsT0FBQTtBQUNBLElBQUFRLFNBQUEsR0FBQUMsdUJBQUEsQ0FBQVQsT0FBQTtBQUNBLElBQUFVLE9BQUEsR0FBQVAsc0JBQUEsQ0FBQUgsT0FBQTtBQUNBLElBQUFXLE1BQUEsR0FBQVIsc0JBQUEsQ0FBQUgsT0FBQTtBQUFtQyxTQUFBUyx3QkFBQUcsQ0FBQSxFQUFBQyxDQUFBLDZCQUFBQyxPQUFBLE1BQUFDLENBQUEsT0FBQUQsT0FBQSxJQUFBRSxDQUFBLE9BQUFGLE9BQUEsWUFBQUwsdUJBQUEsWUFBQUEsQ0FBQUcsQ0FBQSxFQUFBQyxDQUFBLFNBQUFBLENBQUEsSUFBQUQsQ0FBQSxJQUFBQSxDQUFBLENBQUFLLFVBQUEsU0FBQUwsQ0FBQSxNQUFBTSxDQUFBLEVBQUFDLENBQUEsRUFBQUMsQ0FBQSxLQUFBQyxTQUFBLFFBQUFDLE9BQUEsRUFBQVYsQ0FBQSxpQkFBQUEsQ0FBQSx1QkFBQUEsQ0FBQSx5QkFBQUEsQ0FBQSxTQUFBUSxDQUFBLE1BQUFGLENBQUEsR0FBQUwsQ0FBQSxHQUFBRyxDQUFBLEdBQUFELENBQUEsUUFBQUcsQ0FBQSxDQUFBSyxHQUFBLENBQUFYLENBQUEsVUFBQU0sQ0FBQSxDQUFBTSxHQUFBLENBQUFaLENBQUEsR0FBQU0sQ0FBQSxDQUFBTyxHQUFBLENBQUFiLENBQUEsRUFBQVEsQ0FB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