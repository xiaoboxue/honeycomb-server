'use strict';

const async = require('async');
const formstream = require('formstream');
const formidable = require('formidable');
const utils = require('../utils');
const log = require('../../../common/log');
const resultsWrap = utils.resultsWrap;

/**
 * 批处理接口，查询app列表.
 * @api /api/apps
 * @query {string} ips - 批处理调用single api时的ip 列表
 */
exports.listApps = function (req, res) {
  let ips = req.query.ips;
  ips = ips && ips.split(',');
  // ips 的校验统一在 utils.callremote 中执行
  let path = '/api/single/apps';
  utils.callremote(path, {method: 'GET', ips: ips}, function (err, results) {
    if (err) {
      log.error('Call remote failed:', err.stack);
      return res.json({
        code: 'ERROR',
        message: err.message
      });
    }
    let errors = [];
    let success = [];
    Object.keys(results).forEach(function (ip) {
      // 正常返回值 results[ip] 是app数组，如果不是数组，则说明single api接口返回了error
      if (Array.isArray(results[ip])) {
        let apps = [];
        results[ip].forEach(function (app) {
          app.ip = ip;
          apps.push(app);
        });
        success.push({
          ip: ip,
          apps: apps
        });
      } else {
        errors.push({
          ip: ip,
          message: results[ip].message || results[ip].stack || results[ip]
        });
      }
    });
    res.json({
      code: 'SUCCESS',
      data: {
        success: success,
        error: errors
      }
    });
  });
};

/**
 * 批处理接口，删除指定 app.
 * @api /api/delete/:appid
 * @query {string} ips - 批处理调用single api时的 ip 列表
 */
exports.deleteApps = function (req, res) {
  let ips = req.query.ips;
  ips = ips && ips.split(',');
  let appid = req.params && req.params.appid;
  let path = `/api/single/delete/${appid}`;
  utils.callremote(path, {method: 'DELETE', ips: ips, series: true}, function (err, results) {
    res.json(resultsWrap(err, results));
  });
};

exports.reloadApps = function (req, res) {
  let ips = req.query.ips;
  ips = ips && ips.split(',');
  let appid = req.params && req.params.appid;
  let path = `/api/single/reload/${appid}`;
  utils.callremote(path, {ips: ips, series: true}, function (err, results) {
    res.json(resultsWrap(err, results));
  });
};

exports.restartApps = function (req, res) {
  let ips = req.query.ips;
  ips = ips && ips.split(',');
  let appid = req.params && req.params.appid;
  let path = `/api/single/restart/${appid}`;
  utils.callremote(path, {ips: ips, series: true}, function (err, results) {
    res.json(resultsWrap(err, results));
  });
};

exports.startApps = function (req, res) {
  let ips = req.query.ips;
  ips = ips && ips.split(',');
  let appid = req.params && req.params.appid;
  let path = `/api/single/start/${appid}`;
  utils.callremote(path, {ips: ips}, function (err, results) {
    res.json(resultsWrap(err, results));
  });
};

exports.stopApps = function (req, res) {
  let ips = req.query.ips;
  ips = ips && ips.split(',');
  let appid = req.params && req.params.appid;
  let path = `/api/single/stop/${appid}`;
  utils.callremote(path, {method: 'DELETE', ips: ips}, function (err, results) {
    res.json(resultsWrap(err, results));
  });
};

/**
 * 发布包
 * query:
 *   ips {String} ip,ip,ip,ip
 *   nostart {Boolean} true
 * body: file.pkg
 */
exports.publish = function (req, res) {
  let ips = req.query.ips;
  let nostart = req.query.nostart;
  ips = ips && ips.split(',');
  async.waterfall([
    function (callback) {
      let form = new formidable.IncomingForm();
      form.parse(req, function (err, fields, files) {
        if (err) {
          err.message = 'uploading app package failed' + err.message;
          err.code = 'ERROR_UPLOAD_APP_PACKAGE';
          return callback(err);
        }
        if (!files || !Object.keys(files).length) {
          let err = new Error('app package empty');
          err.code = 'ERROR_APP_PACKAGE_EMPTY';
          return callback(err);
        }
        callback(null, files.pkg || files.appPkg || files.file);
      });
    },
    function (file, callback) {
      if (!/^[\w\-]+(_\d+\.\d+\.\d+_\d+)?\.tgz$/.test(file.name)) {
        return callback(new Error('illegal file name of your app.'));
      }
      log.info(`publish app "${file.name}" to servers:`, ips);
      let apiPath = '/api/single/publish';
      if (nostart) {
        apiPath += '?nostart=' + nostart;
      }
      utils.callremote(apiPath, {
        method: 'POST',
        ips: ips,
        prepare: function () {
          let form = formstream();
          form.file('pkg', file.path, file.name);
          this.headers = form.headers();
          this.stream = form;
        },
        series: true
      }, function (err, results) {
        callback(err, results);
      });
    }
  ], function (err, data) {
    res.json(resultsWrap(err, data));
  });
};

/**
 * 获取 app 配置
 */
exports.getAppConfig = function (req, res) {
  let ips = req.query.ips;
  let appName = req.params.appName;
  let type = req.params.type || 'app';
  ips = ips && ips.split(',');
  let path = `/api/single/config/${type}/${appName}`;
  utils.callremote(path, {
    method: 'GET',
    ips: ips
  }, function (err, results) {
    res.json(resultsWrap(err, results));
  });
};
/**
 * 设置 app 配置
 */
exports.setAppConfig = function (req, res) {
  let ips = req.query.ips;
  let appName = req.params.appName;
  let type = req.params.type || 'app';
  ips = ips && ips.split(',');
  let path = `/api/single/config/${type}/${appName}`;
  let data = req.body;
  utils.callremote(path, {
    method: 'POST',
    data: data,
    ips: ips
  }, function (err, results) {
    res.json(resultsWrap(err, results));
  });
};


exports.cleanAppExitRecord = function (req, res) {
  let ips = req.query.ips;
  let appId = req.params.appid;
  ips = ips && ips.split(',');
  let path = `/api/single/clean_exit_record/${appId}`;
  utils.callremote(path, {
    method: 'DELETE',
    ips: ips
  }, function (err, results) {
    res.json(resultsWrap(err, results));
  });
};

exports.online = function (req, res) {
  let ips = req.query.ips;
  ips = ips && ips.split(',');
  let path = '/api/single/online';
  utils.callremote(path, {
    method: 'GET',
    ips: ips
  }, function (err, results) {
    res.json(resultsWrap(err, results));
  });
};

exports.offline = function (req, res) {
  let ips = req.query.ips;
  ips = ips && ips.split(',');
  let path = '/api/single/offline';
  utils.callremote(path, {
    method: 'GET',
    ips: ips
  }, function (err, results) {
    res.json(resultsWrap(err, results));
  });
};

exports.listCoreDump = function (req, res) {
  let ips = req.query.ips;
  ips = ips && ips.split(',');
  let path = '/api/single/coredump';
  utils.callremote(path, {
    method: 'GET',
    ips: ips
  }, function (err, results) {
    res.json(resultsWrap(err, results));
  });
};

exports.listDeadProcess = function (req, res) {
  let ips = req.query.ips;
  ips = ips && ips.split(',');
  let path = '/api/single/dead_process';
  utils.callremote(path, {
    method: 'GET',
    ips: ips
  }, function (err, results) {
    res.json(resultsWrap(err, results));
  });
};

exports.deleteCoreDump = function (req, res) {
  let ips = req.query.ips;
  let body = req.body;
  ips = ips && ips.split(',');
  let path = '/api/single/coredump';
  utils.callremote(path, {
    method: 'POST',
    ips: ips,
    data: body
  }, function (err, results) {
    res.json(resultsWrap(err, results));
  });
};

exports.killDeadProcess = function (req, res) {
  let ips = req.query.ips;
  ips = ips && ips.split(',');
  let path = '/api/single/dead_process/' + req.params.pid;
  utils.callremote(path, {
    method: 'DELETE',
    ips: ips
  }, function (err, results) {
    res.json(resultsWrap(err, results));
  });
};