import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';

mkdirSync('media/codicons', { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf']) copyFileSync(`node_modules/@vscode/codicons/dist/${f}`, `media/codicons/${f}`);

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, minify: false, logLevel: 'info' };

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
    // The Agent SDK is ESM and reads import.meta.url, which a CJS bundle does not have.
    define: { 'import.meta.url': '__importMetaUrl' },
    banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/webview/chat.ts'],
    outfile: 'dist/webview/chat.js',
    platform: 'browser',
    target: 'es2020',
    format: 'iife',
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
