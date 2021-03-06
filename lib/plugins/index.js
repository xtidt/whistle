var path = require('path');
var p = require('pfork');
var fs = require('fs');
var fse = require('fs-extra');
var url = require('url');
var http = require('http');
var extend = require('util')._extend;
var EventEmitter = require('events').EventEmitter;
var pluginMgr = new EventEmitter();
var colors = require('colors/safe');
var comUtil = require('../util');
var logger = require('../util/logger');
var util = require('./util');
var config = require('../config');
var getPluginsSync = require('./get-plugins-sync');
var getPlugin = require('./get-plugins');
var rulesMgr = require('../rules');
var RulesMgr = require('../rules/rules');
var properties = require('../rules/util').properties;
var PLUGIN_MAIN = path.join(__dirname, './load-plugin');
var PLUGIN_URL_RE = new RegExp('(?:http|ws)s?:\\/\\/([\\da-z]+)\\.' + config.localUIHost.replace(/\./g, '\\.') + '(?:\\:\\d+)?\\/', 'i');
var RULE_VALUE_HEADER = 'x-whistle-rule-value';
var SSL_FLAG_HEADER = 'x-whistle-https';
var FULL_URL_HEADER = 'x-whistle-full-url';
var REAL_URL_HEADER = 'x-whistle-real-url';
var CUR_RULE_HEADER = 'x-whistle-rule';
var NEXT_RULE_HEADER = 'x-whistle-next-rule';
var REQ_ID_HEADER = 'x-whistle-req-id';
var DATA_ID_HEADER = 'x-whistle-data-id';
var STATUS_CODE_HEADER = 'x-whistle-status-code';
var LOCAL_HOST_HEADER = 'x-whistle-local-host';
var METHOD_HEADER = 'x-whistle-method';
var CLIENT_IP_HEADER = 'x-forwarded-for';
var INTERVAL = 6000;
var UTF8_OPTIONS = {encoding: 'utf8'};
var plugins = getPluginsSync();
var LOCALHOST = '127.0.0.1';
var conf = {};

/*eslint no-console: "off"*/
Object.keys(config).forEach(function(name) {
  var value = config[name];
  if (typeof value == 'string' || typeof value == 'number') {
    conf[name] = value;
  }
});

pluginMgr.on('updateRules', function() {
  rulesMgr.clearAppend();
  Object.keys(plugins).sort(function(a, b) {
    var p1 = plugins[a];
    var p2 = plugins[b];
    return (p1.mtime > p2.mtime) ? 1 : -1;
  }).forEach(function(name) {
    if (pluginIsDisabled(name.slice(0, -1))) {
      return;
    }
    var plugin = plugins[name];
    if (plugin._rules && !plugin.rulesMgr) {
      plugin.rulesMgr = new RulesMgr();
      plugin.rulesMgr.parse(plugin._rules, plugin.path);
    }
    plugin.rules && rulesMgr.append(plugin.rules, plugin.path);
  });
});
pluginMgr.emit('updateRules');

pluginMgr.updateRules = function() {
  pluginMgr.emit('updateRules');
};

pluginMgr.on('update', function(result) {
  Object.keys(result).forEach(function(name) {
    pluginMgr.stopPlugin(result[name]);
  });
});
pluginMgr.on('uninstall', function(result) {
  Object.keys(result).forEach(function(name) {
    pluginMgr.stopPlugin(result[name]);
  });
});

function showVerbose(oldData, newData) {
  if (!config.debugMode) {
    return;
  }
  var uninstallData, installData, updateData;
  Object.keys(oldData).forEach(function(name) {
    var oldItem = oldData[name];
    var newItem = newData[name];
    if (!newItem) {
      uninstallData = uninstallData || {};
      uninstallData[name] = oldItem;
    } else if (newItem.path != oldItem.path || newItem.mtime != oldItem.mtime) {
      updateData = updateData || {};
      updateData[name] = newItem;
    }
  });

  Object.keys(newData).forEach(function(name) {
    if (!oldData[name]) {
      installData = installData || {};
      installData[name] = newData[name];
    }
  });

  if (uninstallData || installData || updateData) {
    console.log('\n***********[%s] %s has changed***********', comUtil.formatDate(), 'plugins');
  }

  uninstallData && Object.keys(uninstallData).forEach(function(name) {
    console.log(colors.red('[' + comUtil.formatDate(new Date(uninstallData[name].mtime)) + '] [uninstall plugin] ' + name.slice(0, -1)));
  });
  installData && Object.keys(installData).forEach(function(name) {
    console.log(colors.green('[' + comUtil.formatDate(new Date(installData[name].mtime)) + '] [install plugin] ' + name.slice(0, -1)));
  });
  updateData && Object.keys(updateData).forEach(function(name) {
    console.log(colors.yellow('[' + comUtil.formatDate(new Date(updateData[name].mtime)) + '] [update plugin] ' + name.slice(0, -1)));
  });
}

function readPackages(obj, callback) {
  var _plugins = {};
  var count = 0;
  var callbackHandler = function() {
    if (--count <= 0) {
      callback(_plugins);
    }
  };
  Object.keys(obj).forEach(function(name) {
    var pkg = plugins[name];
    var newPkg = obj[name];
    if (!pkg || pkg.path != newPkg.path || pkg.mtime != newPkg.mtime) {
      ++count;
      fse.readJson(newPkg.pkgPath, function(err, pkg) {
        if (pkg && pkg.version) {
          newPkg.version = pkg.version;
          newPkg.homepage = util.getHomePageFromPackage(pkg);
          newPkg.description = pkg.description;
          newPkg.moduleName = pkg.name;
          _plugins[name] = newPkg;
          fs.readFile(path.join(path.join(newPkg.path, 'rules.txt')), UTF8_OPTIONS, function(err, rulesText) {
            newPkg.rules = comUtil.trim(rulesText);
            fs.readFile(path.join(path.join(newPkg.path, '_rules.txt')), UTF8_OPTIONS, function(err, rulesText) {
              newPkg._rules = comUtil.trim(rulesText);
              callbackHandler();
            });
          });
        } else {
          callbackHandler();
        }
      });
    } else {
      _plugins[name] = pkg;
    }
  });

  if (count <= 0) {
    callback(_plugins);
  }
}

(function update() {
  setTimeout(function() {
    getPlugin(function(result) {
      readPackages(result, function(_plugins) {
        var updatePlugins, uninstallPlugins;
        Object.keys(plugins).forEach(function(name) {
          var plugin = plugins[name];
          var newPlugin = _plugins[name];
          if (!newPlugin) {
            uninstallPlugins = uninstallPlugins || {};
            uninstallPlugins[name] = plugin;
          } else if (newPlugin.path != plugin.path || newPlugin.mtime != plugin.mtime) {
            updatePlugins = updatePlugins || {};
            updatePlugins[name] = newPlugin;
          }
        });
        showVerbose(plugins, _plugins);
        plugins = _plugins;
        if (uninstallPlugins || updatePlugins) {
          uninstallPlugins && pluginMgr.emit('uninstall', uninstallPlugins);
          updatePlugins && pluginMgr.emit('update', updatePlugins);
          pluginMgr.emit('updateRules');
        }
        update();
      });
    });
  }, INTERVAL);
})();

pluginMgr.RULE_VALUE_HEADER = RULE_VALUE_HEADER;
pluginMgr.SSL_FLAG_HEADER = SSL_FLAG_HEADER;
pluginMgr.FULL_URL_HEADER = FULL_URL_HEADER;
pluginMgr.REAL_URL_HEADER = REAL_URL_HEADER;
pluginMgr.METHOD_HEADER = METHOD_HEADER;
pluginMgr.CLIENT_IP_HEADER = CLIENT_IP_HEADER;
pluginMgr.NEXT_RULE_HEADER = NEXT_RULE_HEADER;
pluginMgr.CUR_RULE_HEADER = CUR_RULE_HEADER;
pluginMgr.REQ_ID_HEADER = REQ_ID_HEADER;
pluginMgr.DATA_ID_HEADER = DATA_ID_HEADER;
pluginMgr.STATUS_CODE_HEADER = STATUS_CODE_HEADER;
pluginMgr.LOCAL_HOST_HEADER = LOCAL_HOST_HEADER;

function loadPlugin(plugin, callback) {
  p.fork({
    name: plugin.moduleName,
    script: PLUGIN_MAIN,
    value: plugin.path,
    RULE_VALUE_HEADER: RULE_VALUE_HEADER,
    SSL_FLAG_HEADER: SSL_FLAG_HEADER,
    FULL_URL_HEADER: FULL_URL_HEADER,
    REAL_URL_HEADER: REAL_URL_HEADER,
    NEXT_RULE_HEADER: NEXT_RULE_HEADER,
    CUR_RULE_HEADER: CUR_RULE_HEADER,
    REQ_ID_HEADER: REQ_ID_HEADER,
    DATA_ID_HEADER: DATA_ID_HEADER,
    STATUS_CODE_HEADER: STATUS_CODE_HEADER,
    LOCAL_HOST_HEADER: LOCAL_HOST_HEADER,
    METHOD_HEADER: METHOD_HEADER,
    CLIENT_IP_HEADER: CLIENT_IP_HEADER,
    debugMode: config.debugMode,
    config: conf
  }, function(err, ports, child) {
    callback && callback(err, ports, child);
    logger.error(err);
    if (config.debugMode) {
      if (err) {
        console.log(colors.red(err));
      } else if (!child.debugMode) {
        child.debugMode = true;
        child.on('data', function(data) {
          if (data && data.type == 'console.log') {
            console.log('[' + comUtil.formatDate() + '] [plugin] [' + plugin.path.substring(plugin.path.lastIndexOf('.') + 1) + ']', data.message);
          }
        });
        child.sendData({
          type: 'console.log',
          status: 'ready'
        });
      }
    }
  });
}

pluginMgr.loadPlugin = loadPlugin;

pluginMgr.stopPlugin = function(plugin) {
  p.kill({
    script: PLUGIN_MAIN,
    value: plugin.path
  }, 10000);
};

pluginMgr.getPlugins = function() {
  return plugins;
};

function pluginIsDisabled(name) {
  if (properties.get('disabledAllPlugins')) {
    return true;
  }
  var disabledPlugins = properties.get('disabledPlugins') || {};
  return disabledPlugins[name];
}

function _getPlugin(protocol) {
  return pluginIsDisabled(protocol.slice(0, -1)) ? null : plugins[protocol];
}

pluginMgr.getPlugin = _getPlugin;

function getPluginByRuleUrl(ruleUrl) {
  if (!ruleUrl || typeof ruleUrl != 'string') {
    return;
  }
  var index = ruleUrl.indexOf(':');
  if (index == -1) {
    return null;
  }
  var protocol = ruleUrl.substring(0, index + 1);
  return pluginIsDisabled(protocol.slice(0, -1)) ? null : plugins[protocol];
}

pluginMgr.getPluginByRuleUrl = getPluginByRuleUrl;

pluginMgr.getPluginByHomePage = function(url) {
  return PLUGIN_URL_RE.test(url)
&& plugins[RegExp.$1 + ':'];
};

function requestRules(options, callback) {
  comUtil.getResponseBody(options, function(err, body) {
    var data = err ? '' : rulesToJson(body);
    if (!data) {
      return callback(err, body, null, body);
    }
    callback(err, typeof data.rules == 'string' ? data.rules : '', data.values, body);
  });
}

function rulesToJson(body) {
  body = body && body.trim();
  if (/^\{[\s\S]+\}$/.test(body)) {
    try {
      return JSON.parse(body);
    } catch(e) {}
  }
}

function getRules(req, port, callback) {
  if (!port) {
    return callback();
  }
  var rules = req.rules;
  var options = url.parse(req.fullUrl);
  options.headers = extend({}, req.headers);
  if (req.reqId) {
    options.headers[REQ_ID_HEADER] = req.reqId;
  }
  options.headers[FULL_URL_HEADER] = encodeURIComponent(req.fullUrl);
  options.headers[METHOD_HEADER] = encodeURIComponent(req.method || 'GET');
  var nextRule = rulesMgr.resolveRule(req.fullUrl, 1);
  if (nextRule) {
    options.headers[NEXT_RULE_HEADER] = encodeURIComponent(nextRule.rawPattern + ' ' + nextRule.matcher);
  }
  var localHost = rules.host;
  if (localHost) {
    options.headers[LOCAL_HOST_HEADER] = encodeURIComponent(comUtil.removeProtocol(localHost.matcher, true) + (localHost.port ? ':' + localHost.port : ''));
  }
  if (rules.rule) {
    options.headers[CUR_RULE_HEADER] = encodeURIComponent(rules.rule.rawPattern + ' ' + rules.rule.matcher);
  }
  if (options.protocol == 'https:' || options.protocol == 'wss:') {
    options.headers[SSL_FLAG_HEADER] = 'true';
  }

  if (typeof req.clientIp == 'string') {
    options.headers[CLIENT_IP_HEADER] = encodeURIComponent(req.clientIp);
  }

  options.protocol = 'http:';
  options.host = LOCALHOST;
  options.port = port;
  options.hostname = null;
  var ruleValue = req.ruleValue || comUtil.getMatcherValue(req.rules.rule);
  if (ruleValue) {
    options.headers[RULE_VALUE_HEADER] = encodeURIComponent(ruleValue);
  }
  delete options.headers.upgrade;
  delete options.headers.connection;
  requestRules(options, callback);
}

pluginMgr.getRules = function(req, callback) {
  var plugin = req.pluginMgr;
  if (!plugin) {
    return callback();
  }
  var retryCount = 0;
  (function getRulesMgr() {
    loadPlugin(plugin, function(err, ports) {
      plugin.ports = ports;
      getRules(req, ports && ports.rulesPort, function(err, body, values, raw) {
        if (retryCount++ < 5 && err) {
          setTimeout(getRulesMgr, 60);
          return;
        }
        if (err || !body) {
          callback(plugin.rulesMgr);
        } else {
          if (raw != plugin.__rules) {
            var rulesMgr = new RulesMgr(values);
            rulesMgr.parse(body + (plugin._rules ? '\n' + plugin._rules : ''), plugin.path);
            plugin._rulesMgr = rulesMgr;
            plugin.__rules = raw;
          }
          callback(plugin._rulesMgr);
        }
      });
    });
  })();
};

function getResRules(req, res, port, callback) {
  if (!port) {
    return callback();
  }
  var options = url.parse(req.fullUrl);
  options.headers = extend({}, res.headers);
  options.headers[FULL_URL_HEADER] = encodeURIComponent(req.fullUrl);
  if (req.realUrl) {
    options.headers[REAL_URL_HEADER] = encodeURIComponent(req.realUrl);
  }
  if (req.reqId) {
    options.headers[REQ_ID_HEADER] = req.reqId;
  }
  if (req.dataId) {
    options.headers[DATA_ID_HEADER] = req.dataId;
  }
  if (typeof req.clientIp == 'string') {
    options.headers[CLIENT_IP_HEADER] = encodeURIComponent(req.clientIp);
  }

  options.headers.host = req.headers.host;
  options.headers[METHOD_HEADER] = encodeURIComponent(req.method || 'GET');
  options.headers[LOCAL_HOST_HEADER] = encodeURIComponent(req.hostIp || LOCALHOST);
  options.headers[STATUS_CODE_HEADER] = encodeURIComponent(res.statusCode == null ? '' : res.statusCode + '');
  if (options.protocol == 'https:' || options.protocol == 'wss:') {
    options.headers[SSL_FLAG_HEADER] = 'true';
  }

  options.protocol = 'http:';
  options.host = LOCALHOST;
  options.port = port;
  options.hostname = null;
  var ruleValue = req.ruleValue || comUtil.getMatcherValue(req.rules.rule);
  if (ruleValue) {
    options.headers[RULE_VALUE_HEADER] = encodeURIComponent(ruleValue);
  }
  delete options.headers.upgrade;
  delete options.headers.connection;
  requestRules(options, callback);
}

pluginMgr.getResRules = function(req, res, callback) {
  var plugin = req.pluginMgr;
  if (!plugin) {
    return callback();
  }

  var retryCount = 0;
  (function getRulesMgr() {
    loadPlugin(plugin, function(err, ports) {
      getResRules(req, res, ports && ports.resRulesPort, function(err, body, values, raw) {
        if (retryCount++ < 5 && err) {
          setTimeout(getRulesMgr, 60);
          return;
        }

        if (err || !body) {
          callback(plugin.rulesMgr);
        } else {
          if (raw != plugin.__resRules) {
            var rulesMgr = new RulesMgr(values);
            rulesMgr.parse(body, plugin.path);
            plugin._resRulesMgr = rulesMgr;
            plugin.__resRules = raw;
          }
          callback(plugin._resRulesMgr);
        }
      });
    });
  })();
};


function postStatus(plugin, data) {
  if (!plugin) {
    return;
  }
  var retryCount = 0;
  data = JSON.stringify(data);
  function sendStatus() {
    loadPlugin(plugin, function(err, ports) {
      var port = ports && ports.statusPort;
      if (port) {
        var request = http.request({
          host: '127.0.0.1',
          port: port,
          method: 'POST'
        }, function(response) {
          response.on('error', errorHandler);
        });
        request.on('error', errorHandler);
        request.end(data);
      }
    });
  }

  function errorHandler() {
    retryCount++ < 5 && setTimeout(sendStatus, 60);
  }

  sendStatus();
}

pluginMgr.postStatus = postStatus;

function getTunnelRules(req, port, callback) {
  if (!port) {
    return callback();
  }
  var options = {
    host: '127.0.0.1',
    port: port,
    headers: req.headers
  };

  if (req.reqId) {
    options.headers[REQ_ID_HEADER] = req.reqId;
  }
  var rules = req.rules;
  var ruleValue = req.ruleValue || comUtil.getMatcherValue(rules.rule);
  if (ruleValue) {
    options.headers[RULE_VALUE_HEADER] = encodeURIComponent(ruleValue);
  }
  if (rules.rule) {
    options.headers[CUR_RULE_HEADER] = encodeURIComponent(rules.rule.rawPattern + ' ' + rules.rule.matcher);
  }
  var localHost = rules.host;
  if (localHost) {
    options.headers[LOCAL_HOST_HEADER] = encodeURIComponent(comUtil.removeProtocol(localHost.matcher, true) + (localHost.port ? ':' + localHost.port : ''));
  }
  if (typeof req.clientIp == 'string') {
    options.headers[CLIENT_IP_HEADER] = encodeURIComponent(req.clientIp);
  }

  requestRules(options, callback);
}

pluginMgr.getTunnelRules = function(req, callback) {
  var plugin = req.pluginMgr;
  if (!plugin) {
    return callback();
  }
  var retryCount = 0;
  (function getTunnelRulesMgr() {
    loadPlugin(plugin, function(err, ports) {
      plugin.ports = ports;
      getTunnelRules(req, ports && ports.tunnelRulesPort, function(err, body, values, raw) {
        if (retryCount++ < 5 && err) {
          setTimeout(getTunnelRulesMgr, 60);
          return;
        }
        if (err || !body) {
          callback(null);
        } else {
          if (raw != plugin.__tunnelRules) {
            var rulesMgr = new RulesMgr(values);
            rulesMgr.parse(body + (plugin._rules ? '\n' + plugin._rules : ''), plugin.path);
            plugin._tunnelRulesMgr = rulesMgr;
            plugin.__tunnelRules = raw;
          }
          callback(plugin._tunnelRulesMgr);
        }
      });
    });
  })();
};

var PLUGIN_RULE_RE = /^([a-z\d_\-]+)(?:\(([\s\S]*)\))?$/;
var PLUGIN_RULE_RE2 = /^([a-z\d_\-]+)(?:\:\/\/([\s\S]*))?$/;

function resolvePluginRule(req) {
  var rules = req.rules;
  var plugin = req.pluginMgr = getPluginByRuleUrl(comUtil.rule.getUrl(rules.rule));
  if (!plugin && rules.plugin) {
    var value = comUtil.getMatcherValue(rules.plugin);
    if (PLUGIN_RULE_RE.test(value) || PLUGIN_RULE_RE2.test(value)) {
      req.ruleValue = RegExp.$2;
      req.pluginMgr = _getPlugin(RegExp.$1 + ':');
    }
  }
  return plugin;
}

pluginMgr.resolvePluginRule = resolvePluginRule;

module.exports = pluginMgr;


