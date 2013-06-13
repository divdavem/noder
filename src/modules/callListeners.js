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

var nextTick = require("../node-modules/nextTick.js");
var uncaughtError = require("./uncaughtError.js");
var handlers = [];
var insideCallSync = false;

var callListeners = function(listeners, params, scope) {
    while (listeners.length > 0) {
        var method = listeners.shift();
        try {
            method.apply(scope, params);
        } catch (e) {
            uncaughtError(e);
        }
    }
};

var callSync = function() {
    insideCallSync = true;
    try {
        callListeners(handlers, []);
    } finally {
        insideCallSync = false;
    }
};

var improvedNextTick = function(fn) {
    if (handlers.length === 0 && !insideCallSync) {
        nextTick(callSync);
    }
    handlers.push(fn);
};

var asyncCallListeners = module.exports = function(listeners, params, scope) {
    if (listeners && listeners.length > 0) {
        improvedNextTick(function() {
            callListeners(listeners, params, scope);
        });
    }
};

asyncCallListeners.nextTick = improvedNextTick;
asyncCallListeners.callSync = callSync;
