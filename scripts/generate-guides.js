// Generates guides.html and guides/<slug>.html from markdown files in
// content/guides/. Run with: node scripts/generate-guides.js
// Re-run after editing any content/guides/<slug>.md file to regenerate the
// static pages — there is no build step in production, the generated
// .html files are what actually gets deployed.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTENT_DIR = path.join(ROOT, 'content', 'guides');
const SITE = 'https://avalor.co.uk';
const PUBLISHED = '2026-09-30';

// Canonical order for the index page and for validating that every
// expected article exists. Add a slug here (and a matching .md file) to
// add a new guide.
const SLUG_ORDER = [
  'what-is-gdv',
  'stamp-duty-additional-property-development',
  'what-is-residual-land-value',
  'profit-margin-property-development',
  'loft-conversion-cost-uk',
  'article-4-direction-hmo',
  'build-renovation-cost-per-square-metre-uk',
  'does-a-property-deal-stack-up',
  'hmo-conversion-cost',
  'flat-conversion-cost',
  'development-finance-explained',
  'what-is-a-development-appraisal',
];

// ── markdown parsing ────────────────────────────────────────────────────
// Deliberately small and specific to the content this site needs:
// frontmatter (title/summary/description/related), #/## headings (mapped
// to h2/h3 — the page h1 comes from frontmatter title), paragraphs,
// - bullet lists, 1. numbered lists, > blockquote (rendered as the amber
// callout box), and | pipe | tables |. Inline: **bold**, *italic*/_italic_,
// [text](url) links.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(text) {
  let t = escapeHtml(text.trim());
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*(.+?)\*/g, '<em>$1</em>');
  t = t.replace(/_(.+?)_/g, '<em>$1</em>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return t;
}

function plainText(s) {
  return s.replace(/<[^>]+>/g, '');
}

function truncate(s, max) {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

function parseFrontmatter(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return { meta: {}, body: raw };
  let i = 1;
  const metaLines = [];
  while (i < lines.length && lines[i].trim() !== '---') { metaLines.push(lines[i]); i++; }
  const body = lines.slice(i + 1).join('\n');
  const meta = {};
  for (const line of metaLines) {
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (m) meta[m[1].trim()] = m[2].trim();
  }
  return { meta, body };
}

function splitTableRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map(c => c.trim());
}

const isTableSeparator = (line) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
const isHeading = (line) => /^#{1,3}\s+/.test(line);
const isBullet = (line) => /^[-*]\s+/.test(line);
const isNumbered = (line) => /^\d+\.\s+/.test(line);
const isQuote = (line) => /^>\s?/.test(line);
const isTableRow = (line) => /^\|/.test(line.trim());

function parseMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      // # and ## both read as the section heading (h2); ### is the sub-heading (h3)
      blocks.push({ t: heading[1].length <= 2 ? 'h2' : 'h3', html: inline(heading[2]) });
      i++; continue;
    }

    if (isQuote(line)) {
      const buf = [];
      while (i < lines.length && isQuote(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      blocks.push({ t: 'callout', html: inline(buf.join(' ')) });
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line).map(inline);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) { rows.push(splitTableRow(lines[i]).map(inline)); i++; }
      blocks.push({ t: 'table', header, rows });
      continue;
    }

    if (isBullet(line)) {
      const items = [];
      while (i < lines.length && isBullet(lines[i])) { items.push(inline(lines[i].replace(/^[-*]\s+/, ''))); i++; }
      blocks.push({ t: 'ul', items });
      continue;
    }

    if (isNumbered(line)) {
      const items = [];
      while (i < lines.length && isNumbered(lines[i])) { items.push(inline(lines[i].replace(/^\d+\.\s+/, ''))); i++; }
      blocks.push({ t: 'ol', items });
      continue;
    }

    // paragraph — collect contiguous plain lines until a blank line or the
    // start of another block type
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isHeading(lines[i]) && !isBullet(lines[i]) && !isNumbered(lines[i]) && !isQuote(lines[i]) && !isTableRow(lines[i])) {
      buf.push(lines[i]); i++;
    }
    blocks.push({ t: 'p', html: inline(buf.join(' ')) });
  }
  return blocks;
}

function blocksToHtml(blocks) {
  return blocks.map(b => {
    if (b.t === 'p') return `<p>${b.html}</p>`;
    if (b.t === 'h2') return `<h2>${b.html}</h2>`;
    if (b.t === 'h3') return `<h3>${b.html}</h3>`;
    if (b.t === 'callout') return `<div class="g-callout">${b.html}</div>`;
    if (b.t === 'ul') return `<ul>${b.items.map(i => `<li>${i}</li>`).join('')}</ul>`;
    if (b.t === 'ol') return `<ol>${b.items.map(i => `<li>${i}</li>`).join('')}</ol>`;
    if (b.t === 'table') {
      const thead = `<tr>${b.header.map(h => `<th>${h}</th>`).join('')}</tr>`;
      const tbody = b.rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
      return `<div class="g-table-wrap"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
    }
    return '';
  }).join('\n      ');
}

// ── load content ─────────────────────────────────────────────────────────
function loadGuide(slug) {
  const file = path.join(CONTENT_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) {
    console.warn(`⚠ Skipping "${slug}" — no content file at content/guides/${slug}.md`);
    return null;
  }
  const raw = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  const blocks = parseMarkdown(body);

  if (!meta.title) {
    console.warn(`⚠ Skipping "${slug}" — missing "title" in frontmatter`);
    return null;
  }
  if (blocks.length === 0) {
    console.warn(`⚠ Skipping "${slug}" — frontmatter found but body is empty`);
    return null;
  }

  const firstParagraph = blocks.find(b => b.t === 'p');
  const fallback = firstParagraph ? plainText(firstParagraph.html) : '';

  if (!meta.summary) console.warn(`  · "${slug}" has no "summary" in frontmatter — using an auto-generated one for now`);
  if (!meta.description) console.warn(`  · "${slug}" has no "description" in frontmatter — using an auto-generated one for now`);

  return {
    slug,
    title: meta.title,
    summary: meta.summary || truncate(fallback, 140),
    description: meta.description || truncate(fallback, 155),
    related: (meta.related || '').split(',').map(s => s.trim()).filter(Boolean),
    body: blocks,
  };
}

const GUIDES = SLUG_ORDER.map(loadGuide).filter(Boolean);
const GUIDES_BY_SLUG = Object.fromEntries(GUIDES.map(g => [g.slug, g]));

// ── shared styling ───────────────────────────────────────────────────────
const STYLE = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --green: #1D9E75; --green-dark: #0F6E56; --green-light: #E1F5EE; --green-text: #085041;
    --amber: #BA7517; --amber-light: #FAEEDA;
    --bg: #F7F8FA; --bg-card: #FFFFFF; --bg-secondary: #F1F3F6;
    --border: #E4E7EC; --text: #111827; --text-secondary: #6B7280; --text-tertiary: #9CA3AF;
    --radius: 10px; --radius-sm: 6px;
    --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
    --shadow-md: 0 4px 6px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.04);
  }
  body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); font-size: 15px; line-height: 1.5; min-height: 100vh; }
  a { color: inherit; }

  .g-nav { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; padding: 16px 2rem; background: rgba(255,255,255,0.92); backdrop-filter: blur(6px); border-bottom: 1px solid var(--border); }
  .g-nav-logo { font-size: 22px; font-weight: 600; letter-spacing: -0.5px; color: var(--text); text-decoration: none; }
  .g-nav-logo span { color: var(--green); }
  .g-nav-links { display: flex; align-items: center; gap: 1.5rem; }
  .g-nav-links a { font-size: 14px; font-weight: 500; color: var(--text); text-decoration: none; }
  .g-nav-links a:hover { color: var(--green); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 16px; border-radius: var(--radius-sm); font-size: 14px; font-weight: 500; font-family: inherit; cursor: pointer; border: 1px solid var(--border); background: var(--bg-card); color: var(--text); text-decoration: none; }
  .btn-primary { background: var(--green); color: #fff; border-color: var(--green); }
  .btn-primary:hover { background: var(--green-dark); border-color: var(--green-dark); }

  .g-hero { max-width: 760px; margin: 0 auto; padding: 3.5rem 2rem 2.5rem; text-align: center; }
  .g-hero h1 { font-size: 36px; font-weight: 600; letter-spacing: -0.5px; line-height: 1.25; margin-bottom: 1rem; color: var(--text); }
  .g-hero p { font-size: 16px; color: var(--text-secondary); line-height: 1.6; }

  .g-list { max-width: 820px; margin: 0 auto; padding: 0 2rem 4rem; display: flex; flex-direction: column; gap: 1rem; }
  .g-card { display: block; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 1.5rem 1.75rem; text-decoration: none; transition: border-color 0.15s, box-shadow 0.15s; }
  .g-card:hover { border-color: var(--green); box-shadow: var(--shadow-md); }
  .g-card-title { font-size: 17px; font-weight: 600; color: var(--text); margin-bottom: 6px; }
  .g-card-summary { font-size: 14px; color: var(--text-secondary); line-height: 1.55; }

  .g-article-wrap { max-width: 700px; margin: 0 auto; padding: 3rem 1.5rem 2rem; }
  .g-back { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: var(--text-secondary); text-decoration: none; margin-bottom: 1.75rem; }
  .g-back:hover { color: var(--green); }
  .g-article-wrap h1 { font-size: 32px; font-weight: 600; line-height: 1.25; letter-spacing: -0.5px; margin-bottom: 0.5rem; color: var(--text); }
  .g-meta { font-size: 13px; color: var(--text-tertiary); margin-bottom: 2.25rem; }
  article h2 { font-size: 21px; font-weight: 600; margin: 2.25rem 0 0.75rem; color: var(--text); }
  article h3 { font-size: 17px; font-weight: 600; margin: 1.5rem 0 0.5rem; color: var(--text); }
  article p { font-size: 15.5px; line-height: 1.7; color: var(--text); margin-bottom: 1rem; }
  article ul, article ol { margin: 0 0 1.1rem 1.25rem; }
  article li { font-size: 15.5px; line-height: 1.7; margin-bottom: 0.5rem; color: var(--text); }
  article strong { font-weight: 600; }
  article a { color: var(--green-text); text-decoration: underline; text-decoration-color: rgba(29,158,117,0.35); }
  article a:hover { text-decoration-color: var(--green-text); }
  .g-callout { background: var(--amber-light); border: 1px solid var(--amber); border-radius: var(--radius-sm); padding: 14px 16px; margin-bottom: 1.5rem; font-size: 13.5px; line-height: 1.6; color: #7A4E00; }

  .g-table-wrap { overflow-x: auto; margin-bottom: 1.25rem; -webkit-overflow-scrolling: touch; }
  article table { width: 100%; border-collapse: collapse; font-size: 14px; }
  article th, article td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  article th { background: var(--bg-secondary); font-weight: 600; color: var(--text); }
  article td { color: var(--text); }
  article tr:last-child td { border-bottom: none; }

  .g-related { max-width: 700px; margin: 0.5rem auto 0; padding: 2rem 1.5rem 0; border-top: 1px solid var(--border); }
  .g-related h2 { font-size: 16px; font-weight: 600; color: var(--text); margin-bottom: 0.85rem; }
  .g-related ul { list-style: none; margin: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .g-related a { font-size: 14.5px; font-weight: 500; color: var(--green-text); text-decoration: none; }
  .g-related a:hover { text-decoration: underline; }

  .g-cta-card { max-width: 700px; margin: 2.5rem auto 0; text-align: center; padding: 2.5rem 2rem; background: linear-gradient(135deg, #0F6E56 0%, #1D9E75 50%, #2DC68E 100%); border-radius: 16px; color: #fff; }
  .g-cta-card h2 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
  .g-cta-card p { font-size: 14px; opacity: 0.9; margin-bottom: 1.25rem; }
  .g-cta-btn { display: inline-block; background: #fff; color: var(--green-dark); font-weight: 600; padding: 11px 24px; border-radius: var(--radius-sm); text-decoration: none; font-size: 14px; }

  .g-footer { padding: 2.5rem 2rem; text-align: center; font-size: 13px; color: var(--text-tertiary); }
  .g-footer a { color: var(--text-secondary); text-decoration: none; }
  .g-footer a:hover { color: var(--green); }

  @media (max-width: 640px) {
    .g-nav { padding: 14px 1.25rem; }
    .g-hero { padding: 2.5rem 1.25rem 2rem; }
    .g-hero h1 { font-size: 28px; }
    .g-list { padding: 0 1.25rem 3rem; }
    .g-article-wrap { padding: 2rem 1.25rem 1.5rem; }
    .g-article-wrap h1 { font-size: 26px; }
    .g-cta-card { margin-left: 1.25rem; margin-right: 1.25rem; padding: 2rem 1.5rem; }
    .g-related { padding: 2rem 1.25rem 0; }
  }
`;

function nav() {
  return `<nav class="g-nav">
    <a class="g-nav-logo" href="/">Avalo<span>r</span></a>
    <div class="g-nav-links">
      <a href="/guides">All guides</a>
      <a class="btn btn-primary" href="/">Try Avalor free</a>
    </div>
  </nav>`;
}

function footer() {
  return `<div class="g-footer">&copy; 2026 Avalor. All rights reserved. · <a href="/">avalor.co.uk</a></div>`;
}

function ctaCard() {
  return `<div class="g-cta-card">
    <h2>Know in minutes whether your next deal stacks up</h2>
    <p>Run instant GDV, build cost, SDLT, finance and risk analysis for any UK postcode — with a clear viability verdict.</p>
    <a class="g-cta-btn" href="/">Start your free trial at avalor.co.uk</a>
  </div>`;
}

function head({ title, description, canonical, ogType, jsonLd }) {
  return `<meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
  <meta name="description" content="${description}"/>
  <link rel="canonical" href="${canonical}"/>
  <meta name="robots" content="index, follow"/>
  <meta property="og:type" content="${ogType}"/>
  <meta property="og:title" content="${title}"/>
  <meta property="og:description" content="${description}"/>
  <meta property="og:url" content="${canonical}"/>
  <meta name="twitter:card" content="summary"/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css"/>
  <style>${STYLE}</style>
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;
}

function renderIndex() {
  const title = 'Property Development Guides | Avalor';
  const description = 'Free guides to UK property development — GDV, residual land value, stamp duty, build costs, HMO and flat conversions, development finance and more.';
  const canonical = `${SITE}/guides`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    description,
    url: canonical,
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
${head({ title, description, canonical, ogType: 'website', jsonLd })}
</head>
<body>
${nav()}
<div class="g-hero">
  <h1>Property development guides</h1>
  <p>Plain-English guides to the numbers and rules behind UK property development — from working out GDV to what a loft conversion actually costs.</p>
</div>
<div class="g-list">
${GUIDES.map(g => `  <a class="g-card" href="/guides/${g.slug}">
    <div class="g-card-title">${g.title}</div>
    <div class="g-card-summary">${g.summary}</div>
  </a>`).join('\n')}
</div>
${ctaCard()}
${footer()}
</body>
</html>
`;
}

function renderArticle(g) {
  const title = `${g.title} | Avalor`;
  const canonical = `${SITE}/guides/${g.slug}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: g.title,
    description: g.description,
    url: canonical,
    datePublished: PUBLISHED,
    dateModified: PUBLISHED,
    author: { '@type': 'Organization', name: 'Avalor' },
    publisher: { '@type': 'Organization', name: 'Avalor', url: SITE },
  };
  const related = g.related
    .map(slug => GUIDES_BY_SLUG[slug])
    .filter(Boolean)
    .map(r => `<li><a href="/guides/${r.slug}">${r.title}</a></li>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
${head({ title, description: g.description, canonical, ogType: 'article', jsonLd })}
</head>
<body>
${nav()}
<div class="g-article-wrap">
  <a class="g-back" href="/guides"><i class="ti ti-arrow-left"></i>All guides</a>
  <h1>${g.title}</h1>
  <div class="g-meta">Avalor guides</div>
  <article>
      ${blocksToHtml(g.body)}
  </article>
</div>${related ? `
<div class="g-related">
  <h2>Related guides</h2>
  <ul>${related}</ul>
</div>` : ''}
${ctaCard()}
${footer()}
</body>
</html>
`;
}

// ── write files ──────────────────────────────────────────────────────────
if (GUIDES.length === 0) {
  console.log('No guide content found yet — nothing to generate. Add markdown files to content/guides/ and re-run.');
} else {
  fs.writeFileSync(path.join(ROOT, 'guides.html'), renderIndex());
  fs.mkdirSync(path.join(ROOT, 'guides'), { recursive: true });
  for (const g of GUIDES) {
    fs.writeFileSync(path.join(ROOT, 'guides', `${g.slug}.html`), renderArticle(g));
  }
  console.log(`Generated guides.html + ${GUIDES.length}/${SLUG_ORDER.length} guide pages.`);
  if (GUIDES.length < SLUG_ORDER.length) {
    console.log(`Still missing: ${SLUG_ORDER.filter(s => !GUIDES_BY_SLUG[s]).join(', ')}`);
  }
}
