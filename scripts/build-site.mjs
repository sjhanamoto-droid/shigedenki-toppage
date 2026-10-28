/**
 * build-site.mjs
 *
 * ソースHTML（ブラウザ内Babelでレンダリングする開発用の形式）を、
 * 検索エンジンがそのまま読める静的HTMLに変換して dist/ に出力する。
 *
 *  1. <script type="text/babel"> 内のJSXを取り出す
 *  2. esbuild でクライアント用バンドルを生成（Babel Standalone と CDN import を排除）
 *  3. 同じJSXを Node 用にバンドルし renderToString で事前レンダリング
 *  4. 結果を <div id="root"> に流し込み、canonical を付与して dist/ に書き出す
 *  5. sitemap.xml と robots.txt を生成する
 */
import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { renderToString } from 'react-dom/server';
import React from 'react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const SITE_URL = 'https://shigedenki.jp';

/** sitemap から除外するページ（noindex 指定のもの） */
const NOINDEX = new Set(['thanks.html']);

/** dist にそのままコピーするディレクトリ */
const STATIC_DIRS = ['assets', 'images'];

// ─── HTML の分解 ──────────────────────────────────────────

const BABEL_OPEN = /<script\s+type="text\/babel"[^>]*>/;
const IMPORTMAP_BLOCK = /<script\s+type="importmap">[\s\S]*?<\/script>\s*/;
const BABEL_CDN = /<script\s+src="https:\/\/unpkg\.com\/@babel\/standalone[^"]*"><\/script>\s*/;

/**
 * <script type="text/babel"> ... </script> の中身を取り出す。
 * JSX 内に </script> は現れないため、開始タグ以降の最後の </script> を終端とみなす。
 */
function extractJsx(html, file) {
  const open = html.match(BABEL_OPEN);
  if (!open) throw new Error(`${file}: <script type="text/babel"> が見つかりません`);
  const start = open.index + open[0].length;
  const end = html.lastIndexOf('</script>');
  if (end <= start) throw new Error(`${file}: babel ブロックの終端を特定できません`);
  return { jsx: html.slice(start, end), start, end, openTag: open[0] };
}

// ─── バンドル ────────────────────────────────────────────

/**
 * 全ページのクライアント用エントリをまとめてバンドルする。
 * splitting を有効にすることで React と framer-motion が共有チャンクに切り出され、
 * ページ間の移動でブラウザキャッシュが効くようになる。
 */
async function bundleClients(entries, outdir) {
  await esbuild.build({
    entryPoints: entries,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    jsx: 'transform',
    outdir,
    entryNames: '[name]',
    chunkNames: 'chunk-[hash]',
    logLevel: 'silent',
  });
}

/** SSR 用。React は external にして、このスクリプト自身の React を共有させる。 */
async function bundleSsr(jsx) {
  const result = await esbuild.build({
    stdin: { contents: jsx, resolveDir: ROOT, loader: 'jsx', sourcefile: 'page.jsx' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    jsx: 'transform',
    // バンドルに含めると別インスタンスの React になり、フック呼び出しが失敗する。
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

/** クライアント用バンドルはそのまま。SSR 用は createRoot 呼び出しを export に差し替える。 */
function toSsrSource(jsx, file) {
  const RENDER_CALL = /createRoot\(\s*document\.getElementById\(\s*['"]root['"]\s*\)\s*\)\s*\.render\(\s*<App\s*\/>\s*\)\s*;?/;
  if (!RENDER_CALL.test(jsx)) {
    throw new Error(`${file}: createRoot(...).render(<App />) が見つかりません`);
  }
  return jsx.replace(RENDER_CALL, 'export default App;');
}

async function prerender(jsx, file, tmpDir) {
  const ssrSource = toSsrSource(jsx, file);
  const code = await bundleSsr(ssrSource);
  const modPath = path.join(tmpDir, `${file.replace(/[^\w]/g, '_')}.mjs`);
  fs.writeFileSync(modPath, code, 'utf-8');
  const mod = await import(pathToFileURL(modPath).href);
  const App = mod.default;
  if (typeof App !== 'function') throw new Error(`${file}: App コンポーネントを取得できません`);
  return renderToString(React.createElement(App));
}

/**
 * 事前レンダリング結果から全画面ローディング画面を取り除く。
 *
 * loader は position:fixed で本文を覆うため、静的HTMLに残すと
 * JS が動かない環境やレンダリングに失敗したクローラーからは
 * 本文が隠れている扱いになりうる。クライアント側は createRoot で
 * #root を描き直すので、実際の表示には影響しない。
 */
function stripLoader(rendered) {
  const OPEN = '<div class="loader"';
  if (!rendered.startsWith(OPEN)) return rendered;

  let depth = 0;
  const re = /<div\b|<\/div>/g;
  let m;
  while ((m = re.exec(rendered)) !== null) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return rendered.slice(m.index + m[0].length);
  }
  throw new Error('loader の終端を特定できません');
}

/**
 * 事前レンダリング結果から、framer-motion の「アニメーション開始時の状態」を取り除く。
 *
 * FadeUp などは initial={{ opacity: 0, y: 30 }} を持つため、そのまま静的HTMLにすると
 * 本文のほとんどが opacity:0 になり、隠しテキストとみなされかねない。
 * クライアント側は #root を描き直すので、実際のアニメーションには影響しない。
 */
function neutralizeAnimationStyles(html) {
  return html.replace(/ style="([^"]*)"/g, (whole, decls) => {
    const kept = decls
      .split(';')
      .map(d => d.trim())
      .filter(Boolean)
      .filter(d => !/^opacity:0(\.\d+)?$/.test(d))
      .filter(d => !/^transform:/.test(d))
      .filter(d => !/^width:0px$/.test(d));
    return kept.length ? ` style="${kept.join(';')}"` : '';
  });
}

// ─── canonical / URL ─────────────────────────────────────

/** ファイルパスから公開URLのパス部分を求める。index.html はルート。 */
function toUrlPath(file) {
  return file === 'index.html' ? '/' : `/${file}`;
}

function canonicalTag(file) {
  return `<link rel="canonical" href="${SITE_URL}${toUrlPath(file)}">`;
}

// ─── ページのビルド ──────────────────────────────────────

/** 出力する JS のファイル名。works/foo.html -> works-foo.js */
function jsNameFor(file) {
  return file.replace(/\//g, '-').replace(/\.html$/, '');
}

/** ページを読み込み、JSX を取り出してクライアント用エントリを書き出す。 */
function preparePage(file, entryDir) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
  const parts = extractJsx(src, file);
  const name = jsNameFor(file);
  const entry = path.join(entryDir, `${name}.jsx`);
  fs.writeFileSync(entry, parts.jsx, 'utf-8');
  return { file, src, ...parts, name, entry };
}

/** 事前レンダリング結果とバンドル参照を埋め込んで dist に書き出す。 */
async function emitPage(page, tmpDir) {
  const { file, src, openTag, end, jsx, name } = page;

  const depth = file.split('/').length - 1;
  const scriptSrc = `${'../'.repeat(depth)}assets/js/${name}.js`;

  const rendered = neutralizeAnimationStyles(stripLoader(await prerender(jsx, file, tmpDir)));

  let html = src.slice(0, src.indexOf(openTag)) + src.slice(end + '</script>'.length);
  html = html.replace(IMPORTMAP_BLOCK, '').replace(BABEL_CDN, '');

  if (!/<div id="root"><\/div>/.test(html)) {
    throw new Error(`${file}: <div id="root"></div> が見つかりません`);
  }
  html = html.replace('<div id="root"></div>', `<div id="root">${rendered}</div>`);
  html = html.replace('</body>', `<script type="module" src="${scriptSrc}"></script>\n</body>`);

  html = html.replace(/\s*<link[^>]*rel="canonical"[^>]*>/gi, '');
  html = html.replace('</head>', `${canonicalTag(file)}\n</head>`);

  const outPath = path.join(DIST, file);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf-8');

  return Buffer.byteLength(rendered);
}

// ─── sitemap / robots ────────────────────────────────────

function buildSitemap(files) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = files
    .filter(f => !NOINDEX.has(f))
    .map(f => {
      const priority = f === 'index.html' ? '1.0' : f.startsWith('works/') ? '0.6' : '0.8';
      return `  <url>\n    <loc>${SITE_URL}${toUrlPath(f)}</loc>\n    <lastmod>${today}</lastmod>\n    <priority>${priority}</priority>\n  </url>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), xml, 'utf-8');
  return files.filter(f => !NOINDEX.has(f)).length;
}

function buildRobots() {
  const txt = `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;
  fs.writeFileSync(path.join(DIST, 'robots.txt'), txt, 'utf-8');
}

// ─── 静的ファイルのコピー ────────────────────────────────

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ─── メイン ──────────────────────────────────────────────

function listPages() {
  const root = fs.readdirSync(ROOT)
    .filter(f => f.endsWith('.html'))
    .sort();
  const works = fs.existsSync(path.join(ROOT, 'works'))
    ? fs.readdirSync(path.join(ROOT, 'works')).filter(f => f.endsWith('.html')).sort().map(f => `works/${f}`)
    : [];
  return [...root, ...works];
}

async function main() {
  console.log('静的HTMLを生成します...');

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // node_modules 配下に置くことで、SSR バンドルが external 指定した
  // react を通常の解決規則で見つけられるようにする。
  const tmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.shige-ssr-'));
  const entryDir = path.join(tmpDir, 'entries');
  fs.mkdirSync(entryDir, { recursive: true });

  const pages = listPages();

  // 1st pass: JSX を取り出してエントリを揃える
  const prepared = pages.map(f => preparePage(f, entryDir));

  // 2nd pass: 全エントリを一括バンドル（共有チャンクが切り出される）
  await bundleClients(prepared.map(p => p.entry), path.join(DIST, 'assets', 'js'));

  // 3rd pass: 事前レンダリングして HTML を書き出す
  for (const page of prepared) {
    const bytes = await emitPage(page, tmpDir);
    console.log(`  ${page.file} (本文 ${bytes.toLocaleString()} バイト)`);
  }

  for (const dir of STATIC_DIRS) {
    const src = path.join(ROOT, dir);
    if (fs.existsSync(src)) copyDir(src, path.join(DIST, dir));
  }

  const count = buildSitemap(pages);
  buildRobots();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`完了: ${pages.length} ページ、sitemap に ${count} URL`);
}

main().catch(err => {
  console.error('ビルド失敗:', err.message);
  process.exit(1);
});
