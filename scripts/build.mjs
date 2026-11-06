import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

await viteBuild();
await build({
  entryPoints: ['src/background.ts', 'src/content.ts'],
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  target: 'chrome120',
  minify: true,
  legalComments: 'none',
});
await mkdir('dist/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await sharp('public/brand.svg').resize(size, size).png().toFile(`dist/icons/icon${size}.png`);
}
console.log('WordNest extension built in dist/');
