const {
    compile,
    registerPreprocessor,
    registerPostprocessor
} = require("@riotjs/compiler");
const typescript = require("typescript");
const rimraf = require("rimraf");
const path = require("path");
const fs = require("fs");

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
let libPath = path.join(dist, "scripts", "lib"); {
    let current = null;
    libPath.split(path.sep).forEach(dir => {
        dir = current != null ? path.join(current, dir) : dir;
        fs.mkdirSync(dir);
        current = dir;
    });
}
fs.copyFileSync(path.join("node_modules", "riot", "riot.min.js"), path.join(libPath, "riot.js"));
fs.copyFileSync(path.join("node_modules", "riot", "LICENSE.txt"), path.join(libPath, "riot LICENSE"));
fs.copyFileSync(path.join("node_modules", "requirejs", "require.js"), path.join(libPath, "require.js"));

let src = path.join("src");

let processedFiles = [];
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
                return;
            }
            processedFiles.splice(index, 1);
        }
        let parsed = path.parse(filepath);
        let dir = path.join(dist, path.relative(src, parsed.dir));
        switch (parsed.ext) {
            case ".riot": {
                let parsedSource;
                try {
                    parsedSource = compile(fs.readFileSync(filepath, "utf-8")).code;
                } catch (e) {
                    console.error('\x1b[31m' + filepath + e.message + '\x1b[0m');
                    return;
                }
                let stream = fs.createWriteStream(path.join(dir, parsed.name + ".js"), "utf-8");
                stream.write(parsedSource);
                stream.close();
                console.log(filepath + ": compiled successfully");
                break;
            }
            case ".ts": {
                if (!parsed.name.endsWith(".d")) {
                    let parsedSource;
                    try {
                        parsedSource = typescript.transpileModule(fs.readFileSync(filepath, "utf-8"), {
                            compilerOptions
                        }).outputText;
                    } catch (e) {
                        console.error('\x1b[31m' + filepath + e.message + '\x1b[0m');
                        return;
                    }
                    let stream = fs.createWriteStream(path.join(dir, parsed.name + ".js"), "utf-8");
                    stream.write(parsedSource);
                    stream.close();
                    console.log(filepath + ": transpiled successfully");
                }
                break;
            }
            default: {
                fs.copyFileSync(filepath, path.join(dir, parsed.base));
                console.log(filepath + ": copied successfully");
            }
        }
    
        processedFiles.push([ filepath, mtime ]);
    }, function (dirpath) {
        dir = path.join(dist, path.relative(src, dirpath));
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir);
        }
    });
}

processFiles();

const process = require('process');
if (process.argv.some(arg => (arg === "-w") || (arg === "--watch"))) {
    console.log("---Watching files---");
    while (true) {
        let time = Date.now();
        while (Date.now() - time < 1000) { continue; }
        processFiles();
    }
}