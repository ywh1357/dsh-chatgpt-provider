import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'node', target: 'node24', packages: 'external', outfile: 'lib/index.js' })
const client = await build({ entryPoints: ['src/client/index.tsx'], bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', packages: 'external', jsx: 'automatic', write: false })
await writeFile('lib/client.js', `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:function(require){var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`)
