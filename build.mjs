import { build } from 'esbuild'

// The ES module for bundlers, and the script the CDN serves
// (challenge.faable.com/v1/api.js), self-contained and minified.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  target: 'es2019',
  sourcemap: true
})
await build({
  entryPoints: ['src/script.ts'],
  outfile: 'dist/api.js',
  bundle: true,
  format: 'iife',
  target: 'es2019',
  minify: true,
  sourcemap: true,
  legalComments: 'none'
})
