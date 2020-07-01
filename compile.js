const {
    compile,
    registerPreprocessor,
    registerPostprocessor
} = require("@riotjs/compiler");
const typescript = require("typescript");
const rimraf = require("rimraf");
const path = require("path");
const fs = require("fs");
const childProcess = require("child_process");
const ncp = require("ncp");

let compilerOptions = {
    target: typescript.ScriptTarget.ES5,
    module: typescript.ModuleKind.UMD,
    lib: ["dom", "es2015"],
    removeComments: true,
    strict: true
};

const tsconfigPath = "./tsconfig.json";
if (fs.existsSync(tsconfigPath)) {
    const {
        config,
        error
    } = typescript.readConfigFile(tsconfigPath, path => fs.readFileSync(path, "utf-8"))
    if (error) throw error;

    const parsedOptions = typescript.parseJsonConfigFileContent(config, typescript.sys, path.dirname(tsconfigPath));
    if (!parsedOptions.errors.length) {
        compilerOptions = parsedOptions.options;
    }
}

function tsPreprocessor(code, { options }) {
    let statements = typescript.createSourceFile(
        options.file,
        code,
        typescript.ScriptTarget.ES5,
        true,
        typescript.ScriptKind.TS
    ).statements;
    let splitCode = code.split("");
    let modules = [];
    for (let i = statements.length - 1; i >= 0; i--) {
        let statement = statements[i];
        if (typescript.SyntaxKind[statement.kind].startsWith("Import")) {
            let start = statement.getStart();
            let end = statement.getEnd();
            let count = end - start;
            modules.push(splitCode.splice(start, count).join(""));
        }
    }
    options.modules = modules;
    code = splitCode.join("");
    const result = typescript.transpileModule(code, {
        fileName: undefined,
        compilerOptions: {
            target: typescript.ScriptTarget.ESNext
        }
    }).outputText;
    return {
        code: result.replace("exports.default = ", "export default "),
        map: null
    };
}
registerPreprocessor("javascript", "ts", tsPreprocessor);
registerPreprocessor("javascript", "typescript", tsPreprocessor);

registerPostprocessor(function (code, { options }) {
    code = typescript.transpileModule(
        (options.modules != null ? options.modules.join("\n") : "") + code, 
        { compilerOptions }
    ).outputText;
    return {
        code,
        map: null
    }
});

let dist = path.join("dist");
if (fs.existsSync(dist)) {
    rimraf.sync(dist);
}
var stop = new Date().getTime();
while (new Date().getTime() < stop + 50);
let libPath = path.join(dist, "scripts", "lib");
{
    let current = null;
    libPath.split(path.sep).forEach(dir => {
        dir = current != null ? path.join(current, dir) : dir;
        fs.mkdirSync(dir);
        current = dir;
    });
}
{
    // copy module dependencies

    function prepareCopyDirectory(dest) {
        dest.split(path.sep).slice(0, -1).reduce((prev, value) => {
            let current = path.join(prev, value);
            if (!fs.existsSync(current)) {
                fs.mkdirSync(current);
            }
            return current;
        }, "");
    }

    function prepareWriteFile(dest) {
        dest.split(path.sep).slice(0, -1).reduce((prev, value) => {
            let current = path.join(prev, value);
            if (!fs.existsSync(current)) {
                fs.mkdirSync(current);
            }
            return current;
        }, "");
    }

    let dependencies = {};
    try {
        dependencies = JSON.parse(childProcess.execSync("npm ls --json --prod --depth=0", {
            encoding: "utf-8"
        })).dependencies;
    } catch (error) {
        console.error(error);
    }
    Object.entries(dependencies).forEach(([name]) => {
        let bundleFile;
        let basePath = path.join("node_modules", name);
        if (name === "requirejs") {
            bundleFile = path.join(basePath, "require.js");
        } else {
            const packageJSON = path.join(basePath, "/package.json");
            if (fs.existsSync(packageJSON)) {
                const package = JSON.parse(fs.readFileSync(packageJSON, {
                    encoding: "utf-8"
                }));
                let possiblePath;
                if (package.main && fs.existsSync(possiblePath = path.join(basePath, package.main))) {
                    bundleFile = possiblePath;
                } else if (fs.existsSync(possiblePath = path.join(basePath, "dist"))) {
                    let dirpath = path.join(libPath, name);
                    prepareCopyDirectory(dirpath);
                    ncp(possiblePath, dirpath, (err) => {
                        if (err) {
                            console.error(err);
                            return;
                        }
                        console.log("copied \"" + possiblePath + path.sep + "\" to \"" + path.join("lib", name) + path.sep + "\"");
                    });
                    return;
                }
            }
        }
        if (bundleFile == null) {
            console.error("cannot copy package: ", name);
            return;
        }
        if (name === "requirejs") {
            let filename = path.join(libPath, "require.js");
            prepareWriteFile(filename);
            fs.copyFile(bundleFile, filename, (err) => {
                if (err) {
                    console.error(err);
                    return;
                }
                console.log("copied \"" + bundleFile + "\" to \"require.js\"");
            });
            return;
        }
        let code = fs.readFileSync(bundleFile, {
            encoding: "utf-8"
        });
        let modules = [];
        let sourceFile = typescript.createSourceFile(
            bundleFile,
            code,
            typescript.ScriptTarget.ES5,
            true,
            typescript.ScriptKind.TS
        );
        let statements = sourceFile.statements;
        let splitCode = code.split("");
        let strictEnd;
        for (let i = statements.length - 1; i >= 0; i--) {
            let statement = statements[i];
            let start = statement.getStart();
            let end = statement.getEnd();
            if (strictEnd == null && statement.kind === 226 && splitCode.slice(start, end).join("").indexOf("use strict") !== -1) {
                if (statement.expression.text === "use strict") {
                    strictEnd = end;
                }
            }
            if (typescript.SyntaxKind[statement.kind].startsWith("Import")) {
                let count = end - start;
                modules.push([splitCode.slice(start, end).join(""), start, end]);
            }
        }
        if (modules.indexOf("module") === -1) {
            if (strictEnd == null) {
                strictEnd = modules.length > 0 ? modules[0][2] : 0;
            }
            splitCode.splice(strictEnd, 0, "\nimport module = require(\"module\"); module;");
        }
        code = splitCode.join("");
        const result = typescript.transpileModule(code, {
            fileName: undefined,
            compilerOptions: {
                target: typescript.ScriptTarget.ESNext,
                module: typescript.ModuleKind.AMD
            }
        }).outputText;
        let filename = path.join(libPath, name + ".js");
        prepareWriteFile(filename);
        fs.writeFile(filename, result, err => {
            if (err) {
                console.error(err);
                return;
            }
            console.log("transpiled \"" + bundleFile + "\" to \"" + path.join("lib", name) + ".js\"");
        });
    });
}

let src = path.join("src");

function computeFileDestination(filepath) {
    let parsed = path.parse(filepath);
    let dir = path.join(dist, path.relative(src, parsed.dir));
    switch (parsed.ext) {
        case ".riot": {
            return path.join(dir, parsed.name + ".js");
        }
        case ".ts": {
            if (!parsed.name.endsWith(".d")) {
                return path.join(dir, parsed.name + ".js");
            }
            return "";
        }
        default: {
            return path.join(dir, parsed.base);
        }
    }
}
function computeDirDestination(dirpath) {
    return path.join(dist, path.relative(src, dirpath));
}

let processedFiles = [];
let processedDirs = [];
function processFiles() {
    (function walkDir(dir, onFile, onDir, skipDirs) {
        skipDirs = skipDirs || [];
        let dirs = Array.from(fs.readdirSync(dir));
        dirs.forEach(f => {
            let filepath = path.join(dir, f);
            let isDirectory = fs.statSync(filepath).isDirectory();
            if (isDirectory) {
                if (!skipDirs.some(function (dir) {
                        return dir === filepath;
                })) {
                    onDir.call(null, filepath);
                    walkDir(filepath, onFile, onDir, skipDirs);
                } else {
                    console.log("Skipped dir", filepath);
                }
            } else {
                onFile.call(null, filepath);
            }
        });
    })(src, function (filepath) {
        var stats = fs.statSync(filepath);
        var mtime = stats.mtime;
        let index = -1;
        processedFiles.some((processedFile, i) => {
            if (processedFile[0] === filepath) {
                index = i;
                return true;
            }
            return false;
        });
        if (index !== -1) {
            if (mtime+0 === processedFiles[index][1]+0) {
                processedFiles[index][2] = true;
                return;
            }
            processedFiles.splice(index, 1);
        }
        let parsed = path.parse(filepath);
        let destinationFilepath = computeFileDestination(filepath);
        switch (parsed.ext) {
            case ".riot": {
                let parsedSource = null;
                try {
                    parsedSource = compile(fs.readFileSync(filepath, "utf-8")).code;
                } catch (e) {
                    console.error('\x1b[31m' + filepath + ": " + e.message + '\x1b[0m');
                }
                if (parsedSource != null){
                    let stream = fs.createWriteStream(destinationFilepath, "utf-8");
                    stream.write(parsedSource);
                    stream.close();
                    console.log(filepath + ": compiled successfully");
                }
                break;
            }
            case ".ts": {
                if (!parsed.name.endsWith(".d")) {
                    let parsedSource = null;
                    try {
                        parsedSource = typescript.transpileModule(fs.readFileSync(filepath, "utf-8"), {
                            compilerOptions
                        }).outputText;
                    } catch (e) {
                        console.error('\x1b[31m' + filepath + e.message + '\x1b[0m');
                    }
                    if (parsedSource != null){
                        let stream = fs.createWriteStream(destinationFilepath, "utf-8");
                        stream.write(parsedSource);
                        stream.close();
                        console.log(filepath + ": transpiled successfully");
                    }
                }
                break;
            }
            default: {
                fs.copyFileSync(filepath, destinationFilepath);
                console.log(filepath + ": copied successfully");
            }
        }
    
        processedFiles.push([ filepath, mtime, true ]);
    }, function (dirpath) {
        let index = -1;
        processedDirs.some((processedDir, i) => {
            if (processedDir[0] === dirpath) {
                index = i;
                return true;
            }
            return false;
        });
        if (index !== -1) {
            processedDirs.splice(index, 1);
        }
        dir = computeDirDestination(dirpath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir);
        }
        processedDirs.push([dirpath, true]);
    });
}

processFiles();

const process = require('process');
if (process.argv.some(arg => (arg === "-w") || (arg === "--watch"))) {
    console.log("---Watching files---");
    while (true) {
        let time = Date.now();
        while (Date.now() - time < 1000) { continue; }
        processedFiles.forEach(processedFile => {
            processedFile[2] = false;
        });
        processedDirs.forEach(processedDir => {
            processedDir[1] = false;
        });
        processFiles();
        let indexToRemove = [];
        processedFiles.forEach((processedFile, index) => {
            if (processedFile[2]) {
                return;
            }
            fs.unlinkSync(computeFileDestination(processedFile[0]));
            console.log(processedFile[0]+": removed");
            indexToRemove.push(index);
        });
        if (indexToRemove.length > 0) {
            for (let index = indexToRemove.length - 1; index >= 0; index--) {
                processedFiles.splice(indexToRemove[index], 1);
            }
        }
        indexToRemove = [];
        processedDirs.forEach((processedDir, index) => {
            if (processedDir[1]) {
                return;
            }
            let dirpath = computeDirDestination(processedDir[0]);
            if (fs.existsSync(dirpath)) {
                rimraf.sync(dirpath);
            }
            indexToRemove.push(index);
        });
        if (indexToRemove.length > 0) {
            for (let index = indexToRemove.length - 1; index >= 0; index--) {
                processedDirs.splice(indexToRemove[index], 1);
            }
        }
    }
}