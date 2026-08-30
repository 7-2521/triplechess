import { build, context } from 'esbuild';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

const TEMPLATE = 'src/client/index.template.html';
const OUT_HTML = 'public/index.html';
const OUT_DIR = 'public/assets';

/**
 * Rewrite index.html to point at the freshly built, content-hashed bundle.
 * Hashed names let the assets be cached forever while a redeploy still takes
 * effect immediately.
 */
async function writeHtml(result) {
  const outputs = Object.keys(result.metafile?.outputs ?? {});
  const find = (ext) => {
    const hit = outputs.find((f) => f.endsWith(ext));
    if (!hit) throw new Error(`build produced no ${ext} bundle`);
    return '/' + hit.replace(/^public\//, '').replace(/\\/g, '/');
  };
  const template = await readFile(TEMPLATE, 'utf8');
  const html = template.replace('__CSS__', find('.css')).replace('__JS__', find('.js'));
  await writeFile(OUT_HTML, html);
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: { app: 'src/client/main.js' },
  outdir: OUT_DIR,
  entryNames: watch ? '[name]' : '[name]-[hash]',
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  splitting: false,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  metafile: true,
  // chessground's piece sets are base64 data URIs inside CSS; keep them inline.
  loader: { '.svg': 'dataurl' },
  logLevel: 'info',
};

// Clear stale hashed bundles so old deploys don't pile up in the image.
await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [
      {
        name: 'html',
        setup(b) {
          b.onEnd(async (result) => {
            if (result.metafile) await writeHtml(result);
          });
        },
      },
    ],
  });
  await ctx.watch();
  console.log('esbuild watching src/client…');
} else {
  const result = await build(options);
  await writeHtml(result);
}
