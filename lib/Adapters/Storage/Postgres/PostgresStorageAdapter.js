"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.PostgresStorageAdapter = void 0;
var _PostgresClient = require("./PostgresClient");
var _node = _interopRequireDefault(require("parse/node"));
var _lodash = _interopRequireDefault(require("lodash"));
var _uuid = require("uuid");
var _sql = _interopRequireDefault(require("./sql"));
var _StorageAdapter = require("../StorageAdapter");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// -disable-next
// -disable-next
// -disable-next
const Utils = require('../../../Utils');
const PostgresRelationDoesNotExistError = '42P01';
const PostgresDuplicateRelationError = '42P07';
const PostgresDuplicateColumnError = '42701';
const PostgresMissingColumnError = '42703';
const PostgresUniqueIndexViolationError = '23505';
const logger = require('../../../logger');
const debug = function (...args) {
  args = ['PG: ' + arguments[0]].concat(args.slice(1, args.length));
  const log = logger.getLogger();
  log.debug.apply(log, args);
};
const parseTypeToPostgresType = type => {
  switch (type.type) {
    case 'String':
      return 'text';
    case 'Date':
      return 'timestamp with time zone';
    case 'Object':
      return 'jsonb';
    case 'File':
      return 'text';
    case 'Boolean':
      return 'boolean';
    case 'Pointer':
      return 'text';
    case 'Number':
      return 'double precision';
    case 'GeoPoint':
      return 'point';
    case 'Bytes':
      return 'jsonb';
    case 'Polygon':
      return 'polygon';
    case 'Array':
      if (type.contents && type.contents.type === 'String') {
        return 'text[]';
      } else {
        return 'jsonb';
      }
    default:
      throw `no type for ${JSON.stringify(type)} yet`;
  }
};
const ParseToPosgresComparator = {
  $gt: '>',
  $lt: '<',
  $gte: '>=',
  $lte: '<='
};
const mongoAggregateToPostgres = {
  $dayOfMonth: 'DAY',
  $dayOfWeek: 'DOW',
  $dayOfYear: 'DOY',
  $isoDayOfWeek: 'ISODOW',
  $isoWeekYear: 'ISOYEAR',
  $hour: 'HOUR',
  $minute: 'MINUTE',
  $second: 'SECOND',
  $millisecond: 'MILLISECONDS',
  $month: 'MONTH',
  $week: 'WEEK',
  $year: 'YEAR'
};
const toPostgresValue = value => {
  if (typeof value === 'object') {
    if (value.__type === 'Date') {
      return value.iso;
    }
    if (value.__type === 'File') {
      return value.name;
    }
  }
  return value;
};
const toPostgresValueCastType = value => {
  const postgresValue = toPostgresValue(value);
  let castType;
  switch (typeof postgresValue) {
    case 'number':
      castType = 'double precision';
      break;
    case 'boolean':
      castType = 'boolean';
      break;
    default:
      castType = undefined;
  }
  return castType;
};
const transformValue = value => {
  if (typeof value === 'object' && value.__type === 'Pointer') {
    return value.objectId;
  }
  return value;
};

// Duplicate from then mongo adapter...
const emptyCLPS = Object.freeze({
  find: {},
  get: {},
  count: {},
  create: {},
  update: {},
  delete: {},
  addField: {},
  protectedFields: {}
});
const defaultCLPS = Object.freeze({
  ACL: {
    '*': {
      read: true,
      write: true
    }
  },
  find: {
    '*': true
  },
  get: {
    '*': true
  },
  count: {
    '*': true
  },
  create: {
    '*': true
  },
  update: {
    '*': true
  },
  delete: {
    '*': true
  },
  addField: {
    '*': true
  },
  protectedFields: {
    '*': []
  }
});
const toParseSchema = schema => {
  if (schema.className === '_User') {
    delete schema.fields._hashed_password;
  }
  if (schema.fields) {
    delete schema.fields._wperm;
    delete schema.fields._rperm;
  }
  let clps = defaultCLPS;
  if (schema.classLevelPermissions) {
    clps = {
      ...emptyCLPS,
      ...schema.classLevelPermissions
    };
  }
  let indexes = {};
  if (schema.indexes) {
    indexes = {
      ...schema.indexes
    };
  }
  return {
    className: schema.className,
    fields: schema.fields,
    classLevelPermissions: clps,
    indexes
  };
};
const toPostgresSchema = schema => {
  if (!schema) {
    return schema;
  }
  schema.fields = schema.fields || {};
  schema.fields._wperm = {
    type: 'Array',
    contents: {
      type: 'String'
    }
  };
  schema.fields._rperm = {
    type: 'Array',
    contents: {
      type: 'String'
    }
  };
  if (schema.className === '_User') {
    schema.fields._hashed_password = {
      type: 'String'
    };
    schema.fields._password_history = {
      type: 'Array'
    };
  }
  return schema;
};
const isArrayIndex = arrayIndex => Array.from(arrayIndex).every(c => c >= '0' && c <= '9');
const handleDotFields = object => {
  Object.keys(object).forEach(fieldName => {
    if (fieldName.indexOf('.') > -1) {
      const components = fieldName.split('.');
      const first = components.shift();
      object[first] = object[first] || {};
      let currentObj = object[first];
      let next;
      let value = object[fieldName];
      if (value && value.__op === 'Delete') {
        value = undefined;
      }
      while (next = components.shift()) {
        currentObj[next] = currentObj[next] || {};
        if (components.length === 0) {
          currentObj[next] = value;
        }
        currentObj = currentObj[next];
      }
      delete object[fieldName];
    }
  });
  return object;
};
const transformDotFieldToComponents = fieldName => {
  return fieldName.split('.').map((cmpt, index) => {
    if (index === 0) {
      return `"${cmpt}"`;
    }
    if (isArrayIndex(cmpt)) {
      return Number(cmpt);
    } else {
      return `'${cmpt}'`;
    }
  });
};
const transformDotField = fieldName => {
  if (fieldName.indexOf('.') === -1) {
    return `"${fieldName}"`;
  }
  const components = transformDotFieldToComponents(fieldName);
  let name = components.slice(0, components.length - 1).join('->');
  name += '->>' + components[components.length - 1];
  return name;
};
const transformAggregateField = fieldName => {
  if (typeof fieldName !== 'string') {
    return fieldName;
  }
  if (fieldName === '$_created_at') {
    return 'createdAt';
  }
  if (fieldName === '$_updated_at') {
    return 'updatedAt';
  }
  return fieldName.substring(1);
};
const validateKeys = object => {
  if (typeof object == 'object') {
    for (const key in object) {
      if (typeof object[key] == 'object') {
        validateKeys(object[key]);
      }
      if (key.includes('$') || key.includes('.')) {
        throw new _node.default.Error(_node.default.Error.INVALID_NESTED_KEY, "Nested keys should not contain the '$' or '.' characters");
      }
    }
  }
};

// Returns the list of join tables on a schema
const joinTablesForSchema = schema => {
  const list = [];
  if (schema) {
    Object.keys(schema.fields).forEach(field => {
      if (schema.fields[field].type === 'Relation') {
        list.push(`_Join:${field}:${schema.className}`);
      }
    });
  }
  return list;
};
const buildWhereClause = ({
  schema,
  query,
  index,
  caseInsensitive
}) => {
  const patterns = [];
  let values = [];
  const sorts = [];
  schema = toPostgresSchema(schema);
  for (const fieldName in query) {
    const isArrayField = schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Array';
    const initialPatternsLength = patterns.length;
    const fieldValue = query[fieldName];

    // nothing in the schema, it's gonna blow up
    if (!schema.fields[fieldName]) {
      // as it won't exist
      if (fieldValue && fieldValue.$exists === false) {
        continue;
      }
    }
    const authDataMatch = fieldName.match(/^_auth_data_([a-zA-Z0-9_]+)$/);
    if (authDataMatch) {
      // TODO: Handle querying by _auth_data_provider, authData is stored in authData field
      continue;
    } else if (caseInsensitive && (fieldName === 'username' || fieldName === 'email')) {
      patterns.push(`LOWER($${index}:name) = LOWER($${index + 1})`);
      values.push(fieldName, fieldValue);
      index += 2;
    } else if (fieldName.indexOf('.') >= 0) {
      let name = transformDotField(fieldName);
      if (fieldValue === null) {
        patterns.push(`$${index}:raw IS NULL`);
        values.push(name);
        index += 1;
        continue;
      } else {
        if (fieldValue.$in) {
          name = transformDotFieldToComponents(fieldName).join('->');
          patterns.push(`($${index}:raw)::jsonb @> $${index + 1}::jsonb`);
          values.push(name, JSON.stringify(fieldValue.$in));
          index += 2;
        } else if (fieldValue.$regex) {
          // Handle later
        } else if (typeof fieldValue !== 'object') {
          patterns.push(`$${index}:raw = $${index + 1}::text`);
          values.push(name, fieldValue);
          index += 2;
        }
      }
    } else if (fieldValue === null || fieldValue === undefined) {
      patterns.push(`$${index}:name IS NULL`);
      values.push(fieldName);
      index += 1;
      continue;
    } else if (typeof fieldValue === 'string') {
      patterns.push(`$${index}:name = $${index + 1}`);
      values.push(fieldName, fieldValue);
      index += 2;
    } else if (typeof fieldValue === 'boolean') {
      patterns.push(`$${index}:name = $${index + 1}`);
      // Can't cast boolean to double precision
      if (schema.fields[fieldName] && schema.fields[fieldName].type === 'Number') {
        // Should always return zero results
        const MAX_INT_PLUS_ONE = 9223372036854775808;
        values.push(fieldName, MAX_INT_PLUS_ONE);
      } else {
        values.push(fieldName, fieldValue);
      }
      index += 2;
    } else if (typeof fieldValue === 'number') {
      patterns.push(`$${index}:name = $${index + 1}`);
      values.push(fieldName, fieldValue);
      index += 2;
    } else if (['$or', '$nor', '$and'].includes(fieldName)) {
      const clauses = [];
      const clauseValues = [];
      fieldValue.forEach(subQuery => {
        const clause = buildWhereClause({
          schema,
          query: subQuery,
          index,
          caseInsensitive
        });
        if (clause.pattern.length > 0) {
          clauses.push(clause.pattern);
          clauseValues.push(...clause.values);
          index += clause.values.length;
        }
      });
      const orOrAnd = fieldName === '$and' ? ' AND ' : ' OR ';
      const not = fieldName === '$nor' ? ' NOT ' : '';
      patterns.push(`${not}(${clauses.join(orOrAnd)})`);
      values.push(...clauseValues);
    }
    if (fieldValue.$ne !== undefined) {
      if (isArrayField) {
        fieldValue.$ne = JSON.stringify([fieldValue.$ne]);
        patterns.push(`NOT array_contains($${index}:name, $${index + 1})`);
      } else {
        if (fieldValue.$ne === null) {
          patterns.push(`$${index}:name IS NOT NULL`);
          values.push(fieldName);
          index += 1;
          continue;
        } else {
          // if not null, we need to manually exclude null
          if (fieldValue.$ne.__type === 'GeoPoint') {
            patterns.push(`($${index}:name <> POINT($${index + 1}, $${index + 2}) OR $${index}:name IS NULL)`);
          } else {
            if (fieldName.indexOf('.') >= 0) {
              const castType = toPostgresValueCastType(fieldValue.$ne);
              const constraintFieldName = castType ? `CAST ((${transformDotField(fieldName)}) AS ${castType})` : transformDotField(fieldName);
              patterns.push(`(${constraintFieldName} <> $${index + 1} OR ${constraintFieldName} IS NULL)`);
            } else if (typeof fieldValue.$ne === 'object' && fieldValue.$ne.$relativeTime) {
              throw new _node.default.Error(_node.default.Error.INVALID_JSON, '$relativeTime can only be used with the $lt, $lte, $gt, and $gte operators');
            } else {
              patterns.push(`($${index}:name <> $${index + 1} OR $${index}:name IS NULL)`);
            }
          }
        }
      }
      if (fieldValue.$ne.__type === 'GeoPoint') {
        const point = fieldValue.$ne;
        values.push(fieldName, point.longitude, point.latitude);
        index += 3;
      } else {
        // TODO: support arrays
        values.push(fieldName, fieldValue.$ne);
        index += 2;
      }
    }
    if (fieldValue.$eq !== undefined) {
      if (fieldValue.$eq === null) {
        patterns.push(`$${index}:name IS NULL`);
        values.push(fieldName);
        index += 1;
      } else {
        if (fieldName.indexOf('.') >= 0) {
          const castType = toPostgresValueCastType(fieldValue.$eq);
          const constraintFieldName = castType ? `CAST ((${transformDotField(fieldName)}) AS ${castType})` : transformDotField(fieldName);
          values.push(fieldValue.$eq);
          patterns.push(`${constraintFieldName} = $${index++}`);
        } else if (typeof fieldValue.$eq === 'object' && fieldValue.$eq.$relativeTime) {
          throw new _node.default.Error(_node.default.Error.INVALID_JSON, '$relativeTime can only be used with the $lt, $lte, $gt, and $gte operators');
        } else {
          values.push(fieldName, fieldValue.$eq);
          patterns.push(`$${index}:name = $${index + 1}`);
          index += 2;
        }
      }
    }
    const isInOrNin = Array.isArray(fieldValue.$in) || Array.isArray(fieldValue.$nin);
    if (Array.isArray(fieldValue.$in) && isArrayField && schema.fields[fieldName].contents && schema.fields[fieldName].contents.type === 'String') {
      const inPatterns = [];
      let allowNull = false;
      values.push(fieldName);
      fieldValue.$in.forEach((listElem, listIndex) => {
        if (listElem === null) {
          allowNull = true;
        } else {
          values.push(listElem);
          inPatterns.push(`$${index + 1 + listIndex - (allowNull ? 1 : 0)}`);
        }
      });
      if (allowNull) {
        patterns.push(`($${index}:name IS NULL OR $${index}:name && ARRAY[${inPatterns.join()}])`);
      } else {
        patterns.push(`$${index}:name && ARRAY[${inPatterns.join()}]`);
      }
      index = index + 1 + inPatterns.length;
    } else if (isInOrNin) {
      var createConstraint = (baseArray, notIn) => {
        const not = notIn ? ' NOT ' : '';
        if (baseArray.length > 0) {
          if (isArrayField) {
            patterns.push(`${not} array_contains($${index}:name, $${index + 1})`);
            values.push(fieldName, JSON.stringify(baseArray));
            index += 2;
          } else {
            // Handle Nested Dot Notation Above
            if (fieldName.indexOf('.') >= 0) {
              return;
            }
            const inPatterns = [];
            values.push(fieldName);
            baseArray.forEach((listElem, listIndex) => {
              if (listElem != null) {
                values.push(listElem);
                inPatterns.push(`$${index + 1 + listIndex}`);
              }
            });
            patterns.push(`$${index}:name ${not} IN (${inPatterns.join()})`);
            index = index + 1 + inPatterns.length;
          }
        } else if (!notIn) {
          values.push(fieldName);
          patterns.push(`$${index}:name IS NULL`);
          index = index + 1;
        } else {
          // Handle empty array
          if (notIn) {
            patterns.push('1 = 1'); // Return all values
          } else {
            patterns.push('1 = 2'); // Return no values
          }
        }
      };
      if (fieldValue.$in) {
        createConstraint(_lodash.default.flatMap(fieldValue.$in, elt => elt), false);
      }
      if (fieldValue.$nin) {
        createConstraint(_lodash.default.flatMap(fieldValue.$nin, elt => elt), true);
      }
    } else if (typeof fieldValue.$in !== 'undefined') {
      throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $in value');
    } else if (typeof fieldValue.$nin !== 'undefined') {
      throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $nin value');
    }
    if (Array.isArray(fieldValue.$all) && isArrayField) {
      if (isAnyValueRegexStartsWith(fieldValue.$all)) {
        if (!isAllValuesRegexOrNone(fieldValue.$all)) {
          throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'All $all values must be of regex type or none: ' + fieldValue.$all);
        }
        for (let i = 0; i < fieldValue.$all.length; i += 1) {
          const value = processRegexPattern(fieldValue.$all[i].$regex);
          fieldValue.$all[i] = value.substring(1) + '%';
        }
        patterns.push(`array_contains_all_regex($${index}:name, $${index + 1}::jsonb)`);
      } else {
        patterns.push(`array_contains_all($${index}:name, $${index + 1}::jsonb)`);
      }
      values.push(fieldName, JSON.stringify(fieldValue.$all));
      index += 2;
    } else if (Array.isArray(fieldValue.$all)) {
      if (fieldValue.$all.length === 1) {
        patterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue.$all[0].objectId);
        index += 2;
      }
    }
    if (typeof fieldValue.$exists !== 'undefined') {
      if (typeof fieldValue.$exists === 'object' && fieldValue.$exists.$relativeTime) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, '$relativeTime can only be used with the $lt, $lte, $gt, and $gte operators');
      } else if (fieldValue.$exists) {
        patterns.push(`$${index}:name IS NOT NULL`);
      } else {
        patterns.push(`$${index}:name IS NULL`);
      }
      values.push(fieldName);
      index += 1;
    }
    if (fieldValue.$containedBy) {
      const arr = fieldValue.$containedBy;
      if (!(arr instanceof Array)) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $containedBy: should be an array`);
      }
      patterns.push(`$${index}:name <@ $${index + 1}::jsonb`);
      values.push(fieldName, JSON.stringify(arr));
      index += 2;
    }
    if (fieldValue.$text) {
      const search = fieldValue.$text.$search;
      let language = 'english';
      if (typeof search !== 'object') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $search, should be object`);
      }
      if (!search.$term || typeof search.$term !== 'string') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $term, should be string`);
      }
      if (search.$language && typeof search.$language !== 'string') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $language, should be string`);
      } else if (search.$language) {
        language = search.$language;
      }
      if (search.$caseSensitive && typeof search.$caseSensitive !== 'boolean') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $caseSensitive, should be boolean`);
      } else if (search.$caseSensitive) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $caseSensitive not supported, please use $regex or create a separate lower case column.`);
      }
      if (search.$diacriticSensitive && typeof search.$diacriticSensitive !== 'boolean') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $diacriticSensitive, should be boolean`);
      } else if (search.$diacriticSensitive === false) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $diacriticSensitive - false not supported, install Postgres Unaccent Extension`);
      }
      patterns.push(`to_tsvector($${index}, $${index + 1}:name) @@ to_tsquery($${index + 2}, $${index + 3})`);
      values.push(language, fieldName, language, search.$term);
      index += 4;
    }
    if (fieldValue.$nearSphere) {
      const point = fieldValue.$nearSphere;
      const distance = fieldValue.$maxDistance;
      const distanceInKM = distance * 6371 * 1000;
      patterns.push(`ST_DistanceSphere($${index}:name::geometry, POINT($${index + 1}, $${index + 2})::geometry) <= $${index + 3}`);
      sorts.push(`ST_DistanceSphere($${index}:name::geometry, POINT($${index + 1}, $${index + 2})::geometry) ASC`);
      values.push(fieldName, point.longitude, point.latitude, distanceInKM);
      index += 4;
    }
    if (fieldValue.$within && fieldValue.$within.$box) {
      const box = fieldValue.$within.$box;
      const left = box[0].longitude;
      const bottom = box[0].latitude;
      const right = box[1].longitude;
      const top = box[1].latitude;
      patterns.push(`$${index}:name::point <@ $${index + 1}::box`);
      values.push(fieldName, `((${left}, ${bottom}), (${right}, ${top}))`);
      index += 2;
    }
    if (fieldValue.$geoWithin && fieldValue.$geoWithin.$centerSphere) {
      const centerSphere = fieldValue.$geoWithin.$centerSphere;
      if (!(centerSphere instanceof Array) || centerSphere.length < 2) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere should be an array of Parse.GeoPoint and distance');
      }
      // Get point, convert to geo point if necessary and validate
      let point = centerSphere[0];
      if (point instanceof Array && point.length === 2) {
        point = new _node.default.GeoPoint(point[1], point[0]);
      } else if (!GeoPointCoder.isValidJSON(point)) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere geo point invalid');
      }
      _node.default.GeoPoint._validate(point.latitude, point.longitude);
      // Get distance and validate
      const distance = centerSphere[1];
      if (isNaN(distance) || distance < 0) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere distance invalid');
      }
      const distanceInKM = distance * 6371 * 1000;
      patterns.push(`ST_DistanceSphere($${index}:name::geometry, POINT($${index + 1}, $${index + 2})::geometry) <= $${index + 3}`);
      values.push(fieldName, point.longitude, point.latitude, distanceInKM);
      index += 4;
    }
    if (fieldValue.$geoWithin && fieldValue.$geoWithin.$polygon) {
      const polygon = fieldValue.$geoWithin.$polygon;
      let points;
      if (typeof polygon === 'object' && polygon.__type === 'Polygon') {
        if (!polygon.coordinates || polygon.coordinates.length < 3) {
          throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; Polygon.coordinates should contain at least 3 lon/lat pairs');
        }
        points = polygon.coordinates;
      } else if (polygon instanceof Array) {
        if (polygon.length < 3) {
          throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; $polygon should contain at least 3 GeoPoints');
        }
        points = polygon;
      } else {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, "bad $geoWithin value; $polygon should be Polygon object or Array of Parse.GeoPoint's");
      }
      points = points.map(point => {
        if (point instanceof Array && point.length === 2) {
          _node.default.GeoPoint._validate(point[1], point[0]);
          return `(${point[0]}, ${point[1]})`;
        }
        if (typeof point !== 'object' || point.__type !== 'GeoPoint') {
          throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value');
        } else {
          _node.default.GeoPoint._validate(point.latitude, point.longitude);
        }
        return `(${point.longitude}, ${point.latitude})`;
      }).join(', ');
      patterns.push(`$${index}:name::point <@ $${index + 1}::polygon`);
      values.push(fieldName, `(${points})`);
      index += 2;
    }
    if (fieldValue.$geoIntersects && fieldValue.$geoIntersects.$point) {
      const point = fieldValue.$geoIntersects.$point;
      if (typeof point !== 'object' || point.__type !== 'GeoPoint') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoIntersect value; $point should be GeoPoint');
      } else {
        _node.default.GeoPoint._validate(point.latitude, point.longitude);
      }
      patterns.push(`$${index}:name::polygon @> $${index + 1}::point`);
      values.push(fieldName, `(${point.longitude}, ${point.latitude})`);
      index += 2;
    }
    if (fieldValue.$regex) {
      let regex = fieldValue.$regex;
      let operator = '~';
      const opts = fieldValue.$options;
      if (opts) {
        if (opts.indexOf('i') >= 0) {
          operator = '~*';
        }
        if (opts.indexOf('x') >= 0) {
          regex = removeWhiteSpace(regex);
        }
      }
      const name = transformDotField(fieldName);
      regex = processRegexPattern(regex);
      patterns.push(`$${index}:raw ${operator} '$${index + 1}:raw'`);
      values.push(name, regex);
      index += 2;
    }
    if (fieldValue.__type === 'Pointer') {
      if (isArrayField) {
        patterns.push(`array_contains($${index}:name, $${index + 1})`);
        values.push(fieldName, JSON.stringify([fieldValue]));
        index += 2;
      } else {
        patterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue.objectId);
        index += 2;
      }
    }
    if (fieldValue.__type === 'Date') {
      patterns.push(`$${index}:name = $${index + 1}`);
      values.push(fieldName, fieldValue.iso);
      index += 2;
    }
    if (fieldValue.__type === 'GeoPoint') {
      patterns.push(`$${index}:name ~= POINT($${index + 1}, $${index + 2})`);
      values.push(fieldName, fieldValue.longitude, fieldValue.latitude);
      index += 3;
    }
    if (fieldValue.__type === 'Polygon') {
      const value = convertPolygonToSQL(fieldValue.coordinates);
      patterns.push(`$${index}:name ~= $${index + 1}::polygon`);
      values.push(fieldName, value);
      index += 2;
    }
    Object.keys(ParseToPosgresComparator).forEach(cmp => {
      if (fieldValue[cmp] || fieldValue[cmp] === 0) {
        const pgComparator = ParseToPosgresComparator[cmp];
        let constraintFieldName;
        let postgresValue = toPostgresValue(fieldValue[cmp]);
        if (fieldName.indexOf('.') >= 0) {
          const castType = toPostgresValueCastType(fieldValue[cmp]);
          constraintFieldName = castType ? `CAST ((${transformDotField(fieldName)}) AS ${castType})` : transformDotField(fieldName);
        } else {
          if (typeof postgresValue === 'object' && postgresValue.$relativeTime) {
            if (schema.fields[fieldName].type !== 'Date') {
              throw new _node.default.Error(_node.default.Error.INVALID_JSON, '$relativeTime can only be used with Date field');
            }
            const parserResult = Utils.relativeTimeToDate(postgresValue.$relativeTime);
            if (parserResult.status === 'success') {
              postgresValue = toPostgresValue(parserResult.result);
            } else {
              // eslint-disable-next-line no-console
              console.error('Error while parsing relative date', parserResult);
              throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $relativeTime (${postgresValue.$relativeTime}) value. ${parserResult.info}`);
            }
          }
          constraintFieldName = `$${index++}:name`;
          values.push(fieldName);
        }
        values.push(postgresValue);
        patterns.push(`${constraintFieldName} ${pgComparator} $${index++}`);
      }
    });
    if (initialPatternsLength === patterns.length) {
      throw new _node.default.Error(_node.default.Error.OPERATION_FORBIDDEN, `Postgres doesn't support this query type yet ${JSON.stringify(fieldValue)}`);
    }
  }
  values = values.map(transformValue);
  return {
    pattern: patterns.join(' AND '),
    values,
    sorts
  };
};
class PostgresStorageAdapter {
  // Private

  constructor({
    uri,
    collectionPrefix = '',
    databaseOptions = {}
  }) {
    const options = {
      ...databaseOptions
    };
    this._collectionPrefix = collectionPrefix;
    this.enableSchemaHooks = !!databaseOptions.enableSchemaHooks;
    this.disableIndexFieldValidation = !!databaseOptions.disableIndexFieldValidation;
    this.schemaCacheTtl = databaseOptions.schemaCacheTtl;
    for (const key of ['enableSchemaHooks', 'schemaCacheTtl', 'disableIndexFieldValidation']) {
      delete options[key];
    }
    const {
      client,
      pgp
    } = (0, _PostgresClient.createClient)(uri, options);
    this._client = client;
    this._onchange = () => {};
    this._pgp = pgp;
    this._uuid = (0, _uuid.v4)();
    this.canSortOnJoinTables = false;
  }
  watch(callback) {
    this._onchange = callback;
  }

  //Note that analyze=true will run the query, executing INSERTS, DELETES, etc.
  createExplainableQuery(query, analyze = false) {
    if (analyze) {
      return 'EXPLAIN (ANALYZE, FORMAT JSON) ' + query;
    } else {
      return 'EXPLAIN (FORMAT JSON) ' + query;
    }
  }
  handleShutdown() {
    if (this._stream) {
      this._stream.done();
      delete this._stream;
    }
    if (!this._client) {
      return;
    }
    this._client.$pool.end();
  }
  async _listenToSchema() {
    if (!this._stream && this.enableSchemaHooks) {
      this._stream = await this._client.connect({
        direct: true
      });
      this._stream.client.on('notification', data => {
        const payload = JSON.parse(data.payload);
        if (payload.senderId !== this._uuid) {
          this._onchange();
        }
      });
      await this._stream.none('LISTEN $1~', 'schema.change');
    }
  }
  _notifySchemaChange() {
    if (this._stream) {
      this._stream.none('NOTIFY $1~, $2', ['schema.change', {
        senderId: this._uuid
      }]).catch(error => {
        // eslint-disable-next-line no-console
        console.log('Failed to Notify:', error); // unlikely to ever happen
      });
    }
  }
  async _ensureSchemaCollectionExists(conn) {
    conn = conn || this._client;
    await conn.none('CREATE TABLE IF NOT EXISTS "_SCHEMA" ( "className" varChar(120), "schema" jsonb, "isParseClass" bool, PRIMARY KEY ("className") )').catch(error => {
      throw error;
    });
  }
  async classExists(name) {
    return this._client.one('SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)', [name], a => a.exists);
  }
  async setClassLevelPermissions(className, CLPs) {
    await this._client.task('set-class-level-permissions', async t => {
      const values = [className, 'schema', 'classLevelPermissions', JSON.stringify(CLPs)];
      await t.none(`UPDATE "_SCHEMA" SET $2:name = json_object_set_key($2:name, $3::text, $4::jsonb) WHERE "className" = $1`, values);
    });
    this._notifySchemaChange();
  }
  async setIndexesWithSchemaFormat(className, submittedIndexes, existingIndexes = {}, fields, conn) {
    conn = conn || this._client;
    const self = this;
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
    const deletedIndexes = [];
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
        deletedIndexes.push(name);
        delete existingIndexes[name];
      } else {
        Object.keys(field).forEach(key => {
          if (!this.disableIndexFieldValidation && !Object.prototype.hasOwnProperty.call(fields, key)) {
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
    await conn.tx('set-indexes-with-schema-format', async t => {
      try {
        if (insertedIndexes.length > 0) {
          await self.createIndexes(className, insertedIndexes, t);
        }
      } catch (e) {
        // pg-promise use Batch error see https://github.com/vitaly-t/spex/blob/e572030f261be1a8e9341fc6f637e36ad07f5231/src/errors/batch.js#L59
        const columnDoesNotExistError = e.getErrors && e.getErrors()[0] && e.getErrors()[0].code === '42703';
        // Specific case when the column does not exist
        if (columnDoesNotExistError) {
          // If the disableIndexFieldValidation is true, we should ignore the error
          if (!this.disableIndexFieldValidation) {
            throw e;
          }
        } else {
          throw e;
        }
      }
      if (deletedIndexes.length > 0) {
        await self.dropIndexes(className, deletedIndexes, t);
      }
      await t.none('UPDATE "_SCHEMA" SET $2:name = json_object_set_key($2:name, $3::text, $4::jsonb) WHERE "className" = $1', [className, 'schema', 'indexes', JSON.stringify(existingIndexes)]);
    });
    this._notifySchemaChange();
  }
  async createClass(className, schema, conn) {
    conn = conn || this._client;
    const parseSchema = await conn.tx('create-class', async t => {
      await this.createTable(className, schema, t);
      await t.none('INSERT INTO "_SCHEMA" ("className", "schema", "isParseClass") VALUES ($<className>, $<schema>, true)', {
        className,
        schema
      });
      await this.setIndexesWithSchemaFormat(className, schema.indexes, {}, schema.fields, t);
      return toParseSchema(schema);
    }).catch(err => {
      if (err.code === PostgresUniqueIndexViolationError && err.detail.includes(className)) {
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, `Class ${className} already exists.`);
      }
      throw err;
    });
    this._notifySchemaChange();
    return parseSchema;
  }

  // Just create a table, do not insert in schema
  async createTable(className, schema, conn) {
    conn = conn || this._client;
    debug('createTable');
    const valuesArray = [];
    const patternsArray = [];
    const fields = Object.assign({}, schema.fields);
    if (className === '_User') {
      fields._email_verify_token_expires_at = {
        type: 'Date'
      };
      fields._email_verify_token = {
        type: 'String'
      };
      fields._account_lockout_expires_at = {
        type: 'Date'
      };
      fields._failed_login_count = {
        type: 'Number'
      };
      fields._perishable_token = {
        type: 'String'
      };
      fields._perishable_token_expires_at = {
        type: 'Date'
      };
      fields._password_changed_at = {
        type: 'Date'
      };
      fields._password_history = {
        type: 'Array'
      };
    }
    let index = 2;
    const relations = [];
    Object.keys(fields).forEach(fieldName => {
      const parseType = fields[fieldName];
      // Skip when it's a relation
      // We'll create the tables later
      if (parseType.type === 'Relation') {
        relations.push(fieldName);
        return;
      }
      if (['_rperm', '_wperm'].indexOf(fieldName) >= 0) {
        parseType.contents = {
          type: 'String'
        };
      }
      valuesArray.push(fieldName);
      valuesArray.push(parseTypeToPostgresType(parseType));
      patternsArray.push(`$${index}:name $${index + 1}:raw`);
      if (fieldName === 'objectId') {
        patternsArray.push(`PRIMARY KEY ($${index}:name)`);
      }
      index = index + 2;
    });
    const qs = `CREATE TABLE IF NOT EXISTS $1:name (${patternsArray.join()})`;
    const values = [className, ...valuesArray];
    return conn.task('create-table', async t => {
      try {
        await t.none(qs, values);
      } catch (error) {
        if (error.code !== PostgresDuplicateRelationError) {
          throw error;
        }
        // ELSE: Table already exists, must have been created by a different request. Ignore the error.
      }
      await t.tx('create-table-tx', tx => {
        return tx.batch(relations.map(fieldName => {
          return tx.none('CREATE TABLE IF NOT EXISTS $<joinTable:name> ("relatedId" varChar(120), "owningId" varChar(120), PRIMARY KEY("relatedId", "owningId") )', {
            joinTable: `_Join:${fieldName}:${className}`
          });
        }));
      });
    });
  }
  async schemaUpgrade(className, schema, conn) {
    debug('schemaUpgrade');
    conn = conn || this._client;
    const self = this;
    await conn.task('schema-upgrade', async t => {
      const columns = await t.map('SELECT column_name FROM information_schema.columns WHERE table_name = $<className>', {
        className
      }, a => a.column_name);
      const newColumns = Object.keys(schema.fields).filter(item => columns.indexOf(item) === -1).map(fieldName => self.addFieldIfNotExists(className, fieldName, schema.fields[fieldName]));
      await t.batch(newColumns);
    });
  }
  async addFieldIfNotExists(className, fieldName, type) {
    // TODO: Must be revised for invalid logic...
    debug('addFieldIfNotExists');
    const self = this;
    await this._client.tx('add-field-if-not-exists', async t => {
      if (type.type !== 'Relation') {
        try {
          await t.none('ALTER TABLE $<className:name> ADD COLUMN IF NOT EXISTS $<fieldName:name> $<postgresType:raw>', {
            className,
            fieldName,
            postgresType: parseTypeToPostgresType(type)
          });
        } catch (error) {
          if (error.code === PostgresRelationDoesNotExistError) {
            return self.createClass(className, {
              fields: {
                [fieldName]: type
              }
            }, t);
          }
          if (error.code !== PostgresDuplicateColumnError) {
            throw error;
          }
          // Column already exists, created by other request. Carry on to see if it's the right type.
        }
      } else {
        await t.none('CREATE TABLE IF NOT EXISTS $<joinTable:name> ("relatedId" varChar(120), "owningId" varChar(120), PRIMARY KEY("relatedId", "owningId") )', {
          joinTable: `_Join:${fieldName}:${className}`
        });
      }
      const result = await t.any('SELECT "schema" FROM "_SCHEMA" WHERE "className" = $<className> and ("schema"::json->\'fields\'->$<fieldName>) is not null', {
        className,
        fieldName
      });
      if (result[0]) {
        throw 'Attempted to add a field that already exists';
      } else {
        const path = `{fields,${fieldName}}`;
        await t.none('UPDATE "_SCHEMA" SET "schema"=jsonb_set("schema", $<path>, $<type>)  WHERE "className"=$<className>', {
          path,
          type,
          className
        });
      }
    });
    this._notifySchemaChange();
  }
  async updateFieldOptions(className, fieldName, type) {
    await this._client.tx('update-schema-field-options', async t => {
      const path = `{fields,${fieldName}}`;
      await t.none('UPDATE "_SCHEMA" SET "schema"=jsonb_set("schema", $<path>, $<type>)  WHERE "className"=$<className>', {
        path,
        type,
        className
      });
    });
  }

  // Drops a collection. Resolves with true if it was a Parse Schema (eg. _User, Custom, etc.)
  // and resolves with false if it wasn't (eg. a join table). Rejects if deletion was impossible.
  async deleteClass(className) {
    const operations = [{
      query: `DROP TABLE IF EXISTS $1:name`,
      values: [className]
    }, {
      query: `DELETE FROM "_SCHEMA" WHERE "className" = $1`,
      values: [className]
    }];
    const response = await this._client.tx(t => t.none(this._pgp.helpers.concat(operations))).then(() => className.indexOf('_Join:') != 0); // resolves with false when _Join table

    this._notifySchemaChange();
    return response;
  }

  // Delete all data known to this adapter. Used for testing.
  async deleteAllClasses() {
    const now = new Date().getTime();
    const helpers = this._pgp.helpers;
    debug('deleteAllClasses');
    if (this._client?.$pool.ended) {
      return;
    }
    await this._client.task('delete-all-classes', async t => {
      try {
        const results = await t.any('SELECT * FROM "_SCHEMA"');
        const joins = results.reduce((list, schema) => {
          return list.concat(joinTablesForSchema(schema.schema));
        }, []);
        const classes = ['_SCHEMA', '_PushStatus', '_JobStatus', '_JobSchedule', '_Hooks', '_GlobalConfig', '_GraphQLConfig', '_Audience', '_Idempotency', ...results.map(result => result.className), ...joins];
        const queries = classes.map(className => ({
          query: 'DROP TABLE IF EXISTS $<className:name>',
          values: {
            className
          }
        }));
        await t.tx(tx => tx.none(helpers.concat(queries)));
      } catch (error) {
        if (error.code !== PostgresRelationDoesNotExistError) {
          throw error;
        }
        // No _SCHEMA collection. Don't delete anything.
      }
    }).then(() => {
      debug(`deleteAllClasses done in ${new Date().getTime() - now}`);
    });
  }

  // Remove the column and all the data. For Relations, the _Join collection is handled
  // specially, this function does not delete _Join columns. It should, however, indicate
  // that the relation fields does not exist anymore. In mongo, this means removing it from
  // the _SCHEMA collection.  There should be no actual data in the collection under the same name
  // as the relation column, so it's fine to attempt to delete it. If the fields listed to be
  // deleted do not exist, this function should return successfully anyways. Checking for
  // attempts to delete non-existent fields is the responsibility of Parse Server.

  // This function is not obligated to delete fields atomically. It is given the field
  // names in a list so that databases that are capable of deleting fields atomically
  // may do so.

  // Returns a Promise.
  async deleteFields(className, schema, fieldNames) {
    debug('deleteFields');
    fieldNames = fieldNames.reduce((list, fieldName) => {
      const field = schema.fields[fieldName];
      if (field.type !== 'Relation') {
        list.push(fieldName);
      }
      delete schema.fields[fieldName];
      return list;
    }, []);
    const values = [className, ...fieldNames];
    const columns = fieldNames.map((name, idx) => {
      return `$${idx + 2}:name`;
    }).join(', DROP COLUMN');
    await this._client.tx('delete-fields', async t => {
      await t.none('UPDATE "_SCHEMA" SET "schema" = $<schema> WHERE "className" = $<className>', {
        schema,
        className
      });
      if (values.length > 1) {
        await t.none(`ALTER TABLE $1:name DROP COLUMN IF EXISTS ${columns}`, values);
      }
    });
    this._notifySchemaChange();
  }

  // Return a promise for all schemas known to this adapter, in Parse format. In case the
  // schemas cannot be retrieved, returns a promise that rejects. Requirements for the
  // rejection reason are TBD.
  async getAllClasses() {
    return this._client.task('get-all-classes', async t => {
      return await t.map('SELECT * FROM "_SCHEMA"', null, row => toParseSchema({
        className: row.className,
        ...row.schema
      }));
    });
  }

  // Return a promise for the schema with the given name, in Parse format. If
  // this adapter doesn't know about the schema, return a promise that rejects with
  // undefined as the reason.
  async getClass(className) {
    debug('getClass');
    return this._client.any('SELECT * FROM "_SCHEMA" WHERE "className" = $<className>', {
      className
    }).then(result => {
      if (result.length !== 1) {
        throw undefined;
      }
      return result[0].schema;
    }).then(toParseSchema);
  }

  // TODO: remove the mongo format dependency in the return value
  async createObject(className, schema, object, transactionalSession) {
    debug('createObject');
    let columnsArray = [];
    const valuesArray = [];
    schema = toPostgresSchema(schema);
    const geoPoints = {};
    object = handleDotFields(object);
    validateKeys(object);
    Object.keys(object).forEach(fieldName => {
      if (object[fieldName] === null) {
        return;
      }
      var authDataMatch = fieldName.match(/^_auth_data_([a-zA-Z0-9_]+)$/);
      const authDataAlreadyExists = !!object.authData;
      if (authDataMatch) {
        var provider = authDataMatch[1];
        object['authData'] = object['authData'] || {};
        object['authData'][provider] = object[fieldName];
        delete object[fieldName];
        fieldName = 'authData';
        // Avoid adding authData multiple times to the query
        if (authDataAlreadyExists) {
          return;
        }
      }
      columnsArray.push(fieldName);
      if (!schema.fields[fieldName] && className === '_User') {
        if (fieldName === '_email_verify_token' || fieldName === '_failed_login_count' || fieldName === '_perishable_token' || fieldName === '_password_history') {
          valuesArray.push(object[fieldName]);
        }
        if (fieldName === '_email_verify_token_expires_at') {
          if (object[fieldName]) {
            valuesArray.push(object[fieldName].iso);
          } else {
            valuesArray.push(null);
          }
        }
        if (fieldName === '_account_lockout_expires_at' || fieldName === '_perishable_token_expires_at' || fieldName === '_password_changed_at') {
          if (object[fieldName]) {
            valuesArray.push(object[fieldName].iso);
          } else {
            valuesArray.push(null);
          }
        }
        return;
      }
      switch (schema.fields[fieldName].type) {
        case 'Date':
          if (object[fieldName]) {
            valuesArray.push(object[fieldName].iso);
          } else {
            valuesArray.push(null);
          }
          break;
        case 'Pointer':
          valuesArray.push(object[fieldName].objectId);
          break;
        case 'Array':
          if (['_rperm', '_wperm'].indexOf(fieldName) >= 0) {
            valuesArray.push(object[fieldName]);
          } else {
            valuesArray.push(JSON.stringify(object[fieldName]));
          }
          break;
        case 'Object':
        case 'Bytes':
        case 'String':
        case 'Number':
        case 'Boolean':
          valuesArray.push(object[fieldName]);
          break;
        case 'File':
          valuesArray.push(object[fieldName].name);
          break;
        case 'Polygon':
          {
            const value = convertPolygonToSQL(object[fieldName].coordinates);
            valuesArray.push(value);
            break;
          }
        case 'GeoPoint':
          // pop the point and process later
          geoPoints[fieldName] = object[fieldName];
          columnsArray.pop();
          break;
        default:
          throw `Type ${schema.fields[fieldName].type} not supported yet`;
      }
    });
    columnsArray = columnsArray.concat(Object.keys(geoPoints));
    const initialValues = valuesArray.map((val, index) => {
      let termination = '';
      const fieldName = columnsArray[index];
      if (['_rperm', '_wperm'].indexOf(fieldName) >= 0) {
        termination = '::text[]';
      } else if (schema.fields[fieldName] && schema.fields[fieldName].type === 'Array') {
        termination = '::jsonb';
      }
      return `$${index + 2 + columnsArray.length}${termination}`;
    });
    const geoPointsInjects = Object.keys(geoPoints).map(key => {
      const value = geoPoints[key];
      valuesArray.push(value.longitude, value.latitude);
      const l = valuesArray.length + columnsArray.length;
      return `POINT($${l}, $${l + 1})`;
    });
    const columnsPattern = columnsArray.map((col, index) => `$${index + 2}:name`).join();
    const valuesPattern = initialValues.concat(geoPointsInjects).join();
    const qs = `INSERT INTO $1:name (${columnsPattern}) VALUES (${valuesPattern})`;
    const values = [className, ...columnsArray, ...valuesArray];
    const promise = (transactionalSession ? transactionalSession.t : this._client).none(qs, values).then(() => ({
      ops: [object]
    })).catch(error => {
      if (error.code === PostgresUniqueIndexViolationError) {
        const err = new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        err.underlyingError = error;
        if (error.constraint) {
          const matches = error.constraint.match(/unique_([a-zA-Z]+)/);
          if (matches && Array.isArray(matches)) {
            err.userInfo = {
              duplicated_field: matches[1]
            };
          }
        }
        error = err;
      }
      throw error;
    });
    if (transactionalSession) {
      transactionalSession.batch.push(promise);
    }
    return promise;
  }

  // Remove all objects that match the given Parse Query.
  // If no objects match, reject with OBJECT_NOT_FOUND. If objects are found and deleted, resolve with undefined.
  // If there is some other error, reject with INTERNAL_SERVER_ERROR.
  async deleteObjectsByQuery(className, schema, query, transactionalSession) {
    debug('deleteObjectsByQuery');
    const values = [className];
    const index = 2;
    const where = buildWhereClause({
      schema,
      index,
      query,
      caseInsensitive: false
    });
    values.push(...where.values);
    if (Object.keys(query).length === 0) {
      where.pattern = 'TRUE';
    }
    const qs = `WITH deleted AS (DELETE FROM $1:name WHERE ${where.pattern} RETURNING *) SELECT count(*) FROM deleted`;
    const promise = (transactionalSession ? transactionalSession.t : this._client).one(qs, values, a => +a.count).then(count => {
      if (count === 0) {
        throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Object not found.');
      } else {
        return count;
      }
    }).catch(error => {
      if (error.code !== PostgresRelationDoesNotExistError) {
        throw error;
      }
      // ELSE: Don't delete anything if doesn't exist
    });
    if (transactionalSession) {
      transactionalSession.batch.push(promise);
    }
    return promise;
  }
  // Return value not currently well specified.
  async findOneAndUpdate(className, schema, query, update, transactionalSession) {
    debug('findOneAndUpdate');
    return this.updateObjectsByQuery(className, schema, query, update, transactionalSession).then(val => val[0]);
  }

  // Apply the update to all objects that match the given Parse Query.
  async updateObjectsByQuery(className, schema, query, update, transactionalSession) {
    debug('updateObjectsByQuery');
    const updatePatterns = [];
    const values = [className];
    let index = 2;
    schema = toPostgresSchema(schema);
    const originalUpdate = {
      ...update
    };

    // Set flag for dot notation fields
    const dotNotationOptions = {};
    Object.keys(update).forEach(fieldName => {
      if (fieldName.indexOf('.') > -1) {
        const components = fieldName.split('.');
        const first = components.shift();
        dotNotationOptions[first] = true;
      } else {
        dotNotationOptions[fieldName] = false;
      }
    });
    update = handleDotFields(update);
    // Resolve authData first,
    // So we don't end up with multiple key updates
    for (const fieldName in update) {
      const authDataMatch = fieldName.match(/^_auth_data_([a-zA-Z0-9_]+)$/);
      if (authDataMatch) {
        var provider = authDataMatch[1];
        const value = update[fieldName];
        delete update[fieldName];
        update['authData'] = update['authData'] || {};
        update['authData'][provider] = value;
      }
    }
    for (const fieldName in update) {
      const fieldValue = update[fieldName];
      // Drop any undefined values.
      if (typeof fieldValue === 'undefined') {
        delete update[fieldName];
      } else if (fieldValue === null) {
        updatePatterns.push(`$${index}:name = NULL`);
        values.push(fieldName);
        index += 1;
      } else if (fieldName == 'authData') {
        // This recursively sets the json_object
        // Only 1 level deep
        const generate = (jsonb, key, value) => {
          return `json_object_set_key(COALESCE(${jsonb}, '{}'::jsonb), ${key}, ${value})::jsonb`;
        };
        const lastKey = `$${index}:name`;
        const fieldNameIndex = index;
        index += 1;
        values.push(fieldName);
        const update = Object.keys(fieldValue).reduce((lastKey, key) => {
          const str = generate(lastKey, `$${index}::text`, `$${index + 1}::jsonb`);
          index += 2;
          let value = fieldValue[key];
          if (value) {
            if (value.__op === 'Delete') {
              value = null;
            } else {
              value = JSON.stringify(value);
            }
          }
          values.push(key, value);
          return str;
        }, lastKey);
        updatePatterns.push(`$${fieldNameIndex}:name = ${update}`);
      } else if (fieldValue.__op === 'Increment') {
        updatePatterns.push(`$${index}:name = COALESCE($${index}:name, 0) + $${index + 1}`);
        values.push(fieldName, fieldValue.amount);
        index += 2;
      } else if (fieldValue.__op === 'Add') {
        updatePatterns.push(`$${index}:name = array_add(COALESCE($${index}:name, '[]'::jsonb), $${index + 1}::jsonb)`);
        values.push(fieldName, JSON.stringify(fieldValue.objects));
        index += 2;
      } else if (fieldValue.__op === 'Delete') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, null);
        index += 2;
      } else if (fieldValue.__op === 'Remove') {
        updatePatterns.push(`$${index}:name = array_remove(COALESCE($${index}:name, '[]'::jsonb), $${index + 1}::jsonb)`);
        values.push(fieldName, JSON.stringify(fieldValue.objects));
        index += 2;
      } else if (fieldValue.__op === 'AddUnique') {
        updatePatterns.push(`$${index}:name = array_add_unique(COALESCE($${index}:name, '[]'::jsonb), $${index + 1}::jsonb)`);
        values.push(fieldName, JSON.stringify(fieldValue.objects));
        index += 2;
      } else if (fieldName === 'updatedAt') {
        //TODO: stop special casing this. It should check for __type === 'Date' and use .iso
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (typeof fieldValue === 'string') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (typeof fieldValue === 'boolean') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (fieldValue.__type === 'Pointer') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue.objectId);
        index += 2;
      } else if (fieldValue.__type === 'Date') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, toPostgresValue(fieldValue));
        index += 2;
      } else if (fieldValue instanceof Date) {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (fieldValue.__type === 'File') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, toPostgresValue(fieldValue));
        index += 2;
      } else if (fieldValue.__type === 'GeoPoint') {
        updatePatterns.push(`$${index}:name = POINT($${index + 1}, $${index + 2})`);
        values.push(fieldName, fieldValue.longitude, fieldValue.latitude);
        index += 3;
      } else if (fieldValue.__type === 'Polygon') {
        const value = convertPolygonToSQL(fieldValue.coordinates);
        updatePatterns.push(`$${index}:name = $${index + 1}::polygon`);
        values.push(fieldName, value);
        index += 2;
      } else if (fieldValue.__type === 'Relation') {
        // noop
      } else if (typeof fieldValue === 'number') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (typeof fieldValue === 'object' && schema.fields[fieldName] && schema.fields[fieldName].type === 'Object') {
        // Gather keys to increment
        const keysToIncrement = Object.keys(originalUpdate).filter(k => {
          // choose top level fields that have a delete operation set
          // Note that Object.keys is iterating over the **original** update object
          // and that some of the keys of the original update could be null or undefined:
          // (See the above check `if (fieldValue === null || typeof fieldValue == "undefined")`)
          const value = originalUpdate[k];
          return value && value.__op === 'Increment' && k.split('.').length === 2 && k.split('.')[0] === fieldName;
        }).map(k => k.split('.')[1]);
        let incrementPatterns = '';
        if (keysToIncrement.length > 0) {
          incrementPatterns = ' || ' + keysToIncrement.map(c => {
            const amount = fieldValue[c].amount;
            return `CONCAT('{"${c}":', COALESCE($${index}:name->>'${c}','0')::int + ${amount}, '}')::jsonb`;
          }).join(' || ');
          // Strip the keys
          keysToIncrement.forEach(key => {
            delete fieldValue[key];
          });
        }
        const keysToDelete = Object.keys(originalUpdate).filter(k => {
          // choose top level fields that have a delete operation set.
          const value = originalUpdate[k];
          return value && value.__op === 'Delete' && k.split('.').length === 2 && k.split('.')[0] === fieldName;
        }).map(k => k.split('.')[1]);
        const deletePatterns = keysToDelete.reduce((p, c, i) => {
          return p + ` - '$${index + 1 + i}:value'`;
        }, '');
        // Override Object
        let updateObject = "'{}'::jsonb";
        if (dotNotationOptions[fieldName]) {
          // Merge Object
          updateObject = `COALESCE($${index}:name, '{}'::jsonb)`;
        }
        updatePatterns.push(`$${index}:name = (${updateObject} ${deletePatterns} ${incrementPatterns} || $${index + 1 + keysToDelete.length}::jsonb )`);
        values.push(fieldName, ...keysToDelete, JSON.stringify(fieldValue));
        index += 2 + keysToDelete.length;
      } else if (Array.isArray(fieldValue) && schema.fields[fieldName] && schema.fields[fieldName].type === 'Array') {
        const expectedType = parseTypeToPostgresType(schema.fields[fieldName]);
        if (expectedType === 'text[]') {
          updatePatterns.push(`$${index}:name = $${index + 1}::text[]`);
          values.push(fieldName, fieldValue);
          index += 2;
        } else {
          updatePatterns.push(`$${index}:name = $${index + 1}::jsonb`);
          values.push(fieldName, JSON.stringify(fieldValue));
          index += 2;
        }
      } else {
        debug('Not supported update', {
          fieldName,
          fieldValue
        });
        return Promise.reject(new _node.default.Error(_node.default.Error.OPERATION_FORBIDDEN, `Postgres doesn't support update ${JSON.stringify(fieldValue)} yet`));
      }
    }
    const where = buildWhereClause({
      schema,
      index,
      query,
      caseInsensitive: false
    });
    values.push(...where.values);
    const whereClause = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const qs = `UPDATE $1:name SET ${updatePatterns.join()} ${whereClause} RETURNING *`;
    const promise = (transactionalSession ? transactionalSession.t : this._client).any(qs, values);
    if (transactionalSession) {
      transactionalSession.batch.push(promise);
    }
    return promise;
  }

  // Hopefully, we can get rid of this. It's only used for config and hooks.
  upsertOneObject(className, schema, query, update, transactionalSession) {
    debug('upsertOneObject');
    const createValue = Object.assign({}, query, update);
    return this.createObject(className, schema, createValue, transactionalSession).catch(error => {
      // ignore duplicate value errors as it's upsert
      if (error.code !== _node.default.Error.DUPLICATE_VALUE) {
        throw error;
      }
      return this.findOneAndUpdate(className, schema, query, update, transactionalSession);
    });
  }
  find(className, schema, query, {
    skip,
    limit,
    sort,
    keys,
    caseInsensitive,
    explain
  }) {
    debug('find');
    const hasLimit = limit !== undefined;
    const hasSkip = skip !== undefined;
    let values = [className];
    const where = buildWhereClause({
      schema,
      query,
      index: 2,
      caseInsensitive
    });
    values.push(...where.values);
    const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const limitPattern = hasLimit ? `LIMIT $${values.length + 1}` : '';
    if (hasLimit) {
      values.push(limit);
    }
    const skipPattern = hasSkip ? `OFFSET $${values.length + 1}` : '';
    if (hasSkip) {
      values.push(skip);
    }
    let sortPattern = '';
    if (sort) {
      const sortCopy = sort;
      const sorting = Object.keys(sort).map(key => {
        const transformKey = transformDotFieldToComponents(key).join('->');
        // Using $idx pattern gives:  non-integer constant in ORDER BY
        if (sortCopy[key] === 1) {
          return `${transformKey} ASC`;
        }
        return `${transformKey} DESC`;
      }).join();
      sortPattern = sort !== undefined && Object.keys(sort).length > 0 ? `ORDER BY ${sorting}` : '';
    }
    if (where.sorts && Object.keys(where.sorts).length > 0) {
      sortPattern = `ORDER BY ${where.sorts.join()}`;
    }
    let columns = '*';
    if (keys) {
      // Exclude empty keys
      // Replace ACL by it's keys
      keys = keys.reduce((memo, key) => {
        if (key === 'ACL') {
          memo.push('_rperm');
          memo.push('_wperm');
        } else if (key.length > 0 && (
        // Remove selected field not referenced in the schema
        // Relation is not a column in postgres
        // $score is a Parse special field and is also not a column
        schema.fields[key] && schema.fields[key].type !== 'Relation' || key === '$score')) {
          memo.push(key);
        }
        return memo;
      }, []);
      columns = keys.map((key, index) => {
        if (key === '$score') {
          return `ts_rank_cd(to_tsvector($${2}, $${3}:name), to_tsquery($${4}, $${5}), 32) as score`;
        }
        return `$${index + values.length + 1}:name`;
      }).join();
      values = values.concat(keys);
    }
    const originalQuery = `SELECT ${columns} FROM $1:name ${wherePattern} ${sortPattern} ${limitPattern} ${skipPattern}`;
    const qs = explain ? this.createExplainableQuery(originalQuery) : originalQuery;
    return this._client.any(qs, values).catch(error => {
      // Query on non existing table, don't crash
      if (error.code !== PostgresRelationDoesNotExistError) {
        throw error;
      }
      return [];
    }).then(results => {
      if (explain) {
        return results;
      }
      return results.map(object => this.postgresObjectToParseObject(className, object, schema));
    });
  }

  // Converts from a postgres-format object to a REST-format object.
  // Does not strip out anything based on a lack of authentication.
  postgresObjectToParseObject(className, object, schema) {
    Object.keys(schema.fields).forEach(fieldName => {
      if (schema.fields[fieldName].type === 'Pointer' && object[fieldName]) {
        object[fieldName] = {
          objectId: object[fieldName],
          __type: 'Pointer',
          className: schema.fields[fieldName].targetClass
        };
      }
      if (schema.fields[fieldName].type === 'Relation') {
        object[fieldName] = {
          __type: 'Relation',
          className: schema.fields[fieldName].targetClass
        };
      }
      if (object[fieldName] && schema.fields[fieldName].type === 'GeoPoint') {
        object[fieldName] = {
          __type: 'GeoPoint',
          latitude: object[fieldName].y,
          longitude: object[fieldName].x
        };
      }
      if (object[fieldName] && schema.fields[fieldName].type === 'Polygon') {
        let coords = new String(object[fieldName]);
        coords = coords.substring(2, coords.length - 2).split('),(');
        const updatedCoords = coords.map(point => {
          return [parseFloat(point.split(',')[1]), parseFloat(point.split(',')[0])];
        });
        object[fieldName] = {
          __type: 'Polygon',
          coordinates: updatedCoords
        };
      }
      if (object[fieldName] && schema.fields[fieldName].type === 'File') {
        object[fieldName] = {
          __type: 'File',
          name: object[fieldName]
        };
      }
    });
    //TODO: remove this reliance on the mongo format. DB adapter shouldn't know there is a difference between created at and any other date field.
    if (object.createdAt) {
      object.createdAt = object.createdAt.toISOString();
    }
    if (object.updatedAt) {
      object.updatedAt = object.updatedAt.toISOString();
    }
    if (object.expiresAt) {
      object.expiresAt = {
        __type: 'Date',
        iso: object.expiresAt.toISOString()
      };
    }
    if (object._email_verify_token_expires_at) {
      object._email_verify_token_expires_at = {
        __type: 'Date',
        iso: object._email_verify_token_expires_at.toISOString()
      };
    }
    if (object._account_lockout_expires_at) {
      object._account_lockout_expires_at = {
        __type: 'Date',
        iso: object._account_lockout_expires_at.toISOString()
      };
    }
    if (object._perishable_token_expires_at) {
      object._perishable_token_expires_at = {
        __type: 'Date',
        iso: object._perishable_token_expires_at.toISOString()
      };
    }
    if (object._password_changed_at) {
      object._password_changed_at = {
        __type: 'Date',
        iso: object._password_changed_at.toISOString()
      };
    }
    for (const fieldName in object) {
      if (object[fieldName] === null) {
        delete object[fieldName];
      }
      if (object[fieldName] instanceof Date) {
        object[fieldName] = {
          __type: 'Date',
          iso: object[fieldName].toISOString()
        };
      }
    }
    return object;
  }

  // Create a unique index. Unique indexes on nullable fields are not allowed. Since we don't
  // currently know which fields are nullable and which aren't, we ignore that criteria.
  // As such, we shouldn't expose this function to users of parse until we have an out-of-band
  // Way of determining if a field is nullable. Undefined doesn't count against uniqueness,
  // which is why we use sparse indexes.
  async ensureUniqueness(className, schema, fieldNames) {
    const constraintName = `${className}_unique_${fieldNames.sort().join('_')}`;
    const constraintPatterns = fieldNames.map((fieldName, index) => `$${index + 3}:name`);
    const qs = `CREATE UNIQUE INDEX IF NOT EXISTS $2:name ON $1:name(${constraintPatterns.join()})`;
    return this._client.none(qs, [className, constraintName, ...fieldNames]).catch(error => {
      if (error.code === PostgresDuplicateRelationError && error.message.includes(constraintName)) {
        // Index already exists. Ignore error.
      } else if (error.code === PostgresUniqueIndexViolationError && error.message.includes(constraintName)) {
        // Cast the error into the proper parse error
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      } else {
        throw error;
      }
    });
  }

  // Executes a count.
  async count(className, schema, query, readPreference, estimate = true) {
    debug('count');
    const values = [className];
    const where = buildWhereClause({
      schema,
      query,
      index: 2,
      caseInsensitive: false
    });
    values.push(...where.values);
    const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    let qs = '';
    if (where.pattern.length > 0 || !estimate) {
      qs = `SELECT count(*) FROM $1:name ${wherePattern}`;
    } else {
      qs = 'SELECT reltuples AS approximate_row_count FROM pg_class WHERE relname = $1';
    }
    return this._client.one(qs, values, a => {
      if (a.approximate_row_count == null || a.approximate_row_count == -1) {
        return !isNaN(+a.count) ? +a.count : 0;
      } else {
        return +a.approximate_row_count;
      }
    }).catch(error => {
      if (error.code !== PostgresRelationDoesNotExistError) {
        throw error;
      }
      return 0;
    });
  }
  async distinct(className, schema, query, fieldName) {
    debug('distinct');
    let field = fieldName;
    let column = fieldName;
    const isNested = fieldName.indexOf('.') >= 0;
    if (isNested) {
      field = transformDotFieldToComponents(fieldName).join('->');
      column = fieldName.split('.')[0];
    }
    const isArrayField = schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Array';
    const isPointerField = schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Pointer';
    const values = [field, column, className];
    const where = buildWhereClause({
      schema,
      query,
      index: 4,
      caseInsensitive: false
    });
    values.push(...where.values);
    const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const transformer = isArrayField ? 'jsonb_array_elements' : 'ON';
    let qs = `SELECT DISTINCT ${transformer}($1:name) $2:name FROM $3:name ${wherePattern}`;
    if (isNested) {
      qs = `SELECT DISTINCT ${transformer}($1:raw) $2:raw FROM $3:name ${wherePattern}`;
    }
    return this._client.any(qs, values).catch(error => {
      if (error.code === PostgresMissingColumnError) {
        return [];
      }
      throw error;
    }).then(results => {
      if (!isNested) {
        results = results.filter(object => object[field] !== null);
        return results.map(object => {
          if (!isPointerField) {
            return object[field];
          }
          return {
            __type: 'Pointer',
            className: schema.fields[fieldName].targetClass,
            objectId: object[field]
          };
        });
      }
      const child = fieldName.split('.')[1];
      return results.map(object => object[column][child]);
    }).then(results => results.map(object => this.postgresObjectToParseObject(className, object, schema)));
  }
  async aggregate(className, schema, pipeline, readPreference, hint, explain) {
    debug('aggregate');
    const values = [className];
    let index = 2;
    let columns = [];
    let countField = null;
    let groupValues = null;
    let wherePattern = '';
    let limitPattern = '';
    let skipPattern = '';
    let sortPattern = '';
    let groupPattern = '';
    for (let i = 0; i < pipeline.length; i += 1) {
      const stage = pipeline[i];
      if (stage.$group) {
        for (const field in stage.$group) {
          const value = stage.$group[field];
          if (value === null || value === undefined) {
            continue;
          }
          if (field === '_id' && typeof value === 'string' && value !== '') {
            columns.push(`$${index}:name AS "objectId"`);
            groupPattern = `GROUP BY $${index}:name`;
            values.push(transformAggregateField(value));
            index += 1;
            continue;
          }
          if (field === '_id' && typeof value === 'object' && Object.keys(value).length !== 0) {
            groupValues = value;
            const groupByFields = [];
            for (const alias in value) {
              if (typeof value[alias] === 'string' && value[alias]) {
                const source = transformAggregateField(value[alias]);
                if (!groupByFields.includes(`"${source}"`)) {
                  groupByFields.push(`"${source}"`);
                }
                values.push(source, alias);
                columns.push(`$${index}:name AS $${index + 1}:name`);
                index += 2;
              } else {
                const operation = Object.keys(value[alias])[0];
                const source = transformAggregateField(value[alias][operation]);
                if (mongoAggregateToPostgres[operation]) {
                  if (!groupByFields.includes(`"${source}"`)) {
                    groupByFields.push(`"${source}"`);
                  }
                  columns.push(`EXTRACT(${mongoAggregateToPostgres[operation]} FROM $${index}:name AT TIME ZONE 'UTC')::integer AS $${index + 1}:name`);
                  values.push(source, alias);
                  index += 2;
                }
              }
            }
            groupPattern = `GROUP BY $${index}:raw`;
            values.push(groupByFields.join());
            index += 1;
            continue;
          }
          if (typeof value === 'object') {
            if (value.$sum) {
              if (typeof value.$sum === 'string') {
                columns.push(`SUM($${index}:name) AS $${index + 1}:name`);
                values.push(transformAggregateField(value.$sum), field);
                index += 2;
              } else {
                countField = field;
                columns.push(`COUNT(*) AS $${index}:name`);
                values.push(field);
                index += 1;
              }
            }
            if (value.$max) {
              columns.push(`MAX($${index}:name) AS $${index + 1}:name`);
              values.push(transformAggregateField(value.$max), field);
              index += 2;
            }
            if (value.$min) {
              columns.push(`MIN($${index}:name) AS $${index + 1}:name`);
              values.push(transformAggregateField(value.$min), field);
              index += 2;
            }
            if (value.$avg) {
              columns.push(`AVG($${index}:name) AS $${index + 1}:name`);
              values.push(transformAggregateField(value.$avg), field);
              index += 2;
            }
          }
        }
      } else {
        columns.push('*');
      }
      if (stage.$project) {
        if (columns.includes('*')) {
          columns = [];
        }
        for (const field in stage.$project) {
          const value = stage.$project[field];
          if (value === 1 || value === true) {
            columns.push(`$${index}:name`);
            values.push(field);
            index += 1;
          }
        }
      }
      if (stage.$match) {
        const patterns = [];
        const orOrAnd = Object.prototype.hasOwnProperty.call(stage.$match, '$or') ? ' OR ' : ' AND ';
        if (stage.$match.$or) {
          const collapse = {};
          stage.$match.$or.forEach(element => {
            for (const key in element) {
              collapse[key] = element[key];
            }
          });
          stage.$match = collapse;
        }
        for (let field in stage.$match) {
          const value = stage.$match[field];
          if (field === '_id') {
            field = 'objectId';
          }
          const matchPatterns = [];
          Object.keys(ParseToPosgresComparator).forEach(cmp => {
            if (value[cmp]) {
              const pgComparator = ParseToPosgresComparator[cmp];
              matchPatterns.push(`$${index}:name ${pgComparator} $${index + 1}`);
              values.push(field, toPostgresValue(value[cmp]));
              index += 2;
            }
          });
          if (matchPatterns.length > 0) {
            patterns.push(`(${matchPatterns.join(' AND ')})`);
          }
          if (schema.fields[field] && schema.fields[field].type && matchPatterns.length === 0) {
            patterns.push(`$${index}:name = $${index + 1}`);
            values.push(field, value);
            index += 2;
          }
        }
        wherePattern = patterns.length > 0 ? `WHERE ${patterns.join(` ${orOrAnd} `)}` : '';
      }
      if (stage.$limit) {
        limitPattern = `LIMIT $${index}`;
        values.push(stage.$limit);
        index += 1;
      }
      if (stage.$skip) {
        skipPattern = `OFFSET $${index}`;
        values.push(stage.$skip);
        index += 1;
      }
      if (stage.$sort) {
        const sort = stage.$sort;
        const keys = Object.keys(sort);
        const sorting = keys.map(key => {
          const transformer = sort[key] === 1 ? 'ASC' : 'DESC';
          const order = `$${index}:name ${transformer}`;
          index += 1;
          return order;
        }).join();
        values.push(...keys);
        sortPattern = sort !== undefined && sorting.length > 0 ? `ORDER BY ${sorting}` : '';
      }
    }
    if (groupPattern) {
      columns.forEach((e, i, a) => {
        if (e && e.trim() === '*') {
          a[i] = '';
        }
      });
    }
    const originalQuery = `SELECT ${columns.filter(Boolean).join()} FROM $1:name ${wherePattern} ${skipPattern} ${groupPattern} ${sortPattern} ${limitPattern}`;
    const qs = explain ? this.createExplainableQuery(originalQuery) : originalQuery;
    return this._client.any(qs, values).then(a => {
      if (explain) {
        return a;
      }
      const results = a.map(object => this.postgresObjectToParseObject(className, object, schema));
      results.forEach(result => {
        if (!Object.prototype.hasOwnProperty.call(result, 'objectId')) {
          result.objectId = null;
        }
        if (groupValues) {
          result.objectId = {};
          for (const key in groupValues) {
            result.objectId[key] = result[key];
            delete result[key];
          }
        }
        if (countField) {
          result[countField] = parseInt(result[countField], 10);
        }
      });
      return results;
    });
  }
  async performInitialization({
    VolatileClassesSchemas
  }) {
    // TODO: This method needs to be rewritten to make proper use of connections (@vitaly-t)
    debug('performInitialization');
    await this._ensureSchemaCollectionExists();
    const promises = VolatileClassesSchemas.map(schema => {
      return this.createTable(schema.className, schema).catch(err => {
        if (err.code === PostgresDuplicateRelationError || err.code === _node.default.Error.INVALID_CLASS_NAME) {
          return Promise.resolve();
        }
        throw err;
      }).then(() => this.schemaUpgrade(schema.className, schema));
    });
    promises.push(this._listenToSchema());
    return Promise.all(promises).then(() => {
      return this._client.tx('perform-initialization', async t => {
        await t.none(_sql.default.misc.jsonObjectSetKeys);
        await t.none(_sql.default.array.add);
        await t.none(_sql.default.array.addUnique);
        await t.none(_sql.default.array.remove);
        await t.none(_sql.default.array.containsAll);
        await t.none(_sql.default.array.containsAllRegex);
        await t.none(_sql.default.array.contains);
        return t.ctx;
      });
    }).then(ctx => {
      debug(`initializationDone in ${ctx.duration}`);
    }).catch(error => {
      // eslint-disable-next-line no-console
      console.error(error);
    });
  }
  async createIndexes(className, indexes, conn) {
    return (conn || this._client).tx(t => t.batch(indexes.map(i => {
      return t.none('CREATE INDEX IF NOT EXISTS $1:name ON $2:name ($3:name)', [i.name, className, i.key]);
    })));
  }
  async createIndexesIfNeeded(className, fieldName, type, conn) {
    await (conn || this._client).none('CREATE INDEX IF NOT EXISTS $1:name ON $2:name ($3:name)', [fieldName, className, type]);
  }
  async dropIndexes(className, indexes, conn) {
    const queries = indexes.map(i => ({
      query: 'DROP INDEX $1:name',
      values: i
    }));
    await (conn || this._client).tx(t => t.none(this._pgp.helpers.concat(queries)));
  }
  async getIndexes(className) {
    const qs = 'SELECT * FROM pg_indexes WHERE tablename = ${className}';
    return this._client.any(qs, {
      className
    });
  }
  async updateSchemaWithIndexes() {
    return Promise.resolve();
  }

  // Used for testing purposes
  async updateEstimatedCount(className) {
    return this._client.none('ANALYZE $1:name', [className]);
  }
  async createTransactionalSession() {
    return new Promise(resolve => {
      const transactionalSession = {};
      transactionalSession.result = this._client.tx(t => {
        transactionalSession.t = t;
        transactionalSession.promise = new Promise(resolve => {
          transactionalSession.resolve = resolve;
        });
        transactionalSession.batch = [];
        resolve(transactionalSession);
        return transactionalSession.promise;
      });
    });
  }
  commitTransactionalSession(transactionalSession) {
    transactionalSession.resolve(transactionalSession.t.batch(transactionalSession.batch));
    return transactionalSession.result;
  }
  abortTransactionalSession(transactionalSession) {
    const result = transactionalSession.result.catch();
    transactionalSession.batch.push(Promise.reject());
    transactionalSession.resolve(transactionalSession.t.batch(transactionalSession.batch));
    return result;
  }
  async ensureIndex(className, schema, fieldNames, indexName, caseInsensitive = false, options = {}) {
    const conn = options.conn !== undefined ? options.conn : this._client;
    const defaultIndexName = `parse_default_${fieldNames.sort().join('_')}`;
    const indexNameOptions = indexName != null ? {
      name: indexName
    } : {
      name: defaultIndexName
    };
    const constraintPatterns = caseInsensitive ? fieldNames.map((fieldName, index) => `lower($${index + 3}:name) varchar_pattern_ops`) : fieldNames.map((fieldName, index) => `$${index + 3}:name`);
    const qs = `CREATE INDEX IF NOT EXISTS $1:name ON $2:name (${constraintPatterns.join()})`;
    const setIdempotencyFunction = options.setIdempotencyFunction !== undefined ? options.setIdempotencyFunction : false;
    if (setIdempotencyFunction) {
      await this.ensureIdempotencyFunctionExists(options);
    }
    await conn.none(qs, [indexNameOptions.name, className, ...fieldNames]).catch(error => {
      if (error.code === PostgresDuplicateRelationError && error.message.includes(indexNameOptions.name)) {
        // Index already exists. Ignore error.
      } else if (error.code === PostgresUniqueIndexViolationError && error.message.includes(indexNameOptions.name)) {
        // Cast the error into the proper parse error
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      } else {
        throw error;
      }
    });
  }
  async deleteIdempotencyFunction(options = {}) {
    const conn = options.conn !== undefined ? options.conn : this._client;
    const qs = 'DROP FUNCTION IF EXISTS idempotency_delete_expired_records()';
    return conn.none(qs).catch(error => {
      throw error;
    });
  }
  async ensureIdempotencyFunctionExists(options = {}) {
    const conn = options.conn !== undefined ? options.conn : this._client;
    const ttlOptions = options.ttl !== undefined ? `${options.ttl} seconds` : '60 seconds';
    const qs = 'CREATE OR REPLACE FUNCTION idempotency_delete_expired_records() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM "_Idempotency" WHERE expire < NOW() - INTERVAL $1; END; $$;';
    return conn.none(qs, [ttlOptions]).catch(error => {
      throw error;
    });
  }
}
exports.PostgresStorageAdapter = PostgresStorageAdapter;
function convertPolygonToSQL(polygon) {
  if (polygon.length < 3) {
    throw new _node.default.Error(_node.default.Error.INVALID_JSON, `Polygon must have at least 3 values`);
  }
  if (polygon[0][0] !== polygon[polygon.length - 1][0] || polygon[0][1] !== polygon[polygon.length - 1][1]) {
    polygon.push(polygon[0]);
  }
  const unique = polygon.filter((item, index, ar) => {
    let foundIndex = -1;
    for (let i = 0; i < ar.length; i += 1) {
      const pt = ar[i];
      if (pt[0] === item[0] && pt[1] === item[1]) {
        foundIndex = i;
        break;
      }
    }
    return foundIndex === index;
  });
  if (unique.length < 3) {
    throw new _node.default.Error(_node.default.Error.INTERNAL_SERVER_ERROR, 'GeoJSON: Loop must have at least 3 different vertices');
  }
  const points = polygon.map(point => {
    _node.default.GeoPoint._validate(parseFloat(point[1]), parseFloat(point[0]));
    return `(${point[1]}, ${point[0]})`;
  }).join(', ');
  return `(${points})`;
}
function removeWhiteSpace(regex) {
  if (!regex.endsWith('\n')) {
    regex += '\n';
  }

  // remove non escaped comments
  return regex.replace(/([^\\])#.*\n/gim, '$1')
  // remove lines starting with a comment
  .replace(/^#.*\n/gim, '')
  // remove non escaped whitespace
  .replace(/([^\\])\s+/gim, '$1')
  // remove whitespace at the beginning of a line
  .replace(/^\s+/, '').trim();
}
function processRegexPattern(s) {
  if (s && s.startsWith('^')) {
    // regex for startsWith
    return '^' + literalizeRegexPart(s.slice(1));
  } else if (s && s.endsWith('$')) {
    // regex for endsWith
    return literalizeRegexPart(s.slice(0, s.length - 1)) + '$';
  }

  // regex for contains
  return literalizeRegexPart(s);
}
function isStartsWithRegex(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('^')) {
    return false;
  }
  const matches = value.match(/\^\\Q.*\\E/);
  return !!matches;
}
function isAllValuesRegexOrNone(values) {
  if (!values || !Array.isArray(values) || values.length === 0) {
    return true;
  }
  const firstValuesIsRegex = isStartsWithRegex(values[0].$regex);
  if (values.length === 1) {
    return firstValuesIsRegex;
  }
  for (let i = 1, length = values.length; i < length; ++i) {
    if (firstValuesIsRegex !== isStartsWithRegex(values[i].$regex)) {
      return false;
    }
  }
  return true;
}
function isAnyValueRegexStartsWith(values) {
  return values.some(function (value) {
    return isStartsWithRegex(value.$regex);
  });
}
function createLiteralRegex(remaining) {
  return remaining.split('').map(c => {
    const regex = RegExp('[0-9 ]|\\p{L}', 'u'); // Support all Unicode letter chars
    if (c.match(regex) !== null) {
      // Don't escape alphanumeric characters
      return c;
    }
    // Escape everything else (single quotes with single quotes, everything else with a backslash)
    return c === `'` ? `''` : `\\${c}`;
  }).join('');
}
function literalizeRegexPart(s) {
  const matcher1 = /\\Q((?!\\E).*)\\E$/;
  const result1 = s.match(matcher1);
  if (result1 && result1.length > 1 && result1.index > -1) {
    // Process Regex that has a beginning and an end specified for the literal text
    const prefix = s.substring(0, result1.index);
    const remaining = result1[1];
    return literalizeRegexPart(prefix) + createLiteralRegex(remaining);
  }

  // Process Regex that has a beginning specified for the literal text
  const matcher2 = /\\Q((?!\\E).*)$/;
  const result2 = s.match(matcher2);
  if (result2 && result2.length > 1 && result2.index > -1) {
    const prefix = s.substring(0, result2.index);
    const remaining = result2[1];
    return literalizeRegexPart(prefix) + createLiteralRegex(remaining);
  }

  // Remove problematic chars from remaining text
  return s
  // Remove all instances of \Q and \E
  .replace(/([^\\])(\\E)/, '$1').replace(/([^\\])(\\Q)/, '$1').replace(/^\\E/, '').replace(/^\\Q/, '')
  // Ensure even number of single quote sequences by adding an extra single quote if needed;
  // this ensures that every single quote is escaped
  .replace(/'+/g, match => {
    return match.length % 2 === 0 ? match : match + "'";
  });
}
var GeoPointCoder = {
  isValidJSON(value) {
    return typeof value === 'object' && value !== null && value.__type === 'GeoPoint';
  }
};
var _default = exports.default = PostgresStorageAdapter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfUG9zdGdyZXNDbGllbnQiLCJyZXF1aXJlIiwiX25vZGUiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwiX2xvZGFzaCIsIl91dWlkIiwiX3NxbCIsIl9TdG9yYWdlQWRhcHRlciIsImUiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsIlV0aWxzIiwiUG9zdGdyZXNSZWxhdGlvbkRvZXNOb3RFeGlzdEVycm9yIiwiUG9zdGdyZXNEdXBsaWNhdGVSZWxhdGlvbkVycm9yIiwiUG9zdGdyZXNEdXBsaWNhdGVDb2x1bW5FcnJvciIsIlBvc3RncmVzTWlzc2luZ0NvbHVtbkVycm9yIiwiUG9zdGdyZXNVbmlxdWVJbmRleFZpb2xhdGlvbkVycm9yIiwibG9nZ2VyIiwiZGVidWciLCJhcmdzIiwiYXJndW1lbnRzIiwiY29uY2F0Iiwic2xpY2UiLCJsZW5ndGgiLCJsb2ciLCJnZXRMb2dnZXIiLCJhcHBseSIsInBhcnNlVHlwZVRvUG9zdGdyZXNUeXBlIiwidHlwZSIsImNvbnRlbnRzIiwiSlNPTiIsInN0cmluZ2lmeSIsIlBhcnNlVG9Qb3NncmVzQ29tcGFyYXRvciIsIiRndCIsIiRsdCIsIiRndGUiLCIkbHRlIiwibW9uZ29BZ2dyZWdhdGVUb1Bvc3RncmVzIiwiJGRheU9mTW9udGgiLCIkZGF5T2ZXZWVrIiwiJGRheU9mWWVhciIsIiRpc29EYXlPZldlZWsiLCIkaXNvV2Vla1llYXIiLCIkaG91ciIsIiRtaW51dGUiLCIkc2Vjb25kIiwiJG1pbGxpc2Vjb25kIiwiJG1vbnRoIiwiJHdlZWsiLCIkeWVhciIsInRvUG9zdGdyZXNWYWx1ZSIsInZhbHVlIiwiX190eXBlIiwiaXNvIiwibmFtZSIsInRvUG9zdGdyZXNWYWx1ZUNhc3RUeXBlIiwicG9zdGdyZXNWYWx1ZSIsImNhc3RUeXBlIiwidW5kZWZpbmVkIiwidHJhbnNmb3JtVmFsdWUiLCJvYmplY3RJZCIsImVtcHR5Q0xQUyIsIk9iamVjdCIsImZyZWV6ZSIsImZpbmQiLCJnZXQiLCJjb3VudCIsImNyZWF0ZSIsInVwZGF0ZSIsImRlbGV0ZSIsImFkZEZpZWxkIiwicHJvdGVjdGVkRmllbGRzIiwiZGVmYXVsdENMUFMiLCJBQ0wiLCJyZWFkIiwid3JpdGUiLCJ0b1BhcnNlU2NoZW1hIiwic2NoZW1hIiwiY2xhc3NOYW1lIiwiZmllbGRzIiwiX2hhc2hlZF9wYXNzd29yZCIsIl93cGVybSIsIl9ycGVybSIsImNscHMiLCJjbGFzc0xldmVsUGVybWlzc2lvbnMiLCJpbmRleGVzIiwidG9Qb3N0Z3Jlc1NjaGVtYSIsIl9wYXNzd29yZF9oaXN0b3J5IiwiaXNBcnJheUluZGV4IiwiYXJyYXlJbmRleCIsIkFycmF5IiwiZnJvbSIsImV2ZXJ5IiwiYyIsImhhbmRsZURvdEZpZWxkcyIsIm9iamVjdCIsImtleXMiLCJmb3JFYWNoIiwiZmllbGROYW1lIiwiaW5kZXhPZiIsImNvbXBvbmVudHMiLCJzcGxpdCIsImZpcnN0Iiwic2hpZnQiLCJjdXJyZW50T2JqIiwibmV4dCIsIl9fb3AiLCJ0cmFuc2Zvcm1Eb3RGaWVsZFRvQ29tcG9uZW50cyIsIm1hcCIsImNtcHQiLCJpbmRleCIsIk51bWJlciIsInRyYW5zZm9ybURvdEZpZWxkIiwiam9pbiIsInRyYW5zZm9ybUFnZ3JlZ2F0ZUZpZWxkIiwic3Vic3RyaW5nIiwidmFsaWRhdGVLZXlzIiwia2V5IiwiaW5jbHVkZXMiLCJQYXJzZSIsIkVycm9yIiwiSU5WQUxJRF9ORVNURURfS0VZIiwiam9pblRhYmxlc0ZvclNjaGVtYSIsImxpc3QiLCJmaWVsZCIsInB1c2giLCJidWlsZFdoZXJlQ2xhdXNlIiwicXVlcnkiLCJjYXNlSW5zZW5zaXRpdmUiLCJwYXR0ZXJucyIsInZhbHVlcyIsInNvcnRzIiwiaXNBcnJheUZpZWxkIiwiaW5pdGlhbFBhdHRlcm5zTGVuZ3RoIiwiZmllbGRWYWx1ZSIsIiRleGlzdHMiLCJhdXRoRGF0YU1hdGNoIiwibWF0Y2giLCIkaW4iLCIkcmVnZXgiLCJNQVhfSU5UX1BMVVNfT05FIiwiY2xhdXNlcyIsImNsYXVzZVZhbHVlcyIsInN1YlF1ZXJ5IiwiY2xhdXNlIiwicGF0dGVybiIsIm9yT3JBbmQiLCJub3QiLCIkbmUiLCJjb25zdHJhaW50RmllbGROYW1lIiwiJHJlbGF0aXZlVGltZSIsIklOVkFMSURfSlNPTiIsInBvaW50IiwibG9uZ2l0dWRlIiwibGF0aXR1ZGUiLCIkZXEiLCJpc0luT3JOaW4iLCJpc0FycmF5IiwiJG5pbiIsImluUGF0dGVybnMiLCJhbGxvd051bGwiLCJsaXN0RWxlbSIsImxpc3RJbmRleCIsImNyZWF0ZUNvbnN0cmFpbnQiLCJiYXNlQXJyYXkiLCJub3RJbiIsIl8iLCJmbGF0TWFwIiwiZWx0IiwiJGFsbCIsImlzQW55VmFsdWVSZWdleFN0YXJ0c1dpdGgiLCJpc0FsbFZhbHVlc1JlZ2V4T3JOb25lIiwiaSIsInByb2Nlc3NSZWdleFBhdHRlcm4iLCIkY29udGFpbmVkQnkiLCJhcnIiLCIkdGV4dCIsInNlYXJjaCIsIiRzZWFyY2giLCJsYW5ndWFnZSIsIiR0ZXJtIiwiJGxhbmd1YWdlIiwiJGNhc2VTZW5zaXRpdmUiLCIkZGlhY3JpdGljU2Vuc2l0aXZlIiwiJG5lYXJTcGhlcmUiLCJkaXN0YW5jZSIsIiRtYXhEaXN0YW5jZSIsImRpc3RhbmNlSW5LTSIsIiR3aXRoaW4iLCIkYm94IiwiYm94IiwibGVmdCIsImJvdHRvbSIsInJpZ2h0IiwidG9wIiwiJGdlb1dpdGhpbiIsIiRjZW50ZXJTcGhlcmUiLCJjZW50ZXJTcGhlcmUiLCJHZW9Qb2ludCIsIkdlb1BvaW50Q29kZXIiLCJpc1ZhbGlkSlNPTiIsIl92YWxpZGF0ZSIsImlzTmFOIiwiJHBvbHlnb24iLCJwb2x5Z29uIiwicG9pbnRzIiwiY29vcmRpbmF0ZXMiLCIkZ2VvSW50ZXJzZWN0cyIsIiRwb2ludCIsInJlZ2V4Iiwib3BlcmF0b3IiLCJvcHRzIiwiJG9wdGlvbnMiLCJyZW1vdmVXaGl0ZVNwYWNlIiwiY29udmVydFBvbHlnb25Ub1NRTCIsImNtcCIsInBnQ29tcGFyYXRvciIsInBhcnNlclJlc3VsdCIsInJlbGF0aXZlVGltZVRvRGF0ZSIsInN0YXR1cyIsInJlc3VsdCIsImNvbnNvbGUiLCJlcnJvciIsImluZm8iLCJPUEVSQVRJT05fRk9SQklEREVOIiwiUG9zdGdyZXNTdG9yYWdlQWRhcHRlciIsImNvbnN0cnVjdG9yIiwidXJpIiwiY29sbGVjdGlvblByZWZpeCIsImRhdGFiYXNlT3B0aW9ucyIsIm9wdGlvbnMiLCJfY29sbGVjdGlvblByZWZpeCIsImVuYWJsZVNjaGVtYUhvb2tzIiwiZGlzYWJsZUluZGV4RmllbGRWYWxpZGF0aW9uIiwic2NoZW1hQ2FjaGVUdGwiLCJjbGllbnQiLCJwZ3AiLCJjcmVhdGVDbGllbnQiLCJfY2xpZW50IiwiX29uY2hhbmdlIiwiX3BncCIsInV1aWR2NCIsImNhblNvcnRPbkpvaW5UYWJsZXMiLCJ3YXRjaCIsImNhbGxiYWNrIiwiY3JlYXRlRXhwbGFpbmFibGVRdWVyeSIsImFuYWx5emUiLCJoYW5kbGVTaHV0ZG93biIsIl9zdHJlYW0iLCJkb25lIiwiJHBvb2wiLCJlbmQiLCJfbGlzdGVuVG9TY2hlbWEiLCJjb25uZWN0IiwiZGlyZWN0Iiwib24iLCJkYXRhIiwicGF5bG9hZCIsInBhcnNlIiwic2VuZGVySWQiLCJub25lIiwiX25vdGlmeVNjaGVtYUNoYW5nZSIsImNhdGNoIiwiX2Vuc3VyZVNjaGVtYUNvbGxlY3Rpb25FeGlzdHMiLCJjb25uIiwiY2xhc3NFeGlzdHMiLCJvbmUiLCJhIiwiZXhpc3RzIiwic2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zIiwiQ0xQcyIsInRhc2siLCJ0Iiwic2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQiLCJzdWJtaXR0ZWRJbmRleGVzIiwiZXhpc3RpbmdJbmRleGVzIiwic2VsZiIsIlByb21pc2UiLCJyZXNvbHZlIiwiX2lkXyIsIl9pZCIsImRlbGV0ZWRJbmRleGVzIiwiaW5zZXJ0ZWRJbmRleGVzIiwiSU5WQUxJRF9RVUVSWSIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsInR4IiwiY3JlYXRlSW5kZXhlcyIsImNvbHVtbkRvZXNOb3RFeGlzdEVycm9yIiwiZ2V0RXJyb3JzIiwiY29kZSIsImRyb3BJbmRleGVzIiwiY3JlYXRlQ2xhc3MiLCJwYXJzZVNjaGVtYSIsImNyZWF0ZVRhYmxlIiwiZXJyIiwiZGV0YWlsIiwiRFVQTElDQVRFX1ZBTFVFIiwidmFsdWVzQXJyYXkiLCJwYXR0ZXJuc0FycmF5IiwiYXNzaWduIiwiX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0IiwiX2VtYWlsX3ZlcmlmeV90b2tlbiIsIl9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCIsIl9mYWlsZWRfbG9naW5fY291bnQiLCJfcGVyaXNoYWJsZV90b2tlbiIsIl9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQiLCJfcGFzc3dvcmRfY2hhbmdlZF9hdCIsInJlbGF0aW9ucyIsInBhcnNlVHlwZSIsInFzIiwiYmF0Y2giLCJqb2luVGFibGUiLCJzY2hlbWFVcGdyYWRlIiwiY29sdW1ucyIsImNvbHVtbl9uYW1lIiwibmV3Q29sdW1ucyIsImZpbHRlciIsIml0ZW0iLCJhZGRGaWVsZElmTm90RXhpc3RzIiwicG9zdGdyZXNUeXBlIiwiYW55IiwicGF0aCIsInVwZGF0ZUZpZWxkT3B0aW9ucyIsImRlbGV0ZUNsYXNzIiwib3BlcmF0aW9ucyIsInJlc3BvbnNlIiwiaGVscGVycyIsInRoZW4iLCJkZWxldGVBbGxDbGFzc2VzIiwibm93IiwiRGF0ZSIsImdldFRpbWUiLCJlbmRlZCIsInJlc3VsdHMiLCJqb2lucyIsInJlZHVjZSIsImNsYXNzZXMiLCJxdWVyaWVzIiwiZGVsZXRlRmllbGRzIiwiZmllbGROYW1lcyIsImlkeCIsImdldEFsbENsYXNzZXMiLCJyb3ciLCJnZXRDbGFzcyIsImNyZWF0ZU9iamVjdCIsInRyYW5zYWN0aW9uYWxTZXNzaW9uIiwiY29sdW1uc0FycmF5IiwiZ2VvUG9pbnRzIiwiYXV0aERhdGFBbHJlYWR5RXhpc3RzIiwiYXV0aERhdGEiLCJwcm92aWRlciIsInBvcCIsImluaXRpYWxWYWx1ZXMiLCJ2YWwiLCJ0ZXJtaW5hdGlvbiIsImdlb1BvaW50c0luamVjdHMiLCJsIiwiY29sdW1uc1BhdHRlcm4iLCJjb2wiLCJ2YWx1ZXNQYXR0ZXJuIiwicHJvbWlzZSIsIm9wcyIsInVuZGVybHlpbmdFcnJvciIsImNvbnN0cmFpbnQiLCJtYXRjaGVzIiwidXNlckluZm8iLCJkdXBsaWNhdGVkX2ZpZWxkIiwiZGVsZXRlT2JqZWN0c0J5UXVlcnkiLCJ3aGVyZSIsIk9CSkVDVF9OT1RfRk9VTkQiLCJmaW5kT25lQW5kVXBkYXRlIiwidXBkYXRlT2JqZWN0c0J5UXVlcnkiLCJ1cGRhdGVQYXR0ZXJucyIsIm9yaWdpbmFsVXBkYXRlIiwiZG90Tm90YXRpb25PcHRpb25zIiwiZ2VuZXJhdGUiLCJqc29uYiIsImxhc3RLZXkiLCJmaWVsZE5hbWVJbmRleCIsInN0ciIsImFtb3VudCIsIm9iamVjdHMiLCJrZXlzVG9JbmNyZW1lbnQiLCJrIiwiaW5jcmVtZW50UGF0dGVybnMiLCJrZXlzVG9EZWxldGUiLCJkZWxldGVQYXR0ZXJucyIsInAiLCJ1cGRhdGVPYmplY3QiLCJleHBlY3RlZFR5cGUiLCJyZWplY3QiLCJ3aGVyZUNsYXVzZSIsInVwc2VydE9uZU9iamVjdCIsImNyZWF0ZVZhbHVlIiwic2tpcCIsImxpbWl0Iiwic29ydCIsImV4cGxhaW4iLCJoYXNMaW1pdCIsImhhc1NraXAiLCJ3aGVyZVBhdHRlcm4iLCJsaW1pdFBhdHRlcm4iLCJza2lwUGF0dGVybiIsInNvcnRQYXR0ZXJuIiwic29ydENvcHkiLCJzb3J0aW5nIiwidHJhbnNmb3JtS2V5IiwibWVtbyIsIm9yaWdpbmFsUXVlcnkiLCJwb3N0Z3Jlc09iamVjdFRvUGFyc2VPYmplY3QiLCJ0YXJnZXRDbGFzcyIsInkiLCJ4IiwiY29vcmRzIiwiU3RyaW5nIiwidXBkYXRlZENvb3JkcyIsInBhcnNlRmxvYXQiLCJjcmVhdGVkQXQiLCJ0b0lTT1N0cmluZyIsInVwZGF0ZWRBdCIsImV4cGlyZXNBdCIsImVuc3VyZVVuaXF1ZW5lc3MiLCJjb25zdHJhaW50TmFtZSIsImNvbnN0cmFpbnRQYXR0ZXJucyIsIm1lc3NhZ2UiLCJyZWFkUHJlZmVyZW5jZSIsImVzdGltYXRlIiwiYXBwcm94aW1hdGVfcm93X2NvdW50IiwiZGlzdGluY3QiLCJjb2x1bW4iLCJpc05lc3RlZCIsImlzUG9pbnRlckZpZWxkIiwidHJhbnNmb3JtZXIiLCJjaGlsZCIsImFnZ3JlZ2F0ZSIsInBpcGVsaW5lIiwiaGludCIsImNvdW50RmllbGQiLCJncm91cFZhbHVlcyIsImdyb3VwUGF0dGVybiIsInN0YWdlIiwiJGdyb3VwIiwiZ3JvdXBCeUZpZWxkcyIsImFsaWFzIiwic291cmNlIiwib3BlcmF0aW9uIiwiJHN1bSIsIiRtYXgiLCIkbWluIiwiJGF2ZyIsIiRwcm9qZWN0IiwiJG1hdGNoIiwiJG9yIiwiY29sbGFwc2UiLCJlbGVtZW50IiwibWF0Y2hQYXR0ZXJucyIsIiRsaW1pdCIsIiRza2lwIiwiJHNvcnQiLCJvcmRlciIsInRyaW0iLCJCb29sZWFuIiwicGFyc2VJbnQiLCJwZXJmb3JtSW5pdGlhbGl6YXRpb24iLCJWb2xhdGlsZUNsYXNzZXNTY2hlbWFzIiwicHJvbWlzZXMiLCJJTlZBTElEX0NMQVNTX05BTUUiLCJhbGwiLCJzcWwiLCJtaXNjIiwianNvbk9iamVjdFNldEtleXMiLCJhcnJheSIsImFkZCIsImFkZFVuaXF1ZSIsInJlbW92ZSIsImNvbnRhaW5zQWxsIiwiY29udGFpbnNBbGxSZWdleCIsImNvbnRhaW5zIiwiY3R4IiwiZHVyYXRpb24iLCJjcmVhdGVJbmRleGVzSWZOZWVkZWQiLCJnZXRJbmRleGVzIiwidXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMiLCJ1cGRhdGVFc3RpbWF0ZWRDb3VudCIsImNyZWF0ZVRyYW5zYWN0aW9uYWxTZXNzaW9uIiwiY29tbWl0VHJhbnNhY3Rpb25hbFNlc3Npb24iLCJhYm9ydFRyYW5zYWN0aW9uYWxTZXNzaW9uIiwiZW5zdXJlSW5kZXgiLCJpbmRleE5hbWUiLCJkZWZhdWx0SW5kZXhOYW1lIiwiaW5kZXhOYW1lT3B0aW9ucyIsInNldElkZW1wb3RlbmN5RnVuY3Rpb24iLCJlbnN1cmVJZGVtcG90ZW5jeUZ1bmN0aW9uRXhpc3RzIiwiZGVsZXRlSWRlbXBvdGVuY3lGdW5jdGlvbiIsInR0bE9wdGlvbnMiLCJ0dGwiLCJleHBvcnRzIiwidW5pcXVlIiwiYXIiLCJmb3VuZEluZGV4IiwicHQiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJlbmRzV2l0aCIsInJlcGxhY2UiLCJzIiwic3RhcnRzV2l0aCIsImxpdGVyYWxpemVSZWdleFBhcnQiLCJpc1N0YXJ0c1dpdGhSZWdleCIsImZpcnN0VmFsdWVzSXNSZWdleCIsInNvbWUiLCJjcmVhdGVMaXRlcmFsUmVnZXgiLCJyZW1haW5pbmciLCJSZWdFeHAiLCJtYXRjaGVyMSIsInJlc3VsdDEiLCJwcmVmaXgiLCJtYXRjaGVyMiIsInJlc3VsdDIiLCJfZGVmYXVsdCJdLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9BZGFwdGVycy9TdG9yYWdlL1Bvc3RncmVzL1Bvc3RncmVzU3RvcmFnZUFkYXB0ZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQGZsb3dcbmltcG9ydCB7IGNyZWF0ZUNsaWVudCB9IGZyb20gJy4vUG9zdGdyZXNDbGllbnQnO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCB7IHY0IGFzIHV1aWR2NCB9IGZyb20gJ3V1aWQnO1xuaW1wb3J0IHNxbCBmcm9tICcuL3NxbCc7XG5pbXBvcnQgeyBTdG9yYWdlQWRhcHRlciB9IGZyb20gJy4uL1N0b3JhZ2VBZGFwdGVyJztcbmltcG9ydCB0eXBlIHsgU2NoZW1hVHlwZSwgUXVlcnlUeXBlLCBRdWVyeU9wdGlvbnMgfSBmcm9tICcuLi9TdG9yYWdlQWRhcHRlcic7XG5jb25zdCBVdGlscyA9IHJlcXVpcmUoJy4uLy4uLy4uL1V0aWxzJyk7XG5cbmNvbnN0IFBvc3RncmVzUmVsYXRpb25Eb2VzTm90RXhpc3RFcnJvciA9ICc0MlAwMSc7XG5jb25zdCBQb3N0Z3Jlc0R1cGxpY2F0ZVJlbGF0aW9uRXJyb3IgPSAnNDJQMDcnO1xuY29uc3QgUG9zdGdyZXNEdXBsaWNhdGVDb2x1bW5FcnJvciA9ICc0MjcwMSc7XG5jb25zdCBQb3N0Z3Jlc01pc3NpbmdDb2x1bW5FcnJvciA9ICc0MjcwMyc7XG5jb25zdCBQb3N0Z3Jlc1VuaXF1ZUluZGV4VmlvbGF0aW9uRXJyb3IgPSAnMjM1MDUnO1xuY29uc3QgbG9nZ2VyID0gcmVxdWlyZSgnLi4vLi4vLi4vbG9nZ2VyJyk7XG5cbmNvbnN0IGRlYnVnID0gZnVuY3Rpb24gKC4uLmFyZ3M6IGFueSkge1xuICBhcmdzID0gWydQRzogJyArIGFyZ3VtZW50c1swXV0uY29uY2F0KGFyZ3Muc2xpY2UoMSwgYXJncy5sZW5ndGgpKTtcbiAgY29uc3QgbG9nID0gbG9nZ2VyLmdldExvZ2dlcigpO1xuICBsb2cuZGVidWcuYXBwbHkobG9nLCBhcmdzKTtcbn07XG5cbmNvbnN0IHBhcnNlVHlwZVRvUG9zdGdyZXNUeXBlID0gdHlwZSA9PiB7XG4gIHN3aXRjaCAodHlwZS50eXBlKSB7XG4gICAgY2FzZSAnU3RyaW5nJzpcbiAgICAgIHJldHVybiAndGV4dCc7XG4gICAgY2FzZSAnRGF0ZSc6XG4gICAgICByZXR1cm4gJ3RpbWVzdGFtcCB3aXRoIHRpbWUgem9uZSc7XG4gICAgY2FzZSAnT2JqZWN0JzpcbiAgICAgIHJldHVybiAnanNvbmInO1xuICAgIGNhc2UgJ0ZpbGUnOlxuICAgICAgcmV0dXJuICd0ZXh0JztcbiAgICBjYXNlICdCb29sZWFuJzpcbiAgICAgIHJldHVybiAnYm9vbGVhbic7XG4gICAgY2FzZSAnUG9pbnRlcic6XG4gICAgICByZXR1cm4gJ3RleHQnO1xuICAgIGNhc2UgJ051bWJlcic6XG4gICAgICByZXR1cm4gJ2RvdWJsZSBwcmVjaXNpb24nO1xuICAgIGNhc2UgJ0dlb1BvaW50JzpcbiAgICAgIHJldHVybiAncG9pbnQnO1xuICAgIGNhc2UgJ0J5dGVzJzpcbiAgICAgIHJldHVybiAnanNvbmInO1xuICAgIGNhc2UgJ1BvbHlnb24nOlxuICAgICAgcmV0dXJuICdwb2x5Z29uJztcbiAgICBjYXNlICdBcnJheSc6XG4gICAgICBpZiAodHlwZS5jb250ZW50cyAmJiB0eXBlLmNvbnRlbnRzLnR5cGUgPT09ICdTdHJpbmcnKSB7XG4gICAgICAgIHJldHVybiAndGV4dFtdJztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiAnanNvbmInO1xuICAgICAgfVxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBgbm8gdHlwZSBmb3IgJHtKU09OLnN0cmluZ2lmeSh0eXBlKX0geWV0YDtcbiAgfVxufTtcblxuY29uc3QgUGFyc2VUb1Bvc2dyZXNDb21wYXJhdG9yID0ge1xuICAkZ3Q6ICc+JyxcbiAgJGx0OiAnPCcsXG4gICRndGU6ICc+PScsXG4gICRsdGU6ICc8PScsXG59O1xuXG5jb25zdCBtb25nb0FnZ3JlZ2F0ZVRvUG9zdGdyZXMgPSB7XG4gICRkYXlPZk1vbnRoOiAnREFZJyxcbiAgJGRheU9mV2VlazogJ0RPVycsXG4gICRkYXlPZlllYXI6ICdET1knLFxuICAkaXNvRGF5T2ZXZWVrOiAnSVNPRE9XJyxcbiAgJGlzb1dlZWtZZWFyOiAnSVNPWUVBUicsXG4gICRob3VyOiAnSE9VUicsXG4gICRtaW51dGU6ICdNSU5VVEUnLFxuICAkc2Vjb25kOiAnU0VDT05EJyxcbiAgJG1pbGxpc2Vjb25kOiAnTUlMTElTRUNPTkRTJyxcbiAgJG1vbnRoOiAnTU9OVEgnLFxuICAkd2VlazogJ1dFRUsnLFxuICAkeWVhcjogJ1lFQVInLFxufTtcblxuY29uc3QgdG9Qb3N0Z3Jlc1ZhbHVlID0gdmFsdWUgPT4ge1xuICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgIGlmICh2YWx1ZS5fX3R5cGUgPT09ICdEYXRlJykge1xuICAgICAgcmV0dXJuIHZhbHVlLmlzbztcbiAgICB9XG4gICAgaWYgKHZhbHVlLl9fdHlwZSA9PT0gJ0ZpbGUnKSB7XG4gICAgICByZXR1cm4gdmFsdWUubmFtZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufTtcblxuY29uc3QgdG9Qb3N0Z3Jlc1ZhbHVlQ2FzdFR5cGUgPSB2YWx1ZSA9PiB7XG4gIGNvbnN0IHBvc3RncmVzVmFsdWUgPSB0b1Bvc3RncmVzVmFsdWUodmFsdWUpO1xuICBsZXQgY2FzdFR5cGU7XG4gIHN3aXRjaCAodHlwZW9mIHBvc3RncmVzVmFsdWUpIHtcbiAgICBjYXNlICdudW1iZXInOlxuICAgICAgY2FzdFR5cGUgPSAnZG91YmxlIHByZWNpc2lvbic7XG4gICAgICBicmVhaztcbiAgICBjYXNlICdib29sZWFuJzpcbiAgICAgIGNhc3RUeXBlID0gJ2Jvb2xlYW4nO1xuICAgICAgYnJlYWs7XG4gICAgZGVmYXVsdDpcbiAgICAgIGNhc3RUeXBlID0gdW5kZWZpbmVkO1xuICB9XG4gIHJldHVybiBjYXN0VHlwZTtcbn07XG5cbmNvbnN0IHRyYW5zZm9ybVZhbHVlID0gdmFsdWUgPT4ge1xuICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiB2YWx1ZS5fX3R5cGUgPT09ICdQb2ludGVyJykge1xuICAgIHJldHVybiB2YWx1ZS5vYmplY3RJZDtcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59O1xuXG4vLyBEdXBsaWNhdGUgZnJvbSB0aGVuIG1vbmdvIGFkYXB0ZXIuLi5cbmNvbnN0IGVtcHR5Q0xQUyA9IE9iamVjdC5mcmVlemUoe1xuICBmaW5kOiB7fSxcbiAgZ2V0OiB7fSxcbiAgY291bnQ6IHt9LFxuICBjcmVhdGU6IHt9LFxuICB1cGRhdGU6IHt9LFxuICBkZWxldGU6IHt9LFxuICBhZGRGaWVsZDoge30sXG4gIHByb3RlY3RlZEZpZWxkczoge30sXG59KTtcblxuY29uc3QgZGVmYXVsdENMUFMgPSBPYmplY3QuZnJlZXplKHtcbiAgQUNMOiB7XG4gICAgJyonOiB7XG4gICAgICByZWFkOiB0cnVlLFxuICAgICAgd3JpdGU6IHRydWUsXG4gICAgfSxcbiAgfSxcbiAgZmluZDogeyAnKic6IHRydWUgfSxcbiAgZ2V0OiB7ICcqJzogdHJ1ZSB9LFxuICBjb3VudDogeyAnKic6IHRydWUgfSxcbiAgY3JlYXRlOiB7ICcqJzogdHJ1ZSB9LFxuICB1cGRhdGU6IHsgJyonOiB0cnVlIH0sXG4gIGRlbGV0ZTogeyAnKic6IHRydWUgfSxcbiAgYWRkRmllbGQ6IHsgJyonOiB0cnVlIH0sXG4gIHByb3RlY3RlZEZpZWxkczogeyAnKic6IFtdIH0sXG59KTtcblxuY29uc3QgdG9QYXJzZVNjaGVtYSA9IHNjaGVtYSA9PiB7XG4gIGlmIChzY2hlbWEuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgZGVsZXRlIHNjaGVtYS5maWVsZHMuX2hhc2hlZF9wYXNzd29yZDtcbiAgfVxuICBpZiAoc2NoZW1hLmZpZWxkcykge1xuICAgIGRlbGV0ZSBzY2hlbWEuZmllbGRzLl93cGVybTtcbiAgICBkZWxldGUgc2NoZW1hLmZpZWxkcy5fcnBlcm07XG4gIH1cbiAgbGV0IGNscHMgPSBkZWZhdWx0Q0xQUztcbiAgaWYgKHNjaGVtYS5jbGFzc0xldmVsUGVybWlzc2lvbnMpIHtcbiAgICBjbHBzID0geyAuLi5lbXB0eUNMUFMsIC4uLnNjaGVtYS5jbGFzc0xldmVsUGVybWlzc2lvbnMgfTtcbiAgfVxuICBsZXQgaW5kZXhlcyA9IHt9O1xuICBpZiAoc2NoZW1hLmluZGV4ZXMpIHtcbiAgICBpbmRleGVzID0geyAuLi5zY2hlbWEuaW5kZXhlcyB9O1xuICB9XG4gIHJldHVybiB7XG4gICAgY2xhc3NOYW1lOiBzY2hlbWEuY2xhc3NOYW1lLFxuICAgIGZpZWxkczogc2NoZW1hLmZpZWxkcyxcbiAgICBjbGFzc0xldmVsUGVybWlzc2lvbnM6IGNscHMsXG4gICAgaW5kZXhlcyxcbiAgfTtcbn07XG5cbmNvbnN0IHRvUG9zdGdyZXNTY2hlbWEgPSBzY2hlbWEgPT4ge1xuICBpZiAoIXNjaGVtYSkge1xuICAgIHJldHVybiBzY2hlbWE7XG4gIH1cbiAgc2NoZW1hLmZpZWxkcyA9IHNjaGVtYS5maWVsZHMgfHwge307XG4gIHNjaGVtYS5maWVsZHMuX3dwZXJtID0geyB0eXBlOiAnQXJyYXknLCBjb250ZW50czogeyB0eXBlOiAnU3RyaW5nJyB9IH07XG4gIHNjaGVtYS5maWVsZHMuX3JwZXJtID0geyB0eXBlOiAnQXJyYXknLCBjb250ZW50czogeyB0eXBlOiAnU3RyaW5nJyB9IH07XG4gIGlmIChzY2hlbWEuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgc2NoZW1hLmZpZWxkcy5faGFzaGVkX3Bhc3N3b3JkID0geyB0eXBlOiAnU3RyaW5nJyB9O1xuICAgIHNjaGVtYS5maWVsZHMuX3Bhc3N3b3JkX2hpc3RvcnkgPSB7IHR5cGU6ICdBcnJheScgfTtcbiAgfVxuICByZXR1cm4gc2NoZW1hO1xufTtcblxuY29uc3QgaXNBcnJheUluZGV4ID0gKGFycmF5SW5kZXgpID0+IEFycmF5LmZyb20oYXJyYXlJbmRleCkuZXZlcnkoYyA9PiBjID49ICcwJyAmJiBjIDw9ICc5Jyk7XG5cbmNvbnN0IGhhbmRsZURvdEZpZWxkcyA9IG9iamVjdCA9PiB7XG4gIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID4gLTEpIHtcbiAgICAgIGNvbnN0IGNvbXBvbmVudHMgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKTtcbiAgICAgIGNvbnN0IGZpcnN0ID0gY29tcG9uZW50cy5zaGlmdCgpO1xuICAgICAgb2JqZWN0W2ZpcnN0XSA9IG9iamVjdFtmaXJzdF0gfHwge307XG4gICAgICBsZXQgY3VycmVudE9iaiA9IG9iamVjdFtmaXJzdF07XG4gICAgICBsZXQgbmV4dDtcbiAgICAgIGxldCB2YWx1ZSA9IG9iamVjdFtmaWVsZE5hbWVdO1xuICAgICAgaWYgKHZhbHVlICYmIHZhbHVlLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgIHZhbHVlID0gdW5kZWZpbmVkO1xuICAgICAgfVxuICAgICAgd2hpbGUgKChuZXh0ID0gY29tcG9uZW50cy5zaGlmdCgpKSkge1xuICAgICAgICBjdXJyZW50T2JqW25leHRdID0gY3VycmVudE9ialtuZXh0XSB8fCB7fTtcbiAgICAgICAgaWYgKGNvbXBvbmVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgY3VycmVudE9ialtuZXh0XSA9IHZhbHVlO1xuICAgICAgICB9XG4gICAgICAgIGN1cnJlbnRPYmogPSBjdXJyZW50T2JqW25leHRdO1xuICAgICAgfVxuICAgICAgZGVsZXRlIG9iamVjdFtmaWVsZE5hbWVdO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBvYmplY3Q7XG59O1xuXG5jb25zdCB0cmFuc2Zvcm1Eb3RGaWVsZFRvQ29tcG9uZW50cyA9IGZpZWxkTmFtZSA9PiB7XG4gIHJldHVybiBmaWVsZE5hbWUuc3BsaXQoJy4nKS5tYXAoKGNtcHQsIGluZGV4KSA9PiB7XG4gICAgaWYgKGluZGV4ID09PSAwKSB7XG4gICAgICByZXR1cm4gYFwiJHtjbXB0fVwiYDtcbiAgICB9XG4gICAgaWYgKGlzQXJyYXlJbmRleChjbXB0KSkge1xuICAgICAgcmV0dXJuIE51bWJlcihjbXB0KTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIGAnJHtjbXB0fSdgO1xuICAgIH1cbiAgfSk7XG59O1xuXG5jb25zdCB0cmFuc2Zvcm1Eb3RGaWVsZCA9IGZpZWxkTmFtZSA9PiB7XG4gIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID09PSAtMSkge1xuICAgIHJldHVybiBgXCIke2ZpZWxkTmFtZX1cImA7XG4gIH1cbiAgY29uc3QgY29tcG9uZW50cyA9IHRyYW5zZm9ybURvdEZpZWxkVG9Db21wb25lbnRzKGZpZWxkTmFtZSk7XG4gIGxldCBuYW1lID0gY29tcG9uZW50cy5zbGljZSgwLCBjb21wb25lbnRzLmxlbmd0aCAtIDEpLmpvaW4oJy0+Jyk7XG4gIG5hbWUgKz0gJy0+PicgKyBjb21wb25lbnRzW2NvbXBvbmVudHMubGVuZ3RoIC0gMV07XG4gIHJldHVybiBuYW1lO1xufTtcblxuY29uc3QgdHJhbnNmb3JtQWdncmVnYXRlRmllbGQgPSBmaWVsZE5hbWUgPT4ge1xuICBpZiAodHlwZW9mIGZpZWxkTmFtZSAhPT0gJ3N0cmluZycpIHtcbiAgICByZXR1cm4gZmllbGROYW1lO1xuICB9XG4gIGlmIChmaWVsZE5hbWUgPT09ICckX2NyZWF0ZWRfYXQnKSB7XG4gICAgcmV0dXJuICdjcmVhdGVkQXQnO1xuICB9XG4gIGlmIChmaWVsZE5hbWUgPT09ICckX3VwZGF0ZWRfYXQnKSB7XG4gICAgcmV0dXJuICd1cGRhdGVkQXQnO1xuICB9XG4gIHJldHVybiBmaWVsZE5hbWUuc3Vic3RyaW5nKDEpO1xufTtcblxuY29uc3QgdmFsaWRhdGVLZXlzID0gb2JqZWN0ID0+IHtcbiAgaWYgKHR5cGVvZiBvYmplY3QgPT0gJ29iamVjdCcpIHtcbiAgICBmb3IgKGNvbnN0IGtleSBpbiBvYmplY3QpIHtcbiAgICAgIGlmICh0eXBlb2Ygb2JqZWN0W2tleV0gPT0gJ29iamVjdCcpIHtcbiAgICAgICAgdmFsaWRhdGVLZXlzKG9iamVjdFtrZXldKTtcbiAgICAgIH1cblxuICAgICAgaWYgKGtleS5pbmNsdWRlcygnJCcpIHx8IGtleS5pbmNsdWRlcygnLicpKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX05FU1RFRF9LRVksXG4gICAgICAgICAgXCJOZXN0ZWQga2V5cyBzaG91bGQgbm90IGNvbnRhaW4gdGhlICckJyBvciAnLicgY2hhcmFjdGVyc1wiXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG4vLyBSZXR1cm5zIHRoZSBsaXN0IG9mIGpvaW4gdGFibGVzIG9uIGEgc2NoZW1hXG5jb25zdCBqb2luVGFibGVzRm9yU2NoZW1hID0gc2NoZW1hID0+IHtcbiAgY29uc3QgbGlzdCA9IFtdO1xuICBpZiAoc2NoZW1hKSB7XG4gICAgT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuZm9yRWFjaChmaWVsZCA9PiB7XG4gICAgICBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSA9PT0gJ1JlbGF0aW9uJykge1xuICAgICAgICBsaXN0LnB1c2goYF9Kb2luOiR7ZmllbGR9OiR7c2NoZW1hLmNsYXNzTmFtZX1gKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuICByZXR1cm4gbGlzdDtcbn07XG5cbmludGVyZmFjZSBXaGVyZUNsYXVzZSB7XG4gIHBhdHRlcm46IHN0cmluZztcbiAgdmFsdWVzOiBBcnJheTxhbnk+O1xuICBzb3J0czogQXJyYXk8YW55Pjtcbn1cblxuY29uc3QgYnVpbGRXaGVyZUNsYXVzZSA9ICh7IHNjaGVtYSwgcXVlcnksIGluZGV4LCBjYXNlSW5zZW5zaXRpdmUgfSk6IFdoZXJlQ2xhdXNlID0+IHtcbiAgY29uc3QgcGF0dGVybnMgPSBbXTtcbiAgbGV0IHZhbHVlcyA9IFtdO1xuICBjb25zdCBzb3J0cyA9IFtdO1xuXG4gIHNjaGVtYSA9IHRvUG9zdGdyZXNTY2hlbWEoc2NoZW1hKTtcbiAgZm9yIChjb25zdCBmaWVsZE5hbWUgaW4gcXVlcnkpIHtcbiAgICBjb25zdCBpc0FycmF5RmllbGQgPVxuICAgICAgc2NoZW1hLmZpZWxkcyAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdBcnJheSc7XG4gICAgY29uc3QgaW5pdGlhbFBhdHRlcm5zTGVuZ3RoID0gcGF0dGVybnMubGVuZ3RoO1xuICAgIGNvbnN0IGZpZWxkVmFsdWUgPSBxdWVyeVtmaWVsZE5hbWVdO1xuXG4gICAgLy8gbm90aGluZyBpbiB0aGUgc2NoZW1hLCBpdCdzIGdvbm5hIGJsb3cgdXBcbiAgICBpZiAoIXNjaGVtYS5maWVsZHNbZmllbGROYW1lXSkge1xuICAgICAgLy8gYXMgaXQgd29uJ3QgZXhpc3RcbiAgICAgIGlmIChmaWVsZFZhbHVlICYmIGZpZWxkVmFsdWUuJGV4aXN0cyA9PT0gZmFsc2UpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGF1dGhEYXRhTWF0Y2ggPSBmaWVsZE5hbWUubWF0Y2goL15fYXV0aF9kYXRhXyhbYS16QS1aMC05X10rKSQvKTtcbiAgICBpZiAoYXV0aERhdGFNYXRjaCkge1xuICAgICAgLy8gVE9ETzogSGFuZGxlIHF1ZXJ5aW5nIGJ5IF9hdXRoX2RhdGFfcHJvdmlkZXIsIGF1dGhEYXRhIGlzIHN0b3JlZCBpbiBhdXRoRGF0YSBmaWVsZFxuICAgICAgY29udGludWU7XG4gICAgfSBlbHNlIGlmIChjYXNlSW5zZW5zaXRpdmUgJiYgKGZpZWxkTmFtZSA9PT0gJ3VzZXJuYW1lJyB8fCBmaWVsZE5hbWUgPT09ICdlbWFpbCcpKSB7XG4gICAgICBwYXR0ZXJucy5wdXNoKGBMT1dFUigkJHtpbmRleH06bmFtZSkgPSBMT1dFUigkJHtpbmRleCArIDF9KWApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfSBlbHNlIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID49IDApIHtcbiAgICAgIGxldCBuYW1lID0gdHJhbnNmb3JtRG90RmllbGQoZmllbGROYW1lKTtcbiAgICAgIGlmIChmaWVsZFZhbHVlID09PSBudWxsKSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpyYXcgSVMgTlVMTGApO1xuICAgICAgICB2YWx1ZXMucHVzaChuYW1lKTtcbiAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoZmllbGRWYWx1ZS4kaW4pIHtcbiAgICAgICAgICBuYW1lID0gdHJhbnNmb3JtRG90RmllbGRUb0NvbXBvbmVudHMoZmllbGROYW1lKS5qb2luKCctPicpO1xuICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCgkJHtpbmRleH06cmF3KTo6anNvbmIgQD4gJCR7aW5kZXggKyAxfTo6anNvbmJgKTtcbiAgICAgICAgICB2YWx1ZXMucHVzaChuYW1lLCBKU09OLnN0cmluZ2lmeShmaWVsZFZhbHVlLiRpbikpO1xuICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS4kcmVnZXgpIHtcbiAgICAgICAgICAvLyBIYW5kbGUgbGF0ZXJcbiAgICAgICAgfSBlbHNlIGlmICh0eXBlb2YgZmllbGRWYWx1ZSAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06cmF3ID0gJCR7aW5kZXggKyAxfTo6dGV4dGApO1xuICAgICAgICAgIHZhbHVlcy5wdXNoKG5hbWUsIGZpZWxkVmFsdWUpO1xuICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUgPT09IG51bGwgfHwgZmllbGRWYWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSBJUyBOVUxMYCk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgaW5kZXggKz0gMTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICBpbmRleCArPSAyO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUgPT09ICdib29sZWFuJykge1xuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAvLyBDYW4ndCBjYXN0IGJvb2xlYW4gdG8gZG91YmxlIHByZWNpc2lvblxuICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ051bWJlcicpIHtcbiAgICAgICAgLy8gU2hvdWxkIGFsd2F5cyByZXR1cm4gemVybyByZXN1bHRzXG4gICAgICAgIGNvbnN0IE1BWF9JTlRfUExVU19PTkUgPSA5MjIzMzcyMDM2ODU0Nzc1ODA4O1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIE1BWF9JTlRfUExVU19PTkUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgIH1cbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgZmllbGRWYWx1ZSA9PT0gJ251bWJlcicpIHtcbiAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfSBlbHNlIGlmIChbJyRvcicsICckbm9yJywgJyRhbmQnXS5pbmNsdWRlcyhmaWVsZE5hbWUpKSB7XG4gICAgICBjb25zdCBjbGF1c2VzID0gW107XG4gICAgICBjb25zdCBjbGF1c2VWYWx1ZXMgPSBbXTtcbiAgICAgIGZpZWxkVmFsdWUuZm9yRWFjaChzdWJRdWVyeSA9PiB7XG4gICAgICAgIGNvbnN0IGNsYXVzZSA9IGJ1aWxkV2hlcmVDbGF1c2Uoe1xuICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICBxdWVyeTogc3ViUXVlcnksXG4gICAgICAgICAgaW5kZXgsXG4gICAgICAgICAgY2FzZUluc2Vuc2l0aXZlLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKGNsYXVzZS5wYXR0ZXJuLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBjbGF1c2VzLnB1c2goY2xhdXNlLnBhdHRlcm4pO1xuICAgICAgICAgIGNsYXVzZVZhbHVlcy5wdXNoKC4uLmNsYXVzZS52YWx1ZXMpO1xuICAgICAgICAgIGluZGV4ICs9IGNsYXVzZS52YWx1ZXMubGVuZ3RoO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgY29uc3Qgb3JPckFuZCA9IGZpZWxkTmFtZSA9PT0gJyRhbmQnID8gJyBBTkQgJyA6ICcgT1IgJztcbiAgICAgIGNvbnN0IG5vdCA9IGZpZWxkTmFtZSA9PT0gJyRub3InID8gJyBOT1QgJyA6ICcnO1xuXG4gICAgICBwYXR0ZXJucy5wdXNoKGAke25vdH0oJHtjbGF1c2VzLmpvaW4ob3JPckFuZCl9KWApO1xuICAgICAgdmFsdWVzLnB1c2goLi4uY2xhdXNlVmFsdWVzKTtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kbmUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKGlzQXJyYXlGaWVsZCkge1xuICAgICAgICBmaWVsZFZhbHVlLiRuZSA9IEpTT04uc3RyaW5naWZ5KFtmaWVsZFZhbHVlLiRuZV0pO1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGBOT1QgYXJyYXlfY29udGFpbnMoJCR7aW5kZXh9Om5hbWUsICQke2luZGV4ICsgMX0pYCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoZmllbGRWYWx1ZS4kbmUgPT09IG51bGwpIHtcbiAgICAgICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSBJUyBOT1QgTlVMTGApO1xuICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBpZiBub3QgbnVsbCwgd2UgbmVlZCB0byBtYW51YWxseSBleGNsdWRlIG51bGxcbiAgICAgICAgICBpZiAoZmllbGRWYWx1ZS4kbmUuX190eXBlID09PSAnR2VvUG9pbnQnKSB7XG4gICAgICAgICAgICBwYXR0ZXJucy5wdXNoKFxuICAgICAgICAgICAgICBgKCQke2luZGV4fTpuYW1lIDw+IFBPSU5UKCQke2luZGV4ICsgMX0sICQke2luZGV4ICsgMn0pIE9SICQke2luZGV4fTpuYW1lIElTIE5VTEwpYFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZS5pbmRleE9mKCcuJykgPj0gMCkge1xuICAgICAgICAgICAgICBjb25zdCBjYXN0VHlwZSA9IHRvUG9zdGdyZXNWYWx1ZUNhc3RUeXBlKGZpZWxkVmFsdWUuJG5lKTtcbiAgICAgICAgICAgICAgY29uc3QgY29uc3RyYWludEZpZWxkTmFtZSA9IGNhc3RUeXBlXG4gICAgICAgICAgICAgICAgPyBgQ0FTVCAoKCR7dHJhbnNmb3JtRG90RmllbGQoZmllbGROYW1lKX0pIEFTICR7Y2FzdFR5cGV9KWBcbiAgICAgICAgICAgICAgICA6IHRyYW5zZm9ybURvdEZpZWxkKGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgIHBhdHRlcm5zLnB1c2goXG4gICAgICAgICAgICAgICAgYCgke2NvbnN0cmFpbnRGaWVsZE5hbWV9IDw+ICQke2luZGV4ICsgMX0gT1IgJHtjb25zdHJhaW50RmllbGROYW1lfSBJUyBOVUxMKWBcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUuJG5lID09PSAnb2JqZWN0JyAmJiBmaWVsZFZhbHVlLiRuZS4kcmVsYXRpdmVUaW1lKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAgICAgJyRyZWxhdGl2ZVRpbWUgY2FuIG9ubHkgYmUgdXNlZCB3aXRoIHRoZSAkbHQsICRsdGUsICRndCwgYW5kICRndGUgb3BlcmF0b3JzJ1xuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgcGF0dGVybnMucHVzaChgKCQke2luZGV4fTpuYW1lIDw+ICQke2luZGV4ICsgMX0gT1IgJCR7aW5kZXh9Om5hbWUgSVMgTlVMTClgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChmaWVsZFZhbHVlLiRuZS5fX3R5cGUgPT09ICdHZW9Qb2ludCcpIHtcbiAgICAgICAgY29uc3QgcG9pbnQgPSBmaWVsZFZhbHVlLiRuZTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBwb2ludC5sb25naXR1ZGUsIHBvaW50LmxhdGl0dWRlKTtcbiAgICAgICAgaW5kZXggKz0gMztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFRPRE86IHN1cHBvcnQgYXJyYXlzXG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZS4kbmUpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoZmllbGRWYWx1ZS4kZXEgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKGZpZWxkVmFsdWUuJGVxID09PSBudWxsKSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lIElTIE5VTExgKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lKTtcbiAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID49IDApIHtcbiAgICAgICAgICBjb25zdCBjYXN0VHlwZSA9IHRvUG9zdGdyZXNWYWx1ZUNhc3RUeXBlKGZpZWxkVmFsdWUuJGVxKTtcbiAgICAgICAgICBjb25zdCBjb25zdHJhaW50RmllbGROYW1lID0gY2FzdFR5cGVcbiAgICAgICAgICAgID8gYENBU1QgKCgke3RyYW5zZm9ybURvdEZpZWxkKGZpZWxkTmFtZSl9KSBBUyAke2Nhc3RUeXBlfSlgXG4gICAgICAgICAgICA6IHRyYW5zZm9ybURvdEZpZWxkKGZpZWxkTmFtZSk7XG4gICAgICAgICAgdmFsdWVzLnB1c2goZmllbGRWYWx1ZS4kZXEpO1xuICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCR7Y29uc3RyYWludEZpZWxkTmFtZX0gPSAkJHtpbmRleCsrfWApO1xuICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWVsZFZhbHVlLiRlcSA9PT0gJ29iamVjdCcgJiYgZmllbGRWYWx1ZS4kZXEuJHJlbGF0aXZlVGltZSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgICckcmVsYXRpdmVUaW1lIGNhbiBvbmx5IGJlIHVzZWQgd2l0aCB0aGUgJGx0LCAkbHRlLCAkZ3QsIGFuZCAkZ3RlIG9wZXJhdG9ycydcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZS4kZXEpO1xuICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgaXNJbk9yTmluID0gQXJyYXkuaXNBcnJheShmaWVsZFZhbHVlLiRpbikgfHwgQXJyYXkuaXNBcnJheShmaWVsZFZhbHVlLiRuaW4pO1xuICAgIGlmIChcbiAgICAgIEFycmF5LmlzQXJyYXkoZmllbGRWYWx1ZS4kaW4pICYmXG4gICAgICBpc0FycmF5RmllbGQgJiZcbiAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5jb250ZW50cyAmJlxuICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmNvbnRlbnRzLnR5cGUgPT09ICdTdHJpbmcnXG4gICAgKSB7XG4gICAgICBjb25zdCBpblBhdHRlcm5zID0gW107XG4gICAgICBsZXQgYWxsb3dOdWxsID0gZmFsc2U7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgZmllbGRWYWx1ZS4kaW4uZm9yRWFjaCgobGlzdEVsZW0sIGxpc3RJbmRleCkgPT4ge1xuICAgICAgICBpZiAobGlzdEVsZW0gPT09IG51bGwpIHtcbiAgICAgICAgICBhbGxvd051bGwgPSB0cnVlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHZhbHVlcy5wdXNoKGxpc3RFbGVtKTtcbiAgICAgICAgICBpblBhdHRlcm5zLnB1c2goYCQke2luZGV4ICsgMSArIGxpc3RJbmRleCAtIChhbGxvd051bGwgPyAxIDogMCl9YCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgaWYgKGFsbG93TnVsbCkge1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGAoJCR7aW5kZXh9Om5hbWUgSVMgTlVMTCBPUiAkJHtpbmRleH06bmFtZSAmJiBBUlJBWVske2luUGF0dGVybnMuam9pbigpfV0pYCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSAmJiBBUlJBWVske2luUGF0dGVybnMuam9pbigpfV1gKTtcbiAgICAgIH1cbiAgICAgIGluZGV4ID0gaW5kZXggKyAxICsgaW5QYXR0ZXJucy5sZW5ndGg7XG4gICAgfSBlbHNlIGlmIChpc0luT3JOaW4pIHtcbiAgICAgIHZhciBjcmVhdGVDb25zdHJhaW50ID0gKGJhc2VBcnJheSwgbm90SW4pID0+IHtcbiAgICAgICAgY29uc3Qgbm90ID0gbm90SW4gPyAnIE5PVCAnIDogJyc7XG4gICAgICAgIGlmIChiYXNlQXJyYXkubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGlmIChpc0FycmF5RmllbGQpIHtcbiAgICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCR7bm90fSBhcnJheV9jb250YWlucygkJHtpbmRleH06bmFtZSwgJCR7aW5kZXggKyAxfSlgKTtcbiAgICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgSlNPTi5zdHJpbmdpZnkoYmFzZUFycmF5KSk7XG4gICAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBIYW5kbGUgTmVzdGVkIERvdCBOb3RhdGlvbiBBYm92ZVxuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZS5pbmRleE9mKCcuJykgPj0gMCkge1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBpblBhdHRlcm5zID0gW107XG4gICAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgYmFzZUFycmF5LmZvckVhY2goKGxpc3RFbGVtLCBsaXN0SW5kZXgpID0+IHtcbiAgICAgICAgICAgICAgaWYgKGxpc3RFbGVtICE9IG51bGwpIHtcbiAgICAgICAgICAgICAgICB2YWx1ZXMucHVzaChsaXN0RWxlbSk7XG4gICAgICAgICAgICAgICAgaW5QYXR0ZXJucy5wdXNoKGAkJHtpbmRleCArIDEgKyBsaXN0SW5kZXh9YCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgJHtub3R9IElOICgke2luUGF0dGVybnMuam9pbigpfSlgKTtcbiAgICAgICAgICAgIGluZGV4ID0gaW5kZXggKyAxICsgaW5QYXR0ZXJucy5sZW5ndGg7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKCFub3RJbikge1xuICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgSVMgTlVMTGApO1xuICAgICAgICAgIGluZGV4ID0gaW5kZXggKyAxO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIEhhbmRsZSBlbXB0eSBhcnJheVxuICAgICAgICAgIGlmIChub3RJbikge1xuICAgICAgICAgICAgcGF0dGVybnMucHVzaCgnMSA9IDEnKTsgLy8gUmV0dXJuIGFsbCB2YWx1ZXNcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcGF0dGVybnMucHVzaCgnMSA9IDInKTsgLy8gUmV0dXJuIG5vIHZhbHVlc1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGlmIChmaWVsZFZhbHVlLiRpbikge1xuICAgICAgICBjcmVhdGVDb25zdHJhaW50KFxuICAgICAgICAgIF8uZmxhdE1hcChmaWVsZFZhbHVlLiRpbiwgZWx0ID0+IGVsdCksXG4gICAgICAgICAgZmFsc2VcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChmaWVsZFZhbHVlLiRuaW4pIHtcbiAgICAgICAgY3JlYXRlQ29uc3RyYWludChcbiAgICAgICAgICBfLmZsYXRNYXAoZmllbGRWYWx1ZS4kbmluLCBlbHQgPT4gZWx0KSxcbiAgICAgICAgICB0cnVlXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgZmllbGRWYWx1ZS4kaW4gIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCAnYmFkICRpbiB2YWx1ZScpO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUuJG5pbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdiYWQgJG5pbiB2YWx1ZScpO1xuICAgIH1cblxuICAgIGlmIChBcnJheS5pc0FycmF5KGZpZWxkVmFsdWUuJGFsbCkgJiYgaXNBcnJheUZpZWxkKSB7XG4gICAgICBpZiAoaXNBbnlWYWx1ZVJlZ2V4U3RhcnRzV2l0aChmaWVsZFZhbHVlLiRhbGwpKSB7XG4gICAgICAgIGlmICghaXNBbGxWYWx1ZXNSZWdleE9yTm9uZShmaWVsZFZhbHVlLiRhbGwpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICAgJ0FsbCAkYWxsIHZhbHVlcyBtdXN0IGJlIG9mIHJlZ2V4IHR5cGUgb3Igbm9uZTogJyArIGZpZWxkVmFsdWUuJGFsbFxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGZpZWxkVmFsdWUuJGFsbC5sZW5ndGg7IGkgKz0gMSkge1xuICAgICAgICAgIGNvbnN0IHZhbHVlID0gcHJvY2Vzc1JlZ2V4UGF0dGVybihmaWVsZFZhbHVlLiRhbGxbaV0uJHJlZ2V4KTtcbiAgICAgICAgICBmaWVsZFZhbHVlLiRhbGxbaV0gPSB2YWx1ZS5zdWJzdHJpbmcoMSkgKyAnJSc7XG4gICAgICAgIH1cbiAgICAgICAgcGF0dGVybnMucHVzaChgYXJyYXlfY29udGFpbnNfYWxsX3JlZ2V4KCQke2luZGV4fTpuYW1lLCAkJHtpbmRleCArIDF9Ojpqc29uYilgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYGFycmF5X2NvbnRhaW5zX2FsbCgkJHtpbmRleH06bmFtZSwgJCR7aW5kZXggKyAxfTo6anNvbmIpYCk7XG4gICAgICB9XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIEpTT04uc3RyaW5naWZ5KGZpZWxkVmFsdWUuJGFsbCkpO1xuICAgICAgaW5kZXggKz0gMjtcbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoZmllbGRWYWx1ZS4kYWxsKSkge1xuICAgICAgaWYgKGZpZWxkVmFsdWUuJGFsbC5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZS4kYWxsWzBdLm9iamVjdElkKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIGZpZWxkVmFsdWUuJGV4aXN0cyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIGlmICh0eXBlb2YgZmllbGRWYWx1ZS4kZXhpc3RzID09PSAnb2JqZWN0JyAmJiBmaWVsZFZhbHVlLiRleGlzdHMuJHJlbGF0aXZlVGltZSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICckcmVsYXRpdmVUaW1lIGNhbiBvbmx5IGJlIHVzZWQgd2l0aCB0aGUgJGx0LCAkbHRlLCAkZ3QsIGFuZCAkZ3RlIG9wZXJhdG9ycydcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS4kZXhpc3RzKSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lIElTIE5PVCBOVUxMYCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSBJUyBOVUxMYCk7XG4gICAgICB9XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgaW5kZXggKz0gMTtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kY29udGFpbmVkQnkpIHtcbiAgICAgIGNvbnN0IGFyciA9IGZpZWxkVmFsdWUuJGNvbnRhaW5lZEJ5O1xuICAgICAgaWYgKCEoYXJyIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sIGBiYWQgJGNvbnRhaW5lZEJ5OiBzaG91bGQgYmUgYW4gYXJyYXlgKTtcbiAgICAgIH1cblxuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPEAgJCR7aW5kZXggKyAxfTo6anNvbmJgKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgSlNPTi5zdHJpbmdpZnkoYXJyKSk7XG4gICAgICBpbmRleCArPSAyO1xuICAgIH1cblxuICAgIGlmIChmaWVsZFZhbHVlLiR0ZXh0KSB7XG4gICAgICBjb25zdCBzZWFyY2ggPSBmaWVsZFZhbHVlLiR0ZXh0LiRzZWFyY2g7XG4gICAgICBsZXQgbGFuZ3VhZ2UgPSAnZW5nbGlzaCc7XG4gICAgICBpZiAodHlwZW9mIHNlYXJjaCAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgYGJhZCAkdGV4dDogJHNlYXJjaCwgc2hvdWxkIGJlIG9iamVjdGApO1xuICAgICAgfVxuICAgICAgaWYgKCFzZWFyY2guJHRlcm0gfHwgdHlwZW9mIHNlYXJjaC4kdGVybSAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgYGJhZCAkdGV4dDogJHRlcm0sIHNob3VsZCBiZSBzdHJpbmdgKTtcbiAgICAgIH1cbiAgICAgIGlmIChzZWFyY2guJGxhbmd1YWdlICYmIHR5cGVvZiBzZWFyY2guJGxhbmd1YWdlICE9PSAnc3RyaW5nJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCBgYmFkICR0ZXh0OiAkbGFuZ3VhZ2UsIHNob3VsZCBiZSBzdHJpbmdgKTtcbiAgICAgIH0gZWxzZSBpZiAoc2VhcmNoLiRsYW5ndWFnZSkge1xuICAgICAgICBsYW5ndWFnZSA9IHNlYXJjaC4kbGFuZ3VhZ2U7XG4gICAgICB9XG4gICAgICBpZiAoc2VhcmNoLiRjYXNlU2Vuc2l0aXZlICYmIHR5cGVvZiBzZWFyY2guJGNhc2VTZW5zaXRpdmUgIT09ICdib29sZWFuJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgIGBiYWQgJHRleHQ6ICRjYXNlU2Vuc2l0aXZlLCBzaG91bGQgYmUgYm9vbGVhbmBcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSBpZiAoc2VhcmNoLiRjYXNlU2Vuc2l0aXZlKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgYGJhZCAkdGV4dDogJGNhc2VTZW5zaXRpdmUgbm90IHN1cHBvcnRlZCwgcGxlYXNlIHVzZSAkcmVnZXggb3IgY3JlYXRlIGEgc2VwYXJhdGUgbG93ZXIgY2FzZSBjb2x1bW4uYFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKHNlYXJjaC4kZGlhY3JpdGljU2Vuc2l0aXZlICYmIHR5cGVvZiBzZWFyY2guJGRpYWNyaXRpY1NlbnNpdGl2ZSAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgYGJhZCAkdGV4dDogJGRpYWNyaXRpY1NlbnNpdGl2ZSwgc2hvdWxkIGJlIGJvb2xlYW5gXG4gICAgICAgICk7XG4gICAgICB9IGVsc2UgaWYgKHNlYXJjaC4kZGlhY3JpdGljU2Vuc2l0aXZlID09PSBmYWxzZSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgIGBiYWQgJHRleHQ6ICRkaWFjcml0aWNTZW5zaXRpdmUgLSBmYWxzZSBub3Qgc3VwcG9ydGVkLCBpbnN0YWxsIFBvc3RncmVzIFVuYWNjZW50IEV4dGVuc2lvbmBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHBhdHRlcm5zLnB1c2goXG4gICAgICAgIGB0b190c3ZlY3RvcigkJHtpbmRleH0sICQke2luZGV4ICsgMX06bmFtZSkgQEAgdG9fdHNxdWVyeSgkJHtpbmRleCArIDJ9LCAkJHtpbmRleCArIDN9KWBcbiAgICAgICk7XG4gICAgICB2YWx1ZXMucHVzaChsYW5ndWFnZSwgZmllbGROYW1lLCBsYW5ndWFnZSwgc2VhcmNoLiR0ZXJtKTtcbiAgICAgIGluZGV4ICs9IDQ7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuJG5lYXJTcGhlcmUpIHtcbiAgICAgIGNvbnN0IHBvaW50ID0gZmllbGRWYWx1ZS4kbmVhclNwaGVyZTtcbiAgICAgIGNvbnN0IGRpc3RhbmNlID0gZmllbGRWYWx1ZS4kbWF4RGlzdGFuY2U7XG4gICAgICBjb25zdCBkaXN0YW5jZUluS00gPSBkaXN0YW5jZSAqIDYzNzEgKiAxMDAwO1xuICAgICAgcGF0dGVybnMucHVzaChcbiAgICAgICAgYFNUX0Rpc3RhbmNlU3BoZXJlKCQke2luZGV4fTpuYW1lOjpnZW9tZXRyeSwgUE9JTlQoJCR7aW5kZXggKyAxfSwgJCR7aW5kZXggKyAyXG4gICAgICAgIH0pOjpnZW9tZXRyeSkgPD0gJCR7aW5kZXggKyAzfWBcbiAgICAgICk7XG4gICAgICBzb3J0cy5wdXNoKFxuICAgICAgICBgU1RfRGlzdGFuY2VTcGhlcmUoJCR7aW5kZXh9Om5hbWU6Omdlb21ldHJ5LCBQT0lOVCgkJHtpbmRleCArIDF9LCAkJHtpbmRleCArIDJcbiAgICAgICAgfSk6Omdlb21ldHJ5KSBBU0NgXG4gICAgICApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBwb2ludC5sb25naXR1ZGUsIHBvaW50LmxhdGl0dWRlLCBkaXN0YW5jZUluS00pO1xuICAgICAgaW5kZXggKz0gNDtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kd2l0aGluICYmIGZpZWxkVmFsdWUuJHdpdGhpbi4kYm94KSB7XG4gICAgICBjb25zdCBib3ggPSBmaWVsZFZhbHVlLiR3aXRoaW4uJGJveDtcbiAgICAgIGNvbnN0IGxlZnQgPSBib3hbMF0ubG9uZ2l0dWRlO1xuICAgICAgY29uc3QgYm90dG9tID0gYm94WzBdLmxhdGl0dWRlO1xuICAgICAgY29uc3QgcmlnaHQgPSBib3hbMV0ubG9uZ2l0dWRlO1xuICAgICAgY29uc3QgdG9wID0gYm94WzFdLmxhdGl0dWRlO1xuXG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZTo6cG9pbnQgPEAgJCR7aW5kZXggKyAxfTo6Ym94YCk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGAoKCR7bGVmdH0sICR7Ym90dG9tfSksICgke3JpZ2h0fSwgJHt0b3B9KSlgKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuJGdlb1dpdGhpbiAmJiBmaWVsZFZhbHVlLiRnZW9XaXRoaW4uJGNlbnRlclNwaGVyZSkge1xuICAgICAgY29uc3QgY2VudGVyU3BoZXJlID0gZmllbGRWYWx1ZS4kZ2VvV2l0aGluLiRjZW50ZXJTcGhlcmU7XG4gICAgICBpZiAoIShjZW50ZXJTcGhlcmUgaW5zdGFuY2VvZiBBcnJheSkgfHwgY2VudGVyU3BoZXJlLmxlbmd0aCA8IDIpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAnYmFkICRnZW9XaXRoaW4gdmFsdWU7ICRjZW50ZXJTcGhlcmUgc2hvdWxkIGJlIGFuIGFycmF5IG9mIFBhcnNlLkdlb1BvaW50IGFuZCBkaXN0YW5jZSdcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIC8vIEdldCBwb2ludCwgY29udmVydCB0byBnZW8gcG9pbnQgaWYgbmVjZXNzYXJ5IGFuZCB2YWxpZGF0ZVxuICAgICAgbGV0IHBvaW50ID0gY2VudGVyU3BoZXJlWzBdO1xuICAgICAgaWYgKHBvaW50IGluc3RhbmNlb2YgQXJyYXkgJiYgcG9pbnQubGVuZ3RoID09PSAyKSB7XG4gICAgICAgIHBvaW50ID0gbmV3IFBhcnNlLkdlb1BvaW50KHBvaW50WzFdLCBwb2ludFswXSk7XG4gICAgICB9IGVsc2UgaWYgKCFHZW9Qb2ludENvZGVyLmlzVmFsaWRKU09OKHBvaW50KSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICdiYWQgJGdlb1dpdGhpbiB2YWx1ZTsgJGNlbnRlclNwaGVyZSBnZW8gcG9pbnQgaW52YWxpZCdcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIFBhcnNlLkdlb1BvaW50Ll92YWxpZGF0ZShwb2ludC5sYXRpdHVkZSwgcG9pbnQubG9uZ2l0dWRlKTtcbiAgICAgIC8vIEdldCBkaXN0YW5jZSBhbmQgdmFsaWRhdGVcbiAgICAgIGNvbnN0IGRpc3RhbmNlID0gY2VudGVyU3BoZXJlWzFdO1xuICAgICAgaWYgKGlzTmFOKGRpc3RhbmNlKSB8fCBkaXN0YW5jZSA8IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAnYmFkICRnZW9XaXRoaW4gdmFsdWU7ICRjZW50ZXJTcGhlcmUgZGlzdGFuY2UgaW52YWxpZCdcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGRpc3RhbmNlSW5LTSA9IGRpc3RhbmNlICogNjM3MSAqIDEwMDA7XG4gICAgICBwYXR0ZXJucy5wdXNoKFxuICAgICAgICBgU1RfRGlzdGFuY2VTcGhlcmUoJCR7aW5kZXh9Om5hbWU6Omdlb21ldHJ5LCBQT0lOVCgkJHtpbmRleCArIDF9LCAkJHtpbmRleCArIDJcbiAgICAgICAgfSk6Omdlb21ldHJ5KSA8PSAkJHtpbmRleCArIDN9YFxuICAgICAgKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgcG9pbnQubG9uZ2l0dWRlLCBwb2ludC5sYXRpdHVkZSwgZGlzdGFuY2VJbktNKTtcbiAgICAgIGluZGV4ICs9IDQ7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuJGdlb1dpdGhpbiAmJiBmaWVsZFZhbHVlLiRnZW9XaXRoaW4uJHBvbHlnb24pIHtcbiAgICAgIGNvbnN0IHBvbHlnb24gPSBmaWVsZFZhbHVlLiRnZW9XaXRoaW4uJHBvbHlnb247XG4gICAgICBsZXQgcG9pbnRzO1xuICAgICAgaWYgKHR5cGVvZiBwb2x5Z29uID09PSAnb2JqZWN0JyAmJiBwb2x5Z29uLl9fdHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICAgIGlmICghcG9seWdvbi5jb29yZGluYXRlcyB8fCBwb2x5Z29uLmNvb3JkaW5hdGVzLmxlbmd0aCA8IDMpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAnYmFkICRnZW9XaXRoaW4gdmFsdWU7IFBvbHlnb24uY29vcmRpbmF0ZXMgc2hvdWxkIGNvbnRhaW4gYXQgbGVhc3QgMyBsb24vbGF0IHBhaXJzJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcG9pbnRzID0gcG9seWdvbi5jb29yZGluYXRlcztcbiAgICAgIH0gZWxzZSBpZiAocG9seWdvbiBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgICAgIGlmIChwb2x5Z29uLmxlbmd0aCA8IDMpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAnYmFkICRnZW9XaXRoaW4gdmFsdWU7ICRwb2x5Z29uIHNob3VsZCBjb250YWluIGF0IGxlYXN0IDMgR2VvUG9pbnRzJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcG9pbnRzID0gcG9seWdvbjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgXCJiYWQgJGdlb1dpdGhpbiB2YWx1ZTsgJHBvbHlnb24gc2hvdWxkIGJlIFBvbHlnb24gb2JqZWN0IG9yIEFycmF5IG9mIFBhcnNlLkdlb1BvaW50J3NcIlxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcG9pbnRzID0gcG9pbnRzXG4gICAgICAgIC5tYXAocG9pbnQgPT4ge1xuICAgICAgICAgIGlmIChwb2ludCBpbnN0YW5jZW9mIEFycmF5ICYmIHBvaW50Lmxlbmd0aCA9PT0gMikge1xuICAgICAgICAgICAgUGFyc2UuR2VvUG9pbnQuX3ZhbGlkYXRlKHBvaW50WzFdLCBwb2ludFswXSk7XG4gICAgICAgICAgICByZXR1cm4gYCgke3BvaW50WzBdfSwgJHtwb2ludFsxXX0pYDtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHR5cGVvZiBwb2ludCAhPT0gJ29iamVjdCcgfHwgcG9pbnQuX190eXBlICE9PSAnR2VvUG9pbnQnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCAnYmFkICRnZW9XaXRoaW4gdmFsdWUnKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgUGFyc2UuR2VvUG9pbnQuX3ZhbGlkYXRlKHBvaW50LmxhdGl0dWRlLCBwb2ludC5sb25naXR1ZGUpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gYCgke3BvaW50LmxvbmdpdHVkZX0sICR7cG9pbnQubGF0aXR1ZGV9KWA7XG4gICAgICAgIH0pXG4gICAgICAgIC5qb2luKCcsICcpO1xuXG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZTo6cG9pbnQgPEAgJCR7aW5kZXggKyAxfTo6cG9seWdvbmApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBgKCR7cG9pbnRzfSlgKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfVxuICAgIGlmIChmaWVsZFZhbHVlLiRnZW9JbnRlcnNlY3RzICYmIGZpZWxkVmFsdWUuJGdlb0ludGVyc2VjdHMuJHBvaW50KSB7XG4gICAgICBjb25zdCBwb2ludCA9IGZpZWxkVmFsdWUuJGdlb0ludGVyc2VjdHMuJHBvaW50O1xuICAgICAgaWYgKHR5cGVvZiBwb2ludCAhPT0gJ29iamVjdCcgfHwgcG9pbnQuX190eXBlICE9PSAnR2VvUG9pbnQnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgJ2JhZCAkZ2VvSW50ZXJzZWN0IHZhbHVlOyAkcG9pbnQgc2hvdWxkIGJlIEdlb1BvaW50J1xuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgUGFyc2UuR2VvUG9pbnQuX3ZhbGlkYXRlKHBvaW50LmxhdGl0dWRlLCBwb2ludC5sb25naXR1ZGUpO1xuICAgICAgfVxuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWU6OnBvbHlnb24gQD4gJCR7aW5kZXggKyAxfTo6cG9pbnRgKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgYCgke3BvaW50LmxvbmdpdHVkZX0sICR7cG9pbnQubGF0aXR1ZGV9KWApO1xuICAgICAgaW5kZXggKz0gMjtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kcmVnZXgpIHtcbiAgICAgIGxldCByZWdleCA9IGZpZWxkVmFsdWUuJHJlZ2V4O1xuICAgICAgbGV0IG9wZXJhdG9yID0gJ34nO1xuICAgICAgY29uc3Qgb3B0cyA9IGZpZWxkVmFsdWUuJG9wdGlvbnM7XG4gICAgICBpZiAob3B0cykge1xuICAgICAgICBpZiAob3B0cy5pbmRleE9mKCdpJykgPj0gMCkge1xuICAgICAgICAgIG9wZXJhdG9yID0gJ34qJztcbiAgICAgICAgfVxuICAgICAgICBpZiAob3B0cy5pbmRleE9mKCd4JykgPj0gMCkge1xuICAgICAgICAgIHJlZ2V4ID0gcmVtb3ZlV2hpdGVTcGFjZShyZWdleCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgY29uc3QgbmFtZSA9IHRyYW5zZm9ybURvdEZpZWxkKGZpZWxkTmFtZSk7XG4gICAgICByZWdleCA9IHByb2Nlc3NSZWdleFBhdHRlcm4ocmVnZXgpO1xuXG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06cmF3ICR7b3BlcmF0b3J9ICckJHtpbmRleCArIDF9OnJhdydgKTtcbiAgICAgIHZhbHVlcy5wdXNoKG5hbWUsIHJlZ2V4KTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuX190eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgIGlmIChpc0FycmF5RmllbGQpIHtcbiAgICAgICAgcGF0dGVybnMucHVzaChgYXJyYXlfY29udGFpbnMoJCR7aW5kZXh9Om5hbWUsICQke2luZGV4ICsgMX0pYCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgSlNPTi5zdHJpbmdpZnkoW2ZpZWxkVmFsdWVdKSk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlLm9iamVjdElkKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdEYXRlJykge1xuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUuaXNvKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuX190eXBlID09PSAnR2VvUG9pbnQnKSB7XG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSB+PSBQT0lOVCgkJHtpbmRleCArIDF9LCAkJHtpbmRleCArIDJ9KWApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlLmxvbmdpdHVkZSwgZmllbGRWYWx1ZS5sYXRpdHVkZSk7XG4gICAgICBpbmRleCArPSAzO1xuICAgIH1cblxuICAgIGlmIChmaWVsZFZhbHVlLl9fdHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGNvbnZlcnRQb2x5Z29uVG9TUUwoZmllbGRWYWx1ZS5jb29yZGluYXRlcyk7XG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSB+PSAkJHtpbmRleCArIDF9Ojpwb2x5Z29uYCk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIHZhbHVlKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfVxuXG4gICAgT2JqZWN0LmtleXMoUGFyc2VUb1Bvc2dyZXNDb21wYXJhdG9yKS5mb3JFYWNoKGNtcCA9PiB7XG4gICAgICBpZiAoZmllbGRWYWx1ZVtjbXBdIHx8IGZpZWxkVmFsdWVbY21wXSA9PT0gMCkge1xuICAgICAgICBjb25zdCBwZ0NvbXBhcmF0b3IgPSBQYXJzZVRvUG9zZ3Jlc0NvbXBhcmF0b3JbY21wXTtcbiAgICAgICAgbGV0IGNvbnN0cmFpbnRGaWVsZE5hbWU7XG4gICAgICAgIGxldCBwb3N0Z3Jlc1ZhbHVlID0gdG9Qb3N0Z3Jlc1ZhbHVlKGZpZWxkVmFsdWVbY21wXSk7XG5cbiAgICAgICAgaWYgKGZpZWxkTmFtZS5pbmRleE9mKCcuJykgPj0gMCkge1xuICAgICAgICAgIGNvbnN0IGNhc3RUeXBlID0gdG9Qb3N0Z3Jlc1ZhbHVlQ2FzdFR5cGUoZmllbGRWYWx1ZVtjbXBdKTtcbiAgICAgICAgICBjb25zdHJhaW50RmllbGROYW1lID0gY2FzdFR5cGVcbiAgICAgICAgICAgID8gYENBU1QgKCgke3RyYW5zZm9ybURvdEZpZWxkKGZpZWxkTmFtZSl9KSBBUyAke2Nhc3RUeXBlfSlgXG4gICAgICAgICAgICA6IHRyYW5zZm9ybURvdEZpZWxkKGZpZWxkTmFtZSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBwb3N0Z3Jlc1ZhbHVlID09PSAnb2JqZWN0JyAmJiBwb3N0Z3Jlc1ZhbHVlLiRyZWxhdGl2ZVRpbWUpIHtcbiAgICAgICAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSAhPT0gJ0RhdGUnKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAgICAgJyRyZWxhdGl2ZVRpbWUgY2FuIG9ubHkgYmUgdXNlZCB3aXRoIERhdGUgZmllbGQnXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBwYXJzZXJSZXN1bHQgPSBVdGlscy5yZWxhdGl2ZVRpbWVUb0RhdGUocG9zdGdyZXNWYWx1ZS4kcmVsYXRpdmVUaW1lKTtcbiAgICAgICAgICAgIGlmIChwYXJzZXJSZXN1bHQuc3RhdHVzID09PSAnc3VjY2VzcycpIHtcbiAgICAgICAgICAgICAgcG9zdGdyZXNWYWx1ZSA9IHRvUG9zdGdyZXNWYWx1ZShwYXJzZXJSZXN1bHQucmVzdWx0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHdoaWxlIHBhcnNpbmcgcmVsYXRpdmUgZGF0ZScsIHBhcnNlclJlc3VsdCk7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAgICAgYGJhZCAkcmVsYXRpdmVUaW1lICgke3Bvc3RncmVzVmFsdWUuJHJlbGF0aXZlVGltZX0pIHZhbHVlLiAke3BhcnNlclJlc3VsdC5pbmZvfWBcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3RyYWludEZpZWxkTmFtZSA9IGAkJHtpbmRleCsrfTpuYW1lYDtcbiAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICB9XG4gICAgICAgIHZhbHVlcy5wdXNoKHBvc3RncmVzVmFsdWUpO1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGAke2NvbnN0cmFpbnRGaWVsZE5hbWV9ICR7cGdDb21wYXJhdG9yfSAkJHtpbmRleCsrfWApO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgaWYgKGluaXRpYWxQYXR0ZXJuc0xlbmd0aCA9PT0gcGF0dGVybnMubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgIGBQb3N0Z3JlcyBkb2Vzbid0IHN1cHBvcnQgdGhpcyBxdWVyeSB0eXBlIHlldCAke0pTT04uc3RyaW5naWZ5KGZpZWxkVmFsdWUpfWBcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIHZhbHVlcyA9IHZhbHVlcy5tYXAodHJhbnNmb3JtVmFsdWUpO1xuICByZXR1cm4geyBwYXR0ZXJuOiBwYXR0ZXJucy5qb2luKCcgQU5EICcpLCB2YWx1ZXMsIHNvcnRzIH07XG59O1xuXG5leHBvcnQgY2xhc3MgUG9zdGdyZXNTdG9yYWdlQWRhcHRlciBpbXBsZW1lbnRzIFN0b3JhZ2VBZGFwdGVyIHtcbiAgY2FuU29ydE9uSm9pblRhYmxlczogYm9vbGVhbjtcbiAgZW5hYmxlU2NoZW1hSG9va3M6IGJvb2xlYW47XG5cbiAgLy8gUHJpdmF0ZVxuICBfY29sbGVjdGlvblByZWZpeDogc3RyaW5nO1xuICBfY2xpZW50OiBhbnk7XG4gIF9vbmNoYW5nZTogYW55O1xuICBfcGdwOiBhbnk7XG4gIF9zdHJlYW06IGFueTtcbiAgX3V1aWQ6IGFueTtcbiAgc2NoZW1hQ2FjaGVUdGw6ID9udW1iZXI7XG4gIGRpc2FibGVJbmRleEZpZWxkVmFsaWRhdGlvbjogYm9vbGVhbjtcblxuICBjb25zdHJ1Y3Rvcih7IHVyaSwgY29sbGVjdGlvblByZWZpeCA9ICcnLCBkYXRhYmFzZU9wdGlvbnMgPSB7fSB9OiBhbnkpIHtcbiAgICBjb25zdCBvcHRpb25zID0geyAuLi5kYXRhYmFzZU9wdGlvbnMgfTtcbiAgICB0aGlzLl9jb2xsZWN0aW9uUHJlZml4ID0gY29sbGVjdGlvblByZWZpeDtcbiAgICB0aGlzLmVuYWJsZVNjaGVtYUhvb2tzID0gISFkYXRhYmFzZU9wdGlvbnMuZW5hYmxlU2NoZW1hSG9va3M7XG4gICAgdGhpcy5kaXNhYmxlSW5kZXhGaWVsZFZhbGlkYXRpb24gPSAhIWRhdGFiYXNlT3B0aW9ucy5kaXNhYmxlSW5kZXhGaWVsZFZhbGlkYXRpb247XG5cbiAgICB0aGlzLnNjaGVtYUNhY2hlVHRsID0gZGF0YWJhc2VPcHRpb25zLnNjaGVtYUNhY2hlVHRsO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIFsnZW5hYmxlU2NoZW1hSG9va3MnLCAnc2NoZW1hQ2FjaGVUdGwnLCAnZGlzYWJsZUluZGV4RmllbGRWYWxpZGF0aW9uJ10pIHtcbiAgICAgIGRlbGV0ZSBvcHRpb25zW2tleV07XG4gICAgfVxuXG4gICAgY29uc3QgeyBjbGllbnQsIHBncCB9ID0gY3JlYXRlQ2xpZW50KHVyaSwgb3B0aW9ucyk7XG4gICAgdGhpcy5fY2xpZW50ID0gY2xpZW50O1xuICAgIHRoaXMuX29uY2hhbmdlID0gKCkgPT4geyB9O1xuICAgIHRoaXMuX3BncCA9IHBncDtcbiAgICB0aGlzLl91dWlkID0gdXVpZHY0KCk7XG4gICAgdGhpcy5jYW5Tb3J0T25Kb2luVGFibGVzID0gZmFsc2U7XG4gIH1cblxuICB3YXRjaChjYWxsYmFjazogKCkgPT4gdm9pZCk6IHZvaWQge1xuICAgIHRoaXMuX29uY2hhbmdlID0gY2FsbGJhY2s7XG4gIH1cblxuICAvL05vdGUgdGhhdCBhbmFseXplPXRydWUgd2lsbCBydW4gdGhlIHF1ZXJ5LCBleGVjdXRpbmcgSU5TRVJUUywgREVMRVRFUywgZXRjLlxuICBjcmVhdGVFeHBsYWluYWJsZVF1ZXJ5KHF1ZXJ5OiBzdHJpbmcsIGFuYWx5emU6IGJvb2xlYW4gPSBmYWxzZSkge1xuICAgIGlmIChhbmFseXplKSB7XG4gICAgICByZXR1cm4gJ0VYUExBSU4gKEFOQUxZWkUsIEZPUk1BVCBKU09OKSAnICsgcXVlcnk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiAnRVhQTEFJTiAoRk9STUFUIEpTT04pICcgKyBxdWVyeTtcbiAgICB9XG4gIH1cblxuICBoYW5kbGVTaHV0ZG93bigpIHtcbiAgICBpZiAodGhpcy5fc3RyZWFtKSB7XG4gICAgICB0aGlzLl9zdHJlYW0uZG9uZSgpO1xuICAgICAgZGVsZXRlIHRoaXMuX3N0cmVhbTtcbiAgICB9XG4gICAgaWYgKCF0aGlzLl9jbGllbnQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5fY2xpZW50LiRwb29sLmVuZCgpO1xuICB9XG5cbiAgYXN5bmMgX2xpc3RlblRvU2NoZW1hKCkge1xuICAgIGlmICghdGhpcy5fc3RyZWFtICYmIHRoaXMuZW5hYmxlU2NoZW1hSG9va3MpIHtcbiAgICAgIHRoaXMuX3N0cmVhbSA9IGF3YWl0IHRoaXMuX2NsaWVudC5jb25uZWN0KHsgZGlyZWN0OiB0cnVlIH0pO1xuICAgICAgdGhpcy5fc3RyZWFtLmNsaWVudC5vbignbm90aWZpY2F0aW9uJywgZGF0YSA9PiB7XG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBKU09OLnBhcnNlKGRhdGEucGF5bG9hZCk7XG4gICAgICAgIGlmIChwYXlsb2FkLnNlbmRlcklkICE9PSB0aGlzLl91dWlkKSB7XG4gICAgICAgICAgdGhpcy5fb25jaGFuZ2UoKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aGlzLl9zdHJlYW0ubm9uZSgnTElTVEVOICQxficsICdzY2hlbWEuY2hhbmdlJyk7XG4gICAgfVxuICB9XG5cbiAgX25vdGlmeVNjaGVtYUNoYW5nZSgpIHtcbiAgICBpZiAodGhpcy5fc3RyZWFtKSB7XG4gICAgICB0aGlzLl9zdHJlYW1cbiAgICAgICAgLm5vbmUoJ05PVElGWSAkMX4sICQyJywgWydzY2hlbWEuY2hhbmdlJywgeyBzZW5kZXJJZDogdGhpcy5fdXVpZCB9XSlcbiAgICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgICAgIGNvbnNvbGUubG9nKCdGYWlsZWQgdG8gTm90aWZ5OicsIGVycm9yKTsgLy8gdW5saWtlbHkgdG8gZXZlciBoYXBwZW5cbiAgICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgX2Vuc3VyZVNjaGVtYUNvbGxlY3Rpb25FeGlzdHMoY29ubjogYW55KSB7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIGF3YWl0IGNvbm5cbiAgICAgIC5ub25lKFxuICAgICAgICAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgXCJfU0NIRU1BXCIgKCBcImNsYXNzTmFtZVwiIHZhckNoYXIoMTIwKSwgXCJzY2hlbWFcIiBqc29uYiwgXCJpc1BhcnNlQ2xhc3NcIiBib29sLCBQUklNQVJZIEtFWSAoXCJjbGFzc05hbWVcIikgKSdcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSk7XG4gIH1cblxuICBhc3luYyBjbGFzc0V4aXN0cyhuYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5fY2xpZW50Lm9uZShcbiAgICAgICdTRUxFQ1QgRVhJU1RTIChTRUxFQ1QgMSBGUk9NIGluZm9ybWF0aW9uX3NjaGVtYS50YWJsZXMgV0hFUkUgdGFibGVfbmFtZSA9ICQxKScsXG4gICAgICBbbmFtZV0sXG4gICAgICBhID0+IGEuZXhpc3RzXG4gICAgKTtcbiAgfVxuXG4gIGFzeW5jIHNldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyhjbGFzc05hbWU6IHN0cmluZywgQ0xQczogYW55KSB7XG4gICAgYXdhaXQgdGhpcy5fY2xpZW50LnRhc2soJ3NldC1jbGFzcy1sZXZlbC1wZXJtaXNzaW9ucycsIGFzeW5jIHQgPT4ge1xuICAgICAgY29uc3QgdmFsdWVzID0gW2NsYXNzTmFtZSwgJ3NjaGVtYScsICdjbGFzc0xldmVsUGVybWlzc2lvbnMnLCBKU09OLnN0cmluZ2lmeShDTFBzKV07XG4gICAgICBhd2FpdCB0Lm5vbmUoXG4gICAgICAgIGBVUERBVEUgXCJfU0NIRU1BXCIgU0VUICQyOm5hbWUgPSBqc29uX29iamVjdF9zZXRfa2V5KCQyOm5hbWUsICQzOjp0ZXh0LCAkNDo6anNvbmIpIFdIRVJFIFwiY2xhc3NOYW1lXCIgPSAkMWAsXG4gICAgICAgIHZhbHVlc1xuICAgICAgKTtcbiAgICB9KTtcbiAgICB0aGlzLl9ub3RpZnlTY2hlbWFDaGFuZ2UoKTtcbiAgfVxuXG4gIGFzeW5jIHNldEluZGV4ZXNXaXRoU2NoZW1hRm9ybWF0KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHN1Ym1pdHRlZEluZGV4ZXM6IGFueSxcbiAgICBleGlzdGluZ0luZGV4ZXM6IGFueSA9IHt9LFxuICAgIGZpZWxkczogYW55LFxuICAgIGNvbm46ID9hbnlcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuICAgIGlmIChzdWJtaXR0ZWRJbmRleGVzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG4gICAgaWYgKE9iamVjdC5rZXlzKGV4aXN0aW5nSW5kZXhlcykubGVuZ3RoID09PSAwKSB7XG4gICAgICBleGlzdGluZ0luZGV4ZXMgPSB7IF9pZF86IHsgX2lkOiAxIH0gfTtcbiAgICB9XG4gICAgY29uc3QgZGVsZXRlZEluZGV4ZXMgPSBbXTtcbiAgICBjb25zdCBpbnNlcnRlZEluZGV4ZXMgPSBbXTtcbiAgICBPYmplY3Qua2V5cyhzdWJtaXR0ZWRJbmRleGVzKS5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgY29uc3QgZmllbGQgPSBzdWJtaXR0ZWRJbmRleGVzW25hbWVdO1xuICAgICAgaWYgKGV4aXN0aW5nSW5kZXhlc1tuYW1lXSAmJiBmaWVsZC5fX29wICE9PSAnRGVsZXRlJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgYEluZGV4ICR7bmFtZX0gZXhpc3RzLCBjYW5ub3QgdXBkYXRlLmApO1xuICAgICAgfVxuICAgICAgaWYgKCFleGlzdGluZ0luZGV4ZXNbbmFtZV0gJiYgZmllbGQuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgYEluZGV4ICR7bmFtZX0gZG9lcyBub3QgZXhpc3QsIGNhbm5vdCBkZWxldGUuYFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKGZpZWxkLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgIGRlbGV0ZWRJbmRleGVzLnB1c2gobmFtZSk7XG4gICAgICAgIGRlbGV0ZSBleGlzdGluZ0luZGV4ZXNbbmFtZV07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBPYmplY3Qua2V5cyhmaWVsZCkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICF0aGlzLmRpc2FibGVJbmRleEZpZWxkVmFsaWRhdGlvbiAmJlxuICAgICAgICAgICAgIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChmaWVsZHMsIGtleSlcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgICAgICAgYEZpZWxkICR7a2V5fSBkb2VzIG5vdCBleGlzdCwgY2Fubm90IGFkZCBpbmRleC5gXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIGV4aXN0aW5nSW5kZXhlc1tuYW1lXSA9IGZpZWxkO1xuICAgICAgICBpbnNlcnRlZEluZGV4ZXMucHVzaCh7XG4gICAgICAgICAga2V5OiBmaWVsZCxcbiAgICAgICAgICBuYW1lLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBhd2FpdCBjb25uLnR4KCdzZXQtaW5kZXhlcy13aXRoLXNjaGVtYS1mb3JtYXQnLCBhc3luYyB0ID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlmIChpbnNlcnRlZEluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGF3YWl0IHNlbGYuY3JlYXRlSW5kZXhlcyhjbGFzc05hbWUsIGluc2VydGVkSW5kZXhlcywgdCk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgLy8gcGctcHJvbWlzZSB1c2UgQmF0Y2ggZXJyb3Igc2VlIGh0dHBzOi8vZ2l0aHViLmNvbS92aXRhbHktdC9zcGV4L2Jsb2IvZTU3MjAzMGYyNjFiZTFhOGU5MzQxZmM2ZjYzN2UzNmFkMDdmNTIzMS9zcmMvZXJyb3JzL2JhdGNoLmpzI0w1OVxuICAgICAgICBjb25zdCBjb2x1bW5Eb2VzTm90RXhpc3RFcnJvciA9IGUuZ2V0RXJyb3JzICYmIGUuZ2V0RXJyb3JzKClbMF0gJiYgZS5nZXRFcnJvcnMoKVswXS5jb2RlID09PSAnNDI3MDMnO1xuICAgICAgICAvLyBTcGVjaWZpYyBjYXNlIHdoZW4gdGhlIGNvbHVtbiBkb2VzIG5vdCBleGlzdFxuICAgICAgICBpZiAoY29sdW1uRG9lc05vdEV4aXN0RXJyb3IpIHtcbiAgICAgICAgICAvLyBJZiB0aGUgZGlzYWJsZUluZGV4RmllbGRWYWxpZGF0aW9uIGlzIHRydWUsIHdlIHNob3VsZCBpZ25vcmUgdGhlIGVycm9yXG4gICAgICAgICAgaWYgKCF0aGlzLmRpc2FibGVJbmRleEZpZWxkVmFsaWRhdGlvbikge1xuICAgICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGRlbGV0ZWRJbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgYXdhaXQgc2VsZi5kcm9wSW5kZXhlcyhjbGFzc05hbWUsIGRlbGV0ZWRJbmRleGVzLCB0KTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHQubm9uZShcbiAgICAgICAgJ1VQREFURSBcIl9TQ0hFTUFcIiBTRVQgJDI6bmFtZSA9IGpzb25fb2JqZWN0X3NldF9rZXkoJDI6bmFtZSwgJDM6OnRleHQsICQ0Ojpqc29uYikgV0hFUkUgXCJjbGFzc05hbWVcIiA9ICQxJyxcbiAgICAgICAgW2NsYXNzTmFtZSwgJ3NjaGVtYScsICdpbmRleGVzJywgSlNPTi5zdHJpbmdpZnkoZXhpc3RpbmdJbmRleGVzKV1cbiAgICAgICk7XG4gICAgfSk7XG4gICAgdGhpcy5fbm90aWZ5U2NoZW1hQ2hhbmdlKCk7XG4gIH1cblxuICBhc3luYyBjcmVhdGVDbGFzcyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBjb25uOiA/YW55KSB7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIGNvbnN0IHBhcnNlU2NoZW1hID0gYXdhaXQgY29ublxuICAgICAgLnR4KCdjcmVhdGUtY2xhc3MnLCBhc3luYyB0ID0+IHtcbiAgICAgICAgYXdhaXQgdGhpcy5jcmVhdGVUYWJsZShjbGFzc05hbWUsIHNjaGVtYSwgdCk7XG4gICAgICAgIGF3YWl0IHQubm9uZShcbiAgICAgICAgICAnSU5TRVJUIElOVE8gXCJfU0NIRU1BXCIgKFwiY2xhc3NOYW1lXCIsIFwic2NoZW1hXCIsIFwiaXNQYXJzZUNsYXNzXCIpIFZBTFVFUyAoJDxjbGFzc05hbWU+LCAkPHNjaGVtYT4sIHRydWUpJyxcbiAgICAgICAgICB7IGNsYXNzTmFtZSwgc2NoZW1hIH1cbiAgICAgICAgKTtcbiAgICAgICAgYXdhaXQgdGhpcy5zZXRJbmRleGVzV2l0aFNjaGVtYUZvcm1hdChjbGFzc05hbWUsIHNjaGVtYS5pbmRleGVzLCB7fSwgc2NoZW1hLmZpZWxkcywgdCk7XG4gICAgICAgIHJldHVybiB0b1BhcnNlU2NoZW1hKHNjaGVtYSk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgIGlmIChlcnIuY29kZSA9PT0gUG9zdGdyZXNVbmlxdWVJbmRleFZpb2xhdGlvbkVycm9yICYmIGVyci5kZXRhaWwuaW5jbHVkZXMoY2xhc3NOYW1lKSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsIGBDbGFzcyAke2NsYXNzTmFtZX0gYWxyZWFkeSBleGlzdHMuYCk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgfSk7XG4gICAgdGhpcy5fbm90aWZ5U2NoZW1hQ2hhbmdlKCk7XG4gICAgcmV0dXJuIHBhcnNlU2NoZW1hO1xuICB9XG5cbiAgLy8gSnVzdCBjcmVhdGUgYSB0YWJsZSwgZG8gbm90IGluc2VydCBpbiBzY2hlbWFcbiAgYXN5bmMgY3JlYXRlVGFibGUoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgY29ubjogYW55KSB7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIGRlYnVnKCdjcmVhdGVUYWJsZScpO1xuICAgIGNvbnN0IHZhbHVlc0FycmF5ID0gW107XG4gICAgY29uc3QgcGF0dGVybnNBcnJheSA9IFtdO1xuICAgIGNvbnN0IGZpZWxkcyA9IE9iamVjdC5hc3NpZ24oe30sIHNjaGVtYS5maWVsZHMpO1xuICAgIGlmIChjbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICAgIGZpZWxkcy5fZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQgPSB7IHR5cGU6ICdEYXRlJyB9O1xuICAgICAgZmllbGRzLl9lbWFpbF92ZXJpZnlfdG9rZW4gPSB7IHR5cGU6ICdTdHJpbmcnIH07XG4gICAgICBmaWVsZHMuX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0ID0geyB0eXBlOiAnRGF0ZScgfTtcbiAgICAgIGZpZWxkcy5fZmFpbGVkX2xvZ2luX2NvdW50ID0geyB0eXBlOiAnTnVtYmVyJyB9O1xuICAgICAgZmllbGRzLl9wZXJpc2hhYmxlX3Rva2VuID0geyB0eXBlOiAnU3RyaW5nJyB9O1xuICAgICAgZmllbGRzLl9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQgPSB7IHR5cGU6ICdEYXRlJyB9O1xuICAgICAgZmllbGRzLl9wYXNzd29yZF9jaGFuZ2VkX2F0ID0geyB0eXBlOiAnRGF0ZScgfTtcbiAgICAgIGZpZWxkcy5fcGFzc3dvcmRfaGlzdG9yeSA9IHsgdHlwZTogJ0FycmF5JyB9O1xuICAgIH1cbiAgICBsZXQgaW5kZXggPSAyO1xuICAgIGNvbnN0IHJlbGF0aW9ucyA9IFtdO1xuICAgIE9iamVjdC5rZXlzKGZpZWxkcykuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgY29uc3QgcGFyc2VUeXBlID0gZmllbGRzW2ZpZWxkTmFtZV07XG4gICAgICAvLyBTa2lwIHdoZW4gaXQncyBhIHJlbGF0aW9uXG4gICAgICAvLyBXZSdsbCBjcmVhdGUgdGhlIHRhYmxlcyBsYXRlclxuICAgICAgaWYgKHBhcnNlVHlwZS50eXBlID09PSAnUmVsYXRpb24nKSB7XG4gICAgICAgIHJlbGF0aW9ucy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmIChbJ19ycGVybScsICdfd3Blcm0nXS5pbmRleE9mKGZpZWxkTmFtZSkgPj0gMCkge1xuICAgICAgICBwYXJzZVR5cGUuY29udGVudHMgPSB7IHR5cGU6ICdTdHJpbmcnIH07XG4gICAgICB9XG4gICAgICB2YWx1ZXNBcnJheS5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICB2YWx1ZXNBcnJheS5wdXNoKHBhcnNlVHlwZVRvUG9zdGdyZXNUeXBlKHBhcnNlVHlwZSkpO1xuICAgICAgcGF0dGVybnNBcnJheS5wdXNoKGAkJHtpbmRleH06bmFtZSAkJHtpbmRleCArIDF9OnJhd2ApO1xuICAgICAgaWYgKGZpZWxkTmFtZSA9PT0gJ29iamVjdElkJykge1xuICAgICAgICBwYXR0ZXJuc0FycmF5LnB1c2goYFBSSU1BUlkgS0VZICgkJHtpbmRleH06bmFtZSlgKTtcbiAgICAgIH1cbiAgICAgIGluZGV4ID0gaW5kZXggKyAyO1xuICAgIH0pO1xuICAgIGNvbnN0IHFzID0gYENSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTICQxOm5hbWUgKCR7cGF0dGVybnNBcnJheS5qb2luKCl9KWA7XG4gICAgY29uc3QgdmFsdWVzID0gW2NsYXNzTmFtZSwgLi4udmFsdWVzQXJyYXldO1xuXG4gICAgcmV0dXJuIGNvbm4udGFzaygnY3JlYXRlLXRhYmxlJywgYXN5bmMgdCA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCB0Lm5vbmUocXMsIHZhbHVlcyk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSAhPT0gUG9zdGdyZXNEdXBsaWNhdGVSZWxhdGlvbkVycm9yKSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICAgICAgLy8gRUxTRTogVGFibGUgYWxyZWFkeSBleGlzdHMsIG11c3QgaGF2ZSBiZWVuIGNyZWF0ZWQgYnkgYSBkaWZmZXJlbnQgcmVxdWVzdC4gSWdub3JlIHRoZSBlcnJvci5cbiAgICAgIH1cbiAgICAgIGF3YWl0IHQudHgoJ2NyZWF0ZS10YWJsZS10eCcsIHR4ID0+IHtcbiAgICAgICAgcmV0dXJuIHR4LmJhdGNoKFxuICAgICAgICAgIHJlbGF0aW9ucy5tYXAoZmllbGROYW1lID0+IHtcbiAgICAgICAgICAgIHJldHVybiB0eC5ub25lKFxuICAgICAgICAgICAgICAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgJDxqb2luVGFibGU6bmFtZT4gKFwicmVsYXRlZElkXCIgdmFyQ2hhcigxMjApLCBcIm93bmluZ0lkXCIgdmFyQ2hhcigxMjApLCBQUklNQVJZIEtFWShcInJlbGF0ZWRJZFwiLCBcIm93bmluZ0lkXCIpICknLFxuICAgICAgICAgICAgICB7IGpvaW5UYWJsZTogYF9Kb2luOiR7ZmllbGROYW1lfToke2NsYXNzTmFtZX1gIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgc2NoZW1hVXBncmFkZShjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBjb25uOiBhbnkpIHtcbiAgICBkZWJ1Zygnc2NoZW1hVXBncmFkZScpO1xuICAgIGNvbm4gPSBjb25uIHx8IHRoaXMuX2NsaWVudDtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcblxuICAgIGF3YWl0IGNvbm4udGFzaygnc2NoZW1hLXVwZ3JhZGUnLCBhc3luYyB0ID0+IHtcbiAgICAgIGNvbnN0IGNvbHVtbnMgPSBhd2FpdCB0Lm1hcChcbiAgICAgICAgJ1NFTEVDVCBjb2x1bW5fbmFtZSBGUk9NIGluZm9ybWF0aW9uX3NjaGVtYS5jb2x1bW5zIFdIRVJFIHRhYmxlX25hbWUgPSAkPGNsYXNzTmFtZT4nLFxuICAgICAgICB7IGNsYXNzTmFtZSB9LFxuICAgICAgICBhID0+IGEuY29sdW1uX25hbWVcbiAgICAgICk7XG4gICAgICBjb25zdCBuZXdDb2x1bW5zID0gT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcylcbiAgICAgICAgLmZpbHRlcihpdGVtID0+IGNvbHVtbnMuaW5kZXhPZihpdGVtKSA9PT0gLTEpXG4gICAgICAgIC5tYXAoZmllbGROYW1lID0+IHNlbGYuYWRkRmllbGRJZk5vdEV4aXN0cyhjbGFzc05hbWUsIGZpZWxkTmFtZSwgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdKSk7XG5cbiAgICAgIGF3YWl0IHQuYmF0Y2gobmV3Q29sdW1ucyk7XG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBhZGRGaWVsZElmTm90RXhpc3RzKGNsYXNzTmFtZTogc3RyaW5nLCBmaWVsZE5hbWU6IHN0cmluZywgdHlwZTogYW55KSB7XG4gICAgLy8gVE9ETzogTXVzdCBiZSByZXZpc2VkIGZvciBpbnZhbGlkIGxvZ2ljLi4uXG4gICAgZGVidWcoJ2FkZEZpZWxkSWZOb3RFeGlzdHMnKTtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICBhd2FpdCB0aGlzLl9jbGllbnQudHgoJ2FkZC1maWVsZC1pZi1ub3QtZXhpc3RzJywgYXN5bmMgdCA9PiB7XG4gICAgICBpZiAodHlwZS50eXBlICE9PSAnUmVsYXRpb24nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgdC5ub25lKFxuICAgICAgICAgICAgJ0FMVEVSIFRBQkxFICQ8Y2xhc3NOYW1lOm5hbWU+IEFERCBDT0xVTU4gSUYgTk9UIEVYSVNUUyAkPGZpZWxkTmFtZTpuYW1lPiAkPHBvc3RncmVzVHlwZTpyYXc+JyxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgIHBvc3RncmVzVHlwZTogcGFyc2VUeXBlVG9Qb3N0Z3Jlc1R5cGUodHlwZSksXG4gICAgICAgICAgICB9XG4gICAgICAgICAgKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gUG9zdGdyZXNSZWxhdGlvbkRvZXNOb3RFeGlzdEVycm9yKSB7XG4gICAgICAgICAgICByZXR1cm4gc2VsZi5jcmVhdGVDbGFzcyhjbGFzc05hbWUsIHsgZmllbGRzOiB7IFtmaWVsZE5hbWVdOiB0eXBlIH0gfSwgdCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChlcnJvci5jb2RlICE9PSBQb3N0Z3Jlc0R1cGxpY2F0ZUNvbHVtbkVycm9yKSB7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gQ29sdW1uIGFscmVhZHkgZXhpc3RzLCBjcmVhdGVkIGJ5IG90aGVyIHJlcXVlc3QuIENhcnJ5IG9uIHRvIHNlZSBpZiBpdCdzIHRoZSByaWdodCB0eXBlLlxuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhd2FpdCB0Lm5vbmUoXG4gICAgICAgICAgJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTICQ8am9pblRhYmxlOm5hbWU+IChcInJlbGF0ZWRJZFwiIHZhckNoYXIoMTIwKSwgXCJvd25pbmdJZFwiIHZhckNoYXIoMTIwKSwgUFJJTUFSWSBLRVkoXCJyZWxhdGVkSWRcIiwgXCJvd25pbmdJZFwiKSApJyxcbiAgICAgICAgICB7IGpvaW5UYWJsZTogYF9Kb2luOiR7ZmllbGROYW1lfToke2NsYXNzTmFtZX1gIH1cbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdC5hbnkoXG4gICAgICAgICdTRUxFQ1QgXCJzY2hlbWFcIiBGUk9NIFwiX1NDSEVNQVwiIFdIRVJFIFwiY2xhc3NOYW1lXCIgPSAkPGNsYXNzTmFtZT4gYW5kIChcInNjaGVtYVwiOjpqc29uLT5cXCdmaWVsZHNcXCctPiQ8ZmllbGROYW1lPikgaXMgbm90IG51bGwnLFxuICAgICAgICB7IGNsYXNzTmFtZSwgZmllbGROYW1lIH1cbiAgICAgICk7XG5cbiAgICAgIGlmIChyZXN1bHRbMF0pIHtcbiAgICAgICAgdGhyb3cgJ0F0dGVtcHRlZCB0byBhZGQgYSBmaWVsZCB0aGF0IGFscmVhZHkgZXhpc3RzJztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBge2ZpZWxkcywke2ZpZWxkTmFtZX19YDtcbiAgICAgICAgYXdhaXQgdC5ub25lKFxuICAgICAgICAgICdVUERBVEUgXCJfU0NIRU1BXCIgU0VUIFwic2NoZW1hXCI9anNvbmJfc2V0KFwic2NoZW1hXCIsICQ8cGF0aD4sICQ8dHlwZT4pICBXSEVSRSBcImNsYXNzTmFtZVwiPSQ8Y2xhc3NOYW1lPicsXG4gICAgICAgICAgeyBwYXRoLCB0eXBlLCBjbGFzc05hbWUgfVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHRoaXMuX25vdGlmeVNjaGVtYUNoYW5nZSgpO1xuICB9XG5cbiAgYXN5bmMgdXBkYXRlRmllbGRPcHRpb25zKGNsYXNzTmFtZTogc3RyaW5nLCBmaWVsZE5hbWU6IHN0cmluZywgdHlwZTogYW55KSB7XG4gICAgYXdhaXQgdGhpcy5fY2xpZW50LnR4KCd1cGRhdGUtc2NoZW1hLWZpZWxkLW9wdGlvbnMnLCBhc3luYyB0ID0+IHtcbiAgICAgIGNvbnN0IHBhdGggPSBge2ZpZWxkcywke2ZpZWxkTmFtZX19YDtcbiAgICAgIGF3YWl0IHQubm9uZShcbiAgICAgICAgJ1VQREFURSBcIl9TQ0hFTUFcIiBTRVQgXCJzY2hlbWFcIj1qc29uYl9zZXQoXCJzY2hlbWFcIiwgJDxwYXRoPiwgJDx0eXBlPikgIFdIRVJFIFwiY2xhc3NOYW1lXCI9JDxjbGFzc05hbWU+JyxcbiAgICAgICAgeyBwYXRoLCB0eXBlLCBjbGFzc05hbWUgfVxuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIERyb3BzIGEgY29sbGVjdGlvbi4gUmVzb2x2ZXMgd2l0aCB0cnVlIGlmIGl0IHdhcyBhIFBhcnNlIFNjaGVtYSAoZWcuIF9Vc2VyLCBDdXN0b20sIGV0Yy4pXG4gIC8vIGFuZCByZXNvbHZlcyB3aXRoIGZhbHNlIGlmIGl0IHdhc24ndCAoZWcuIGEgam9pbiB0YWJsZSkuIFJlamVjdHMgaWYgZGVsZXRpb24gd2FzIGltcG9zc2libGUuXG4gIGFzeW5jIGRlbGV0ZUNsYXNzKGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgY29uc3Qgb3BlcmF0aW9ucyA9IFtcbiAgICAgIHsgcXVlcnk6IGBEUk9QIFRBQkxFIElGIEVYSVNUUyAkMTpuYW1lYCwgdmFsdWVzOiBbY2xhc3NOYW1lXSB9LFxuICAgICAge1xuICAgICAgICBxdWVyeTogYERFTEVURSBGUk9NIFwiX1NDSEVNQVwiIFdIRVJFIFwiY2xhc3NOYW1lXCIgPSAkMWAsXG4gICAgICAgIHZhbHVlczogW2NsYXNzTmFtZV0sXG4gICAgICB9LFxuICAgIF07XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLl9jbGllbnRcbiAgICAgIC50eCh0ID0+IHQubm9uZSh0aGlzLl9wZ3AuaGVscGVycy5jb25jYXQob3BlcmF0aW9ucykpKVxuICAgICAgLnRoZW4oKCkgPT4gY2xhc3NOYW1lLmluZGV4T2YoJ19Kb2luOicpICE9IDApOyAvLyByZXNvbHZlcyB3aXRoIGZhbHNlIHdoZW4gX0pvaW4gdGFibGVcblxuICAgIHRoaXMuX25vdGlmeVNjaGVtYUNoYW5nZSgpO1xuICAgIHJldHVybiByZXNwb25zZTtcbiAgfVxuXG4gIC8vIERlbGV0ZSBhbGwgZGF0YSBrbm93biB0byB0aGlzIGFkYXB0ZXIuIFVzZWQgZm9yIHRlc3RpbmcuXG4gIGFzeW5jIGRlbGV0ZUFsbENsYXNzZXMoKSB7XG4gICAgY29uc3Qgbm93ID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XG4gICAgY29uc3QgaGVscGVycyA9IHRoaXMuX3BncC5oZWxwZXJzO1xuICAgIGRlYnVnKCdkZWxldGVBbGxDbGFzc2VzJyk7XG4gICAgaWYgKHRoaXMuX2NsaWVudD8uJHBvb2wuZW5kZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgYXdhaXQgdGhpcy5fY2xpZW50XG4gICAgICAudGFzaygnZGVsZXRlLWFsbC1jbGFzc2VzJywgYXN5bmMgdCA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IHQuYW55KCdTRUxFQ1QgKiBGUk9NIFwiX1NDSEVNQVwiJyk7XG4gICAgICAgICAgY29uc3Qgam9pbnMgPSByZXN1bHRzLnJlZHVjZSgobGlzdDogQXJyYXk8c3RyaW5nPiwgc2NoZW1hOiBhbnkpID0+IHtcbiAgICAgICAgICAgIHJldHVybiBsaXN0LmNvbmNhdChqb2luVGFibGVzRm9yU2NoZW1hKHNjaGVtYS5zY2hlbWEpKTtcbiAgICAgICAgICB9LCBbXSk7XG4gICAgICAgICAgY29uc3QgY2xhc3NlcyA9IFtcbiAgICAgICAgICAgICdfU0NIRU1BJyxcbiAgICAgICAgICAgICdfUHVzaFN0YXR1cycsXG4gICAgICAgICAgICAnX0pvYlN0YXR1cycsXG4gICAgICAgICAgICAnX0pvYlNjaGVkdWxlJyxcbiAgICAgICAgICAgICdfSG9va3MnLFxuICAgICAgICAgICAgJ19HbG9iYWxDb25maWcnLFxuICAgICAgICAgICAgJ19HcmFwaFFMQ29uZmlnJyxcbiAgICAgICAgICAgICdfQXVkaWVuY2UnLFxuICAgICAgICAgICAgJ19JZGVtcG90ZW5jeScsXG4gICAgICAgICAgICAuLi5yZXN1bHRzLm1hcChyZXN1bHQgPT4gcmVzdWx0LmNsYXNzTmFtZSksXG4gICAgICAgICAgICAuLi5qb2lucyxcbiAgICAgICAgICBdO1xuICAgICAgICAgIGNvbnN0IHF1ZXJpZXMgPSBjbGFzc2VzLm1hcChjbGFzc05hbWUgPT4gKHtcbiAgICAgICAgICAgIHF1ZXJ5OiAnRFJPUCBUQUJMRSBJRiBFWElTVFMgJDxjbGFzc05hbWU6bmFtZT4nLFxuICAgICAgICAgICAgdmFsdWVzOiB7IGNsYXNzTmFtZSB9LFxuICAgICAgICAgIH0pKTtcbiAgICAgICAgICBhd2FpdCB0LnR4KHR4ID0+IHR4Lm5vbmUoaGVscGVycy5jb25jYXQocXVlcmllcykpKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBpZiAoZXJyb3IuY29kZSAhPT0gUG9zdGdyZXNSZWxhdGlvbkRvZXNOb3RFeGlzdEVycm9yKSB7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gTm8gX1NDSEVNQSBjb2xsZWN0aW9uLiBEb24ndCBkZWxldGUgYW55dGhpbmcuXG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGRlYnVnKGBkZWxldGVBbGxDbGFzc2VzIGRvbmUgaW4gJHtuZXcgRGF0ZSgpLmdldFRpbWUoKSAtIG5vd31gKTtcbiAgICAgIH0pO1xuICB9XG5cbiAgLy8gUmVtb3ZlIHRoZSBjb2x1bW4gYW5kIGFsbCB0aGUgZGF0YS4gRm9yIFJlbGF0aW9ucywgdGhlIF9Kb2luIGNvbGxlY3Rpb24gaXMgaGFuZGxlZFxuICAvLyBzcGVjaWFsbHksIHRoaXMgZnVuY3Rpb24gZG9lcyBub3QgZGVsZXRlIF9Kb2luIGNvbHVtbnMuIEl0IHNob3VsZCwgaG93ZXZlciwgaW5kaWNhdGVcbiAgLy8gdGhhdCB0aGUgcmVsYXRpb24gZmllbGRzIGRvZXMgbm90IGV4aXN0IGFueW1vcmUuIEluIG1vbmdvLCB0aGlzIG1lYW5zIHJlbW92aW5nIGl0IGZyb21cbiAgLy8gdGhlIF9TQ0hFTUEgY29sbGVjdGlvbi4gIFRoZXJlIHNob3VsZCBiZSBubyBhY3R1YWwgZGF0YSBpbiB0aGUgY29sbGVjdGlvbiB1bmRlciB0aGUgc2FtZSBuYW1lXG4gIC8vIGFzIHRoZSByZWxhdGlvbiBjb2x1bW4sIHNvIGl0J3MgZmluZSB0byBhdHRlbXB0IHRvIGRlbGV0ZSBpdC4gSWYgdGhlIGZpZWxkcyBsaXN0ZWQgdG8gYmVcbiAgLy8gZGVsZXRlZCBkbyBub3QgZXhpc3QsIHRoaXMgZnVuY3Rpb24gc2hvdWxkIHJldHVybiBzdWNjZXNzZnVsbHkgYW55d2F5cy4gQ2hlY2tpbmcgZm9yXG4gIC8vIGF0dGVtcHRzIHRvIGRlbGV0ZSBub24tZXhpc3RlbnQgZmllbGRzIGlzIHRoZSByZXNwb25zaWJpbGl0eSBvZiBQYXJzZSBTZXJ2ZXIuXG5cbiAgLy8gVGhpcyBmdW5jdGlvbiBpcyBub3Qgb2JsaWdhdGVkIHRvIGRlbGV0ZSBmaWVsZHMgYXRvbWljYWxseS4gSXQgaXMgZ2l2ZW4gdGhlIGZpZWxkXG4gIC8vIG5hbWVzIGluIGEgbGlzdCBzbyB0aGF0IGRhdGFiYXNlcyB0aGF0IGFyZSBjYXBhYmxlIG9mIGRlbGV0aW5nIGZpZWxkcyBhdG9taWNhbGx5XG4gIC8vIG1heSBkbyBzby5cblxuICAvLyBSZXR1cm5zIGEgUHJvbWlzZS5cbiAgYXN5bmMgZGVsZXRlRmllbGRzKGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUsIGZpZWxkTmFtZXM6IHN0cmluZ1tdKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgZGVidWcoJ2RlbGV0ZUZpZWxkcycpO1xuICAgIGZpZWxkTmFtZXMgPSBmaWVsZE5hbWVzLnJlZHVjZSgobGlzdDogQXJyYXk8c3RyaW5nPiwgZmllbGROYW1lOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkID0gc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdO1xuICAgICAgaWYgKGZpZWxkLnR5cGUgIT09ICdSZWxhdGlvbicpIHtcbiAgICAgICAgbGlzdC5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICB9XG4gICAgICBkZWxldGUgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdO1xuICAgICAgcmV0dXJuIGxpc3Q7XG4gICAgfSwgW10pO1xuXG4gICAgY29uc3QgdmFsdWVzID0gW2NsYXNzTmFtZSwgLi4uZmllbGROYW1lc107XG4gICAgY29uc3QgY29sdW1ucyA9IGZpZWxkTmFtZXNcbiAgICAgIC5tYXAoKG5hbWUsIGlkeCkgPT4ge1xuICAgICAgICByZXR1cm4gYCQke2lkeCArIDJ9Om5hbWVgO1xuICAgICAgfSlcbiAgICAgIC5qb2luKCcsIERST1AgQ09MVU1OJyk7XG5cbiAgICBhd2FpdCB0aGlzLl9jbGllbnQudHgoJ2RlbGV0ZS1maWVsZHMnLCBhc3luYyB0ID0+IHtcbiAgICAgIGF3YWl0IHQubm9uZSgnVVBEQVRFIFwiX1NDSEVNQVwiIFNFVCBcInNjaGVtYVwiID0gJDxzY2hlbWE+IFdIRVJFIFwiY2xhc3NOYW1lXCIgPSAkPGNsYXNzTmFtZT4nLCB7XG4gICAgICAgIHNjaGVtYSxcbiAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgfSk7XG4gICAgICBpZiAodmFsdWVzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgYXdhaXQgdC5ub25lKGBBTFRFUiBUQUJMRSAkMTpuYW1lIERST1AgQ09MVU1OIElGIEVYSVNUUyAke2NvbHVtbnN9YCwgdmFsdWVzKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB0aGlzLl9ub3RpZnlTY2hlbWFDaGFuZ2UoKTtcbiAgfVxuXG4gIC8vIFJldHVybiBhIHByb21pc2UgZm9yIGFsbCBzY2hlbWFzIGtub3duIHRvIHRoaXMgYWRhcHRlciwgaW4gUGFyc2UgZm9ybWF0LiBJbiBjYXNlIHRoZVxuICAvLyBzY2hlbWFzIGNhbm5vdCBiZSByZXRyaWV2ZWQsIHJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVqZWN0cy4gUmVxdWlyZW1lbnRzIGZvciB0aGVcbiAgLy8gcmVqZWN0aW9uIHJlYXNvbiBhcmUgVEJELlxuICBhc3luYyBnZXRBbGxDbGFzc2VzKCkge1xuICAgIHJldHVybiB0aGlzLl9jbGllbnQudGFzaygnZ2V0LWFsbC1jbGFzc2VzJywgYXN5bmMgdCA9PiB7XG4gICAgICByZXR1cm4gYXdhaXQgdC5tYXAoJ1NFTEVDVCAqIEZST00gXCJfU0NIRU1BXCInLCBudWxsLCByb3cgPT5cbiAgICAgICAgdG9QYXJzZVNjaGVtYSh7IGNsYXNzTmFtZTogcm93LmNsYXNzTmFtZSwgLi4ucm93LnNjaGVtYSB9KVxuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFJldHVybiBhIHByb21pc2UgZm9yIHRoZSBzY2hlbWEgd2l0aCB0aGUgZ2l2ZW4gbmFtZSwgaW4gUGFyc2UgZm9ybWF0LiBJZlxuICAvLyB0aGlzIGFkYXB0ZXIgZG9lc24ndCBrbm93IGFib3V0IHRoZSBzY2hlbWEsIHJldHVybiBhIHByb21pc2UgdGhhdCByZWplY3RzIHdpdGhcbiAgLy8gdW5kZWZpbmVkIGFzIHRoZSByZWFzb24uXG4gIGFzeW5jIGdldENsYXNzKGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgZGVidWcoJ2dldENsYXNzJyk7XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudFxuICAgICAgLmFueSgnU0VMRUNUICogRlJPTSBcIl9TQ0hFTUFcIiBXSEVSRSBcImNsYXNzTmFtZVwiID0gJDxjbGFzc05hbWU+Jywge1xuICAgICAgICBjbGFzc05hbWUsXG4gICAgICB9KVxuICAgICAgLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgICAgaWYgKHJlc3VsdC5sZW5ndGggIT09IDEpIHtcbiAgICAgICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc3VsdFswXS5zY2hlbWE7XG4gICAgICB9KVxuICAgICAgLnRoZW4odG9QYXJzZVNjaGVtYSk7XG4gIH1cblxuICAvLyBUT0RPOiByZW1vdmUgdGhlIG1vbmdvIGZvcm1hdCBkZXBlbmRlbmN5IGluIHRoZSByZXR1cm4gdmFsdWVcbiAgYXN5bmMgY3JlYXRlT2JqZWN0KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBvYmplY3Q6IGFueSxcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbjogP2FueVxuICApIHtcbiAgICBkZWJ1ZygnY3JlYXRlT2JqZWN0Jyk7XG4gICAgbGV0IGNvbHVtbnNBcnJheSA9IFtdO1xuICAgIGNvbnN0IHZhbHVlc0FycmF5ID0gW107XG4gICAgc2NoZW1hID0gdG9Qb3N0Z3Jlc1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IGdlb1BvaW50cyA9IHt9O1xuXG4gICAgb2JqZWN0ID0gaGFuZGxlRG90RmllbGRzKG9iamVjdCk7XG5cbiAgICB2YWxpZGF0ZUtleXMob2JqZWN0KTtcblxuICAgIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgaWYgKG9iamVjdFtmaWVsZE5hbWVdID09PSBudWxsKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHZhciBhdXRoRGF0YU1hdGNoID0gZmllbGROYW1lLm1hdGNoKC9eX2F1dGhfZGF0YV8oW2EtekEtWjAtOV9dKykkLyk7XG4gICAgICBjb25zdCBhdXRoRGF0YUFscmVhZHlFeGlzdHMgPSAhIW9iamVjdC5hdXRoRGF0YTtcbiAgICAgIGlmIChhdXRoRGF0YU1hdGNoKSB7XG4gICAgICAgIHZhciBwcm92aWRlciA9IGF1dGhEYXRhTWF0Y2hbMV07XG4gICAgICAgIG9iamVjdFsnYXV0aERhdGEnXSA9IG9iamVjdFsnYXV0aERhdGEnXSB8fCB7fTtcbiAgICAgICAgb2JqZWN0WydhdXRoRGF0YSddW3Byb3ZpZGVyXSA9IG9iamVjdFtmaWVsZE5hbWVdO1xuICAgICAgICBkZWxldGUgb2JqZWN0W2ZpZWxkTmFtZV07XG4gICAgICAgIGZpZWxkTmFtZSA9ICdhdXRoRGF0YSc7XG4gICAgICAgIC8vIEF2b2lkIGFkZGluZyBhdXRoRGF0YSBtdWx0aXBsZSB0aW1lcyB0byB0aGUgcXVlcnlcbiAgICAgICAgaWYgKGF1dGhEYXRhQWxyZWFkeUV4aXN0cykge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb2x1bW5zQXJyYXkucHVzaChmaWVsZE5hbWUpO1xuICAgICAgaWYgKCFzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiYgY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBmaWVsZE5hbWUgPT09ICdfZW1haWxfdmVyaWZ5X3Rva2VuJyB8fFxuICAgICAgICAgIGZpZWxkTmFtZSA9PT0gJ19mYWlsZWRfbG9naW5fY291bnQnIHx8XG4gICAgICAgICAgZmllbGROYW1lID09PSAnX3BlcmlzaGFibGVfdG9rZW4nIHx8XG4gICAgICAgICAgZmllbGROYW1lID09PSAnX3Bhc3N3b3JkX2hpc3RvcnknXG4gICAgICAgICkge1xuICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0pO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGZpZWxkTmFtZSA9PT0gJ19lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdCcpIHtcbiAgICAgICAgICBpZiAob2JqZWN0W2ZpZWxkTmFtZV0pIHtcbiAgICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0uaXNvKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChudWxsKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXG4gICAgICAgICAgZmllbGROYW1lID09PSAnX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0JyB8fFxuICAgICAgICAgIGZpZWxkTmFtZSA9PT0gJ19wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQnIHx8XG4gICAgICAgICAgZmllbGROYW1lID09PSAnX3Bhc3N3b3JkX2NoYW5nZWRfYXQnXG4gICAgICAgICkge1xuICAgICAgICAgIGlmIChvYmplY3RbZmllbGROYW1lXSkge1xuICAgICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChvYmplY3RbZmllbGROYW1lXS5pc28pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKG51bGwpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBzd2l0Y2ggKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlKSB7XG4gICAgICAgIGNhc2UgJ0RhdGUnOlxuICAgICAgICAgIGlmIChvYmplY3RbZmllbGROYW1lXSkge1xuICAgICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChvYmplY3RbZmllbGROYW1lXS5pc28pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKG51bGwpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnUG9pbnRlcic6XG4gICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChvYmplY3RbZmllbGROYW1lXS5vYmplY3RJZCk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ0FycmF5JzpcbiAgICAgICAgICBpZiAoWydfcnBlcm0nLCAnX3dwZXJtJ10uaW5kZXhPZihmaWVsZE5hbWUpID49IDApIHtcbiAgICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKEpTT04uc3RyaW5naWZ5KG9iamVjdFtmaWVsZE5hbWVdKSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdPYmplY3QnOlxuICAgICAgICBjYXNlICdCeXRlcyc6XG4gICAgICAgIGNhc2UgJ1N0cmluZyc6XG4gICAgICAgIGNhc2UgJ051bWJlcic6XG4gICAgICAgIGNhc2UgJ0Jvb2xlYW4nOlxuICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0pO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdGaWxlJzpcbiAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKG9iamVjdFtmaWVsZE5hbWVdLm5hbWUpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdQb2x5Z29uJzoge1xuICAgICAgICAgIGNvbnN0IHZhbHVlID0gY29udmVydFBvbHlnb25Ub1NRTChvYmplY3RbZmllbGROYW1lXS5jb29yZGluYXRlcyk7XG4gICAgICAgICAgdmFsdWVzQXJyYXkucHVzaCh2YWx1ZSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgY2FzZSAnR2VvUG9pbnQnOlxuICAgICAgICAgIC8vIHBvcCB0aGUgcG9pbnQgYW5kIHByb2Nlc3MgbGF0ZXJcbiAgICAgICAgICBnZW9Qb2ludHNbZmllbGROYW1lXSA9IG9iamVjdFtmaWVsZE5hbWVdO1xuICAgICAgICAgIGNvbHVtbnNBcnJheS5wb3AoKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aHJvdyBgVHlwZSAke3NjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlfSBub3Qgc3VwcG9ydGVkIHlldGA7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBjb2x1bW5zQXJyYXkgPSBjb2x1bW5zQXJyYXkuY29uY2F0KE9iamVjdC5rZXlzKGdlb1BvaW50cykpO1xuICAgIGNvbnN0IGluaXRpYWxWYWx1ZXMgPSB2YWx1ZXNBcnJheS5tYXAoKHZhbCwgaW5kZXgpID0+IHtcbiAgICAgIGxldCB0ZXJtaW5hdGlvbiA9ICcnO1xuICAgICAgY29uc3QgZmllbGROYW1lID0gY29sdW1uc0FycmF5W2luZGV4XTtcbiAgICAgIGlmIChbJ19ycGVybScsICdfd3Blcm0nXS5pbmRleE9mKGZpZWxkTmFtZSkgPj0gMCkge1xuICAgICAgICB0ZXJtaW5hdGlvbiA9ICc6OnRleHRbXSc7XG4gICAgICB9IGVsc2UgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ0FycmF5Jykge1xuICAgICAgICB0ZXJtaW5hdGlvbiA9ICc6Ompzb25iJztcbiAgICAgIH1cbiAgICAgIHJldHVybiBgJCR7aW5kZXggKyAyICsgY29sdW1uc0FycmF5Lmxlbmd0aH0ke3Rlcm1pbmF0aW9ufWA7XG4gICAgfSk7XG4gICAgY29uc3QgZ2VvUG9pbnRzSW5qZWN0cyA9IE9iamVjdC5rZXlzKGdlb1BvaW50cykubWFwKGtleSA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGdlb1BvaW50c1trZXldO1xuICAgICAgdmFsdWVzQXJyYXkucHVzaCh2YWx1ZS5sb25naXR1ZGUsIHZhbHVlLmxhdGl0dWRlKTtcbiAgICAgIGNvbnN0IGwgPSB2YWx1ZXNBcnJheS5sZW5ndGggKyBjb2x1bW5zQXJyYXkubGVuZ3RoO1xuICAgICAgcmV0dXJuIGBQT0lOVCgkJHtsfSwgJCR7bCArIDF9KWA7XG4gICAgfSk7XG5cbiAgICBjb25zdCBjb2x1bW5zUGF0dGVybiA9IGNvbHVtbnNBcnJheS5tYXAoKGNvbCwgaW5kZXgpID0+IGAkJHtpbmRleCArIDJ9Om5hbWVgKS5qb2luKCk7XG4gICAgY29uc3QgdmFsdWVzUGF0dGVybiA9IGluaXRpYWxWYWx1ZXMuY29uY2F0KGdlb1BvaW50c0luamVjdHMpLmpvaW4oKTtcblxuICAgIGNvbnN0IHFzID0gYElOU0VSVCBJTlRPICQxOm5hbWUgKCR7Y29sdW1uc1BhdHRlcm59KSBWQUxVRVMgKCR7dmFsdWVzUGF0dGVybn0pYDtcbiAgICBjb25zdCB2YWx1ZXMgPSBbY2xhc3NOYW1lLCAuLi5jb2x1bW5zQXJyYXksIC4uLnZhbHVlc0FycmF5XTtcbiAgICBjb25zdCBwcm9taXNlID0gKHRyYW5zYWN0aW9uYWxTZXNzaW9uID8gdHJhbnNhY3Rpb25hbFNlc3Npb24udCA6IHRoaXMuX2NsaWVudClcbiAgICAgIC5ub25lKHFzLCB2YWx1ZXMpXG4gICAgICAudGhlbigoKSA9PiAoeyBvcHM6IFtvYmplY3RdIH0pKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IFBvc3RncmVzVW5pcXVlSW5kZXhWaW9sYXRpb25FcnJvcikge1xuICAgICAgICAgIGNvbnN0IGVyciA9IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICk7XG4gICAgICAgICAgZXJyLnVuZGVybHlpbmdFcnJvciA9IGVycm9yO1xuICAgICAgICAgIGlmIChlcnJvci5jb25zdHJhaW50KSB7XG4gICAgICAgICAgICBjb25zdCBtYXRjaGVzID0gZXJyb3IuY29uc3RyYWludC5tYXRjaCgvdW5pcXVlXyhbYS16QS1aXSspLyk7XG4gICAgICAgICAgICBpZiAobWF0Y2hlcyAmJiBBcnJheS5pc0FycmF5KG1hdGNoZXMpKSB7XG4gICAgICAgICAgICAgIGVyci51c2VySW5mbyA9IHsgZHVwbGljYXRlZF9maWVsZDogbWF0Y2hlc1sxXSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBlcnJvciA9IGVycjtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuICAgIGlmICh0cmFuc2FjdGlvbmFsU2Vzc2lvbikge1xuICAgICAgdHJhbnNhY3Rpb25hbFNlc3Npb24uYmF0Y2gucHVzaChwcm9taXNlKTtcbiAgICB9XG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cblxuICAvLyBSZW1vdmUgYWxsIG9iamVjdHMgdGhhdCBtYXRjaCB0aGUgZ2l2ZW4gUGFyc2UgUXVlcnkuXG4gIC8vIElmIG5vIG9iamVjdHMgbWF0Y2gsIHJlamVjdCB3aXRoIE9CSkVDVF9OT1RfRk9VTkQuIElmIG9iamVjdHMgYXJlIGZvdW5kIGFuZCBkZWxldGVkLCByZXNvbHZlIHdpdGggdW5kZWZpbmVkLlxuICAvLyBJZiB0aGVyZSBpcyBzb21lIG90aGVyIGVycm9yLCByZWplY3Qgd2l0aCBJTlRFUk5BTF9TRVJWRVJfRVJST1IuXG4gIGFzeW5jIGRlbGV0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICkge1xuICAgIGRlYnVnKCdkZWxldGVPYmplY3RzQnlRdWVyeScpO1xuICAgIGNvbnN0IHZhbHVlcyA9IFtjbGFzc05hbWVdO1xuICAgIGNvbnN0IGluZGV4ID0gMjtcbiAgICBjb25zdCB3aGVyZSA9IGJ1aWxkV2hlcmVDbGF1c2Uoe1xuICAgICAgc2NoZW1hLFxuICAgICAgaW5kZXgsXG4gICAgICBxdWVyeSxcbiAgICAgIGNhc2VJbnNlbnNpdGl2ZTogZmFsc2UsXG4gICAgfSk7XG4gICAgdmFsdWVzLnB1c2goLi4ud2hlcmUudmFsdWVzKTtcbiAgICBpZiAoT2JqZWN0LmtleXMocXVlcnkpLmxlbmd0aCA9PT0gMCkge1xuICAgICAgd2hlcmUucGF0dGVybiA9ICdUUlVFJztcbiAgICB9XG4gICAgY29uc3QgcXMgPSBgV0lUSCBkZWxldGVkIEFTIChERUxFVEUgRlJPTSAkMTpuYW1lIFdIRVJFICR7d2hlcmUucGF0dGVybn0gUkVUVVJOSU5HICopIFNFTEVDVCBjb3VudCgqKSBGUk9NIGRlbGV0ZWRgO1xuICAgIGNvbnN0IHByb21pc2UgPSAodHJhbnNhY3Rpb25hbFNlc3Npb24gPyB0cmFuc2FjdGlvbmFsU2Vzc2lvbi50IDogdGhpcy5fY2xpZW50KVxuICAgICAgLm9uZShxcywgdmFsdWVzLCBhID0+ICthLmNvdW50KVxuICAgICAgLnRoZW4oY291bnQgPT4ge1xuICAgICAgICBpZiAoY291bnQgPT09IDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ09iamVjdCBub3QgZm91bmQuJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmV0dXJuIGNvdW50O1xuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgIT09IFBvc3RncmVzUmVsYXRpb25Eb2VzTm90RXhpc3RFcnJvcikge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICAgIC8vIEVMU0U6IERvbid0IGRlbGV0ZSBhbnl0aGluZyBpZiBkb2Vzbid0IGV4aXN0XG4gICAgICB9KTtcbiAgICBpZiAodHJhbnNhY3Rpb25hbFNlc3Npb24pIHtcbiAgICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uLmJhdGNoLnB1c2gocHJvbWlzZSk7XG4gICAgfVxuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIC8vIFJldHVybiB2YWx1ZSBub3QgY3VycmVudGx5IHdlbGwgc3BlY2lmaWVkLlxuICBhc3luYyBmaW5kT25lQW5kVXBkYXRlKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHVwZGF0ZTogYW55LFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgZGVidWcoJ2ZpbmRPbmVBbmRVcGRhdGUnKTtcbiAgICByZXR1cm4gdGhpcy51cGRhdGVPYmplY3RzQnlRdWVyeShjbGFzc05hbWUsIHNjaGVtYSwgcXVlcnksIHVwZGF0ZSwgdHJhbnNhY3Rpb25hbFNlc3Npb24pLnRoZW4oXG4gICAgICB2YWwgPT4gdmFsWzBdXG4gICAgKTtcbiAgfVxuXG4gIC8vIEFwcGx5IHRoZSB1cGRhdGUgdG8gYWxsIG9iamVjdHMgdGhhdCBtYXRjaCB0aGUgZ2l2ZW4gUGFyc2UgUXVlcnkuXG4gIGFzeW5jIHVwZGF0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHVwZGF0ZTogYW55LFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICk6IFByb21pc2U8W2FueV0+IHtcbiAgICBkZWJ1ZygndXBkYXRlT2JqZWN0c0J5UXVlcnknKTtcbiAgICBjb25zdCB1cGRhdGVQYXR0ZXJucyA9IFtdO1xuICAgIGNvbnN0IHZhbHVlcyA9IFtjbGFzc05hbWVdO1xuICAgIGxldCBpbmRleCA9IDI7XG4gICAgc2NoZW1hID0gdG9Qb3N0Z3Jlc1NjaGVtYShzY2hlbWEpO1xuXG4gICAgY29uc3Qgb3JpZ2luYWxVcGRhdGUgPSB7IC4uLnVwZGF0ZSB9O1xuXG4gICAgLy8gU2V0IGZsYWcgZm9yIGRvdCBub3RhdGlvbiBmaWVsZHNcbiAgICBjb25zdCBkb3ROb3RhdGlvbk9wdGlvbnMgPSB7fTtcbiAgICBPYmplY3Qua2V5cyh1cGRhdGUpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID4gLTEpIHtcbiAgICAgICAgY29uc3QgY29tcG9uZW50cyA9IGZpZWxkTmFtZS5zcGxpdCgnLicpO1xuICAgICAgICBjb25zdCBmaXJzdCA9IGNvbXBvbmVudHMuc2hpZnQoKTtcbiAgICAgICAgZG90Tm90YXRpb25PcHRpb25zW2ZpcnN0XSA9IHRydWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBkb3ROb3RhdGlvbk9wdGlvbnNbZmllbGROYW1lXSA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHVwZGF0ZSA9IGhhbmRsZURvdEZpZWxkcyh1cGRhdGUpO1xuICAgIC8vIFJlc29sdmUgYXV0aERhdGEgZmlyc3QsXG4gICAgLy8gU28gd2UgZG9uJ3QgZW5kIHVwIHdpdGggbXVsdGlwbGUga2V5IHVwZGF0ZXNcbiAgICBmb3IgKGNvbnN0IGZpZWxkTmFtZSBpbiB1cGRhdGUpIHtcbiAgICAgIGNvbnN0IGF1dGhEYXRhTWF0Y2ggPSBmaWVsZE5hbWUubWF0Y2goL15fYXV0aF9kYXRhXyhbYS16QS1aMC05X10rKSQvKTtcbiAgICAgIGlmIChhdXRoRGF0YU1hdGNoKSB7XG4gICAgICAgIHZhciBwcm92aWRlciA9IGF1dGhEYXRhTWF0Y2hbMV07XG4gICAgICAgIGNvbnN0IHZhbHVlID0gdXBkYXRlW2ZpZWxkTmFtZV07XG4gICAgICAgIGRlbGV0ZSB1cGRhdGVbZmllbGROYW1lXTtcbiAgICAgICAgdXBkYXRlWydhdXRoRGF0YSddID0gdXBkYXRlWydhdXRoRGF0YSddIHx8IHt9O1xuICAgICAgICB1cGRhdGVbJ2F1dGhEYXRhJ11bcHJvdmlkZXJdID0gdmFsdWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBmaWVsZE5hbWUgaW4gdXBkYXRlKSB7XG4gICAgICBjb25zdCBmaWVsZFZhbHVlID0gdXBkYXRlW2ZpZWxkTmFtZV07XG4gICAgICAvLyBEcm9wIGFueSB1bmRlZmluZWQgdmFsdWVzLlxuICAgICAgaWYgKHR5cGVvZiBmaWVsZFZhbHVlID09PSAndW5kZWZpbmVkJykge1xuICAgICAgICBkZWxldGUgdXBkYXRlW2ZpZWxkTmFtZV07XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUgPT09IG51bGwpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSBOVUxMYCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgIGluZGV4ICs9IDE7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkTmFtZSA9PSAnYXV0aERhdGEnKSB7XG4gICAgICAgIC8vIFRoaXMgcmVjdXJzaXZlbHkgc2V0cyB0aGUganNvbl9vYmplY3RcbiAgICAgICAgLy8gT25seSAxIGxldmVsIGRlZXBcbiAgICAgICAgY29uc3QgZ2VuZXJhdGUgPSAoanNvbmI6IHN0cmluZywga2V5OiBzdHJpbmcsIHZhbHVlOiBhbnkpID0+IHtcbiAgICAgICAgICByZXR1cm4gYGpzb25fb2JqZWN0X3NldF9rZXkoQ09BTEVTQ0UoJHtqc29uYn0sICd7fSc6Ompzb25iKSwgJHtrZXl9LCAke3ZhbHVlfSk6Ompzb25iYDtcbiAgICAgICAgfTtcbiAgICAgICAgY29uc3QgbGFzdEtleSA9IGAkJHtpbmRleH06bmFtZWA7XG4gICAgICAgIGNvbnN0IGZpZWxkTmFtZUluZGV4ID0gaW5kZXg7XG4gICAgICAgIGluZGV4ICs9IDE7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgIGNvbnN0IHVwZGF0ZSA9IE9iamVjdC5rZXlzKGZpZWxkVmFsdWUpLnJlZHVjZSgobGFzdEtleTogc3RyaW5nLCBrZXk6IHN0cmluZykgPT4ge1xuICAgICAgICAgIGNvbnN0IHN0ciA9IGdlbmVyYXRlKGxhc3RLZXksIGAkJHtpbmRleH06OnRleHRgLCBgJCR7aW5kZXggKyAxfTo6anNvbmJgKTtcbiAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICAgIGxldCB2YWx1ZSA9IGZpZWxkVmFsdWVba2V5XTtcbiAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5fX29wID09PSAnRGVsZXRlJykge1xuICAgICAgICAgICAgICB2YWx1ZSA9IG51bGw7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB2YWx1ZSA9IEpTT04uc3RyaW5naWZ5KHZhbHVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgdmFsdWVzLnB1c2goa2V5LCB2YWx1ZSk7XG4gICAgICAgICAgcmV0dXJuIHN0cjtcbiAgICAgICAgfSwgbGFzdEtleSk7XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goYCQke2ZpZWxkTmFtZUluZGV4fTpuYW1lID0gJHt1cGRhdGV9YCk7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUuX19vcCA9PT0gJ0luY3JlbWVudCcpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSBDT0FMRVNDRSgkJHtpbmRleH06bmFtZSwgMCkgKyAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZS5hbW91bnQpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fb3AgPT09ICdBZGQnKSB7XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goXG4gICAgICAgICAgYCQke2luZGV4fTpuYW1lID0gYXJyYXlfYWRkKENPQUxFU0NFKCQke2luZGV4fTpuYW1lLCAnW10nOjpqc29uYiksICQke2luZGV4ICsgMX06Ompzb25iKWBcbiAgICAgICAgKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBKU09OLnN0cmluZ2lmeShmaWVsZFZhbHVlLm9iamVjdHMpKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX29wID09PSAnRGVsZXRlJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBudWxsKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX29wID09PSAnUmVtb3ZlJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKFxuICAgICAgICAgIGAkJHtpbmRleH06bmFtZSA9IGFycmF5X3JlbW92ZShDT0FMRVNDRSgkJHtpbmRleH06bmFtZSwgJ1tdJzo6anNvbmIpLCAkJHtpbmRleCArIDFcbiAgICAgICAgICB9Ojpqc29uYilgXG4gICAgICAgICk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgSlNPTi5zdHJpbmdpZnkoZmllbGRWYWx1ZS5vYmplY3RzKSk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUuX19vcCA9PT0gJ0FkZFVuaXF1ZScpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChcbiAgICAgICAgICBgJCR7aW5kZXh9Om5hbWUgPSBhcnJheV9hZGRfdW5pcXVlKENPQUxFU0NFKCQke2luZGV4fTpuYW1lLCAnW10nOjpqc29uYiksICQke2luZGV4ICsgMVxuICAgICAgICAgIH06Ompzb25iKWBcbiAgICAgICAgKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBKU09OLnN0cmluZ2lmeShmaWVsZFZhbHVlLm9iamVjdHMpKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGROYW1lID09PSAndXBkYXRlZEF0Jykge1xuICAgICAgICAvL1RPRE86IHN0b3Agc3BlY2lhbCBjYXNpbmcgdGhpcy4gSXQgc2hvdWxkIGNoZWNrIGZvciBfX3R5cGUgPT09ICdEYXRlJyBhbmQgdXNlIC5pc29cbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWVsZFZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUgPT09ICdib29sZWFuJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlLm9iamVjdElkKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdEYXRlJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCB0b1Bvc3RncmVzVmFsdWUoZmllbGRWYWx1ZSkpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlIGluc3RhbmNlb2YgRGF0ZSkge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdGaWxlJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCB0b1Bvc3RncmVzVmFsdWUoZmllbGRWYWx1ZSkpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fdHlwZSA9PT0gJ0dlb1BvaW50Jykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9IFBPSU5UKCQke2luZGV4ICsgMX0sICQke2luZGV4ICsgMn0pYCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZS5sb25naXR1ZGUsIGZpZWxkVmFsdWUubGF0aXR1ZGUpO1xuICAgICAgICBpbmRleCArPSAzO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fdHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gY29udmVydFBvbHlnb25Ub1NRTChmaWVsZFZhbHVlLmNvb3JkaW5hdGVzKTtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9Ojpwb2x5Z29uYCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgdmFsdWUpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fdHlwZSA9PT0gJ1JlbGF0aW9uJykge1xuICAgICAgICAvLyBub29wXG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWVsZFZhbHVlID09PSAnbnVtYmVyJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgIHR5cGVvZiBmaWVsZFZhbHVlID09PSAnb2JqZWN0JyAmJlxuICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiZcbiAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdPYmplY3QnXG4gICAgICApIHtcbiAgICAgICAgLy8gR2F0aGVyIGtleXMgdG8gaW5jcmVtZW50XG4gICAgICAgIGNvbnN0IGtleXNUb0luY3JlbWVudCA9IE9iamVjdC5rZXlzKG9yaWdpbmFsVXBkYXRlKVxuICAgICAgICAgIC5maWx0ZXIoayA9PiB7XG4gICAgICAgICAgICAvLyBjaG9vc2UgdG9wIGxldmVsIGZpZWxkcyB0aGF0IGhhdmUgYSBkZWxldGUgb3BlcmF0aW9uIHNldFxuICAgICAgICAgICAgLy8gTm90ZSB0aGF0IE9iamVjdC5rZXlzIGlzIGl0ZXJhdGluZyBvdmVyIHRoZSAqKm9yaWdpbmFsKiogdXBkYXRlIG9iamVjdFxuICAgICAgICAgICAgLy8gYW5kIHRoYXQgc29tZSBvZiB0aGUga2V5cyBvZiB0aGUgb3JpZ2luYWwgdXBkYXRlIGNvdWxkIGJlIG51bGwgb3IgdW5kZWZpbmVkOlxuICAgICAgICAgICAgLy8gKFNlZSB0aGUgYWJvdmUgY2hlY2sgYGlmIChmaWVsZFZhbHVlID09PSBudWxsIHx8IHR5cGVvZiBmaWVsZFZhbHVlID09IFwidW5kZWZpbmVkXCIpYClcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gb3JpZ2luYWxVcGRhdGVba107XG4gICAgICAgICAgICByZXR1cm4gKFxuICAgICAgICAgICAgICB2YWx1ZSAmJlxuICAgICAgICAgICAgICB2YWx1ZS5fX29wID09PSAnSW5jcmVtZW50JyAmJlxuICAgICAgICAgICAgICBrLnNwbGl0KCcuJykubGVuZ3RoID09PSAyICYmXG4gICAgICAgICAgICAgIGsuc3BsaXQoJy4nKVswXSA9PT0gZmllbGROYW1lXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLm1hcChrID0+IGsuc3BsaXQoJy4nKVsxXSk7XG5cbiAgICAgICAgbGV0IGluY3JlbWVudFBhdHRlcm5zID0gJyc7XG4gICAgICAgIGlmIChrZXlzVG9JbmNyZW1lbnQubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGluY3JlbWVudFBhdHRlcm5zID1cbiAgICAgICAgICAgICcgfHwgJyArXG4gICAgICAgICAgICBrZXlzVG9JbmNyZW1lbnRcbiAgICAgICAgICAgICAgLm1hcChjID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBhbW91bnQgPSBmaWVsZFZhbHVlW2NdLmFtb3VudDtcbiAgICAgICAgICAgICAgICByZXR1cm4gYENPTkNBVCgne1wiJHtjfVwiOicsIENPQUxFU0NFKCQke2luZGV4fTpuYW1lLT4+JyR7Y30nLCcwJyk6OmludCArICR7YW1vdW50fSwgJ30nKTo6anNvbmJgO1xuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAuam9pbignIHx8ICcpO1xuICAgICAgICAgIC8vIFN0cmlwIHRoZSBrZXlzXG4gICAgICAgICAga2V5c1RvSW5jcmVtZW50LmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICAgIGRlbGV0ZSBmaWVsZFZhbHVlW2tleV07XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBrZXlzVG9EZWxldGU6IEFycmF5PHN0cmluZz4gPSBPYmplY3Qua2V5cyhvcmlnaW5hbFVwZGF0ZSlcbiAgICAgICAgICAuZmlsdGVyKGsgPT4ge1xuICAgICAgICAgICAgLy8gY2hvb3NlIHRvcCBsZXZlbCBmaWVsZHMgdGhhdCBoYXZlIGEgZGVsZXRlIG9wZXJhdGlvbiBzZXQuXG4gICAgICAgICAgICBjb25zdCB2YWx1ZSA9IG9yaWdpbmFsVXBkYXRlW2tdO1xuICAgICAgICAgICAgcmV0dXJuIChcbiAgICAgICAgICAgICAgdmFsdWUgJiZcbiAgICAgICAgICAgICAgdmFsdWUuX19vcCA9PT0gJ0RlbGV0ZScgJiZcbiAgICAgICAgICAgICAgay5zcGxpdCgnLicpLmxlbmd0aCA9PT0gMiAmJlxuICAgICAgICAgICAgICBrLnNwbGl0KCcuJylbMF0gPT09IGZpZWxkTmFtZVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5tYXAoayA9PiBrLnNwbGl0KCcuJylbMV0pO1xuXG4gICAgICAgIGNvbnN0IGRlbGV0ZVBhdHRlcm5zID0ga2V5c1RvRGVsZXRlLnJlZHVjZSgocDogc3RyaW5nLCBjOiBzdHJpbmcsIGk6IG51bWJlcikgPT4ge1xuICAgICAgICAgIHJldHVybiBwICsgYCAtICckJHtpbmRleCArIDEgKyBpfTp2YWx1ZSdgO1xuICAgICAgICB9LCAnJyk7XG4gICAgICAgIC8vIE92ZXJyaWRlIE9iamVjdFxuICAgICAgICBsZXQgdXBkYXRlT2JqZWN0ID0gXCIne30nOjpqc29uYlwiO1xuXG4gICAgICAgIGlmIChkb3ROb3RhdGlvbk9wdGlvbnNbZmllbGROYW1lXSkge1xuICAgICAgICAgIC8vIE1lcmdlIE9iamVjdFxuICAgICAgICAgIHVwZGF0ZU9iamVjdCA9IGBDT0FMRVNDRSgkJHtpbmRleH06bmFtZSwgJ3t9Jzo6anNvbmIpYDtcbiAgICAgICAgfVxuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKFxuICAgICAgICAgIGAkJHtpbmRleH06bmFtZSA9ICgke3VwZGF0ZU9iamVjdH0gJHtkZWxldGVQYXR0ZXJuc30gJHtpbmNyZW1lbnRQYXR0ZXJuc30gfHwgJCR7aW5kZXggKyAxICsga2V5c1RvRGVsZXRlLmxlbmd0aFxuICAgICAgICAgIH06Ompzb25iIClgXG4gICAgICAgICk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgLi4ua2V5c1RvRGVsZXRlLCBKU09OLnN0cmluZ2lmeShmaWVsZFZhbHVlKSk7XG4gICAgICAgIGluZGV4ICs9IDIgKyBrZXlzVG9EZWxldGUubGVuZ3RoO1xuICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgQXJyYXkuaXNBcnJheShmaWVsZFZhbHVlKSAmJlxuICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiZcbiAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdBcnJheSdcbiAgICAgICkge1xuICAgICAgICBjb25zdCBleHBlY3RlZFR5cGUgPSBwYXJzZVR5cGVUb1Bvc3RncmVzVHlwZShzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0pO1xuICAgICAgICBpZiAoZXhwZWN0ZWRUeXBlID09PSAndGV4dFtdJykge1xuICAgICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfTo6dGV4dFtdYCk7XG4gICAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfTo6anNvbmJgKTtcbiAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIEpTT04uc3RyaW5naWZ5KGZpZWxkVmFsdWUpKTtcbiAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBkZWJ1ZygnTm90IHN1cHBvcnRlZCB1cGRhdGUnLCB7IGZpZWxkTmFtZSwgZmllbGRWYWx1ZSB9KTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgICAgICBgUG9zdGdyZXMgZG9lc24ndCBzdXBwb3J0IHVwZGF0ZSAke0pTT04uc3RyaW5naWZ5KGZpZWxkVmFsdWUpfSB5ZXRgXG4gICAgICAgICAgKVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHdoZXJlID0gYnVpbGRXaGVyZUNsYXVzZSh7XG4gICAgICBzY2hlbWEsXG4gICAgICBpbmRleCxcbiAgICAgIHF1ZXJ5LFxuICAgICAgY2FzZUluc2Vuc2l0aXZlOiBmYWxzZSxcbiAgICB9KTtcbiAgICB2YWx1ZXMucHVzaCguLi53aGVyZS52YWx1ZXMpO1xuXG4gICAgY29uc3Qgd2hlcmVDbGF1c2UgPSB3aGVyZS5wYXR0ZXJuLmxlbmd0aCA+IDAgPyBgV0hFUkUgJHt3aGVyZS5wYXR0ZXJufWAgOiAnJztcbiAgICBjb25zdCBxcyA9IGBVUERBVEUgJDE6bmFtZSBTRVQgJHt1cGRhdGVQYXR0ZXJucy5qb2luKCl9ICR7d2hlcmVDbGF1c2V9IFJFVFVSTklORyAqYDtcbiAgICBjb25zdCBwcm9taXNlID0gKHRyYW5zYWN0aW9uYWxTZXNzaW9uID8gdHJhbnNhY3Rpb25hbFNlc3Npb24udCA6IHRoaXMuX2NsaWVudCkuYW55KHFzLCB2YWx1ZXMpO1xuICAgIGlmICh0cmFuc2FjdGlvbmFsU2Vzc2lvbikge1xuICAgICAgdHJhbnNhY3Rpb25hbFNlc3Npb24uYmF0Y2gucHVzaChwcm9taXNlKTtcbiAgICB9XG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cblxuICAvLyBIb3BlZnVsbHksIHdlIGNhbiBnZXQgcmlkIG9mIHRoaXMuIEl0J3Mgb25seSB1c2VkIGZvciBjb25maWcgYW5kIGhvb2tzLlxuICB1cHNlcnRPbmVPYmplY3QoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgdXBkYXRlOiBhbnksXG4gICAgdHJhbnNhY3Rpb25hbFNlc3Npb246ID9hbnlcbiAgKSB7XG4gICAgZGVidWcoJ3Vwc2VydE9uZU9iamVjdCcpO1xuICAgIGNvbnN0IGNyZWF0ZVZhbHVlID0gT2JqZWN0LmFzc2lnbih7fSwgcXVlcnksIHVwZGF0ZSk7XG4gICAgcmV0dXJuIHRoaXMuY3JlYXRlT2JqZWN0KGNsYXNzTmFtZSwgc2NoZW1hLCBjcmVhdGVWYWx1ZSwgdHJhbnNhY3Rpb25hbFNlc3Npb24pLmNhdGNoKGVycm9yID0+IHtcbiAgICAgIC8vIGlnbm9yZSBkdXBsaWNhdGUgdmFsdWUgZXJyb3JzIGFzIGl0J3MgdXBzZXJ0XG4gICAgICBpZiAoZXJyb3IuY29kZSAhPT0gUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFKSB7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRoaXMuZmluZE9uZUFuZFVwZGF0ZShjbGFzc05hbWUsIHNjaGVtYSwgcXVlcnksIHVwZGF0ZSwgdHJhbnNhY3Rpb25hbFNlc3Npb24pO1xuICAgIH0pO1xuICB9XG5cbiAgZmluZChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB7IHNraXAsIGxpbWl0LCBzb3J0LCBrZXlzLCBjYXNlSW5zZW5zaXRpdmUsIGV4cGxhaW4gfTogUXVlcnlPcHRpb25zXG4gICkge1xuICAgIGRlYnVnKCdmaW5kJyk7XG4gICAgY29uc3QgaGFzTGltaXQgPSBsaW1pdCAhPT0gdW5kZWZpbmVkO1xuICAgIGNvbnN0IGhhc1NraXAgPSBza2lwICE9PSB1bmRlZmluZWQ7XG4gICAgbGV0IHZhbHVlcyA9IFtjbGFzc05hbWVdO1xuICAgIGNvbnN0IHdoZXJlID0gYnVpbGRXaGVyZUNsYXVzZSh7XG4gICAgICBzY2hlbWEsXG4gICAgICBxdWVyeSxcbiAgICAgIGluZGV4OiAyLFxuICAgICAgY2FzZUluc2Vuc2l0aXZlLFxuICAgIH0pO1xuICAgIHZhbHVlcy5wdXNoKC4uLndoZXJlLnZhbHVlcyk7XG4gICAgY29uc3Qgd2hlcmVQYXR0ZXJuID0gd2hlcmUucGF0dGVybi5sZW5ndGggPiAwID8gYFdIRVJFICR7d2hlcmUucGF0dGVybn1gIDogJyc7XG4gICAgY29uc3QgbGltaXRQYXR0ZXJuID0gaGFzTGltaXQgPyBgTElNSVQgJCR7dmFsdWVzLmxlbmd0aCArIDF9YCA6ICcnO1xuICAgIGlmIChoYXNMaW1pdCkge1xuICAgICAgdmFsdWVzLnB1c2gobGltaXQpO1xuICAgIH1cbiAgICBjb25zdCBza2lwUGF0dGVybiA9IGhhc1NraXAgPyBgT0ZGU0VUICQke3ZhbHVlcy5sZW5ndGggKyAxfWAgOiAnJztcbiAgICBpZiAoaGFzU2tpcCkge1xuICAgICAgdmFsdWVzLnB1c2goc2tpcCk7XG4gICAgfVxuXG4gICAgbGV0IHNvcnRQYXR0ZXJuID0gJyc7XG4gICAgaWYgKHNvcnQpIHtcbiAgICAgIGNvbnN0IHNvcnRDb3B5OiBhbnkgPSBzb3J0O1xuICAgICAgY29uc3Qgc29ydGluZyA9IE9iamVjdC5rZXlzKHNvcnQpXG4gICAgICAgIC5tYXAoa2V5ID0+IHtcbiAgICAgICAgICBjb25zdCB0cmFuc2Zvcm1LZXkgPSB0cmFuc2Zvcm1Eb3RGaWVsZFRvQ29tcG9uZW50cyhrZXkpLmpvaW4oJy0+Jyk7XG4gICAgICAgICAgLy8gVXNpbmcgJGlkeCBwYXR0ZXJuIGdpdmVzOiAgbm9uLWludGVnZXIgY29uc3RhbnQgaW4gT1JERVIgQllcbiAgICAgICAgICBpZiAoc29ydENvcHlba2V5XSA9PT0gMSkge1xuICAgICAgICAgICAgcmV0dXJuIGAke3RyYW5zZm9ybUtleX0gQVNDYDtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIGAke3RyYW5zZm9ybUtleX0gREVTQ2A7XG4gICAgICAgIH0pXG4gICAgICAgIC5qb2luKCk7XG4gICAgICBzb3J0UGF0dGVybiA9IHNvcnQgIT09IHVuZGVmaW5lZCAmJiBPYmplY3Qua2V5cyhzb3J0KS5sZW5ndGggPiAwID8gYE9SREVSIEJZICR7c29ydGluZ31gIDogJyc7XG4gICAgfVxuICAgIGlmICh3aGVyZS5zb3J0cyAmJiBPYmplY3Qua2V5cygod2hlcmUuc29ydHM6IGFueSkpLmxlbmd0aCA+IDApIHtcbiAgICAgIHNvcnRQYXR0ZXJuID0gYE9SREVSIEJZICR7d2hlcmUuc29ydHMuam9pbigpfWA7XG4gICAgfVxuXG4gICAgbGV0IGNvbHVtbnMgPSAnKic7XG4gICAgaWYgKGtleXMpIHtcbiAgICAgIC8vIEV4Y2x1ZGUgZW1wdHkga2V5c1xuICAgICAgLy8gUmVwbGFjZSBBQ0wgYnkgaXQncyBrZXlzXG4gICAgICBrZXlzID0ga2V5cy5yZWR1Y2UoKG1lbW8sIGtleSkgPT4ge1xuICAgICAgICBpZiAoa2V5ID09PSAnQUNMJykge1xuICAgICAgICAgIG1lbW8ucHVzaCgnX3JwZXJtJyk7XG4gICAgICAgICAgbWVtby5wdXNoKCdfd3Blcm0nKTtcbiAgICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgICBrZXkubGVuZ3RoID4gMCAmJlxuICAgICAgICAgIC8vIFJlbW92ZSBzZWxlY3RlZCBmaWVsZCBub3QgcmVmZXJlbmNlZCBpbiB0aGUgc2NoZW1hXG4gICAgICAgICAgLy8gUmVsYXRpb24gaXMgbm90IGEgY29sdW1uIGluIHBvc3RncmVzXG4gICAgICAgICAgLy8gJHNjb3JlIGlzIGEgUGFyc2Ugc3BlY2lhbCBmaWVsZCBhbmQgaXMgYWxzbyBub3QgYSBjb2x1bW5cbiAgICAgICAgICAoKHNjaGVtYS5maWVsZHNba2V5XSAmJiBzY2hlbWEuZmllbGRzW2tleV0udHlwZSAhPT0gJ1JlbGF0aW9uJykgfHwga2V5ID09PSAnJHNjb3JlJylcbiAgICAgICAgKSB7XG4gICAgICAgICAgbWVtby5wdXNoKGtleSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG1lbW87XG4gICAgICB9LCBbXSk7XG4gICAgICBjb2x1bW5zID0ga2V5c1xuICAgICAgICAubWFwKChrZXksIGluZGV4KSA9PiB7XG4gICAgICAgICAgaWYgKGtleSA9PT0gJyRzY29yZScpIHtcbiAgICAgICAgICAgIHJldHVybiBgdHNfcmFua19jZCh0b190c3ZlY3RvcigkJHsyfSwgJCR7M306bmFtZSksIHRvX3RzcXVlcnkoJCR7NH0sICQkezV9KSwgMzIpIGFzIHNjb3JlYDtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIGAkJHtpbmRleCArIHZhbHVlcy5sZW5ndGggKyAxfTpuYW1lYDtcbiAgICAgICAgfSlcbiAgICAgICAgLmpvaW4oKTtcbiAgICAgIHZhbHVlcyA9IHZhbHVlcy5jb25jYXQoa2V5cyk7XG4gICAgfVxuXG4gICAgY29uc3Qgb3JpZ2luYWxRdWVyeSA9IGBTRUxFQ1QgJHtjb2x1bW5zfSBGUk9NICQxOm5hbWUgJHt3aGVyZVBhdHRlcm59ICR7c29ydFBhdHRlcm59ICR7bGltaXRQYXR0ZXJufSAke3NraXBQYXR0ZXJufWA7XG4gICAgY29uc3QgcXMgPSBleHBsYWluID8gdGhpcy5jcmVhdGVFeHBsYWluYWJsZVF1ZXJ5KG9yaWdpbmFsUXVlcnkpIDogb3JpZ2luYWxRdWVyeTtcbiAgICByZXR1cm4gdGhpcy5fY2xpZW50XG4gICAgICAuYW55KHFzLCB2YWx1ZXMpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAvLyBRdWVyeSBvbiBub24gZXhpc3RpbmcgdGFibGUsIGRvbid0IGNyYXNoXG4gICAgICAgIGlmIChlcnJvci5jb2RlICE9PSBQb3N0Z3Jlc1JlbGF0aW9uRG9lc05vdEV4aXN0RXJyb3IpIHtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gW107XG4gICAgICB9KVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIGlmIChleHBsYWluKSB7XG4gICAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc3VsdHMubWFwKG9iamVjdCA9PiB0aGlzLnBvc3RncmVzT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIC8vIENvbnZlcnRzIGZyb20gYSBwb3N0Z3Jlcy1mb3JtYXQgb2JqZWN0IHRvIGEgUkVTVC1mb3JtYXQgb2JqZWN0LlxuICAvLyBEb2VzIG5vdCBzdHJpcCBvdXQgYW55dGhpbmcgYmFzZWQgb24gYSBsYWNrIG9mIGF1dGhlbnRpY2F0aW9uLlxuICBwb3N0Z3Jlc09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lOiBzdHJpbmcsIG9iamVjdDogYW55LCBzY2hlbWE6IGFueSkge1xuICAgIE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1BvaW50ZXInICYmIG9iamVjdFtmaWVsZE5hbWVdKSB7XG4gICAgICAgIG9iamVjdFtmaWVsZE5hbWVdID0ge1xuICAgICAgICAgIG9iamVjdElkOiBvYmplY3RbZmllbGROYW1lXSxcbiAgICAgICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgICAgICBjbGFzc05hbWU6IHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50YXJnZXRDbGFzcyxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1JlbGF0aW9uJykge1xuICAgICAgICBvYmplY3RbZmllbGROYW1lXSA9IHtcbiAgICAgICAgICBfX3R5cGU6ICdSZWxhdGlvbicsXG4gICAgICAgICAgY2xhc3NOYW1lOiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udGFyZ2V0Q2xhc3MsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBpZiAob2JqZWN0W2ZpZWxkTmFtZV0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdHZW9Qb2ludCcpIHtcbiAgICAgICAgb2JqZWN0W2ZpZWxkTmFtZV0gPSB7XG4gICAgICAgICAgX190eXBlOiAnR2VvUG9pbnQnLFxuICAgICAgICAgIGxhdGl0dWRlOiBvYmplY3RbZmllbGROYW1lXS55LFxuICAgICAgICAgIGxvbmdpdHVkZTogb2JqZWN0W2ZpZWxkTmFtZV0ueCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmIChvYmplY3RbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICAgIGxldCBjb29yZHMgPSBuZXcgU3RyaW5nKG9iamVjdFtmaWVsZE5hbWVdKTtcbiAgICAgICAgY29vcmRzID0gY29vcmRzLnN1YnN0cmluZygyLCBjb29yZHMubGVuZ3RoIC0gMikuc3BsaXQoJyksKCcpO1xuICAgICAgICBjb25zdCB1cGRhdGVkQ29vcmRzID0gY29vcmRzLm1hcChwb2ludCA9PiB7XG4gICAgICAgICAgcmV0dXJuIFtwYXJzZUZsb2F0KHBvaW50LnNwbGl0KCcsJylbMV0pLCBwYXJzZUZsb2F0KHBvaW50LnNwbGl0KCcsJylbMF0pXTtcbiAgICAgICAgfSk7XG4gICAgICAgIG9iamVjdFtmaWVsZE5hbWVdID0ge1xuICAgICAgICAgIF9fdHlwZTogJ1BvbHlnb24nLFxuICAgICAgICAgIGNvb3JkaW5hdGVzOiB1cGRhdGVkQ29vcmRzLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgaWYgKG9iamVjdFtmaWVsZE5hbWVdICYmIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnRmlsZScpIHtcbiAgICAgICAgb2JqZWN0W2ZpZWxkTmFtZV0gPSB7XG4gICAgICAgICAgX190eXBlOiAnRmlsZScsXG4gICAgICAgICAgbmFtZTogb2JqZWN0W2ZpZWxkTmFtZV0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfSk7XG4gICAgLy9UT0RPOiByZW1vdmUgdGhpcyByZWxpYW5jZSBvbiB0aGUgbW9uZ28gZm9ybWF0LiBEQiBhZGFwdGVyIHNob3VsZG4ndCBrbm93IHRoZXJlIGlzIGEgZGlmZmVyZW5jZSBiZXR3ZWVuIGNyZWF0ZWQgYXQgYW5kIGFueSBvdGhlciBkYXRlIGZpZWxkLlxuICAgIGlmIChvYmplY3QuY3JlYXRlZEF0KSB7XG4gICAgICBvYmplY3QuY3JlYXRlZEF0ID0gb2JqZWN0LmNyZWF0ZWRBdC50b0lTT1N0cmluZygpO1xuICAgIH1cbiAgICBpZiAob2JqZWN0LnVwZGF0ZWRBdCkge1xuICAgICAgb2JqZWN0LnVwZGF0ZWRBdCA9IG9iamVjdC51cGRhdGVkQXQudG9JU09TdHJpbmcoKTtcbiAgICB9XG4gICAgaWYgKG9iamVjdC5leHBpcmVzQXQpIHtcbiAgICAgIG9iamVjdC5leHBpcmVzQXQgPSB7XG4gICAgICAgIF9fdHlwZTogJ0RhdGUnLFxuICAgICAgICBpc286IG9iamVjdC5leHBpcmVzQXQudG9JU09TdHJpbmcoKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGlmIChvYmplY3QuX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0KSB7XG4gICAgICBvYmplY3QuX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0ID0ge1xuICAgICAgICBfX3R5cGU6ICdEYXRlJyxcbiAgICAgICAgaXNvOiBvYmplY3QuX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0LnRvSVNPU3RyaW5nKCksXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAob2JqZWN0Ll9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCkge1xuICAgICAgb2JqZWN0Ll9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCA9IHtcbiAgICAgICAgX190eXBlOiAnRGF0ZScsXG4gICAgICAgIGlzbzogb2JqZWN0Ll9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdC50b0lTT1N0cmluZygpLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKG9iamVjdC5fcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0KSB7XG4gICAgICBvYmplY3QuX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCA9IHtcbiAgICAgICAgX190eXBlOiAnRGF0ZScsXG4gICAgICAgIGlzbzogb2JqZWN0Ll9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQudG9JU09TdHJpbmcoKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGlmIChvYmplY3QuX3Bhc3N3b3JkX2NoYW5nZWRfYXQpIHtcbiAgICAgIG9iamVjdC5fcGFzc3dvcmRfY2hhbmdlZF9hdCA9IHtcbiAgICAgICAgX190eXBlOiAnRGF0ZScsXG4gICAgICAgIGlzbzogb2JqZWN0Ll9wYXNzd29yZF9jaGFuZ2VkX2F0LnRvSVNPU3RyaW5nKCksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgZmllbGROYW1lIGluIG9iamVjdCkge1xuICAgICAgaWYgKG9iamVjdFtmaWVsZE5hbWVdID09PSBudWxsKSB7XG4gICAgICAgIGRlbGV0ZSBvYmplY3RbZmllbGROYW1lXTtcbiAgICAgIH1cbiAgICAgIGlmIChvYmplY3RbZmllbGROYW1lXSBpbnN0YW5jZW9mIERhdGUpIHtcbiAgICAgICAgb2JqZWN0W2ZpZWxkTmFtZV0gPSB7XG4gICAgICAgICAgX190eXBlOiAnRGF0ZScsXG4gICAgICAgICAgaXNvOiBvYmplY3RbZmllbGROYW1lXS50b0lTT1N0cmluZygpLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBvYmplY3Q7XG4gIH1cblxuICAvLyBDcmVhdGUgYSB1bmlxdWUgaW5kZXguIFVuaXF1ZSBpbmRleGVzIG9uIG51bGxhYmxlIGZpZWxkcyBhcmUgbm90IGFsbG93ZWQuIFNpbmNlIHdlIGRvbid0XG4gIC8vIGN1cnJlbnRseSBrbm93IHdoaWNoIGZpZWxkcyBhcmUgbnVsbGFibGUgYW5kIHdoaWNoIGFyZW4ndCwgd2UgaWdub3JlIHRoYXQgY3JpdGVyaWEuXG4gIC8vIEFzIHN1Y2gsIHdlIHNob3VsZG4ndCBleHBvc2UgdGhpcyBmdW5jdGlvbiB0byB1c2VycyBvZiBwYXJzZSB1bnRpbCB3ZSBoYXZlIGFuIG91dC1vZi1iYW5kXG4gIC8vIFdheSBvZiBkZXRlcm1pbmluZyBpZiBhIGZpZWxkIGlzIG51bGxhYmxlLiBVbmRlZmluZWQgZG9lc24ndCBjb3VudCBhZ2FpbnN0IHVuaXF1ZW5lc3MsXG4gIC8vIHdoaWNoIGlzIHdoeSB3ZSB1c2Ugc3BhcnNlIGluZGV4ZXMuXG4gIGFzeW5jIGVuc3VyZVVuaXF1ZW5lc3MoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgZmllbGROYW1lczogc3RyaW5nW10pIHtcbiAgICBjb25zdCBjb25zdHJhaW50TmFtZSA9IGAke2NsYXNzTmFtZX1fdW5pcXVlXyR7ZmllbGROYW1lcy5zb3J0KCkuam9pbignXycpfWA7XG4gICAgY29uc3QgY29uc3RyYWludFBhdHRlcm5zID0gZmllbGROYW1lcy5tYXAoKGZpZWxkTmFtZSwgaW5kZXgpID0+IGAkJHtpbmRleCArIDN9Om5hbWVgKTtcbiAgICBjb25zdCBxcyA9IGBDUkVBVEUgVU5JUVVFIElOREVYIElGIE5PVCBFWElTVFMgJDI6bmFtZSBPTiAkMTpuYW1lKCR7Y29uc3RyYWludFBhdHRlcm5zLmpvaW4oKX0pYDtcbiAgICByZXR1cm4gdGhpcy5fY2xpZW50Lm5vbmUocXMsIFtjbGFzc05hbWUsIGNvbnN0cmFpbnROYW1lLCAuLi5maWVsZE5hbWVzXSkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgaWYgKGVycm9yLmNvZGUgPT09IFBvc3RncmVzRHVwbGljYXRlUmVsYXRpb25FcnJvciAmJiBlcnJvci5tZXNzYWdlLmluY2x1ZGVzKGNvbnN0cmFpbnROYW1lKSkge1xuICAgICAgICAvLyBJbmRleCBhbHJlYWR5IGV4aXN0cy4gSWdub3JlIGVycm9yLlxuICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgZXJyb3IuY29kZSA9PT0gUG9zdGdyZXNVbmlxdWVJbmRleFZpb2xhdGlvbkVycm9yICYmXG4gICAgICAgIGVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoY29uc3RyYWludE5hbWUpXG4gICAgICApIHtcbiAgICAgICAgLy8gQ2FzdCB0aGUgZXJyb3IgaW50byB0aGUgcHJvcGVyIHBhcnNlIGVycm9yXG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsXG4gICAgICAgICAgJ0EgZHVwbGljYXRlIHZhbHVlIGZvciBhIGZpZWxkIHdpdGggdW5pcXVlIHZhbHVlcyB3YXMgcHJvdmlkZWQnXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8vIEV4ZWN1dGVzIGEgY291bnQuXG4gIGFzeW5jIGNvdW50KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHJlYWRQcmVmZXJlbmNlPzogc3RyaW5nLFxuICAgIGVzdGltYXRlPzogYm9vbGVhbiA9IHRydWVcbiAgKSB7XG4gICAgZGVidWcoJ2NvdW50Jyk7XG4gICAgY29uc3QgdmFsdWVzID0gW2NsYXNzTmFtZV07XG4gICAgY29uc3Qgd2hlcmUgPSBidWlsZFdoZXJlQ2xhdXNlKHtcbiAgICAgIHNjaGVtYSxcbiAgICAgIHF1ZXJ5LFxuICAgICAgaW5kZXg6IDIsXG4gICAgICBjYXNlSW5zZW5zaXRpdmU6IGZhbHNlLFxuICAgIH0pO1xuICAgIHZhbHVlcy5wdXNoKC4uLndoZXJlLnZhbHVlcyk7XG5cbiAgICBjb25zdCB3aGVyZVBhdHRlcm4gPSB3aGVyZS5wYXR0ZXJuLmxlbmd0aCA+IDAgPyBgV0hFUkUgJHt3aGVyZS5wYXR0ZXJufWAgOiAnJztcbiAgICBsZXQgcXMgPSAnJztcblxuICAgIGlmICh3aGVyZS5wYXR0ZXJuLmxlbmd0aCA+IDAgfHwgIWVzdGltYXRlKSB7XG4gICAgICBxcyA9IGBTRUxFQ1QgY291bnQoKikgRlJPTSAkMTpuYW1lICR7d2hlcmVQYXR0ZXJufWA7XG4gICAgfSBlbHNlIHtcbiAgICAgIHFzID0gJ1NFTEVDVCByZWx0dXBsZXMgQVMgYXBwcm94aW1hdGVfcm93X2NvdW50IEZST00gcGdfY2xhc3MgV0hFUkUgcmVsbmFtZSA9ICQxJztcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5fY2xpZW50XG4gICAgICAub25lKHFzLCB2YWx1ZXMsIGEgPT4ge1xuICAgICAgICBpZiAoYS5hcHByb3hpbWF0ZV9yb3dfY291bnQgPT0gbnVsbCB8fCBhLmFwcHJveGltYXRlX3Jvd19jb3VudCA9PSAtMSkge1xuICAgICAgICAgIHJldHVybiAhaXNOYU4oK2EuY291bnQpID8gK2EuY291bnQgOiAwO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJldHVybiArYS5hcHByb3hpbWF0ZV9yb3dfY291bnQ7XG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSAhPT0gUG9zdGdyZXNSZWxhdGlvbkRvZXNOb3RFeGlzdEVycm9yKSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIDA7XG4gICAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGRpc3RpbmN0KGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUsIHF1ZXJ5OiBRdWVyeVR5cGUsIGZpZWxkTmFtZTogc3RyaW5nKSB7XG4gICAgZGVidWcoJ2Rpc3RpbmN0Jyk7XG4gICAgbGV0IGZpZWxkID0gZmllbGROYW1lO1xuICAgIGxldCBjb2x1bW4gPSBmaWVsZE5hbWU7XG4gICAgY29uc3QgaXNOZXN0ZWQgPSBmaWVsZE5hbWUuaW5kZXhPZignLicpID49IDA7XG4gICAgaWYgKGlzTmVzdGVkKSB7XG4gICAgICBmaWVsZCA9IHRyYW5zZm9ybURvdEZpZWxkVG9Db21wb25lbnRzKGZpZWxkTmFtZSkuam9pbignLT4nKTtcbiAgICAgIGNvbHVtbiA9IGZpZWxkTmFtZS5zcGxpdCgnLicpWzBdO1xuICAgIH1cbiAgICBjb25zdCBpc0FycmF5RmllbGQgPVxuICAgICAgc2NoZW1hLmZpZWxkcyAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdBcnJheSc7XG4gICAgY29uc3QgaXNQb2ludGVyRmllbGQgPVxuICAgICAgc2NoZW1hLmZpZWxkcyAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdQb2ludGVyJztcbiAgICBjb25zdCB2YWx1ZXMgPSBbZmllbGQsIGNvbHVtbiwgY2xhc3NOYW1lXTtcbiAgICBjb25zdCB3aGVyZSA9IGJ1aWxkV2hlcmVDbGF1c2Uoe1xuICAgICAgc2NoZW1hLFxuICAgICAgcXVlcnksXG4gICAgICBpbmRleDogNCxcbiAgICAgIGNhc2VJbnNlbnNpdGl2ZTogZmFsc2UsXG4gICAgfSk7XG4gICAgdmFsdWVzLnB1c2goLi4ud2hlcmUudmFsdWVzKTtcblxuICAgIGNvbnN0IHdoZXJlUGF0dGVybiA9IHdoZXJlLnBhdHRlcm4ubGVuZ3RoID4gMCA/IGBXSEVSRSAke3doZXJlLnBhdHRlcm59YCA6ICcnO1xuICAgIGNvbnN0IHRyYW5zZm9ybWVyID0gaXNBcnJheUZpZWxkID8gJ2pzb25iX2FycmF5X2VsZW1lbnRzJyA6ICdPTic7XG4gICAgbGV0IHFzID0gYFNFTEVDVCBESVNUSU5DVCAke3RyYW5zZm9ybWVyfSgkMTpuYW1lKSAkMjpuYW1lIEZST00gJDM6bmFtZSAke3doZXJlUGF0dGVybn1gO1xuICAgIGlmIChpc05lc3RlZCkge1xuICAgICAgcXMgPSBgU0VMRUNUIERJU1RJTkNUICR7dHJhbnNmb3JtZXJ9KCQxOnJhdykgJDI6cmF3IEZST00gJDM6bmFtZSAke3doZXJlUGF0dGVybn1gO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5fY2xpZW50XG4gICAgICAuYW55KHFzLCB2YWx1ZXMpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gUG9zdGdyZXNNaXNzaW5nQ29sdW1uRXJyb3IpIHtcbiAgICAgICAgICByZXR1cm4gW107XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIGlmICghaXNOZXN0ZWQpIHtcbiAgICAgICAgICByZXN1bHRzID0gcmVzdWx0cy5maWx0ZXIob2JqZWN0ID0+IG9iamVjdFtmaWVsZF0gIT09IG51bGwpO1xuICAgICAgICAgIHJldHVybiByZXN1bHRzLm1hcChvYmplY3QgPT4ge1xuICAgICAgICAgICAgaWYgKCFpc1BvaW50ZXJGaWVsZCkge1xuICAgICAgICAgICAgICByZXR1cm4gb2JqZWN0W2ZpZWxkXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICAgICAgICBjbGFzc05hbWU6IHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50YXJnZXRDbGFzcyxcbiAgICAgICAgICAgICAgb2JqZWN0SWQ6IG9iamVjdFtmaWVsZF0sXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGNoaWxkID0gZmllbGROYW1lLnNwbGl0KCcuJylbMV07XG4gICAgICAgIHJldHVybiByZXN1bHRzLm1hcChvYmplY3QgPT4gb2JqZWN0W2NvbHVtbl1bY2hpbGRdKTtcbiAgICAgIH0pXG4gICAgICAudGhlbihyZXN1bHRzID0+XG4gICAgICAgIHJlc3VsdHMubWFwKG9iamVjdCA9PiB0aGlzLnBvc3RncmVzT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKSlcbiAgICAgICk7XG4gIH1cblxuICBhc3luYyBhZ2dyZWdhdGUoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBhbnksXG4gICAgcGlwZWxpbmU6IGFueSxcbiAgICByZWFkUHJlZmVyZW5jZTogP3N0cmluZyxcbiAgICBoaW50OiA/bWl4ZWQsXG4gICAgZXhwbGFpbj86IGJvb2xlYW5cbiAgKSB7XG4gICAgZGVidWcoJ2FnZ3JlZ2F0ZScpO1xuICAgIGNvbnN0IHZhbHVlcyA9IFtjbGFzc05hbWVdO1xuICAgIGxldCBpbmRleDogbnVtYmVyID0gMjtcbiAgICBsZXQgY29sdW1uczogc3RyaW5nW10gPSBbXTtcbiAgICBsZXQgY291bnRGaWVsZCA9IG51bGw7XG4gICAgbGV0IGdyb3VwVmFsdWVzID0gbnVsbDtcbiAgICBsZXQgd2hlcmVQYXR0ZXJuID0gJyc7XG4gICAgbGV0IGxpbWl0UGF0dGVybiA9ICcnO1xuICAgIGxldCBza2lwUGF0dGVybiA9ICcnO1xuICAgIGxldCBzb3J0UGF0dGVybiA9ICcnO1xuICAgIGxldCBncm91cFBhdHRlcm4gPSAnJztcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHBpcGVsaW5lLmxlbmd0aDsgaSArPSAxKSB7XG4gICAgICBjb25zdCBzdGFnZSA9IHBpcGVsaW5lW2ldO1xuICAgICAgaWYgKHN0YWdlLiRncm91cCkge1xuICAgICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHN0YWdlLiRncm91cCkge1xuICAgICAgICAgIGNvbnN0IHZhbHVlID0gc3RhZ2UuJGdyb3VwW2ZpZWxkXTtcbiAgICAgICAgICBpZiAodmFsdWUgPT09IG51bGwgfHwgdmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChmaWVsZCA9PT0gJ19pZCcgJiYgdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZSAhPT0gJycpIHtcbiAgICAgICAgICAgIGNvbHVtbnMucHVzaChgJCR7aW5kZXh9Om5hbWUgQVMgXCJvYmplY3RJZFwiYCk7XG4gICAgICAgICAgICBncm91cFBhdHRlcm4gPSBgR1JPVVAgQlkgJCR7aW5kZXh9Om5hbWVgO1xuICAgICAgICAgICAgdmFsdWVzLnB1c2godHJhbnNmb3JtQWdncmVnYXRlRmllbGQodmFsdWUpKTtcbiAgICAgICAgICAgIGluZGV4ICs9IDE7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGZpZWxkID09PSAnX2lkJyAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmIE9iamVjdC5rZXlzKHZhbHVlKS5sZW5ndGggIT09IDApIHtcbiAgICAgICAgICAgIGdyb3VwVmFsdWVzID0gdmFsdWU7XG4gICAgICAgICAgICBjb25zdCBncm91cEJ5RmllbGRzID0gW107XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGFsaWFzIGluIHZhbHVlKSB7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgdmFsdWVbYWxpYXNdID09PSAnc3RyaW5nJyAmJiB2YWx1ZVthbGlhc10pIHtcbiAgICAgICAgICAgICAgICBjb25zdCBzb3VyY2UgPSB0cmFuc2Zvcm1BZ2dyZWdhdGVGaWVsZCh2YWx1ZVthbGlhc10pO1xuICAgICAgICAgICAgICAgIGlmICghZ3JvdXBCeUZpZWxkcy5pbmNsdWRlcyhgXCIke3NvdXJjZX1cImApKSB7XG4gICAgICAgICAgICAgICAgICBncm91cEJ5RmllbGRzLnB1c2goYFwiJHtzb3VyY2V9XCJgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdmFsdWVzLnB1c2goc291cmNlLCBhbGlhcyk7XG4gICAgICAgICAgICAgICAgY29sdW1ucy5wdXNoKGAkJHtpbmRleH06bmFtZSBBUyAkJHtpbmRleCArIDF9Om5hbWVgKTtcbiAgICAgICAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnN0IG9wZXJhdGlvbiA9IE9iamVjdC5rZXlzKHZhbHVlW2FsaWFzXSlbMF07XG4gICAgICAgICAgICAgICAgY29uc3Qgc291cmNlID0gdHJhbnNmb3JtQWdncmVnYXRlRmllbGQodmFsdWVbYWxpYXNdW29wZXJhdGlvbl0pO1xuICAgICAgICAgICAgICAgIGlmIChtb25nb0FnZ3JlZ2F0ZVRvUG9zdGdyZXNbb3BlcmF0aW9uXSkge1xuICAgICAgICAgICAgICAgICAgaWYgKCFncm91cEJ5RmllbGRzLmluY2x1ZGVzKGBcIiR7c291cmNlfVwiYCkpIHtcbiAgICAgICAgICAgICAgICAgICAgZ3JvdXBCeUZpZWxkcy5wdXNoKGBcIiR7c291cmNlfVwiYCk7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICBjb2x1bW5zLnB1c2goXG4gICAgICAgICAgICAgICAgICAgIGBFWFRSQUNUKCR7bW9uZ29BZ2dyZWdhdGVUb1Bvc3RncmVzW29wZXJhdGlvbl1cbiAgICAgICAgICAgICAgICAgICAgfSBGUk9NICQke2luZGV4fTpuYW1lIEFUIFRJTUUgWk9ORSAnVVRDJyk6OmludGVnZXIgQVMgJCR7aW5kZXggKyAxfTpuYW1lYFxuICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgIHZhbHVlcy5wdXNoKHNvdXJjZSwgYWxpYXMpO1xuICAgICAgICAgICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGdyb3VwUGF0dGVybiA9IGBHUk9VUCBCWSAkJHtpbmRleH06cmF3YDtcbiAgICAgICAgICAgIHZhbHVlcy5wdXNoKGdyb3VwQnlGaWVsZHMuam9pbigpKTtcbiAgICAgICAgICAgIGluZGV4ICs9IDE7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS4kc3VtKSB7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgdmFsdWUuJHN1bSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICBjb2x1bW5zLnB1c2goYFNVTSgkJHtpbmRleH06bmFtZSkgQVMgJCR7aW5kZXggKyAxfTpuYW1lYCk7XG4gICAgICAgICAgICAgICAgdmFsdWVzLnB1c2godHJhbnNmb3JtQWdncmVnYXRlRmllbGQodmFsdWUuJHN1bSksIGZpZWxkKTtcbiAgICAgICAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvdW50RmllbGQgPSBmaWVsZDtcbiAgICAgICAgICAgICAgICBjb2x1bW5zLnB1c2goYENPVU5UKCopIEFTICQke2luZGV4fTpuYW1lYCk7XG4gICAgICAgICAgICAgICAgdmFsdWVzLnB1c2goZmllbGQpO1xuICAgICAgICAgICAgICAgIGluZGV4ICs9IDE7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh2YWx1ZS4kbWF4KSB7XG4gICAgICAgICAgICAgIGNvbHVtbnMucHVzaChgTUFYKCQke2luZGV4fTpuYW1lKSBBUyAkJHtpbmRleCArIDF9Om5hbWVgKTtcbiAgICAgICAgICAgICAgdmFsdWVzLnB1c2godHJhbnNmb3JtQWdncmVnYXRlRmllbGQodmFsdWUuJG1heCksIGZpZWxkKTtcbiAgICAgICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh2YWx1ZS4kbWluKSB7XG4gICAgICAgICAgICAgIGNvbHVtbnMucHVzaChgTUlOKCQke2luZGV4fTpuYW1lKSBBUyAkJHtpbmRleCArIDF9Om5hbWVgKTtcbiAgICAgICAgICAgICAgdmFsdWVzLnB1c2godHJhbnNmb3JtQWdncmVnYXRlRmllbGQodmFsdWUuJG1pbiksIGZpZWxkKTtcbiAgICAgICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh2YWx1ZS4kYXZnKSB7XG4gICAgICAgICAgICAgIGNvbHVtbnMucHVzaChgQVZHKCQke2luZGV4fTpuYW1lKSBBUyAkJHtpbmRleCArIDF9Om5hbWVgKTtcbiAgICAgICAgICAgICAgdmFsdWVzLnB1c2godHJhbnNmb3JtQWdncmVnYXRlRmllbGQodmFsdWUuJGF2ZyksIGZpZWxkKTtcbiAgICAgICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbHVtbnMucHVzaCgnKicpO1xuICAgICAgfVxuICAgICAgaWYgKHN0YWdlLiRwcm9qZWN0KSB7XG4gICAgICAgIGlmIChjb2x1bW5zLmluY2x1ZGVzKCcqJykpIHtcbiAgICAgICAgICBjb2x1bW5zID0gW107XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCBmaWVsZCBpbiBzdGFnZS4kcHJvamVjdCkge1xuICAgICAgICAgIGNvbnN0IHZhbHVlID0gc3RhZ2UuJHByb2plY3RbZmllbGRdO1xuICAgICAgICAgIGlmICh2YWx1ZSA9PT0gMSB8fCB2YWx1ZSA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgY29sdW1ucy5wdXNoKGAkJHtpbmRleH06bmFtZWApO1xuICAgICAgICAgICAgdmFsdWVzLnB1c2goZmllbGQpO1xuICAgICAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChzdGFnZS4kbWF0Y2gpIHtcbiAgICAgICAgY29uc3QgcGF0dGVybnMgPSBbXTtcbiAgICAgICAgY29uc3Qgb3JPckFuZCA9IE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChzdGFnZS4kbWF0Y2gsICckb3InKVxuICAgICAgICAgID8gJyBPUiAnXG4gICAgICAgICAgOiAnIEFORCAnO1xuXG4gICAgICAgIGlmIChzdGFnZS4kbWF0Y2guJG9yKSB7XG4gICAgICAgICAgY29uc3QgY29sbGFwc2UgPSB7fTtcbiAgICAgICAgICBzdGFnZS4kbWF0Y2guJG9yLmZvckVhY2goZWxlbWVudCA9PiB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGtleSBpbiBlbGVtZW50KSB7XG4gICAgICAgICAgICAgIGNvbGxhcHNlW2tleV0gPSBlbGVtZW50W2tleV07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgc3RhZ2UuJG1hdGNoID0gY29sbGFwc2U7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChsZXQgZmllbGQgaW4gc3RhZ2UuJG1hdGNoKSB7XG4gICAgICAgICAgY29uc3QgdmFsdWUgPSBzdGFnZS4kbWF0Y2hbZmllbGRdO1xuICAgICAgICAgIGlmIChmaWVsZCA9PT0gJ19pZCcpIHtcbiAgICAgICAgICAgIGZpZWxkID0gJ29iamVjdElkJztcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgbWF0Y2hQYXR0ZXJucyA9IFtdO1xuICAgICAgICAgIE9iamVjdC5rZXlzKFBhcnNlVG9Qb3NncmVzQ29tcGFyYXRvcikuZm9yRWFjaChjbXAgPT4ge1xuICAgICAgICAgICAgaWYgKHZhbHVlW2NtcF0pIHtcbiAgICAgICAgICAgICAgY29uc3QgcGdDb21wYXJhdG9yID0gUGFyc2VUb1Bvc2dyZXNDb21wYXJhdG9yW2NtcF07XG4gICAgICAgICAgICAgIG1hdGNoUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgJHtwZ0NvbXBhcmF0b3J9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgICAgICAgdmFsdWVzLnB1c2goZmllbGQsIHRvUG9zdGdyZXNWYWx1ZSh2YWx1ZVtjbXBdKSk7XG4gICAgICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgaWYgKG1hdGNoUGF0dGVybnMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgcGF0dGVybnMucHVzaChgKCR7bWF0Y2hQYXR0ZXJucy5qb2luKCcgQU5EICcpfSlgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGRdICYmIHNjaGVtYS5maWVsZHNbZmllbGRdLnR5cGUgJiYgbWF0Y2hQYXR0ZXJucy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgICAgICAgdmFsdWVzLnB1c2goZmllbGQsIHZhbHVlKTtcbiAgICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHdoZXJlUGF0dGVybiA9IHBhdHRlcm5zLmxlbmd0aCA+IDAgPyBgV0hFUkUgJHtwYXR0ZXJucy5qb2luKGAgJHtvck9yQW5kfSBgKX1gIDogJyc7XG4gICAgICB9XG4gICAgICBpZiAoc3RhZ2UuJGxpbWl0KSB7XG4gICAgICAgIGxpbWl0UGF0dGVybiA9IGBMSU1JVCAkJHtpbmRleH1gO1xuICAgICAgICB2YWx1ZXMucHVzaChzdGFnZS4kbGltaXQpO1xuICAgICAgICBpbmRleCArPSAxO1xuICAgICAgfVxuICAgICAgaWYgKHN0YWdlLiRza2lwKSB7XG4gICAgICAgIHNraXBQYXR0ZXJuID0gYE9GRlNFVCAkJHtpbmRleH1gO1xuICAgICAgICB2YWx1ZXMucHVzaChzdGFnZS4kc2tpcCk7XG4gICAgICAgIGluZGV4ICs9IDE7XG4gICAgICB9XG4gICAgICBpZiAoc3RhZ2UuJHNvcnQpIHtcbiAgICAgICAgY29uc3Qgc29ydCA9IHN0YWdlLiRzb3J0O1xuICAgICAgICBjb25zdCBrZXlzID0gT2JqZWN0LmtleXMoc29ydCk7XG4gICAgICAgIGNvbnN0IHNvcnRpbmcgPSBrZXlzXG4gICAgICAgICAgLm1hcChrZXkgPT4ge1xuICAgICAgICAgICAgY29uc3QgdHJhbnNmb3JtZXIgPSBzb3J0W2tleV0gPT09IDEgPyAnQVNDJyA6ICdERVNDJztcbiAgICAgICAgICAgIGNvbnN0IG9yZGVyID0gYCQke2luZGV4fTpuYW1lICR7dHJhbnNmb3JtZXJ9YDtcbiAgICAgICAgICAgIGluZGV4ICs9IDE7XG4gICAgICAgICAgICByZXR1cm4gb3JkZXI7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuam9pbigpO1xuICAgICAgICB2YWx1ZXMucHVzaCguLi5rZXlzKTtcbiAgICAgICAgc29ydFBhdHRlcm4gPSBzb3J0ICE9PSB1bmRlZmluZWQgJiYgc29ydGluZy5sZW5ndGggPiAwID8gYE9SREVSIEJZICR7c29ydGluZ31gIDogJyc7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGdyb3VwUGF0dGVybikge1xuICAgICAgY29sdW1ucy5mb3JFYWNoKChlLCBpLCBhKSA9PiB7XG4gICAgICAgIGlmIChlICYmIGUudHJpbSgpID09PSAnKicpIHtcbiAgICAgICAgICBhW2ldID0gJyc7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IG9yaWdpbmFsUXVlcnkgPSBgU0VMRUNUICR7Y29sdW1uc1xuICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgLmpvaW4oKX0gRlJPTSAkMTpuYW1lICR7d2hlcmVQYXR0ZXJufSAke3NraXBQYXR0ZXJufSAke2dyb3VwUGF0dGVybn0gJHtzb3J0UGF0dGVybn0gJHtsaW1pdFBhdHRlcm59YDtcbiAgICBjb25zdCBxcyA9IGV4cGxhaW4gPyB0aGlzLmNyZWF0ZUV4cGxhaW5hYmxlUXVlcnkob3JpZ2luYWxRdWVyeSkgOiBvcmlnaW5hbFF1ZXJ5O1xuICAgIHJldHVybiB0aGlzLl9jbGllbnQuYW55KHFzLCB2YWx1ZXMpLnRoZW4oYSA9PiB7XG4gICAgICBpZiAoZXhwbGFpbikge1xuICAgICAgICByZXR1cm4gYTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBhLm1hcChvYmplY3QgPT4gdGhpcy5wb3N0Z3Jlc09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSkpO1xuICAgICAgcmVzdWx0cy5mb3JFYWNoKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlc3VsdCwgJ29iamVjdElkJykpIHtcbiAgICAgICAgICByZXN1bHQub2JqZWN0SWQgPSBudWxsO1xuICAgICAgICB9XG4gICAgICAgIGlmIChncm91cFZhbHVlcykge1xuICAgICAgICAgIHJlc3VsdC5vYmplY3RJZCA9IHt9O1xuICAgICAgICAgIGZvciAoY29uc3Qga2V5IGluIGdyb3VwVmFsdWVzKSB7XG4gICAgICAgICAgICByZXN1bHQub2JqZWN0SWRba2V5XSA9IHJlc3VsdFtrZXldO1xuICAgICAgICAgICAgZGVsZXRlIHJlc3VsdFtrZXldO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoY291bnRGaWVsZCkge1xuICAgICAgICAgIHJlc3VsdFtjb3VudEZpZWxkXSA9IHBhcnNlSW50KHJlc3VsdFtjb3VudEZpZWxkXSwgMTApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIHJldHVybiByZXN1bHRzO1xuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgcGVyZm9ybUluaXRpYWxpemF0aW9uKHsgVm9sYXRpbGVDbGFzc2VzU2NoZW1hcyB9OiBhbnkpIHtcbiAgICAvLyBUT0RPOiBUaGlzIG1ldGhvZCBuZWVkcyB0byBiZSByZXdyaXR0ZW4gdG8gbWFrZSBwcm9wZXIgdXNlIG9mIGNvbm5lY3Rpb25zIChAdml0YWx5LXQpXG4gICAgZGVidWcoJ3BlcmZvcm1Jbml0aWFsaXphdGlvbicpO1xuICAgIGF3YWl0IHRoaXMuX2Vuc3VyZVNjaGVtYUNvbGxlY3Rpb25FeGlzdHMoKTtcbiAgICBjb25zdCBwcm9taXNlcyA9IFZvbGF0aWxlQ2xhc3Nlc1NjaGVtYXMubWFwKHNjaGVtYSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jcmVhdGVUYWJsZShzY2hlbWEuY2xhc3NOYW1lLCBzY2hlbWEpXG4gICAgICAgIC5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIGVyci5jb2RlID09PSBQb3N0Z3Jlc0R1cGxpY2F0ZVJlbGF0aW9uRXJyb3IgfHxcbiAgICAgICAgICAgIGVyci5jb2RlID09PSBQYXJzZS5FcnJvci5JTlZBTElEX0NMQVNTX05BTUVcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9KVxuICAgICAgICAudGhlbigoKSA9PiB0aGlzLnNjaGVtYVVwZ3JhZGUoc2NoZW1hLmNsYXNzTmFtZSwgc2NoZW1hKSk7XG4gICAgfSk7XG4gICAgcHJvbWlzZXMucHVzaCh0aGlzLl9saXN0ZW5Ub1NjaGVtYSgpKTtcbiAgICByZXR1cm4gUHJvbWlzZS5hbGwocHJvbWlzZXMpXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiB0aGlzLl9jbGllbnQudHgoJ3BlcmZvcm0taW5pdGlhbGl6YXRpb24nLCBhc3luYyB0ID0+IHtcbiAgICAgICAgICBhd2FpdCB0Lm5vbmUoc3FsLm1pc2MuanNvbk9iamVjdFNldEtleXMpO1xuICAgICAgICAgIGF3YWl0IHQubm9uZShzcWwuYXJyYXkuYWRkKTtcbiAgICAgICAgICBhd2FpdCB0Lm5vbmUoc3FsLmFycmF5LmFkZFVuaXF1ZSk7XG4gICAgICAgICAgYXdhaXQgdC5ub25lKHNxbC5hcnJheS5yZW1vdmUpO1xuICAgICAgICAgIGF3YWl0IHQubm9uZShzcWwuYXJyYXkuY29udGFpbnNBbGwpO1xuICAgICAgICAgIGF3YWl0IHQubm9uZShzcWwuYXJyYXkuY29udGFpbnNBbGxSZWdleCk7XG4gICAgICAgICAgYXdhaXQgdC5ub25lKHNxbC5hcnJheS5jb250YWlucyk7XG4gICAgICAgICAgcmV0dXJuIHQuY3R4O1xuICAgICAgICB9KTtcbiAgICAgIH0pXG4gICAgICAudGhlbihjdHggPT4ge1xuICAgICAgICBkZWJ1ZyhgaW5pdGlhbGl6YXRpb25Eb25lIGluICR7Y3R4LmR1cmF0aW9ufWApO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoZXJyb3IpO1xuICAgICAgfSk7XG4gIH1cblxuICBhc3luYyBjcmVhdGVJbmRleGVzKGNsYXNzTmFtZTogc3RyaW5nLCBpbmRleGVzOiBhbnksIGNvbm46ID9hbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gKGNvbm4gfHwgdGhpcy5fY2xpZW50KS50eCh0ID0+XG4gICAgICB0LmJhdGNoKFxuICAgICAgICBpbmRleGVzLm1hcChpID0+IHtcbiAgICAgICAgICByZXR1cm4gdC5ub25lKCdDUkVBVEUgSU5ERVggSUYgTk9UIEVYSVNUUyAkMTpuYW1lIE9OICQyOm5hbWUgKCQzOm5hbWUpJywgW1xuICAgICAgICAgICAgaS5uYW1lLFxuICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgaS5rZXksXG4gICAgICAgICAgXSk7XG4gICAgICAgIH0pXG4gICAgICApXG4gICAgKTtcbiAgfVxuXG4gIGFzeW5jIGNyZWF0ZUluZGV4ZXNJZk5lZWRlZChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBmaWVsZE5hbWU6IHN0cmluZyxcbiAgICB0eXBlOiBhbnksXG4gICAgY29ubjogP2FueVxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCAoY29ubiB8fCB0aGlzLl9jbGllbnQpLm5vbmUoJ0NSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTICQxOm5hbWUgT04gJDI6bmFtZSAoJDM6bmFtZSknLCBbXG4gICAgICBmaWVsZE5hbWUsXG4gICAgICBjbGFzc05hbWUsXG4gICAgICB0eXBlLFxuICAgIF0pO1xuICB9XG5cbiAgYXN5bmMgZHJvcEluZGV4ZXMoY2xhc3NOYW1lOiBzdHJpbmcsIGluZGV4ZXM6IGFueSwgY29ubjogYW55KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgcXVlcmllcyA9IGluZGV4ZXMubWFwKGkgPT4gKHtcbiAgICAgIHF1ZXJ5OiAnRFJPUCBJTkRFWCAkMTpuYW1lJyxcbiAgICAgIHZhbHVlczogaSxcbiAgICB9KSk7XG4gICAgYXdhaXQgKGNvbm4gfHwgdGhpcy5fY2xpZW50KS50eCh0ID0+IHQubm9uZSh0aGlzLl9wZ3AuaGVscGVycy5jb25jYXQocXVlcmllcykpKTtcbiAgfVxuXG4gIGFzeW5jIGdldEluZGV4ZXMoY2xhc3NOYW1lOiBzdHJpbmcpIHtcbiAgICBjb25zdCBxcyA9ICdTRUxFQ1QgKiBGUk9NIHBnX2luZGV4ZXMgV0hFUkUgdGFibGVuYW1lID0gJHtjbGFzc05hbWV9JztcbiAgICByZXR1cm4gdGhpcy5fY2xpZW50LmFueShxcywgeyBjbGFzc05hbWUgfSk7XG4gIH1cblxuICBhc3luYyB1cGRhdGVTY2hlbWFXaXRoSW5kZXhlcygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICAvLyBVc2VkIGZvciB0ZXN0aW5nIHB1cnBvc2VzXG4gIGFzeW5jIHVwZGF0ZUVzdGltYXRlZENvdW50KGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudC5ub25lKCdBTkFMWVpFICQxOm5hbWUnLCBbY2xhc3NOYW1lXSk7XG4gIH1cblxuICBhc3luYyBjcmVhdGVUcmFuc2FjdGlvbmFsU2Vzc2lvbigpOiBQcm9taXNlPGFueT4ge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIGNvbnN0IHRyYW5zYWN0aW9uYWxTZXNzaW9uID0ge307XG4gICAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbi5yZXN1bHQgPSB0aGlzLl9jbGllbnQudHgodCA9PiB7XG4gICAgICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uLnQgPSB0O1xuICAgICAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbi5wcm9taXNlID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICAgICAgdHJhbnNhY3Rpb25hbFNlc3Npb24ucmVzb2x2ZSA9IHJlc29sdmU7XG4gICAgICAgIH0pO1xuICAgICAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbi5iYXRjaCA9IFtdO1xuICAgICAgICByZXNvbHZlKHRyYW5zYWN0aW9uYWxTZXNzaW9uKTtcbiAgICAgICAgcmV0dXJuIHRyYW5zYWN0aW9uYWxTZXNzaW9uLnByb21pc2U7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIGNvbW1pdFRyYW5zYWN0aW9uYWxTZXNzaW9uKHRyYW5zYWN0aW9uYWxTZXNzaW9uOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbi5yZXNvbHZlKHRyYW5zYWN0aW9uYWxTZXNzaW9uLnQuYmF0Y2godHJhbnNhY3Rpb25hbFNlc3Npb24uYmF0Y2gpKTtcbiAgICByZXR1cm4gdHJhbnNhY3Rpb25hbFNlc3Npb24ucmVzdWx0O1xuICB9XG5cbiAgYWJvcnRUcmFuc2FjdGlvbmFsU2Vzc2lvbih0cmFuc2FjdGlvbmFsU2Vzc2lvbjogYW55KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgcmVzdWx0ID0gdHJhbnNhY3Rpb25hbFNlc3Npb24ucmVzdWx0LmNhdGNoKCk7XG4gICAgdHJhbnNhY3Rpb25hbFNlc3Npb24uYmF0Y2gucHVzaChQcm9taXNlLnJlamVjdCgpKTtcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbi5yZXNvbHZlKHRyYW5zYWN0aW9uYWxTZXNzaW9uLnQuYmF0Y2godHJhbnNhY3Rpb25hbFNlc3Npb24uYmF0Y2gpKTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgYXN5bmMgZW5zdXJlSW5kZXgoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIGZpZWxkTmFtZXM6IHN0cmluZ1tdLFxuICAgIGluZGV4TmFtZTogP3N0cmluZyxcbiAgICBjYXNlSW5zZW5zaXRpdmU6IGJvb2xlYW4gPSBmYWxzZSxcbiAgICBvcHRpb25zPzogT2JqZWN0ID0ge31cbiAgKTogUHJvbWlzZTxhbnk+IHtcbiAgICBjb25zdCBjb25uID0gb3B0aW9ucy5jb25uICE9PSB1bmRlZmluZWQgPyBvcHRpb25zLmNvbm4gOiB0aGlzLl9jbGllbnQ7XG4gICAgY29uc3QgZGVmYXVsdEluZGV4TmFtZSA9IGBwYXJzZV9kZWZhdWx0XyR7ZmllbGROYW1lcy5zb3J0KCkuam9pbignXycpfWA7XG4gICAgY29uc3QgaW5kZXhOYW1lT3B0aW9uczogT2JqZWN0ID1cbiAgICAgIGluZGV4TmFtZSAhPSBudWxsID8geyBuYW1lOiBpbmRleE5hbWUgfSA6IHsgbmFtZTogZGVmYXVsdEluZGV4TmFtZSB9O1xuICAgIGNvbnN0IGNvbnN0cmFpbnRQYXR0ZXJucyA9IGNhc2VJbnNlbnNpdGl2ZVxuICAgICAgPyBmaWVsZE5hbWVzLm1hcCgoZmllbGROYW1lLCBpbmRleCkgPT4gYGxvd2VyKCQke2luZGV4ICsgM306bmFtZSkgdmFyY2hhcl9wYXR0ZXJuX29wc2ApXG4gICAgICA6IGZpZWxkTmFtZXMubWFwKChmaWVsZE5hbWUsIGluZGV4KSA9PiBgJCR7aW5kZXggKyAzfTpuYW1lYCk7XG4gICAgY29uc3QgcXMgPSBgQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgJDE6bmFtZSBPTiAkMjpuYW1lICgke2NvbnN0cmFpbnRQYXR0ZXJucy5qb2luKCl9KWA7XG4gICAgY29uc3Qgc2V0SWRlbXBvdGVuY3lGdW5jdGlvbiA9XG4gICAgICBvcHRpb25zLnNldElkZW1wb3RlbmN5RnVuY3Rpb24gIT09IHVuZGVmaW5lZCA/IG9wdGlvbnMuc2V0SWRlbXBvdGVuY3lGdW5jdGlvbiA6IGZhbHNlO1xuICAgIGlmIChzZXRJZGVtcG90ZW5jeUZ1bmN0aW9uKSB7XG4gICAgICBhd2FpdCB0aGlzLmVuc3VyZUlkZW1wb3RlbmN5RnVuY3Rpb25FeGlzdHMob3B0aW9ucyk7XG4gICAgfVxuICAgIGF3YWl0IGNvbm4ubm9uZShxcywgW2luZGV4TmFtZU9wdGlvbnMubmFtZSwgY2xhc3NOYW1lLCAuLi5maWVsZE5hbWVzXSkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgaWYgKFxuICAgICAgICBlcnJvci5jb2RlID09PSBQb3N0Z3Jlc0R1cGxpY2F0ZVJlbGF0aW9uRXJyb3IgJiZcbiAgICAgICAgZXJyb3IubWVzc2FnZS5pbmNsdWRlcyhpbmRleE5hbWVPcHRpb25zLm5hbWUpXG4gICAgICApIHtcbiAgICAgICAgLy8gSW5kZXggYWxyZWFkeSBleGlzdHMuIElnbm9yZSBlcnJvci5cbiAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgIGVycm9yLmNvZGUgPT09IFBvc3RncmVzVW5pcXVlSW5kZXhWaW9sYXRpb25FcnJvciAmJlxuICAgICAgICBlcnJvci5tZXNzYWdlLmluY2x1ZGVzKGluZGV4TmFtZU9wdGlvbnMubmFtZSlcbiAgICAgICkge1xuICAgICAgICAvLyBDYXN0IHRoZSBlcnJvciBpbnRvIHRoZSBwcm9wZXIgcGFyc2UgZXJyb3JcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAnQSBkdXBsaWNhdGUgdmFsdWUgZm9yIGEgZmllbGQgd2l0aCB1bmlxdWUgdmFsdWVzIHdhcyBwcm92aWRlZCdcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgZGVsZXRlSWRlbXBvdGVuY3lGdW5jdGlvbihvcHRpb25zPzogT2JqZWN0ID0ge30pOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IGNvbm4gPSBvcHRpb25zLmNvbm4gIT09IHVuZGVmaW5lZCA/IG9wdGlvbnMuY29ubiA6IHRoaXMuX2NsaWVudDtcbiAgICBjb25zdCBxcyA9ICdEUk9QIEZVTkNUSU9OIElGIEVYSVNUUyBpZGVtcG90ZW5jeV9kZWxldGVfZXhwaXJlZF9yZWNvcmRzKCknO1xuICAgIHJldHVybiBjb25uLm5vbmUocXMpLmNhdGNoKGVycm9yID0+IHtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgZW5zdXJlSWRlbXBvdGVuY3lGdW5jdGlvbkV4aXN0cyhvcHRpb25zPzogT2JqZWN0ID0ge30pOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IGNvbm4gPSBvcHRpb25zLmNvbm4gIT09IHVuZGVmaW5lZCA/IG9wdGlvbnMuY29ubiA6IHRoaXMuX2NsaWVudDtcbiAgICBjb25zdCB0dGxPcHRpb25zID0gb3B0aW9ucy50dGwgIT09IHVuZGVmaW5lZCA/IGAke29wdGlvbnMudHRsfSBzZWNvbmRzYCA6ICc2MCBzZWNvbmRzJztcbiAgICBjb25zdCBxcyA9XG4gICAgICAnQ1JFQVRFIE9SIFJFUExBQ0UgRlVOQ1RJT04gaWRlbXBvdGVuY3lfZGVsZXRlX2V4cGlyZWRfcmVjb3JkcygpIFJFVFVSTlMgdm9pZCBMQU5HVUFHRSBwbHBnc3FsIEFTICQkIEJFR0lOIERFTEVURSBGUk9NIFwiX0lkZW1wb3RlbmN5XCIgV0hFUkUgZXhwaXJlIDwgTk9XKCkgLSBJTlRFUlZBTCAkMTsgRU5EOyAkJDsnO1xuICAgIHJldHVybiBjb25uLm5vbmUocXMsIFt0dGxPcHRpb25zXSkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY29udmVydFBvbHlnb25Ub1NRTChwb2x5Z29uKSB7XG4gIGlmIChwb2x5Z29uLmxlbmd0aCA8IDMpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCBgUG9seWdvbiBtdXN0IGhhdmUgYXQgbGVhc3QgMyB2YWx1ZXNgKTtcbiAgfVxuICBpZiAoXG4gICAgcG9seWdvblswXVswXSAhPT0gcG9seWdvbltwb2x5Z29uLmxlbmd0aCAtIDFdWzBdIHx8XG4gICAgcG9seWdvblswXVsxXSAhPT0gcG9seWdvbltwb2x5Z29uLmxlbmd0aCAtIDFdWzFdXG4gICkge1xuICAgIHBvbHlnb24ucHVzaChwb2x5Z29uWzBdKTtcbiAgfVxuICBjb25zdCB1bmlxdWUgPSBwb2x5Z29uLmZpbHRlcigoaXRlbSwgaW5kZXgsIGFyKSA9PiB7XG4gICAgbGV0IGZvdW5kSW5kZXggPSAtMTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGFyLmxlbmd0aDsgaSArPSAxKSB7XG4gICAgICBjb25zdCBwdCA9IGFyW2ldO1xuICAgICAgaWYgKHB0WzBdID09PSBpdGVtWzBdICYmIHB0WzFdID09PSBpdGVtWzFdKSB7XG4gICAgICAgIGZvdW5kSW5kZXggPSBpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGZvdW5kSW5kZXggPT09IGluZGV4O1xuICB9KTtcbiAgaWYgKHVuaXF1ZS5sZW5ndGggPCAzKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLFxuICAgICAgJ0dlb0pTT046IExvb3AgbXVzdCBoYXZlIGF0IGxlYXN0IDMgZGlmZmVyZW50IHZlcnRpY2VzJ1xuICAgICk7XG4gIH1cbiAgY29uc3QgcG9pbnRzID0gcG9seWdvblxuICAgIC5tYXAocG9pbnQgPT4ge1xuICAgICAgUGFyc2UuR2VvUG9pbnQuX3ZhbGlkYXRlKHBhcnNlRmxvYXQocG9pbnRbMV0pLCBwYXJzZUZsb2F0KHBvaW50WzBdKSk7XG4gICAgICByZXR1cm4gYCgke3BvaW50WzFdfSwgJHtwb2ludFswXX0pYDtcbiAgICB9KVxuICAgIC5qb2luKCcsICcpO1xuICByZXR1cm4gYCgke3BvaW50c30pYDtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlV2hpdGVTcGFjZShyZWdleCkge1xuICBpZiAoIXJlZ2V4LmVuZHNXaXRoKCdcXG4nKSkge1xuICAgIHJlZ2V4ICs9ICdcXG4nO1xuICB9XG5cbiAgLy8gcmVtb3ZlIG5vbiBlc2NhcGVkIGNvbW1lbnRzXG4gIHJldHVybiAoXG4gICAgcmVnZXhcbiAgICAgIC5yZXBsYWNlKC8oW15cXFxcXSkjLipcXG4vZ2ltLCAnJDEnKVxuICAgICAgLy8gcmVtb3ZlIGxpbmVzIHN0YXJ0aW5nIHdpdGggYSBjb21tZW50XG4gICAgICAucmVwbGFjZSgvXiMuKlxcbi9naW0sICcnKVxuICAgICAgLy8gcmVtb3ZlIG5vbiBlc2NhcGVkIHdoaXRlc3BhY2VcbiAgICAgIC5yZXBsYWNlKC8oW15cXFxcXSlcXHMrL2dpbSwgJyQxJylcbiAgICAgIC8vIHJlbW92ZSB3aGl0ZXNwYWNlIGF0IHRoZSBiZWdpbm5pbmcgb2YgYSBsaW5lXG4gICAgICAucmVwbGFjZSgvXlxccysvLCAnJylcbiAgICAgIC50cmltKClcbiAgKTtcbn1cblxuZnVuY3Rpb24gcHJvY2Vzc1JlZ2V4UGF0dGVybihzKSB7XG4gIGlmIChzICYmIHMuc3RhcnRzV2l0aCgnXicpKSB7XG4gICAgLy8gcmVnZXggZm9yIHN0YXJ0c1dpdGhcbiAgICByZXR1cm4gJ14nICsgbGl0ZXJhbGl6ZVJlZ2V4UGFydChzLnNsaWNlKDEpKTtcbiAgfSBlbHNlIGlmIChzICYmIHMuZW5kc1dpdGgoJyQnKSkge1xuICAgIC8vIHJlZ2V4IGZvciBlbmRzV2l0aFxuICAgIHJldHVybiBsaXRlcmFsaXplUmVnZXhQYXJ0KHMuc2xpY2UoMCwgcy5sZW5ndGggLSAxKSkgKyAnJCc7XG4gIH1cblxuICAvLyByZWdleCBmb3IgY29udGFpbnNcbiAgcmV0dXJuIGxpdGVyYWxpemVSZWdleFBhcnQocyk7XG59XG5cbmZ1bmN0aW9uIGlzU3RhcnRzV2l0aFJlZ2V4KHZhbHVlKSB7XG4gIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnc3RyaW5nJyB8fCAhdmFsdWUuc3RhcnRzV2l0aCgnXicpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgY29uc3QgbWF0Y2hlcyA9IHZhbHVlLm1hdGNoKC9cXF5cXFxcUS4qXFxcXEUvKTtcbiAgcmV0dXJuICEhbWF0Y2hlcztcbn1cblxuZnVuY3Rpb24gaXNBbGxWYWx1ZXNSZWdleE9yTm9uZSh2YWx1ZXMpIHtcbiAgaWYgKCF2YWx1ZXMgfHwgIUFycmF5LmlzQXJyYXkodmFsdWVzKSB8fCB2YWx1ZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBjb25zdCBmaXJzdFZhbHVlc0lzUmVnZXggPSBpc1N0YXJ0c1dpdGhSZWdleCh2YWx1ZXNbMF0uJHJlZ2V4KTtcbiAgaWYgKHZhbHVlcy5sZW5ndGggPT09IDEpIHtcbiAgICByZXR1cm4gZmlyc3RWYWx1ZXNJc1JlZ2V4O1xuICB9XG5cbiAgZm9yIChsZXQgaSA9IDEsIGxlbmd0aCA9IHZhbHVlcy5sZW5ndGg7IGkgPCBsZW5ndGg7ICsraSkge1xuICAgIGlmIChmaXJzdFZhbHVlc0lzUmVnZXggIT09IGlzU3RhcnRzV2l0aFJlZ2V4KHZhbHVlc1tpXS4kcmVnZXgpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIGlzQW55VmFsdWVSZWdleFN0YXJ0c1dpdGgodmFsdWVzKSB7XG4gIHJldHVybiB2YWx1ZXMuc29tZShmdW5jdGlvbiAodmFsdWUpIHtcbiAgICByZXR1cm4gaXNTdGFydHNXaXRoUmVnZXgodmFsdWUuJHJlZ2V4KTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUxpdGVyYWxSZWdleChyZW1haW5pbmc6IHN0cmluZykge1xuICByZXR1cm4gcmVtYWluaW5nXG4gICAgLnNwbGl0KCcnKVxuICAgIC5tYXAoYyA9PiB7XG4gICAgICBjb25zdCByZWdleCA9IFJlZ0V4cCgnWzAtOSBdfFxcXFxwe0x9JywgJ3UnKTsgLy8gU3VwcG9ydCBhbGwgVW5pY29kZSBsZXR0ZXIgY2hhcnNcbiAgICAgIGlmIChjLm1hdGNoKHJlZ2V4KSAhPT0gbnVsbCkge1xuICAgICAgICAvLyBEb24ndCBlc2NhcGUgYWxwaGFudW1lcmljIGNoYXJhY3RlcnNcbiAgICAgICAgcmV0dXJuIGM7XG4gICAgICB9XG4gICAgICAvLyBFc2NhcGUgZXZlcnl0aGluZyBlbHNlIChzaW5nbGUgcXVvdGVzIHdpdGggc2luZ2xlIHF1b3RlcywgZXZlcnl0aGluZyBlbHNlIHdpdGggYSBiYWNrc2xhc2gpXG4gICAgICByZXR1cm4gYyA9PT0gYCdgID8gYCcnYCA6IGBcXFxcJHtjfWA7XG4gICAgfSlcbiAgICAuam9pbignJyk7XG59XG5cbmZ1bmN0aW9uIGxpdGVyYWxpemVSZWdleFBhcnQoczogc3RyaW5nKSB7XG4gIGNvbnN0IG1hdGNoZXIxID0gL1xcXFxRKCg/IVxcXFxFKS4qKVxcXFxFJC87XG4gIGNvbnN0IHJlc3VsdDE6IGFueSA9IHMubWF0Y2gobWF0Y2hlcjEpO1xuICBpZiAocmVzdWx0MSAmJiByZXN1bHQxLmxlbmd0aCA+IDEgJiYgcmVzdWx0MS5pbmRleCA+IC0xKSB7XG4gICAgLy8gUHJvY2VzcyBSZWdleCB0aGF0IGhhcyBhIGJlZ2lubmluZyBhbmQgYW4gZW5kIHNwZWNpZmllZCBmb3IgdGhlIGxpdGVyYWwgdGV4dFxuICAgIGNvbnN0IHByZWZpeCA9IHMuc3Vic3RyaW5nKDAsIHJlc3VsdDEuaW5kZXgpO1xuICAgIGNvbnN0IHJlbWFpbmluZyA9IHJlc3VsdDFbMV07XG5cbiAgICByZXR1cm4gbGl0ZXJhbGl6ZVJlZ2V4UGFydChwcmVmaXgpICsgY3JlYXRlTGl0ZXJhbFJlZ2V4KHJlbWFpbmluZyk7XG4gIH1cblxuICAvLyBQcm9jZXNzIFJlZ2V4IHRoYXQgaGFzIGEgYmVnaW5uaW5nIHNwZWNpZmllZCBmb3IgdGhlIGxpdGVyYWwgdGV4dFxuICBjb25zdCBtYXRjaGVyMiA9IC9cXFxcUSgoPyFcXFxcRSkuKikkLztcbiAgY29uc3QgcmVzdWx0MjogYW55ID0gcy5tYXRjaChtYXRjaGVyMik7XG4gIGlmIChyZXN1bHQyICYmIHJlc3VsdDIubGVuZ3RoID4gMSAmJiByZXN1bHQyLmluZGV4ID4gLTEpIHtcbiAgICBjb25zdCBwcmVmaXggPSBzLnN1YnN0cmluZygwLCByZXN1bHQyLmluZGV4KTtcbiAgICBjb25zdCByZW1haW5pbmcgPSByZXN1bHQyWzFdO1xuXG4gICAgcmV0dXJuIGxpdGVyYWxpemVSZWdleFBhcnQocHJlZml4KSArIGNyZWF0ZUxpdGVyYWxSZWdleChyZW1haW5pbmcpO1xuICB9XG5cbiAgLy8gUmVtb3ZlIHByb2JsZW1hdGljIGNoYXJzIGZyb20gcmVtYWluaW5nIHRleHRcbiAgcmV0dXJuIHNcbiAgICAvLyBSZW1vdmUgYWxsIGluc3RhbmNlcyBvZiBcXFEgYW5kIFxcRVxuICAgIC5yZXBsYWNlKC8oW15cXFxcXSkoXFxcXEUpLywgJyQxJylcbiAgICAucmVwbGFjZSgvKFteXFxcXF0pKFxcXFxRKS8sICckMScpXG4gICAgLnJlcGxhY2UoL15cXFxcRS8sICcnKVxuICAgIC5yZXBsYWNlKC9eXFxcXFEvLCAnJylcbiAgICAvLyBFbnN1cmUgZXZlbiBudW1iZXIgb2Ygc2luZ2xlIHF1b3RlIHNlcXVlbmNlcyBieSBhZGRpbmcgYW4gZXh0cmEgc2luZ2xlIHF1b3RlIGlmIG5lZWRlZDtcbiAgICAvLyB0aGlzIGVuc3VyZXMgdGhhdCBldmVyeSBzaW5nbGUgcXVvdGUgaXMgZXNjYXBlZFxuICAgIC5yZXBsYWNlKC8nKy9nLCBtYXRjaCA9PiB7XG4gICAgICByZXR1cm4gbWF0Y2gubGVuZ3RoICUgMiA9PT0gMCA/IG1hdGNoIDogbWF0Y2ggKyBcIidcIjtcbiAgICB9KTtcbn1cblxudmFyIEdlb1BvaW50Q29kZXIgPSB7XG4gIGlzVmFsaWRKU09OKHZhbHVlKSB7XG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiYgdmFsdWUgIT09IG51bGwgJiYgdmFsdWUuX190eXBlID09PSAnR2VvUG9pbnQnO1xuICB9LFxufTtcblxuZXhwb3J0IGRlZmF1bHQgUG9zdGdyZXNTdG9yYWdlQWRhcHRlcjtcbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FBQ0EsSUFBQUEsZUFBQSxHQUFBQyxPQUFBO0FBRUEsSUFBQUMsS0FBQSxHQUFBQyxzQkFBQSxDQUFBRixPQUFBO0FBRUEsSUFBQUcsT0FBQSxHQUFBRCxzQkFBQSxDQUFBRixPQUFBO0FBRUEsSUFBQUksS0FBQSxHQUFBSixPQUFBO0FBQ0EsSUFBQUssSUFBQSxHQUFBSCxzQkFBQSxDQUFBRixPQUFBO0FBQ0EsSUFBQU0sZUFBQSxHQUFBTixPQUFBO0FBQW1ELFNBQUFFLHVCQUFBSyxDQUFBLFdBQUFBLENBQUEsSUFBQUEsQ0FBQSxDQUFBQyxVQUFBLEdBQUFELENBQUEsS0FBQUUsT0FBQSxFQUFBRixDQUFBO0FBUG5EO0FBRUE7QUFFQTtBQUtBLE1BQU1HLEtBQUssR0FBR1YsT0FBTyxDQUFDLGdCQUFnQixDQUFDO0FBRXZD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