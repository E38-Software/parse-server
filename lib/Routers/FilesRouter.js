"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.FilesRouter = void 0;
var _express = _interopRequireDefault(require("express"));
var Middlewares = _interopRequireWildcard(require("../middlewares"));
var _node = _interopRequireDefault(require("parse/node"));
var _Config = _interopRequireDefault(require("../Config"));
var _logger = _interopRequireDefault(require("../logger"));
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const triggers = require('../triggers');
const Utils = require('../Utils');
class FilesRouter {
  expressRouter({
    maxUploadSize = '20Mb'
  } = {}) {
    var router = _express.default.Router();
    router.get('/files/:appId/:filename', this.getHandler);
    router.get('/files/:appId/metadata/:filename', this.metadataHandler);
    router.post('/files', function (req, res, next) {
      next(new _node.default.Error(_node.default.Error.INVALID_FILE_NAME, 'Filename not provided.'));
    });
    router.post('/files/:filename', _express.default.raw({
      type: () => {
        return true;
      },
      limit: maxUploadSize
    }),
    // Allow uploads without Content-Type, or with any Content-Type.
    Middlewares.handleParseHeaders, Middlewares.handleParseSession, this.createHandler);
    router.delete('/files/:filename', Middlewares.handleParseHeaders, Middlewares.handleParseSession, Middlewares.enforceMasterKeyAccess, this.deleteHandler);
    return router;
  }
  async getHandler(req, res) {
    const config = _Config.default.get(req.params.appId);
    if (!config) {
      res.status(403);
      const err = new _node.default.Error(_node.default.Error.OPERATION_FORBIDDEN, 'Invalid application ID.');
      res.json({
        code: err.code,
        error: err.message
      });
      return;
    }
    let filename = req.params.filename;
    try {
      const filesController = config.filesController;
      const mime = (await import('mime')).default;
      let contentType = mime.getType(filename);
      let file = new _node.default.File(filename, {
        base64: ''
      }, contentType);
      const triggerResult = await triggers.maybeRunFileTrigger(triggers.Types.beforeFind, {
        file
      }, config, req.auth);
      if (triggerResult?.file?._name) {
        filename = triggerResult?.file?._name;
        contentType = mime.getType(filename);
      }
      if (isFileStreamable(req, filesController)) {
        filesController.handleFileStream(config, filename, req, res, contentType).catch(() => {
          res.status(404);
          res.set('Content-Type', 'text/plain');
          res.end('File not found.');
        });
        return;
      }
      let data = await filesController.getFileData(config, filename).catch(() => {
        res.status(404);
        res.set('Content-Type', 'text/plain');
        res.end('File not found.');
      });
      if (!data) {
        return;
      }
      file = new _node.default.File(filename, {
        base64: data.toString('base64')
      }, contentType);
      const afterFind = await triggers.maybeRunFileTrigger(triggers.Types.afterFind, {
        file,
        forceDownload: false
      }, config, req.auth);
      if (afterFind?.file) {
        contentType = mime.getType(afterFind.file._name);
        data = Buffer.from(afterFind.file._data, 'base64');
      }
      res.status(200);
      res.set('Content-Type', contentType);
      res.set('Content-Length', data.length);
      if (afterFind.forceDownload) {
        res.set('Content-Disposition', `attachment;filename=${afterFind.file._name}`);
      }
      res.end(data);
    } catch (e) {
      const err = triggers.resolveError(e, {
        code: _node.default.Error.SCRIPT_FAILED,
        message: `Could not find file: ${filename}.`
      });
      res.status(403);
      res.json({
        code: err.code,
        error: err.message
      });
    }
  }
  async createHandler(req, res, next) {
    const config = req.config;
    const user = req.auth.user;
    const isMaster = req.auth.isMaster;
    const isLinked = user && _node.default.AnonymousUtils.isLinked(user);
    if (!isMaster && !config.fileUpload.enableForAnonymousUser && isLinked) {
      next(new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, 'File upload by anonymous user is disabled.'));
      return;
    }
    if (!isMaster && !config.fileUpload.enableForAuthenticatedUser && !isLinked && user) {
      next(new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, 'File upload by authenticated user is disabled.'));
      return;
    }
    if (!isMaster && !config.fileUpload.enableForPublic && !user) {
      next(new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, 'File upload by public is disabled.'));
      return;
    }
    const filesController = config.filesController;
    const {
      filename
    } = req.params;
    const contentType = req.get('Content-type');
    if (!req.body || !req.body.length) {
      next(new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, 'Invalid file upload.'));
      return;
    }
    const error = filesController.validateFilename(filename);
    if (error) {
      next(error);
      return;
    }
    const fileExtensions = config.fileUpload?.fileExtensions;
    if (!isMaster && fileExtensions) {
      const isValidExtension = extension => {
        return fileExtensions.some(ext => {
          if (ext === '*') {
            return true;
          }
          const regex = new RegExp(ext);
          if (regex.test(extension)) {
            return true;
          }
        });
      };
      let extension = contentType;
      if (filename && filename.includes('.')) {
        extension = filename.substring(filename.lastIndexOf('.') + 1);
      } else if (contentType && contentType.includes('/')) {
        extension = contentType.split('/')[1];
      }
      extension = extension?.split(' ')?.join('');
      if (extension && !isValidExtension(extension)) {
        next(new _node.default.Error(_node.default.Error.FILE_SAVE_ERROR, `File upload of extension ${extension} is disabled.`));
        return;
      }
    }
    const base64 = req.body.toString('base64');
    const file = new _node.default.File(filename, {
      base64
    }, contentType);
    const {
      metadata = {},
      tags = {}
    } = req.fileData || {};
    try {
      // Scan request data for denied keywords
      Utils.checkProhibitedKeywords(config, metadata);
      Utils.checkProhibitedKeywords(config, tags);
    } catch (error) {
      next(new _node.default.Error(_node.default.Error.INVALID_KEY_NAME, error));
      return;
    }
    file.setTags(tags);
    file.setMetadata(metadata);
    const fileSize = Buffer.byteLength(req.body);
    const fileObject = {
      file,
      fileSize
    };
    try {
      // run beforeSaveFile trigger
      const triggerResult = await triggers.maybeRunFileTrigger(triggers.Types.beforeSave, fileObject, config, req.auth);
      let saveResult;
      // if a new ParseFile is returned check if it's an already saved file
      if (triggerResult instanceof _node.default.File) {
        fileObject.file = triggerResult;
        if (triggerResult.url()) {
          // set fileSize to null because we wont know how big it is here
          fileObject.fileSize = null;
          saveResult = {
            url: triggerResult.url(),
            name: triggerResult._name
          };
        }
      }
      // if the file returned by the trigger has already been saved skip saving anything
      if (!saveResult) {
        // update fileSize
        const bufferData = Buffer.from(fileObject.file._data, 'base64');
        fileObject.fileSize = Buffer.byteLength(bufferData);
        // prepare file options
        const fileOptions = {
          metadata: fileObject.file._metadata
        };
        // some s3-compatible providers (DigitalOcean, Linode) do not accept tags
        // so we do not include the tags option if it is empty.
        const fileTags = Object.keys(fileObject.file._tags).length > 0 ? {
          tags: fileObject.file._tags
        } : {};
        Object.assign(fileOptions, fileTags);
        // save file
        const createFileResult = await filesController.createFile(config, fileObject.file._name, bufferData, fileObject.file._source.type, fileOptions);
        // update file with new data
        fileObject.file._name = createFileResult.name;
        fileObject.file._url = createFileResult.url;
        fileObject.file._requestTask = null;
        fileObject.file._previousSave = Promise.resolve(fileObject.file);
        saveResult = {
          url: createFileResult.url,
          name: createFileResult.name
        };
      }
      // run afterSaveFile trigger
      await triggers.maybeRunFileTrigger(triggers.Types.afterSave, fileObject, config, req.auth);
      res.status(201);
      res.set('Location', saveResult.url);
      res.json(saveResult);
    } catch (e) {
      _logger.default.error('Error creating a file: ', e);
      const error = triggers.resolveError(e, {
        code: _node.default.Error.FILE_SAVE_ERROR,
        message: `Could not store file: ${fileObject.file._name}.`
      });
      next(error);
    }
  }
  async deleteHandler(req, res, next) {
    try {
      const {
        filesController
      } = req.config;
      const {
        filename
      } = req.params;
      // run beforeDeleteFile trigger
      const file = new _node.default.File(filename);
      file._url = await filesController.adapter.getFileLocation(req.config, filename);
      const fileObject = {
        file,
        fileSize: null
      };
      await triggers.maybeRunFileTrigger(triggers.Types.beforeDelete, fileObject, req.config, req.auth);
      // delete file
      await filesController.deleteFile(req.config, filename);
      // run afterDeleteFile trigger
      await triggers.maybeRunFileTrigger(triggers.Types.afterDelete, fileObject, req.config, req.auth);
      res.status(200);
      // TODO: return useful JSON here?
      res.end();
    } catch (e) {
      _logger.default.error('Error deleting a file: ', e);
      const error = triggers.resolveError(e, {
        code: _node.default.Error.FILE_DELETE_ERROR,
        message: 'Could not delete file.'
      });
      next(error);
    }
  }
  async metadataHandler(req, res) {
    try {
      const config = _Config.default.get(req.params.appId);
      const {
        filesController
      } = config;
      const {
        filename
      } = req.params;
      const data = await filesController.getMetadata(filename);
      res.status(200);
      res.json(data);
    } catch (e) {
      res.status(200);
      res.json({});
    }
  }
}
exports.FilesRouter = FilesRouter;
function isFileStreamable(req, filesController) {
  const range = (req.get('Range') || '/-/').split('-');
  const start = Number(range[0]);
  const end = Number(range[1]);
  return (!isNaN(start) || !isNaN(end)) && typeof filesController.adapter.handleFileStream === 'function';
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfZXhwcmVzcyIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiTWlkZGxld2FyZXMiLCJfaW50ZXJvcFJlcXVpcmVXaWxkY2FyZCIsIl9ub2RlIiwiX0NvbmZpZyIsIl9sb2dnZXIiLCJlIiwidCIsIldlYWtNYXAiLCJyIiwibiIsIl9fZXNNb2R1bGUiLCJvIiwiaSIsImYiLCJfX3Byb3RvX18iLCJkZWZhdWx0IiwiaGFzIiwiZ2V0Iiwic2V0IiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwiT2JqZWN0IiwiZGVmaW5lUHJvcGVydHkiLCJnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IiLCJ0cmlnZ2VycyIsIlV0aWxzIiwiRmlsZXNSb3V0ZXIiLCJleHByZXNzUm91dGVyIiwibWF4VXBsb2FkU2l6ZSIsInJvdXRlciIsImV4cHJlc3MiLCJSb3V0ZXIiLCJnZXRIYW5kbGVyIiwibWV0YWRhdGFIYW5kbGVyIiwicG9zdCIsInJlcSIsInJlcyIsIm5leHQiLCJQYXJzZSIsIkVycm9yIiwiSU5WQUxJRF9GSUxFX05BTUUiLCJyYXciLCJ0eXBlIiwibGltaXQiLCJoYW5kbGVQYXJzZUhlYWRlcnMiLCJoYW5kbGVQYXJzZVNlc3Npb24iLCJjcmVhdGVIYW5kbGVyIiwiZGVsZXRlIiwiZW5mb3JjZU1hc3RlcktleUFjY2VzcyIsImRlbGV0ZUhhbmRsZXIiLCJjb25maWciLCJDb25maWciLCJwYXJhbXMiLCJhcHBJZCIsInN0YXR1cyIsImVyciIsIk9QRVJBVElPTl9GT1JCSURERU4iLCJqc29uIiwiY29kZSIsImVycm9yIiwibWVzc2FnZSIsImZpbGVuYW1lIiwiZmlsZXNDb250cm9sbGVyIiwibWltZSIsImNvbnRlbnRUeXBlIiwiZ2V0VHlwZSIsImZpbGUiLCJGaWxlIiwiYmFzZTY0IiwidHJpZ2dlclJlc3VsdCIsIm1heWJlUnVuRmlsZVRyaWdnZXIiLCJUeXBlcyIsImJlZm9yZUZpbmQiLCJhdXRoIiwiX25hbWUiLCJpc0ZpbGVTdHJlYW1hYmxlIiwiaGFuZGxlRmlsZVN0cmVhbSIsImNhdGNoIiwiZW5kIiwiZGF0YSIsImdldEZpbGVEYXRhIiwidG9TdHJpbmciLCJhZnRlckZpbmQiLCJmb3JjZURvd25sb2FkIiwiQnVmZmVyIiwiZnJvbSIsIl9kYXRhIiwibGVuZ3RoIiwicmVzb2x2ZUVycm9yIiwiU0NSSVBUX0ZBSUxFRCIsInVzZXIiLCJpc01hc3RlciIsImlzTGlua2VkIiwiQW5vbnltb3VzVXRpbHMiLCJmaWxlVXBsb2FkIiwiZW5hYmxlRm9yQW5vbnltb3VzVXNlciIsIkZJTEVfU0FWRV9FUlJPUiIsImVuYWJsZUZvckF1dGhlbnRpY2F0ZWRVc2VyIiwiZW5hYmxlRm9yUHVibGljIiwiYm9keSIsInZhbGlkYXRlRmlsZW5hbWUiLCJmaWxlRXh0ZW5zaW9ucyIsImlzVmFsaWRFeHRlbnNpb24iLCJleHRlbnNpb24iLCJzb21lIiwiZXh0IiwicmVnZXgiLCJSZWdFeHAiLCJ0ZXN0IiwiaW5jbHVkZXMiLCJzdWJzdHJpbmciLCJsYXN0SW5kZXhPZiIsInNwbGl0Iiwiam9pbiIsIm1ldGFkYXRhIiwidGFncyIsImZpbGVEYXRhIiwiY2hlY2tQcm9oaWJpdGVkS2V5d29yZHMiLCJJTlZBTElEX0tFWV9OQU1FIiwic2V0VGFncyIsInNldE1ldGFkYXRhIiwiZmlsZVNpemUiLCJieXRlTGVuZ3RoIiwiZmlsZU9iamVjdCIsImJlZm9yZVNhdmUiLCJzYXZlUmVzdWx0IiwidXJsIiwibmFtZSIsImJ1ZmZlckRhdGEiLCJmaWxlT3B0aW9ucyIsIl9tZXRhZGF0YSIsImZpbGVUYWdzIiwia2V5cyIsIl90YWdzIiwiYXNzaWduIiwiY3JlYXRlRmlsZVJlc3VsdCIsImNyZWF0ZUZpbGUiLCJfc291cmNlIiwiX3VybCIsIl9yZXF1ZXN0VGFzayIsIl9wcmV2aW91c1NhdmUiLCJQcm9taXNlIiwicmVzb2x2ZSIsImFmdGVyU2F2ZSIsImxvZ2dlciIsImFkYXB0ZXIiLCJnZXRGaWxlTG9jYXRpb24iLCJiZWZvcmVEZWxldGUiLCJkZWxldGVGaWxlIiwiYWZ0ZXJEZWxldGUiLCJGSUxFX0RFTEVURV9FUlJPUiIsImdldE1ldGFkYXRhIiwiZXhwb3J0cyIsInJhbmdlIiwic3RhcnQiLCJOdW1iZXIiLCJpc05hTiJdLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9Sb3V0ZXJzL0ZpbGVzUm91dGVyLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBleHByZXNzIGZyb20gJ2V4cHJlc3MnO1xuaW1wb3J0ICogYXMgTWlkZGxld2FyZXMgZnJvbSAnLi4vbWlkZGxld2FyZXMnO1xuaW1wb3J0IFBhcnNlIGZyb20gJ3BhcnNlL25vZGUnO1xuaW1wb3J0IENvbmZpZyBmcm9tICcuLi9Db25maWcnO1xuaW1wb3J0IGxvZ2dlciBmcm9tICcuLi9sb2dnZXInO1xuY29uc3QgdHJpZ2dlcnMgPSByZXF1aXJlKCcuLi90cmlnZ2VycycpO1xuY29uc3QgVXRpbHMgPSByZXF1aXJlKCcuLi9VdGlscycpO1xuXG5leHBvcnQgY2xhc3MgRmlsZXNSb3V0ZXIge1xuICBleHByZXNzUm91dGVyKHsgbWF4VXBsb2FkU2l6ZSA9ICcyME1iJyB9ID0ge30pIHtcbiAgICB2YXIgcm91dGVyID0gZXhwcmVzcy5Sb3V0ZXIoKTtcbiAgICByb3V0ZXIuZ2V0KCcvZmlsZXMvOmFwcElkLzpmaWxlbmFtZScsIHRoaXMuZ2V0SGFuZGxlcik7XG4gICAgcm91dGVyLmdldCgnL2ZpbGVzLzphcHBJZC9tZXRhZGF0YS86ZmlsZW5hbWUnLCB0aGlzLm1ldGFkYXRhSGFuZGxlcik7XG5cbiAgICByb3V0ZXIucG9zdCgnL2ZpbGVzJywgZnVuY3Rpb24gKHJlcSwgcmVzLCBuZXh0KSB7XG4gICAgICBuZXh0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0ZJTEVfTkFNRSwgJ0ZpbGVuYW1lIG5vdCBwcm92aWRlZC4nKSk7XG4gICAgfSk7XG5cbiAgICByb3V0ZXIucG9zdChcbiAgICAgICcvZmlsZXMvOmZpbGVuYW1lJyxcbiAgICAgIGV4cHJlc3MucmF3KHtcbiAgICAgICAgdHlwZTogKCkgPT4ge1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuICAgICAgICBsaW1pdDogbWF4VXBsb2FkU2l6ZSxcbiAgICAgIH0pLCAvLyBBbGxvdyB1cGxvYWRzIHdpdGhvdXQgQ29udGVudC1UeXBlLCBvciB3aXRoIGFueSBDb250ZW50LVR5cGUuXG4gICAgICBNaWRkbGV3YXJlcy5oYW5kbGVQYXJzZUhlYWRlcnMsXG4gICAgICBNaWRkbGV3YXJlcy5oYW5kbGVQYXJzZVNlc3Npb24sXG4gICAgICB0aGlzLmNyZWF0ZUhhbmRsZXJcbiAgICApO1xuXG4gICAgcm91dGVyLmRlbGV0ZShcbiAgICAgICcvZmlsZXMvOmZpbGVuYW1lJyxcbiAgICAgIE1pZGRsZXdhcmVzLmhhbmRsZVBhcnNlSGVhZGVycyxcbiAgICAgIE1pZGRsZXdhcmVzLmhhbmRsZVBhcnNlU2Vzc2lvbixcbiAgICAgIE1pZGRsZXdhcmVzLmVuZm9yY2VNYXN0ZXJLZXlBY2Nlc3MsXG4gICAgICB0aGlzLmRlbGV0ZUhhbmRsZXJcbiAgICApO1xuICAgIHJldHVybiByb3V0ZXI7XG4gIH1cblxuICBhc3luYyBnZXRIYW5kbGVyKHJlcSwgcmVzKSB7XG4gICAgY29uc3QgY29uZmlnID0gQ29uZmlnLmdldChyZXEucGFyYW1zLmFwcElkKTtcbiAgICBpZiAoIWNvbmZpZykge1xuICAgICAgcmVzLnN0YXR1cyg0MDMpO1xuICAgICAgY29uc3QgZXJyID0gbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sICdJbnZhbGlkIGFwcGxpY2F0aW9uIElELicpO1xuICAgICAgcmVzLmpzb24oeyBjb2RlOiBlcnIuY29kZSwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGxldCBmaWxlbmFtZSA9IHJlcS5wYXJhbXMuZmlsZW5hbWU7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGZpbGVzQ29udHJvbGxlciA9IGNvbmZpZy5maWxlc0NvbnRyb2xsZXI7XG4gICAgICBjb25zdCBtaW1lID0gKGF3YWl0IGltcG9ydCgnbWltZScpKS5kZWZhdWx0O1xuICAgICAgbGV0IGNvbnRlbnRUeXBlID0gbWltZS5nZXRUeXBlKGZpbGVuYW1lKTtcbiAgICAgIGxldCBmaWxlID0gbmV3IFBhcnNlLkZpbGUoZmlsZW5hbWUsIHsgYmFzZTY0OiAnJyB9LCBjb250ZW50VHlwZSk7XG4gICAgICBjb25zdCB0cmlnZ2VyUmVzdWx0ID0gYXdhaXQgdHJpZ2dlcnMubWF5YmVSdW5GaWxlVHJpZ2dlcihcbiAgICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlRmluZCxcbiAgICAgICAgeyBmaWxlIH0sXG4gICAgICAgIGNvbmZpZyxcbiAgICAgICAgcmVxLmF1dGhcbiAgICAgICk7XG4gICAgICBpZiAodHJpZ2dlclJlc3VsdD8uZmlsZT8uX25hbWUpIHtcbiAgICAgICAgZmlsZW5hbWUgPSB0cmlnZ2VyUmVzdWx0Py5maWxlPy5fbmFtZTtcbiAgICAgICAgY29udGVudFR5cGUgPSBtaW1lLmdldFR5cGUoZmlsZW5hbWUpO1xuICAgICAgfVxuXG4gICAgICBpZiAoaXNGaWxlU3RyZWFtYWJsZShyZXEsIGZpbGVzQ29udHJvbGxlcikpIHtcbiAgICAgICAgZmlsZXNDb250cm9sbGVyLmhhbmRsZUZpbGVTdHJlYW0oY29uZmlnLCBmaWxlbmFtZSwgcmVxLCByZXMsIGNvbnRlbnRUeXBlKS5jYXRjaCgoKSA9PiB7XG4gICAgICAgICAgcmVzLnN0YXR1cyg0MDQpO1xuICAgICAgICAgIHJlcy5zZXQoJ0NvbnRlbnQtVHlwZScsICd0ZXh0L3BsYWluJyk7XG4gICAgICAgICAgcmVzLmVuZCgnRmlsZSBub3QgZm91bmQuJyk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGxldCBkYXRhID0gYXdhaXQgZmlsZXNDb250cm9sbGVyLmdldEZpbGVEYXRhKGNvbmZpZywgZmlsZW5hbWUpLmNhdGNoKCgpID0+IHtcbiAgICAgICAgcmVzLnN0YXR1cyg0MDQpO1xuICAgICAgICByZXMuc2V0KCdDb250ZW50LVR5cGUnLCAndGV4dC9wbGFpbicpO1xuICAgICAgICByZXMuZW5kKCdGaWxlIG5vdCBmb3VuZC4nKTtcbiAgICAgIH0pO1xuICAgICAgaWYgKCFkYXRhKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGZpbGUgPSBuZXcgUGFyc2UuRmlsZShmaWxlbmFtZSwgeyBiYXNlNjQ6IGRhdGEudG9TdHJpbmcoJ2Jhc2U2NCcpIH0sIGNvbnRlbnRUeXBlKTtcbiAgICAgIGNvbnN0IGFmdGVyRmluZCA9IGF3YWl0IHRyaWdnZXJzLm1heWJlUnVuRmlsZVRyaWdnZXIoXG4gICAgICAgIHRyaWdnZXJzLlR5cGVzLmFmdGVyRmluZCxcbiAgICAgICAgeyBmaWxlLCBmb3JjZURvd25sb2FkOiBmYWxzZSB9LFxuICAgICAgICBjb25maWcsXG4gICAgICAgIHJlcS5hdXRoXG4gICAgICApO1xuXG4gICAgICBpZiAoYWZ0ZXJGaW5kPy5maWxlKSB7XG4gICAgICAgIGNvbnRlbnRUeXBlID0gbWltZS5nZXRUeXBlKGFmdGVyRmluZC5maWxlLl9uYW1lKTtcbiAgICAgICAgZGF0YSA9IEJ1ZmZlci5mcm9tKGFmdGVyRmluZC5maWxlLl9kYXRhLCAnYmFzZTY0Jyk7XG4gICAgICB9XG5cbiAgICAgIHJlcy5zdGF0dXMoMjAwKTtcbiAgICAgIHJlcy5zZXQoJ0NvbnRlbnQtVHlwZScsIGNvbnRlbnRUeXBlKTtcbiAgICAgIHJlcy5zZXQoJ0NvbnRlbnQtTGVuZ3RoJywgZGF0YS5sZW5ndGgpO1xuICAgICAgaWYgKGFmdGVyRmluZC5mb3JjZURvd25sb2FkKSB7XG4gICAgICAgIHJlcy5zZXQoJ0NvbnRlbnQtRGlzcG9zaXRpb24nLCBgYXR0YWNobWVudDtmaWxlbmFtZT0ke2FmdGVyRmluZC5maWxlLl9uYW1lfWApO1xuICAgICAgfVxuICAgICAgcmVzLmVuZChkYXRhKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zdCBlcnIgPSB0cmlnZ2Vycy5yZXNvbHZlRXJyb3IoZSwge1xuICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELFxuICAgICAgICBtZXNzYWdlOiBgQ291bGQgbm90IGZpbmQgZmlsZTogJHtmaWxlbmFtZX0uYCxcbiAgICAgIH0pO1xuICAgICAgcmVzLnN0YXR1cyg0MDMpO1xuICAgICAgcmVzLmpzb24oeyBjb2RlOiBlcnIuY29kZSwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIGNyZWF0ZUhhbmRsZXIocmVxLCByZXMsIG5leHQpIHtcbiAgICBjb25zdCBjb25maWcgPSByZXEuY29uZmlnO1xuICAgIGNvbnN0IHVzZXIgPSByZXEuYXV0aC51c2VyO1xuICAgIGNvbnN0IGlzTWFzdGVyID0gcmVxLmF1dGguaXNNYXN0ZXI7XG4gICAgY29uc3QgaXNMaW5rZWQgPSB1c2VyICYmIFBhcnNlLkFub255bW91c1V0aWxzLmlzTGlua2VkKHVzZXIpO1xuICAgIGlmICghaXNNYXN0ZXIgJiYgIWNvbmZpZy5maWxlVXBsb2FkLmVuYWJsZUZvckFub255bW91c1VzZXIgJiYgaXNMaW5rZWQpIHtcbiAgICAgIG5leHQoXG4gICAgICAgIG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5GSUxFX1NBVkVfRVJST1IsICdGaWxlIHVwbG9hZCBieSBhbm9ueW1vdXMgdXNlciBpcyBkaXNhYmxlZC4nKVxuICAgICAgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKCFpc01hc3RlciAmJiAhY29uZmlnLmZpbGVVcGxvYWQuZW5hYmxlRm9yQXV0aGVudGljYXRlZFVzZXIgJiYgIWlzTGlua2VkICYmIHVzZXIpIHtcbiAgICAgIG5leHQoXG4gICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5GSUxFX1NBVkVfRVJST1IsXG4gICAgICAgICAgJ0ZpbGUgdXBsb2FkIGJ5IGF1dGhlbnRpY2F0ZWQgdXNlciBpcyBkaXNhYmxlZC4nXG4gICAgICAgIClcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghaXNNYXN0ZXIgJiYgIWNvbmZpZy5maWxlVXBsb2FkLmVuYWJsZUZvclB1YmxpYyAmJiAhdXNlcikge1xuICAgICAgbmV4dChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRklMRV9TQVZFX0VSUk9SLCAnRmlsZSB1cGxvYWQgYnkgcHVibGljIGlzIGRpc2FibGVkLicpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgZmlsZXNDb250cm9sbGVyID0gY29uZmlnLmZpbGVzQ29udHJvbGxlcjtcbiAgICBjb25zdCB7IGZpbGVuYW1lIH0gPSByZXEucGFyYW1zO1xuICAgIGNvbnN0IGNvbnRlbnRUeXBlID0gcmVxLmdldCgnQ29udGVudC10eXBlJyk7XG5cbiAgICBpZiAoIXJlcS5ib2R5IHx8ICFyZXEuYm9keS5sZW5ndGgpIHtcbiAgICAgIG5leHQobmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLkZJTEVfU0FWRV9FUlJPUiwgJ0ludmFsaWQgZmlsZSB1cGxvYWQuJykpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGVycm9yID0gZmlsZXNDb250cm9sbGVyLnZhbGlkYXRlRmlsZW5hbWUoZmlsZW5hbWUpO1xuICAgIGlmIChlcnJvcikge1xuICAgICAgbmV4dChlcnJvcik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgZmlsZUV4dGVuc2lvbnMgPSBjb25maWcuZmlsZVVwbG9hZD8uZmlsZUV4dGVuc2lvbnM7XG4gICAgaWYgKCFpc01hc3RlciAmJiBmaWxlRXh0ZW5zaW9ucykge1xuICAgICAgY29uc3QgaXNWYWxpZEV4dGVuc2lvbiA9IGV4dGVuc2lvbiA9PiB7XG4gICAgICAgIHJldHVybiBmaWxlRXh0ZW5zaW9ucy5zb21lKGV4dCA9PiB7XG4gICAgICAgICAgaWYgKGV4dCA9PT0gJyonKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgcmVnZXggPSBuZXcgUmVnRXhwKGV4dCk7XG4gICAgICAgICAgaWYgKHJlZ2V4LnRlc3QoZXh0ZW5zaW9uKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgIH07XG4gICAgICBsZXQgZXh0ZW5zaW9uID0gY29udGVudFR5cGU7XG4gICAgICBpZiAoZmlsZW5hbWUgJiYgZmlsZW5hbWUuaW5jbHVkZXMoJy4nKSkge1xuICAgICAgICBleHRlbnNpb24gPSBmaWxlbmFtZS5zdWJzdHJpbmcoZmlsZW5hbWUubGFzdEluZGV4T2YoJy4nKSArIDEpO1xuICAgICAgfSBlbHNlIGlmIChjb250ZW50VHlwZSAmJiBjb250ZW50VHlwZS5pbmNsdWRlcygnLycpKSB7XG4gICAgICAgIGV4dGVuc2lvbiA9IGNvbnRlbnRUeXBlLnNwbGl0KCcvJylbMV07XG4gICAgICB9XG4gICAgICBleHRlbnNpb24gPSBleHRlbnNpb24/LnNwbGl0KCcgJyk/LmpvaW4oJycpO1xuXG4gICAgICBpZiAoZXh0ZW5zaW9uICYmICFpc1ZhbGlkRXh0ZW5zaW9uKGV4dGVuc2lvbikpIHtcbiAgICAgICAgbmV4dChcbiAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5GSUxFX1NBVkVfRVJST1IsXG4gICAgICAgICAgICBgRmlsZSB1cGxvYWQgb2YgZXh0ZW5zaW9uICR7ZXh0ZW5zaW9ufSBpcyBkaXNhYmxlZC5gXG4gICAgICAgICAgKVxuICAgICAgICApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgYmFzZTY0ID0gcmVxLmJvZHkudG9TdHJpbmcoJ2Jhc2U2NCcpO1xuICAgIGNvbnN0IGZpbGUgPSBuZXcgUGFyc2UuRmlsZShmaWxlbmFtZSwgeyBiYXNlNjQgfSwgY29udGVudFR5cGUpO1xuICAgIGNvbnN0IHsgbWV0YWRhdGEgPSB7fSwgdGFncyA9IHt9IH0gPSByZXEuZmlsZURhdGEgfHwge307XG4gICAgdHJ5IHtcbiAgICAgIC8vIFNjYW4gcmVxdWVzdCBkYXRhIGZvciBkZW5pZWQga2V5d29yZHNcbiAgICAgIFV0aWxzLmNoZWNrUHJvaGliaXRlZEtleXdvcmRzKGNvbmZpZywgbWV0YWRhdGEpO1xuICAgICAgVXRpbHMuY2hlY2tQcm9oaWJpdGVkS2V5d29yZHMoY29uZmlnLCB0YWdzKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgbmV4dChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgZXJyb3IpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZmlsZS5zZXRUYWdzKHRhZ3MpO1xuICAgIGZpbGUuc2V0TWV0YWRhdGEobWV0YWRhdGEpO1xuICAgIGNvbnN0IGZpbGVTaXplID0gQnVmZmVyLmJ5dGVMZW5ndGgocmVxLmJvZHkpO1xuICAgIGNvbnN0IGZpbGVPYmplY3QgPSB7IGZpbGUsIGZpbGVTaXplIH07XG4gICAgdHJ5IHtcbiAgICAgIC8vIHJ1biBiZWZvcmVTYXZlRmlsZSB0cmlnZ2VyXG4gICAgICBjb25zdCB0cmlnZ2VyUmVzdWx0ID0gYXdhaXQgdHJpZ2dlcnMubWF5YmVSdW5GaWxlVHJpZ2dlcihcbiAgICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlU2F2ZSxcbiAgICAgICAgZmlsZU9iamVjdCxcbiAgICAgICAgY29uZmlnLFxuICAgICAgICByZXEuYXV0aFxuICAgICAgKTtcbiAgICAgIGxldCBzYXZlUmVzdWx0O1xuICAgICAgLy8gaWYgYSBuZXcgUGFyc2VGaWxlIGlzIHJldHVybmVkIGNoZWNrIGlmIGl0J3MgYW4gYWxyZWFkeSBzYXZlZCBmaWxlXG4gICAgICBpZiAodHJpZ2dlclJlc3VsdCBpbnN0YW5jZW9mIFBhcnNlLkZpbGUpIHtcbiAgICAgICAgZmlsZU9iamVjdC5maWxlID0gdHJpZ2dlclJlc3VsdDtcbiAgICAgICAgaWYgKHRyaWdnZXJSZXN1bHQudXJsKCkpIHtcbiAgICAgICAgICAvLyBzZXQgZmlsZVNpemUgdG8gbnVsbCBiZWNhdXNlIHdlIHdvbnQga25vdyBob3cgYmlnIGl0IGlzIGhlcmVcbiAgICAgICAgICBmaWxlT2JqZWN0LmZpbGVTaXplID0gbnVsbDtcbiAgICAgICAgICBzYXZlUmVzdWx0ID0ge1xuICAgICAgICAgICAgdXJsOiB0cmlnZ2VyUmVzdWx0LnVybCgpLFxuICAgICAgICAgICAgbmFtZTogdHJpZ2dlclJlc3VsdC5fbmFtZSxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBpZiB0aGUgZmlsZSByZXR1cm5lZCBieSB0aGUgdHJpZ2dlciBoYXMgYWxyZWFkeSBiZWVuIHNhdmVkIHNraXAgc2F2aW5nIGFueXRoaW5nXG4gICAgICBpZiAoIXNhdmVSZXN1bHQpIHtcbiAgICAgICAgLy8gdXBkYXRlIGZpbGVTaXplXG4gICAgICAgIGNvbnN0IGJ1ZmZlckRhdGEgPSBCdWZmZXIuZnJvbShmaWxlT2JqZWN0LmZpbGUuX2RhdGEsICdiYXNlNjQnKTtcbiAgICAgICAgZmlsZU9iamVjdC5maWxlU2l6ZSA9IEJ1ZmZlci5ieXRlTGVuZ3RoKGJ1ZmZlckRhdGEpO1xuICAgICAgICAvLyBwcmVwYXJlIGZpbGUgb3B0aW9uc1xuICAgICAgICBjb25zdCBmaWxlT3B0aW9ucyA9IHtcbiAgICAgICAgICBtZXRhZGF0YTogZmlsZU9iamVjdC5maWxlLl9tZXRhZGF0YSxcbiAgICAgICAgfTtcbiAgICAgICAgLy8gc29tZSBzMy1jb21wYXRpYmxlIHByb3ZpZGVycyAoRGlnaXRhbE9jZWFuLCBMaW5vZGUpIGRvIG5vdCBhY2NlcHQgdGFnc1xuICAgICAgICAvLyBzbyB3ZSBkbyBub3QgaW5jbHVkZSB0aGUgdGFncyBvcHRpb24gaWYgaXQgaXMgZW1wdHkuXG4gICAgICAgIGNvbnN0IGZpbGVUYWdzID1cbiAgICAgICAgICBPYmplY3Qua2V5cyhmaWxlT2JqZWN0LmZpbGUuX3RhZ3MpLmxlbmd0aCA+IDAgPyB7IHRhZ3M6IGZpbGVPYmplY3QuZmlsZS5fdGFncyB9IDoge307XG4gICAgICAgIE9iamVjdC5hc3NpZ24oZmlsZU9wdGlvbnMsIGZpbGVUYWdzKTtcbiAgICAgICAgLy8gc2F2ZSBmaWxlXG4gICAgICAgIGNvbnN0IGNyZWF0ZUZpbGVSZXN1bHQgPSBhd2FpdCBmaWxlc0NvbnRyb2xsZXIuY3JlYXRlRmlsZShcbiAgICAgICAgICBjb25maWcsXG4gICAgICAgICAgZmlsZU9iamVjdC5maWxlLl9uYW1lLFxuICAgICAgICAgIGJ1ZmZlckRhdGEsXG4gICAgICAgICAgZmlsZU9iamVjdC5maWxlLl9zb3VyY2UudHlwZSxcbiAgICAgICAgICBmaWxlT3B0aW9uc1xuICAgICAgICApO1xuICAgICAgICAvLyB1cGRhdGUgZmlsZSB3aXRoIG5ldyBkYXRhXG4gICAgICAgIGZpbGVPYmplY3QuZmlsZS5fbmFtZSA9IGNyZWF0ZUZpbGVSZXN1bHQubmFtZTtcbiAgICAgICAgZmlsZU9iamVjdC5maWxlLl91cmwgPSBjcmVhdGVGaWxlUmVzdWx0LnVybDtcbiAgICAgICAgZmlsZU9iamVjdC5maWxlLl9yZXF1ZXN0VGFzayA9IG51bGw7XG4gICAgICAgIGZpbGVPYmplY3QuZmlsZS5fcHJldmlvdXNTYXZlID0gUHJvbWlzZS5yZXNvbHZlKGZpbGVPYmplY3QuZmlsZSk7XG4gICAgICAgIHNhdmVSZXN1bHQgPSB7XG4gICAgICAgICAgdXJsOiBjcmVhdGVGaWxlUmVzdWx0LnVybCxcbiAgICAgICAgICBuYW1lOiBjcmVhdGVGaWxlUmVzdWx0Lm5hbWUsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICAvLyBydW4gYWZ0ZXJTYXZlRmlsZSB0cmlnZ2VyXG4gICAgICBhd2FpdCB0cmlnZ2Vycy5tYXliZVJ1bkZpbGVUcmlnZ2VyKHRyaWdnZXJzLlR5cGVzLmFmdGVyU2F2ZSwgZmlsZU9iamVjdCwgY29uZmlnLCByZXEuYXV0aCk7XG4gICAgICByZXMuc3RhdHVzKDIwMSk7XG4gICAgICByZXMuc2V0KCdMb2NhdGlvbicsIHNhdmVSZXN1bHQudXJsKTtcbiAgICAgIHJlcy5qc29uKHNhdmVSZXN1bHQpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGxvZ2dlci5lcnJvcignRXJyb3IgY3JlYXRpbmcgYSBmaWxlOiAnLCBlKTtcbiAgICAgIGNvbnN0IGVycm9yID0gdHJpZ2dlcnMucmVzb2x2ZUVycm9yKGUsIHtcbiAgICAgICAgY29kZTogUGFyc2UuRXJyb3IuRklMRV9TQVZFX0VSUk9SLFxuICAgICAgICBtZXNzYWdlOiBgQ291bGQgbm90IHN0b3JlIGZpbGU6ICR7ZmlsZU9iamVjdC5maWxlLl9uYW1lfS5gLFxuICAgICAgfSk7XG4gICAgICBuZXh0KGVycm9yKTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBkZWxldGVIYW5kbGVyKHJlcSwgcmVzLCBuZXh0KSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgZmlsZXNDb250cm9sbGVyIH0gPSByZXEuY29uZmlnO1xuICAgICAgY29uc3QgeyBmaWxlbmFtZSB9ID0gcmVxLnBhcmFtcztcbiAgICAgIC8vIHJ1biBiZWZvcmVEZWxldGVGaWxlIHRyaWdnZXJcbiAgICAgIGNvbnN0IGZpbGUgPSBuZXcgUGFyc2UuRmlsZShmaWxlbmFtZSk7XG4gICAgICBmaWxlLl91cmwgPSBhd2FpdCBmaWxlc0NvbnRyb2xsZXIuYWRhcHRlci5nZXRGaWxlTG9jYXRpb24ocmVxLmNvbmZpZywgZmlsZW5hbWUpO1xuICAgICAgY29uc3QgZmlsZU9iamVjdCA9IHsgZmlsZSwgZmlsZVNpemU6IG51bGwgfTtcbiAgICAgIGF3YWl0IHRyaWdnZXJzLm1heWJlUnVuRmlsZVRyaWdnZXIoXG4gICAgICAgIHRyaWdnZXJzLlR5cGVzLmJlZm9yZURlbGV0ZSxcbiAgICAgICAgZmlsZU9iamVjdCxcbiAgICAgICAgcmVxLmNvbmZpZyxcbiAgICAgICAgcmVxLmF1dGhcbiAgICAgICk7XG4gICAgICAvLyBkZWxldGUgZmlsZVxuICAgICAgYXdhaXQgZmlsZXNDb250cm9sbGVyLmRlbGV0ZUZpbGUocmVxLmNvbmZpZywgZmlsZW5hbWUpO1xuICAgICAgLy8gcnVuIGFmdGVyRGVsZXRlRmlsZSB0cmlnZ2VyXG4gICAgICBhd2FpdCB0cmlnZ2Vycy5tYXliZVJ1bkZpbGVUcmlnZ2VyKFxuICAgICAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlckRlbGV0ZSxcbiAgICAgICAgZmlsZU9iamVjdCxcbiAgICAgICAgcmVxLmNvbmZpZyxcbiAgICAgICAgcmVxLmF1dGhcbiAgICAgICk7XG4gICAgICByZXMuc3RhdHVzKDIwMCk7XG4gICAgICAvLyBUT0RPOiByZXR1cm4gdXNlZnVsIEpTT04gaGVyZT9cbiAgICAgIHJlcy5lbmQoKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2dnZXIuZXJyb3IoJ0Vycm9yIGRlbGV0aW5nIGEgZmlsZTogJywgZSk7XG4gICAgICBjb25zdCBlcnJvciA9IHRyaWdnZXJzLnJlc29sdmVFcnJvcihlLCB7XG4gICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLkZJTEVfREVMRVRFX0VSUk9SLFxuICAgICAgICBtZXNzYWdlOiAnQ291bGQgbm90IGRlbGV0ZSBmaWxlLicsXG4gICAgICB9KTtcbiAgICAgIG5leHQoZXJyb3IpO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIG1ldGFkYXRhSGFuZGxlcihyZXEsIHJlcykge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjb25maWcgPSBDb25maWcuZ2V0KHJlcS5wYXJhbXMuYXBwSWQpO1xuICAgICAgY29uc3QgeyBmaWxlc0NvbnRyb2xsZXIgfSA9IGNvbmZpZztcbiAgICAgIGNvbnN0IHsgZmlsZW5hbWUgfSA9IHJlcS5wYXJhbXM7XG4gICAgICBjb25zdCBkYXRhID0gYXdhaXQgZmlsZXNDb250cm9sbGVyLmdldE1ldGFkYXRhKGZpbGVuYW1lKTtcbiAgICAgIHJlcy5zdGF0dXMoMjAwKTtcbiAgICAgIHJlcy5qc29uKGRhdGEpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHJlcy5zdGF0dXMoMjAwKTtcbiAgICAgIHJlcy5qc29uKHt9KTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gaXNGaWxlU3RyZWFtYWJsZShyZXEsIGZpbGVzQ29udHJvbGxlcikge1xuICBjb25zdCByYW5nZSA9IChyZXEuZ2V0KCdSYW5nZScpIHx8ICcvLS8nKS5zcGxpdCgnLScpO1xuICBjb25zdCBzdGFydCA9IE51bWJlcihyYW5nZVswXSk7XG4gIGNvbnN0IGVuZCA9IE51bWJlcihyYW5nZVsxXSk7XG4gIHJldHVybiAoXG4gICAgKCFpc05hTihzdGFydCkgfHwgIWlzTmFOKGVuZCkpICYmIHR5cGVvZiBmaWxlc0NvbnRyb2xsZXIuYWRhcHRlci5oYW5kbGVGaWxlU3RyZWFtID09PSAnZnVuY3Rpb24nXG4gICk7XG59XG4iXSwibWFwcGluZ3MiOiI7Ozs7OztBQUFBLElBQUFBLFFBQUEsR0FBQUMsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFDLFdBQUEsR0FBQUMsdUJBQUEsQ0FBQUYsT0FBQTtBQUNBLElBQUFHLEtBQUEsR0FBQUosc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFJLE9BQUEsR0FBQUwsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFLLE9BQUEsR0FBQU4sc0JBQUEsQ0FBQUMsT0FBQTtBQUErQixTQUFBRSx3QkFBQUksQ0FBQSxFQUFBQyxDQUFBLDZCQUFBQyxPQUFBLE1BQUFDLENBQUEsT0FBQUQsT0FBQSxJQUFBRSxDQUFBLE9BQUFGLE9BQUEsWUFBQU4sdUJBQUEsWUFBQUEsQ0FBQUksQ0FBQSxFQUFBQyxDQUFBLFNBQUFBLENBQUEsSUFBQUQsQ0FBQSxJQUFBQSxDQUFBLENBQUFLLFVBQUEsU0FBQUwsQ0FBQSxNQUFBTSxDQUFBLEVBQUFDLENBQUEsRUFBQUMsQ0FBQSxLQUFBQyxTQUFBLFFBQUFDLE9BQUEsRUFBQVYsQ0FBQSxpQkFBQUEsQ0FBQSx1QkFBQUEsQ0FBQSx5QkFBQUEsQ0FBQSxTQUFBUSxDQUFBLE1BQUFGLENBQUEsR0FBQUwsQ0FBQSxHQUFBRyxDQUFBLEdBQUFELENBQUEsUUFBQUcsQ0FBQSxDQUFBSyxHQUFBLENB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