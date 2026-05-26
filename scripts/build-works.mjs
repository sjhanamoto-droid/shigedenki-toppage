import { Client } from '@notionhq/client';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

// ─── Helpers ────────────────────────────────────────────��─

function getPlainText(prop) {
  if (!prop) return '';
  if (prop.type === 'title') return prop.title.map(t => t.plain_text).join('');
  if (prop.type === 'rich_text') return prop.rich_text.map(t => t.plain_text).join('');
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'number') return prop.number ?? '';
  if (prop.type === 'checkbox') return prop.checkbox;
  return '';
}

function getFiles(prop) {
  if (!prop || prop.type !== 'files') return [];
  return prop.files.map(f => {
    if (f.type === 'file') return f.file.url;
    if (f.type === 'external') return f.external.url;
    return '';
  }).filter(Boolean);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    client.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\u3000-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Fetch from Notion ────────────────────────────────────

async function fetchWorks() {
  const response = await notion.databases.query({
    database_id: databaseId,
    filter: { property: '公開', checkbox: { equals: true } },
    sorts: [{ property: '表示順', direction: 'ascending' }],
  });

  const works = [];
  for (const page of response.results) {
    const props = page.properties;
    const title = getPlainText(props['タイトル'] || props['Title'] || props['Name']);
    const slug = getPlainText(props['Slug']) || slugify(title);
    const type = getPlainText(props['工事種別']);
    const tag = getPlainText(props['タグ表示']) || type.toUpperCase();
    const year = getPlainText(props['施工年']);
    const scale = getPlainText(props['規模']);
    const scope = getPlainText(props['工事範囲']);
    const location = getPlainText(props['施工場所']);
    const duration = getPlainText(props['工期']);
    const budget = getPlainText(props['予算規模']);
    const body = getPlainText(props['詳細本文']);
    const coverUrls = getFiles(props['カバー画像']);
    const galleryUrls = getFiles(props['ギャラリー']);
    const sortOrder = getPlainText(props['表示順']);

    works.push({
      id: page.id,
      title, slug, type, tag, year, scale, scope,
      location, duration, budget, body,
      coverUrls, galleryUrls, sortOrder,
    });
  }
  return works;
}

// ─── Download images ──────────────────────────────────────

async function downloadImages(works) {
  const imgDir = path.join(ROOT, 'images', 'works');
  fs.mkdirSync(imgDir, { recursive: true });

  for (const work of works) {
    // Cover image
    if (work.coverUrls.length > 0) {
      const ext = 'jpg';
      const filename = `${work.slug}-cover.${ext}`;
      const dest = path.join(imgDir, filename);
      if (!fs.existsSync(dest)) {
        console.log(`  Downloading cover: ${filename}`);
        await downloadFile(work.coverUrls[0], dest);
      }
      work.coverImage = `images/works/${filename}`;
    } else {
      work.coverImage = 'images/pagehead-works.jpg';
    }

    // Gallery images
    work.galleryImages = [];
    for (let i = 0; i < work.galleryUrls.length; i++) {
      const ext = 'jpg';
      const filename = `${work.slug}-gallery-${i + 1}.${ext}`;
      const dest = path.join(imgDir, filename);
      if (!fs.existsSync(dest)) {
        console.log(`  Downloading gallery: ${filename}`);
        await downloadFile(work.galleryUrls[i], dest);
      }
      work.galleryImages.push(`images/works/${filename}`);
    }
  }
}

// ─── Generate works.html (list page) ─────────────────────

function generateWorksList(works) {
  const worksJson = JSON.stringify(works.map(w => ({
    id: w.id,
    type: w.type,
    tag: w.tag,
    title: w.title,
    meta: [w.year, w.scale].filter(Boolean),
    img: w.coverImage,
    slug: w.slug,
  })));

  const template = fs.readFileSync(path.join(ROOT, 'templates', 'works-list.html'), 'utf-8');
  const output = template.replace('/*__WORKS_DATA__*/', `const works = ${worksJson};`);
  fs.writeFileSync(path.join(ROOT, 'works.html'), output, 'utf-8');
  console.log('Generated: works.html');
}

// ─── Generate detail pages ────────────────────────────────

function generateDetailPages(works) {
  const template = fs.readFileSync(path.join(ROOT, 'templates', 'works-detail.html'), 'utf-8');
  const worksDir = path.join(ROOT, 'works');
  fs.mkdirSync(worksDir, { recursive: true });

  for (let i = 0; i < works.length; i++) {
    const w = works[i];
    const prev = i > 0 ? works[i - 1] : null;
    const next = i < works.length - 1 ? works[i + 1] : null;

    const pageData = JSON.stringify({
      title: w.title,
      tag: w.tag,
      type: w.type,
      year: w.year,
      scale: w.scale,
      scope: w.scope,
      location: w.location,
      duration: w.duration,
      budget: w.budget,
      body: w.body,
      coverImage: w.coverImage ? `../${w.coverImage}` : '',
      galleryImages: w.galleryImages.map(g => `../${g}`),
      prev: prev ? { slug: prev.slug, title: prev.title } : null,
      next: next ? { slug: next.slug, title: next.title } : null,
    });

    const output = template
      .replace('/*__PAGE_DATA__*/', `const pageData = ${pageData};`)
      .replace('{{TITLE}}', `${w.title} ｜ 施工事例 ｜ 株式会社シゲ電気`)
      .replace('{{DESCRIPTION}}', `${w.title}の施工事例詳細。${w.scope || ''}${w.scale ? ' / ' + w.scale : ''}`);

    fs.writeFileSync(path.join(worksDir, `${w.slug}.html`), output, 'utf-8');
    console.log(`Generated: works/${w.slug}.html`);
  }
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
  console.log('Build works pages from Notion...');

  if (!process.env.NOTION_API_KEY || !process.env.NOTION_DATABASE_ID) {
    console.warn('Warning: NOTION_API_KEY or NOTION_DATABASE_ID not set.');
    console.warn('Skipping Notion fetch. Using existing files.');
    return;
  }

  const works = await fetchWorks();
  console.log(`Fetched ${works.length} works from Notion.`);

  if (works.length === 0) {
    console.warn('No published works found. Skipping generation.');
    return;
  }

  await downloadImages(works);
  generateWorksList(works);
  generateDetailPages(works);

  console.log('Build complete!');
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
