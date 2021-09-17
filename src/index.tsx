import { dataToEsm } from "@rollup/pluginutils";
import * as fs from "fs/promises";
import { Plugin, ViteDevServer, ModuleNode, Update } from "vite";
import postcss from "postcss";
import * as postcssModules from "postcss-modules";

const cssLangs = `\\.(scss|less|styl|stylus|pcss|postcss)($|\\?)`;
const imgLangs = `\\.(png|webp|jpg|gif|jpeg|tiff|svg|bmp)($|\\?)`;
const cssLangRE = new RegExp(cssLangs);
const imgLangRE = new RegExp(imgLangs);
const cssModuleRE = new RegExp(`\\.module${cssLangs}`);
const modulesOptions: Record<string, any> = {
    scopeBehaviour: "local", localsConvention: "camelCaseOnly", compact: true
};
const nodeLess = require("less");

// 这里不去定义每个编译的具体类型了
type Precompiler = {
    regExp: RegExp;
    ompiler: (code: string, file: string) => Promise<string>;
};

export type Opts = {
    precompilers?: Precompiler[];
    postcssPlugins?: any[];
    postcssModulesOpts?: Record<string, any>;
    [anme: string]: any
}
export default function plugin(opts: Opts = {}): Plugin {
    const precompilers: Precompiler[] = opts.precompilers ? opts.precompilers : [
        {
            regExp: /.(less)$/,
            ompiler: async (code, file) => {
                const cssCode = (
                    await nodeLess.render(code, {
                        syncImport: true,
                        javascriptEnabled: true,
                    })
                ).css;
                return cssCode
            }
        }
    ]

    // 括号后面的图片样式设置不匹配
    const urlCodeReg = /url?(\()?('|")(\w|\/|.)+('|")(\))/g;
    const urlReg = /(url|\(|'|"|\))/g;
    const jsFileReg = /(.jsx?|.tsx?)$/;
    const name = "vite-plugin-css-modules";
    let server: ViteDevServer;
    const plugin: Plugin = {
        enforce: "post",
        name,
        configureServer(_server) {
            server = _server;
        },
        handleHotUpdate({ server, file, modules }) {
            if (cssLangRE.test(file) && !file.includes("node_modules") && !cssModuleRE.test(file)) {
                const updates: Update[] = [];

                const loopFn = (modules: Set<ModuleNode> | ModuleNode[]) => {
                    modules &&
                        modules.forEach((module: ModuleNode) => {
                            const fileUrl = module.url;
                            if (jsFileReg.test(fileUrl)) {
                                updates.push({
                                    type: `js-update`,
                                    timestamp: new Date().getTime(),
                                    path: fileUrl,
                                    acceptedPath: fileUrl,
                                });
                                return;
                            }
                            module.importers &&
                                module.importers.forEach((ModuleNode: ModuleNode) => {
                                    const fileUrl = ModuleNode.url;
                                    if (jsFileReg.test(fileUrl)) {
                                        updates.push({
                                            type: `js-update`,
                                            timestamp: new Date().getTime(),
                                            path: ModuleNode.url,
                                            acceptedPath: ModuleNode.url,
                                        });
                                    } else {
                                        loopFn(ModuleNode.importers);
                                    }
                                });
                        });
                };
                loopFn(modules);
                server.ws.send({
                    type: "update",
                    updates,
                });
            }
        },
        async transform(raw, id) { 
            if (cssLangRE.test(id) && !id.includes("node_modules") && !cssModuleRE.test(id)) {
                let styleCon = await fs.readFile(id, "utf8");
                // 编译前清除 js 注释 
                const singlelineCommentsRE = /\/\/.*/g
                styleCon = styleCon.replace(singlelineCommentsRE, '')
 
                let { code: css, modules } = await compileCSS(id, styleCon, opts.postcssPlugins || [], opts.postcssModulesOpts || {});
                // 替换所有 url 资源
                const urls: string[] = css.match(urlCodeReg) || [];
                urls.forEach((urlVal) => {
                    const url = urlVal.replace(urlReg, "");
                    if (imgLangRE.test(url)) {
                        const newUrl = getRequireFilePage(id, url);
                        css = css.replace(url, newUrl);
                    }
                });

                // @import 处理
                const { moduleGraph } = server;
                const thisModule = moduleGraph.getModuleById(id);
                if (thisModule) {
                    // 引用的文件
                    for (const item of thisModule.importedModules as unknown as ModuleNode[]) {
                        // 当前文件，需要编译后放置到引用的文件顶部
                        const fileUrl = item.file;
                        const impFC = await fs.readFile(fileUrl, "utf8");
                        const impFCByTransformed = await compileCSS(fileUrl, impFC, opts.postcssPlugins || [], opts.postcssModulesOpts || {}); 
                        // 将这个modules合并到主文件的 module
                        for (const key in impFCByTransformed.modules) {
                            const module = impFCByTransformed.modules[key];
                            modules[key] = module;
                        }

                        let impFCByTransformedCode = impFCByTransformed.code;
                        // 替换所有 url 资源
                        const urls = impFCByTransformedCode.match(urlCodeReg) || [];
                        urls.forEach((urlVal) => {
                            const url = urlVal.replace(urlReg, "");
                            if (imgLangRE.test(url)) {
                                const newUrl = getRequireFilePage(fileUrl, url);
                                impFCByTransformedCode = impFCByTransformedCode.replace(url, newUrl);
                            }
                        });

                        // 这里不考虑入口文件，直接给当前文件附上即可
                        css = impFCByTransformedCode + "\n " + css;
                    }

                    // 清除掉 @import “xxx” || @import url(“xxx”)
                    css = css.replace(/(@import)\s+(url)?(\()?('|")(\w|\/|.)+('|")(\))?;?/gi, "");
                }

                // 预编译器处理
                for (const precompiler of precompilers) {
                    if (precompiler.regExp.test(id)) {
                        css = await precompiler.ompiler(css, id);
                    }
                } 

                const modulesCode =
                    modules &&
                    dataToEsm(modules, {
                        namedExports: true,
                        preferConst: true,
                    });

                const resStr = [
                    `\nimport { updateStyle, removeStyle } from "/@vite/client"`,
                    `const id = "${id}"`,
                    "const css = `" + css + "`;",
                    `updateStyle(id, css);`,
                    `${modulesCode || `import.meta.hot.accept()\nexport default css`}`,
                    `import.meta.hot.prune(() => removeStyle(id))`,
                ].join("\n");

                return {
                    code: resStr,
                    css,
                    modulesCode,
                };
            }
            return undefined;
        },
    };

    return plugin;
}

type compileCSSRes = {
    ast: any,
    modules: Record<string, any>,
    code: string,
    messages: any[],
}

async function compileCSS(id: string, code: string, _postcssPlugins?: any[], _postcssModules?: Record<string, any>): Promise<compileCSSRes> {
    let modules;
    let postcssPlugins = [..._postcssPlugins];
    postcssPlugins.unshift(
        postcssModules({
            ...modulesOptions,
            ..._postcssModules,
            getJSON(cssFileName: string, _modules: Record<string, any>, outputFileName: string) {
                modules = _modules;
                if (modulesOptions && typeof modulesOptions.getJSON === "function") {
                    modulesOptions.getJSON(cssFileName, _modules, outputFileName);
                }
                if (_postcssModules && typeof _postcssModules.getJSON === "function") {
                    _postcssModules.getJSON(cssFileName, _modules, outputFileName);
                }
            },
        })
    );

    const postcssResult = await postcss(postcssPlugins).process(code, {
        to: id,
        from: id,
        map: {
            inline: false,
            annotation: false,
        },
    });
    return {
        ast: postcssResult,
        modules,
        code: postcssResult.css,
        messages: postcssResult.messages,
    };
}

function getRequireFilePage(fileSrc: string, requireSrc: string): string {
    // Get up .. the number of, It could be a level
    const parentLevel = requireSrc.match(/(\.\.\/)/g)?.length || 0;
    const requireSrcLoc = requireSrc.replace(/(\.\.\/|\.\/)/g, "");
    const arrrs = fileSrc.split("/").reverse();
    // The current file must be deleted
    // arrrs.splice(0, parentLevel === 0 ? parentLevel + 1 : parentLevel);
    arrrs.splice(0, parentLevel + 1);
    const reqPath = arrrs.reverse().join("/");
    let reaSrc = `${reqPath}/${requireSrcLoc}`;

    // public String getPath, Remove the drive letter
    reaSrc = reaSrc.replace(process.cwd().replace(/\\/g, "/"), "");

    return `${reaSrc}`;
}
