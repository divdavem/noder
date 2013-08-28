/*
 * Copyright 2012 Amadeus s.a.s.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var promise = require("./promise.js");
var Loader = require('./loader.js');
var Resolver = require('./resolver.js');
var execScripts = require('../node-modules/execScripts.js');
var typeUtils = require('./type.js');
var noderError = require('./noderError.js');
var dirname = require('./path.js').dirname;
var jsEval = require('./jsEval.js');
var findRequires = require('./findRequires.js');
var noderPropertiesKey = "_noder";

var PROPERTY_DEFINITION = 0;
var PROPERTY_DEPENDENCIES = 1;
var PROPERTY_EXECUTING = 2;
var PROPERTY_PRELOADING = 3;
var PROPERTY_LOADING_DEFINITION = 4;
var PROPERTY_PRELOADING_PARENTS = 5;

var bind = function(fn, scope) {
    return function() {
        return fn.apply(scope, arguments);
    };
};

var bind1 = function(fn, scope, paramBind) {
    return function(param) {
        return fn.call(scope, paramBind, param);
    };
};

var Module = function(context, filename) {
    if (filename) {
        this.dirname = dirname(filename);
    } else {
        this.dirname = filename = '.';
    }
    this[noderPropertiesKey] = {};
    this.filename = filename;
    this.id = filename;
    this.require = bind1(context.moduleRequire, context, this);
    this.require.resolve = bind1(context.moduleResolve, context, this);
    this.require.cache = context.cache;
    this.parent = null;
    this.children = [];
    this.preloaded = false;
    this.loaded = false;
    this.exports = {};
};

var getModuleProperty = function(module, property) {
    return module[noderPropertiesKey][property];
};

var setModuleProperty = function(module, property, value) {
    module[noderPropertiesKey][property] = value;
    return value;
};

var start = function(context) {
    var config = context.config;
    var actions = promise.done;

    if (!("scriptsType" in config)) {
        config.scriptsType = config.varName;
    }
    var scriptsType = config.scriptsType;
    if (scriptsType) {
        actions = actions.then(function() {
            return execScripts(context, scriptsType);
        });
    }

    var main = config.main;
    actions = actions.then(main ? function() {
        return context.execModuleCall(main);
    } : promise.empty /* if there is no main module, an empty parameter should be passed to onstart */ );

    actions = actions.then(config.onstart);

    return actions.always(function() {
        context = null;
        config = null;
        actions = null;
    });
};

var Context = function(config) {
    config = config || {};
    this.config = config;
    this.cache = {};

    this.resolver = new Resolver(this);
    this.loader = new Loader(this);

    var rootModule = new Module(this);
    rootModule.preloaded = true;
    rootModule.loaded = true;
    rootModule.define = this.define = bind(this.define, this);
    rootModule.asyncRequire = bind1(this.moduleAsyncRequire, this, rootModule);
    rootModule.execute = bind(this.jsModuleExecute, this);
    rootModule.createContext = Context.createContext;
    this.rootModule = rootModule;

    var globalVarName = config.varName;
    if (globalVarName) {
        global[globalVarName] = rootModule;
    }

    start(this).end();
};

var contextProto = Context.prototype = {};

var checkCircularDependency = function(module, lookInside) {
    if (lookInside === module) {
        return true;
    }
    var parents = getModuleProperty(lookInside, PROPERTY_PRELOADING_PARENTS);
    if (parents) {
        for (var i = 0; parents[i]; i++) {
            if (checkCircularDependency(module, parents[i])) {
                return true;
            }
        }
    }
    return false;
};

// Preloading a module means making it ready to be executed (loading its definition and preloading its
// dependencies)
contextProto.modulePreload = function(module, parent) {
    if (module.preloaded) {
        return promise.done;
    }
    var preloading = getModuleProperty(module, PROPERTY_PRELOADING);
    if (preloading) {
        // If we get here, it may be because of a circular dependency
        if (parent) {
            if (checkCircularDependency(module, parent)) {
                return promise.done;
            } else {
                getModuleProperty(module, PROPERTY_PRELOADING_PARENTS).push(parent);
            }
        }
        return preloading;
    }
    var self = this;
    if (parent && parent.id != '.') {
        module.parent = parent;
        module.require.main = parent.require.main;
        parent.children.push(module);
    } else {
        module.require.main = module;
    }
    setModuleProperty(module, PROPERTY_PRELOADING_PARENTS, parent ? [parent] : []);
    return setModuleProperty(module, PROPERTY_PRELOADING, self.moduleLoadDefinition(module).then(function() {
        return self.modulePreloadDependencies(module, getModuleProperty(module, PROPERTY_DEPENDENCIES));
    }).then(function() {
        module.preloaded = true;
        setModuleProperty(module, PROPERTY_PRELOADING, false);
        setModuleProperty(module, PROPERTY_PRELOADING_PARENTS, null);
    }, function(error) {
        throw noderError("modulePreload", [module], error);
    }).always(function() {
        // clean up
        module = null;
        self = null;
        parent = null;
    }));
};

contextProto.moduleLoadDefinition = function(module) {
    if (getModuleProperty(module, PROPERTY_DEFINITION)) {
        return promise.done;
    }
    var res = getModuleProperty(module, PROPERTY_LOADING_DEFINITION);
    if (!res) {
        // store the promise so that it can be resolved when the define method is called:
        res = setModuleProperty(module, PROPERTY_LOADING_DEFINITION, promise());
        var filename = module.filename;
        if (this.builtinModules.hasOwnProperty(filename)) {
            this.moduleDefine(module, [], this.builtinModules[filename](this));
        } else {
            this.loader.moduleLoad(module).always(function(error) {
                // if reaching this, and if res is still pending, then it means the module was not found where expected
                if (res.isPending()) {
                    res.reject(noderError("moduleLoadDefinition", [module], error));
                }
                res = null;
            });
        }
    }
    return res;
};

contextProto.moduleProcessPlugin = function(module, pluginDef) {
    var allowedParameters = {
        "module": module,
        "true": true,
        "false": false,
        "__dirname": module.dirname,
        "__filename": module.filename
    };
    var parameters = pluginDef[1].slice(1);
    for (var i = 0, l = parameters.length; i < l; i++) {
        var curParameter = parameters[i];
        if (typeUtils.isArray(curParameter)) {
            curParameter = curParameter[0];
            if (!allowedParameters.hasOwnProperty(curParameter)) {
                return;
            }
            parameters[i] = allowedParameters[curParameter];
        }
    }
    return this.moduleExecute(this.getModule(this.moduleResolve(module, pluginDef[0]))).then(function(plugin) {
        var methodName = pluginDef[1][0];
        var method = (plugin[methodName] || {}).$preload;
        if (method) {
            return method.apply(plugin, parameters);
        }
    }).then(null, function(error) {
        throw noderError("moduleProcessPlugin", [module, pluginDef], error);
    });
};

contextProto.modulePreloadDependencies = function(module, dependencies) {
    var promises = [];
    for (var i = 0, l = dependencies.length; i < l; i++) {
        var curDependency = dependencies[i];
        var curPromise = null;
        if (typeUtils.isArray(curDependency)) {
            curPromise = this.moduleProcessPlugin(module, curDependency);
            curDependency = curDependency[0]; // in case curPromise is null, this is used to preload the module as usual
        }
        if (!curPromise) {
            curPromise = this.modulePreload(this.getModule(this.moduleResolve(module, curDependency)), module);
        }
        promises.push(curPromise);

    }
    return promise.when(promises);
};

contextProto.moduleExecuteSync = function(module) {
    if (module.loaded || getModuleProperty(module, PROPERTY_EXECUTING)) { /* this.executing is true only in the case of a circular dependency */
        return module.exports;
    }
    if (!module.preloaded) {
        throw noderError("notPreloaded", [module]);
    }
    var exports = module.exports;
    setModuleProperty(module, PROPERTY_EXECUTING, true);
    try {
        getModuleProperty(module, PROPERTY_DEFINITION).call(exports, module, global);
        setModuleProperty(module, PROPERTY_DEFINITION, null);
        setModuleProperty(module, PROPERTY_DEPENDENCIES, null);
        module.loaded = true;
        return module.exports;
    } finally {
        setModuleProperty(module, PROPERTY_EXECUTING, false);
    }
};

contextProto.moduleResolve = function(module, id) {
    return this.resolver.moduleResolve(module, id);
};

contextProto.moduleRequire = function(module, id) {
    return this.moduleExecuteSync(this.getModule(this.moduleResolve(module, id)));
};

contextProto.getModule = function(moduleFilename) {
    if (!moduleFilename) {
        // anonymous module
        return new Module(this);
    }
    var res = this.cache[moduleFilename];
    if (!res) {
        this.cache[moduleFilename] = res = new Module(this, moduleFilename);
    }
    return res;
};

contextProto.define = function(moduleFilename, dependencies, body) {
    this.moduleDefine(this.getModule(moduleFilename), dependencies, body);
};

contextProto.moduleDefine = function(module, dependencies, body) {
    if (!getModuleProperty(module, PROPERTY_DEFINITION)) {
        // do not override an existing definition
        setModuleProperty(module, PROPERTY_DEFINITION, body);
        setModuleProperty(module, PROPERTY_DEPENDENCIES, dependencies);
        var loadingDefinition = getModuleProperty(module, PROPERTY_LOADING_DEFINITION);
        if (loadingDefinition) {
            setModuleProperty(module, PROPERTY_LOADING_DEFINITION, false);
            loadingDefinition.resolve();
        }
    }
    return module;
};

contextProto.moduleExecute = function(module) {
    var self = this;
    return self.modulePreload(module).then(function() {
        return self.moduleExecuteSync(module);
    }).always(function() {
        self = null;
        module = null;
    });
};

contextProto.moduleAsyncRequire = function(module, id) {
    if (typeUtils.isArray(id)) {
        return this.modulePreloadDependencies(module, id);
    } else {
        return this.moduleRequire(module, id);
    }
};

contextProto.jsModuleDefine = function(jsCode, moduleFilename, url, lineDiff) {
    var dependencies = findRequires(jsCode, this.pluginRegExp);
    var body = this.jsModuleEval(jsCode, url || moduleFilename, lineDiff);
    return this.moduleDefine(this.getModule(moduleFilename), dependencies, body);
};

contextProto.jsModuleExecute = function(jsCode, moduleFilename, url) {
    return this.moduleExecute(this.jsModuleDefine(jsCode, moduleFilename, url));
};

contextProto.jsModuleEval = function(jsCode, url, lineDiff) {
    var code = ['(function(module, global){\nvar require = module.require, exports = module.exports, __filename = module.filename, __dirname = module.dirname;\n\n', jsCode, '\n\n})'];
    return jsEval(code.join(''), url, (lineDiff || 0) + 3 /* we are adding 3 lines compared to url */ );
};

contextProto.execModuleCall = function(moduleFilename) {
    return this.moduleExecute(this.getModule(this.moduleResolve(this.rootModule, moduleFilename)));
};

contextProto.builtinModules = {
    "noder-js/asyncRequire.js": function(context) {
        return function(module) {
            module.exports = {
                create: function(module) {
                    return function(id) {
                        return context.moduleAsyncRequire(module, id);
                    };
                }
            };
        };
    }
};

contextProto.Context = Context;

contextProto.pluginRegExp = /\$[^\/]+$/;

Context.createContext = function(cfg) {
    return (new Context(cfg)).rootModule;
};

Context.expose = function(name, exports) {
    var body = function(module) {
        module.exports = exports;
    };
    contextProto.builtinModules[name] = function() {
        return body;
    };
};

module.exports = Context;
