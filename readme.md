# vite-plugin-css-modules

[![npm](https://img.shields.io/npm/v/vite-plugin-css-modules.svg)](https://www.npmjs.com/package/vite-remark-html)

Make all style files supported css module, not just xxx.module.xxx

## Install

```
npm i vite-plugin-css-modules | yarn add vite-plugin-css-modules
```

## Usage

```ts
import vitePluginCssModules from "vite-plugin-css-modules";

export default {
	plugins: [vitePluginCssModules()],
};
```

## Options

### precompilers [optional]

Precompiler configuration for various style files. Plug-in built-in less type file compilation configuration

eg: less

    vitePluginCssModules({
        precompilers:[
            {
                regExp: /.(less)$/,
                // Self-handling compilation
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
    }),


### postcssPlugins [optional]

    postcss plugins config, see also postcss
 
### postcssModulesOpts [optional]
    
    postcss-modules plugins config, see also postcss-modules
 