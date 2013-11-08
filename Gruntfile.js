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

module.exports = function(grunt) {
    var pkg = require('./package.json');

    var licenseLong = grunt.file.read('tasks/templates/LICENSE-long');
    var licenseSmall = grunt.file.read('tasks/templates/LICENSE-small');
    var acornPath = require.resolve('acorn/acorn.js');
    var phantomjsInstances = "npm_package_config_phantomjsInstances" in process.env ? process.env.npm_package_config_phantomjsInstances || "0" : "1";

    var noderPackages = function(noderEnvironment) {
        return [{
            builder: {
                type: "NoderBootstrapPackage",
                cfg: {
                    noderEnvironment: noderEnvironment,
                    header: licenseLong
                }
            },
            name: "noder.js"
        }];
    };

    grunt.initConfig({
        pkg: pkg,
        clean: ['dist'],
        atpackager: {
            browser: {
                options: {
                    outputDirectory: "dist/browser",
                    packages: noderPackages("browser")
                }
            },
            node: {
                options: {
                    outputDirectory: "dist/node",
                    packages: noderPackages("node")
                }
            },
            options: {
                sourceDirectories: ['src/plugins'],
                sourceFiles: ['**/*.js'],
                visitors: [{
                    type: "ImportSourceFile",
                    cfg: {
                        sourceFile: acornPath,
                        targetLogicalPath: "noderError/acorn.js"
                    }
                }, "CopyUnpackaged"]
            }
        },
        uglify: {
            options: {
                banner: licenseSmall
            },
            browser: {
                src: ['dist/browser/noder.js'],
                dest: 'dist/browser/noder.min.js'
            },
            node: {
                src: ['dist/node/noder.js'],
                dest: 'dist/node/noder.min.js'
            }
        },
        gzip: {
            browser: {
                files: {
                    'dist/browser/noder.min.js.gz': 'dist/browser/noder.min.js'
                }
            },
            node: {
                files: {
                    'dist/node/noder.min.js.gz': 'dist/node/noder.min.js'
                }
            }
        },
        jshint: {
            sources: ['package.json', '*.js', 'tasks/**/*.js', 'build/**/*.js', 'src/**/*.js', 'spec/**/*.js'],
            dist: ['dist/*/noder.js'],
            options: {
                debug: true,
                unused: true,
                eqnull: true
            }
        },
        mocha: {
            src: 'spec/**/*.spec.js',
            options: {
                ui: 'tdd',
                reporter: "spec"
            }
        },
        attester: {
            src: 'spec/browser/attester.yml',
            options: {
                "phantomjs-instances": phantomjsInstances
            }
        },
        watch: {
            files: '<%= jshint.sources %>',
            tasks: ['dev']
        },
        jsbeautifier: {
            update: {
                src: '<%= jshint.sources %>'
            },
            check: {
                src: '<%= jshint.sources %>',
                options: {
                    mode: "VERIFY_ONLY"
                }
            }
        }
    });

    grunt.loadTasks("tasks/internal");
    grunt.loadNpmTasks('atpackager');
    require('atpackager').loadPlugin('./atpackager');
    grunt.loadNpmTasks('grunt-jsbeautifier');
    grunt.loadNpmTasks("grunt-contrib-uglify");
    grunt.loadNpmTasks('grunt-contrib-watch');
    grunt.loadNpmTasks("grunt-contrib-jshint");
    grunt.loadNpmTasks("grunt-contrib-clean");
    grunt.registerTask('build', ['clean', 'atpackager', 'uglify', 'gzip']);
    // testacular_start without dontWait must always be the last task to run (it terminates the process)
    grunt.registerTask('test', ['jsbeautifier:check', 'jshint', 'mocha', 'attester']);
    grunt.registerTask('beautify', ['jsbeautifier:update']);
    grunt.registerTask('dev', ['beautify', 'build', 'jshint']);
    grunt.registerTask('default', ['build', 'test']);
};
