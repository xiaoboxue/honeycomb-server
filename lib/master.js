'use strict';

if (
  typeof process.setuid === 'function' &&
  typeof process.setgid === 'function' &&
  typeof process.getuid === 'function' &&
  typeof process.getgid === 'function'
) {
  process.setuid(process.getuid());
  process.setgid(process.getgid());
}

const fs = require('xfs');
const _ = require('lodash');
const path = require('path');
// const util = require('util');
const async = require('async');
const EventEmitter = require('events');

const Proxy = require('./proxy');
const Child = require('./child');
const Session = require('./session');
const log = require('../common/log');
const message = require('./message');
const utils = require('../common/utils');

const APPID_PROXY = '__PROXY__';
const APPID_ADMIN = '__ADMIN__';

let FLAG_MASTER = 'MASTER';

/**
 * Class Master
 * @param {Object} config
 *        - runDir
 *        - pidFile
 *        - workers
 */
class Master extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.online = true;
    /**
     * app的运行时状态
     * @type {Object}
     *       key: appName
     *       value: Child instance
     */
    this.children = {};
    this.adminApiFile = path.join(__dirname, '../lib/admin');
    // this.proxyFile = path.join(__dirname, '../lib/proxy');
    this.appSession = new Session({file: config.appsSessionPath});

    this.startTime = new Date().getTime();
    /**
     *
     * @type {Object}
     * {
     *   system: ['system_1.2.1_2', 'system_1.1.0_1'],
     *   analysis: ['analysis_2.1.1_2]'
     * }
     * 取数组的第一个元素为 current working 版本
     */
    this.onlineApps = {};

    process.nextTick(() => {
      this.emit('ready');
    });
  }
}

Master.prototype.init = function (done) {
  // init run dir, and write down pid file
  utils.mkdirp(this.config.runDir);
  utils.mkdirp(this.config.appsRoot);
  utils.mkdirp(path.join(this.config.proxy.nginxIncludePath, 'http'));
  utils.mkdirp(path.join(this.config.proxy.nginxIncludePath, 'stream'));
  fs.writeFileSync(this.config.pidFile, process.pid);
  fs.writeFileSync(this.config.serverStatusFile, 'online');
  let self = this;

  function shutdown(sig, err) {
    log.error(FLAG_MASTER, `server received ${sig}, will shutdown.`, err ? err.stack || err : '');
    self.exit(function () {
      process.exit(1);
    });
  }

  process.on('uncaughtException', function (err) {
    shutdown('uncaughtException', err);
  });
  process.on('unhandledRejection', (reason, p) => {
    log.error('UnhandledRejection', `at: Promise ${p}, reason: ${reason}`);
  });
  // 服务上下线信号，收到信号之后，广播各app, 切换上下线状态
  // SIGUSR2 can be code: 31|12|17, using `kill -l` to check which code in your system
  process.on('SIGUSR2', () => {
    let status;
    try {
      status = fs.readFileSync(this.config.serverStatusFile).toString();
    } catch (e) {
      status = '';
    }
    switch (status) {
      case 'online':
        this.$online();
        break;
      case 'offline':
        this.$offline();
        break;
      default:
        log.warn(FLAG_MASTER, 'unknow SIGUSR2', status);
    }
    return false;
  });
  // 终端指令关闭进程 kill -15
  process.on('SIGTERM', function () {
    shutdown('SIGTERM');
  });
  // 终端退出时
  process.on('SIGHUB', function () {
    shutdown('SIGHUB');
  });
  process.on('SIGQUIT', function () {
    shutdown('SIGQUIT');
  });
  // Ctrl-C 退出
  process.on('SIGINT', function () {
    shutdown('SIGINT');
  });
  process.on('SIGABRT', function () {
    let err = 'recived system abort request,maybe system resouce was bleeding.please check you machine resouce: ram, hard driver, io socket...';
    shutdown('SIGABRT', err);
  });

  // 监听app_ready事件
  this.on('app_ready', function (message, done) {
    log.info(FLAG_MASTER, `app:${message.appId} ready`);
    let cfg = message;
    // 内置app
    if ([APPID_PROXY, APPID_ADMIN].indexOf(cfg.appId) !== -1) {
      done();
      return log.info(FLAG_MASTER, `inner_app_ready ${cfg.appId}, ignore register proxy`);
    }

    if (self.onlineApps[cfg.name]) {
      self.onlineApps[cfg.name].push(cfg.appId);
    } else {
      self.onlineApps[cfg.name] = [cfg.appId];
    }
    // 倒叙排，保证最大版本在前面
    self.onlineApps[cfg.name].sort((a, b) => {
      let aid = utils.parseAppId(a);
      let bid = utils.parseAppId(b);
      return utils.genWeight(bid.version, bid.buildNum) - utils.genWeight(aid.version, aid.buildNum);
    });

    if (!cfg.target) {
      log.warn(FLAG_MASTER, `app_missing_target : "${cfg.appId}",  start as daemon`);
      // if no target, so this is an daemond app, not a web app
      return done();
    }
    self.proxy.register(cfg, done);
  });

  done();
};

Master.prototype.getChild = function (appId) {
  return this.children[appId];
};
/**
 * 启动子进程
 * @param  {String}   appKey    appName like `appabc_1.0.0`
 * @param  {Object}   options
 *         - file {Path} the app enter file
 *         - appId
 *
 * @param  {Function} cb(err)
 */
Master.prototype._fork = function (appId, options, cb) {
  let callbackOnce = false;
  options.appId = appId;
  options.appRoot = options.file;
  let child = this.children[appId];
  if (child && child.status !== 'offline') {
    return cb(new Error(appId + ' already exists, Options: ' + JSON.stringify(options)));
  } else {
    child = new Child(appId);
  }

  try {
    require.resolve(options.file);
  } catch (e) {
    return cb(new Error('master._fork() error , File: ' + options.file + ' not found, Options: ' + JSON.stringify(options)));
  }
  /*
  child.on('error', function (app, err) {
    this.emit('app_error', app, err);
  });
  */

  child.on('ready', (message) => {
    this.emit('app_ready', message, () => {
      if (callbackOnce === false) {
        callbackOnce = true;
        cb && cb(null, message);
      }
    });
  });


  child.on('worker_exit', (info) => {
    // self.emit('app_exit', child, info);
    if (callbackOnce === false) {
      cb && cb(info);
      callbackOnce = true;
    }
  });

  child.on('message', (childProc, msg) => {
    message.receive(msg, childProc, this);
  });

  /**
   * @param {Object} options
   *   - file
   *   - appId
   *   - config
   */
  child.start(options);
  this.children[appId] = child;
  return child;
};

Master.prototype.run = function (cb) {
  const fns = [
    this.init.bind(this),
    this.initAdmin.bind(this),
    this.initProxy.bind(this)
  ];
  fns.push(this.initApps.bind(this));
  async.series(fns, (err) => {
    if (err) {
      cb(err);
    } else {
      if (this.config.proxy.healthCheck &&
        this.config.proxy.healthCheck.autoTouch) {
        fs.sync().save(this.config.proxy.healthCheck.file, 'success');
      }
      cb(null);
    }
  });
};


/**
 * 启动admin进程
 * @param  {Function} cb [description]
 * @return {[type]}      [description]
 */
Master.prototype.initAdmin = function (cb) {
  log.info(FLAG_MASTER, `starting_app : ${APPID_ADMIN}`);
  this.admin = this._fork(APPID_ADMIN, {
    file: this.adminApiFile,
    config: _.assign(this.config.admin, {
      appId: APPID_ADMIN,
      noPersistent: true
    })
  }, cb);
};
/**
 * 启动proxy进程
 * @param  {Function} cb [description]
 * @return {[type]}      [description]
 */
Master.prototype.initProxy = function (cb) {
  this.proxy = new Proxy(this.config.proxy);

  this.proxy.on('error', function (err) {
    log.error('NGINX_CONFIG_ERROR', err);
  });

  this.proxy.on('ready', cb);

  let nodeProxy = this.proxy.getNodeChild();
  if (nodeProxy) {
    this.children[APPID_PROXY] = nodeProxy;
  }
};

/**
 * 从session中恢复app
 * @param  {Function} cb [description]
 * @return {[type]}      [description]
 */
Master.prototype.initApps = function (cb) {
  let apps = this.appSession.apps();

  if (Object.keys(apps).length === 0) {
    return cb();
  }
  let arr = [];
  let config = this.config;

  for (let k in apps) {
    let tmp = utils.parseAppId(k);
    tmp = config.apps[tmp.name];
    if (tmp) {
      apps[k].order = tmp.order;
      apps[k].processorNum = isNaN(tmp.processorNum) ? undefined : tmp.processorNum;
    }
    arr.push([k, apps[k], apps[k].order || 1000]);
  }

  arr.sort(function (a, b) {
    if (a[2] > b[2]) {
      return 1;
    } else {
      return -1;
    }
  });

  async.eachSeries(arr, (item, done) => {
    this.$mount(item[0], item[1], function (err) {
      err && log.error(FLAG_MASTER, `start_app_failed : ${item[0]}`, err);
      done(null);
    });
  }, cb);
};

/**
 * 退出服务
 */
Master.prototype.exit = function (cb) {
  log.info(FLAG_MASTER, 'server is shutting down....');
  if (this.config.proxy.healthCheck &&
    this.config.proxy.healthCheck.file) {
    fs.sync().rm(this.config.proxy.healthCheck.file);
  }
  let children = this.children;
  async.eachOfSeries(children, (child, appId, done) => {
    if (appId === APPID_PROXY) {
      return done();
    }
    child.stop((err) => {
      if (err) {
        log.error(FLAG_MASTER, `server stop app:${appId} error`, err);
      }
      done();
    });
  }, () => {
    this.children = {};
    this.proxy && this.proxy.exit();
    this.admin = null;
    this.proxy = null;
    fs.unlinkSync(this.config.pidFile);
    fs.unlinkSync(this.config.serverStatusFile);
    log.warn(FLAG_MASTER, 'server_stoped');
    cb && cb();
  });
};

Master.prototype.$config = function (cb) {
  cb(null, this.config);
};

Master.prototype.$list = function (cb) {
  const apps = {};
  const ref = this.children;
  for (let child in ref) {
    let cc = ref[child];
    cc.errorExitRecord && cc.errorExitRecord.forEach(function (v, i, a) {
      a[i] = new Date(v).toString();
    });

    let appInfo = {
      pid: cc.options.pid,
      name: cc.options.name,
      version: cc.options.version,
      expectWorkerNum: cc.options.processorNum,
      workerNum: cc.getPid().length,
      buildNum: cc.options.buildNum,
      appId: cc.options.appId,
      status: cc.status,
      exitCount: cc.exitCount,
      errorExitCount: cc.errorExitCount,
      errorExitRecord: cc.errorExitRecord,
      framework: cc.options.framework
    };

    if (cc.options.target) {
      let extra = {};
      let keys = this.config.appExtraInfo;
      keys.forEach((key) => {
        extra[key] = cc.options[key];
      });
      extra.bind = extra.bind || this.config.proxy.port;
      appInfo.extra = extra;
    }

    let currWorkingAppId = this.onlineApps[appInfo.name] && this.onlineApps[appInfo.name][0];
    if (appInfo.appId === currWorkingAppId) {
      appInfo.isCurrWorking = true;
    }
    apps[child] = appInfo;
  }
  return cb && cb(null, apps);
};

/**
 * 获取app的配置信息
 * @return {Object}
 */
Master.prototype.getAppConfig = function (appName) {
  let appsConfig = this.config.apps || {};
  let commonConfig = this.config.appsCommon || {};
  return _.merge({}, commonConfig, appsConfig[appName] || {});
};
/**
 * 挂载app
 * @param  {String}   appId app_2.0.1_1
 * @param  {Object}   config {dir: xxxx}
 * @param  {Function} cb(err)
 */
Master.prototype.$mount = function (appId, config, cb) {
  log.info(FLAG_MASTER, `mount_app : ${appId}`);
  if (!config.dir || !appId) {
    return cb(new Error('Error APPConfig appId: ' + appId + ', config: ' + JSON.stringify(config)));
  }
  let processorNum = 1;
  let pkg = {};
  try {
    pkg = require(path.join(config.dir, './package.json'));
    if (pkg && pkg.dtboost && pkg.dtboost.processorNum) {
      processorNum = Number(pkg.dtboost.processorNum);
    } else if (pkg && pkg.honeycomb && pkg.honeycomb.processorNum) {
      processorNum = Number(pkg.honeycomb.processorNum);
    }
  } catch (e) {
    // do nothing
  }

  let privateConfig = this.getAppConfig(pkg.name);

  if (isNaN(processorNum)) {
    processorNum = 1;
  }
  this._fork(appId, {
    config: privateConfig,
    file: config.dir,
    processorNum: config.processorNum || privateConfig.processorNum || processorNum
  }, (err) => {
    if (!err && !this.appSession.get(appId) && !config.noPersistent) {
      this.appSession.set(appId, {
        dir: config.dir
      });
    }
    cb && cb(err, 'mount app success');
  });
};

/**
 * 卸载app
 * @param  {String}   appId
 * @param  {Function} cb(err)
 */
Master.prototype.$unmount = function (appId, deleteFlag, cb) {
  if (cb === undefined) {
    cb = deleteFlag;
    deleteFlag = false;
  }
  let child = this.children[appId];
  if (!child) {
    let err = new Error('App is not mounted: ' + appId);
    err.code = 'APP_NOT_MOUNTED';
    return cb(err);
  }
  if (appId === APPID_PROXY || appId === APPID_ADMIN) {
    let err = new Error('Internal app, can not remove');
    err.code = 'APP_FORBIDDEN_MOUNT';
    return cb(err);
  }
  log.info(FLAG_MASTER, `unmout_app : ${appId}`);
  // TODO 如果全局关联，则需要先从服务的VIP上摘除，然后卸载
  let cfg = child.workerConfig;
  let self = this;
  // 删除数组中下线的版本
  this.onlineApps[cfg.name] = _.remove(this.onlineApps[cfg.name], (id) => {
    return id !== appId;
  });

  function done() {
    self.appSession.remove(appId);
    child.stop((err) => {
      cb && cb(err, 'unmount app success');
    });
    if (deleteFlag) {
      delete self.children[appId];
    }
  }

  // app not ready
  if (!cfg.appId && !cfg.type) {
    return done();
  }

  this.proxy.unregister(cfg, (err) => {
    if (err) {
      return cb && cb(err);
    }
    done();
  });
};

/**
 * 重载app
 */
Master.prototype.$reload = function (appId, cb) {
  let child = this.children[appId];
  if (!child) {
    let err = new Error('App is not mounted: ' + appId);
    err.code = 'APP_NOT_MOUNTED';
    return cb(err);
  }
  // refresh config info
  child.options.config = this.getAppConfig(child.options.name);
  child.reload((err, next) => {
    if (err && err.code === 'SERVER_BUSY') {
      return cb(err);
    }
    this.proxy.updateRouter(child.workerConfig, (err) => {
      next(err, cb);
    });
  });
};
/**
 * 服务上下线，控制健康检查用
 */
Master.prototype.$online = function (cb) {
  let healthCheck = this.config.proxy.healthCheck;
  cb = cb || (() => {});

  if (this.online) {
    return cb();
  }
  /**
   * 通知各app上线
   * 这在socket类型的app中管用
   */
  for (let app in this.children) {
    this.children[app].send({
      action: 'online'
    });
  }

  if (healthCheck && healthCheck.file) {
    try {
      fs.writeFileSync(healthCheck.file, '');
    } catch (e) {
      e.message = 'switch online server error:' + e.message;
      return cb(e);
    }
  }
  this.online = true;
  cb();
};
/**
 * 服务上下线，控制健康检查用
 */
Master.prototype.$offline = function (cb) {
  let healthCheck = this.config.proxy.healthCheck;
  cb = cb || (() => {});
  if (!this.online) {
    return cb();
  }
  /**
   * 通知各app下线
   * 这在socket类型的app中管用
   */
  for (let app in this.children) {
    this.children[app].send({
      action: 'offline'
    });
  }
  /**
   * 关闭http的健康检查接口
   */
  if (healthCheck && healthCheck.file) {
    try {
      fs.unlinkSync(healthCheck.file);
    } catch (e) {
      e.message = 'switch offline server failed:' + e.message;
      return cb(e);
    }
  }
  this.online = false;
  cb();
};

Master.prototype.$restartAdmin = function (cb) {
  this.admin.stop();
  setTimeout(() => {
    this.initAdmin();
  }, 500);
  cb(null);
};

Master.prototype.$status = function (cb) {
  let apps = {};
  let ref = this.children;
  for (let child in ref) {
    apps[child] = {
      exitCount: ref[child].exitCount,
      errorExitCount: ref[child].errorExitCount,
      errorExitRecord: ref[child].errorExitRecord
    };
  }

  cb(null, {
    startTime: this.startTime,
    runningTime: new Date().getTime() - this.startTime,
    online: this.online,
    apps: apps
  });
};

Master.prototype.$cleanExitRecord = function (appId, cb) {
  let child = this.children[appId];
  if (child) {
    child.errorExitRecord = [];
    child.errorExitCount = 0;
    cb(null);
  } else {
    cb(new Error('appid:' + appId + ' not found'));
  }
};

Master.prototype.$getAppPids = function (cb) {
  let children = this.children;
  let onlineApps = this.onlineApps;
  let results = {};
  for (let app in onlineApps) {
    onlineApps[app].forEach((child) => {
      results[child] = children[child].getPid();
    });
  }

  results[APPID_PROXY] = children[APPID_PROXY].getPid();
  results[APPID_ADMIN] = children[APPID_ADMIN].getPid();

  results['__MASTER__']  = [process.pid];

  /* e.g. results:
    {
      'admin_3.0.1_1': [ 4047 ],
      'system_2.3.11_1': [ 4045 ],
      'example_2.0.0_2': [ 4049, 4050 ],
      __PROXY__: [ 4043, 4044 ],
      __ADMIN__: [ 4042 ]
    }
  */
  cb(null, results);
};

Master.prototype.$reloadConfig = function (cb) {
  try {
    this.config.reload();
  } catch (e) {
    return cb(e);
  }
  this.proxy && this.proxy.init(this.config.proxy);
  cb(null);
};

module.exports = Master;