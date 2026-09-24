/**
 * Generator for the repository's designed artwork: the social card, the README
 * banners, and the two README diagrams.
 *
 * Not part of the product: `docs/` is outside the package `files` list, so this
 * script and the images it writes never reach a consumer's `node_modules`. Run it
 * from the repository root with `node docs/assets/make-card.mjs` after a
 * `pnpm install`; Playwright's Chromium is the only tool it needs, and it is
 * already a devDependency for the browser gates. Every image is an HTML page
 * rendered by Chromium, so the text in them stays editable here. The images it
 * writes are committed:
 *
 * - `social-preview.png` — uploaded by hand in GitHub Settings → Social preview,
 *   which the API does not expose. PNG, because GitHub's upload takes no WebP.
 * - `readme-banner[.zh-cn].webp` — the hero image at the top of each README.
 * - `build-pipeline[.zh-cn].webp` — Markdown in git to a static host.
 * - `publication-flow[.zh-cn].webp` — how a note is published or withheld.
 *
 * WebP is re-encoded from Chromium's PNG screenshot by its own canvas encoder,
 * the way `make-screenshots.mjs` does, so no image dependency is added. Colours
 * are the site's dark-theme tokens from `src/styles/tokens.css`, so the artwork
 * and the product agree.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./', import.meta.url));

const C = {
  bg: '#0d1013', surface: '#161b21', surfaceAlt: '#1c222a', text: '#e9edf2',
  muted: '#a4b0be', line: '#2b323c', lineStrong: '#69737f',
  accent: '#8ad884', link: '#86c8e6', danger: '#f08c8c',
};

const MARK_PATH =
  'M50.4 78.5a75.1 75.1 0 0 0-28.5 6.9l24.2-65.7c.7-2 1.9-3.2 3.4-3.2h29c1.5 0 2.7 1.2 3.4 3.2l24.2 65.7s-11.6-7-28.5-7L67 45.5c-.4-1.7-1.6-2.8-2.9-2.8-1.3 0-2.5 1.1-2.9 2.7L50.4 78.5Zm-1.1 28.2Zm-4.2-20.2c-2 6.6-.6 15.8 4.2 20.2a17.5 17.5 0 0 1 .2-.7 5.5 5.5 0 0 1 5.7-4.5c2.8.1 4.3 1.5 4.7 4.7.2 1.1.2 2.3.2 3.5v.4c0 2.7.7 5.2 2.2 7.4a13 13 0 0 0 5.7 4.9v-.3l-.2-.3c-1.8-5.6-.5-9.5 4.4-12.8l1.5-1a73 73 0 0 0 3.2-2.2 16 16 0 0 0 6.8-11.4c.3-2 .1-4-.6-6l-.8.6-1.6 1a37 37 0 0 1-22.4 2.7c-5-.7-9.7-2-13.2-6.2Z';
const mark = (size) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 128 128" fill="none"><path d="${MARK_PATH}" fill="${C.accent}"/></svg>`;

const NODES = [
  [200, 46, 13], [96, 132, 9], [316, 126, 11], [40, 244, 8],
  [172, 236, 15], [300, 240, 9], [112, 352, 10], [246, 344, 12], [356, 300, 8],
];
const EDGES = [
  [0, 1], [0, 2], [1, 3], [1, 4], [2, 4], [2, 5],
  [4, 6], [4, 7], [5, 7], [5, 8], [7, 8], [6, 3],
];
const graph = (css = '') => `<svg viewBox="0 0 400 400" fill="none" style="${css}">
  ${EDGES.map(([a, b]) => {
    const [x1, y1] = NODES[a];
    const [x2, y2] = NODES[b];
    const hot = a === 4 || b === 4;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${hot ? 'rgba(138,216,132,.45)' : 'rgba(233,237,242,.18)'}" stroke-width="${hot ? 2.2 : 1.6}"/>`;
  }).join('')}
  ${NODES.map(([x, y, r], i) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${i === 4 ? C.accent : C.link}" fill-opacity="${i === 4 ? 1 : 0.85}"/>`).join('')}
  <circle cx="172" cy="236" r="26" stroke="${C.accent}" stroke-opacity=".35" stroke-width="2"/>
</svg>`;

// Line icons, 24px grid, stroked in the current colour.
const ICON = {
  git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="9" r="2.5"/><path d="M6 8.5v7M18 11.5c0 3-3 4-9.5 5"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  folder: '<path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5h4.3l2 2.2h8.7A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
};
const icon = (name, color, size = 26) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;

const BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; }
  body { background: ${C.bg}; color: ${C.text}; -webkit-font-smoothing: antialiased;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
      "Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif; }
  code, .mono { font-family: ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace; }
  .glow { position: absolute; inset: 0; background:
      radial-gradient(900px 560px at 92% -18%, rgba(134,200,230,.16), transparent 62%),
      radial-gradient(760px 520px at -10% 118%, rgba(138,216,132,.14), transparent 60%); }
  .grid { position: absolute; inset: 0; opacity: .55;
    background-image:
      linear-gradient(rgba(233,237,242,.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(233,237,242,.04) 1px, transparent 1px);
    background-size: 44px 44px;
    mask-image: radial-gradient(circle at 50% 45%, #000, transparent 78%); }
`;
const doc = (css, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;

const STRINGS = {
  en: {
    lang: 'en',
    tagline: 'Publish your <em>Markdown notes</em> as a static digital garden',
    sub: 'A privacy-preserving static site generator. Backlinks, a link graph, and full-text search — from the git repository you already have.',
    chips: ['[[wikilinks]]', 'backlinks', 'link graph', 'Pagefind search', 'no server', 'no trackers'],
    mockTitle: 'Evergreen notes',
    mockMeta: 'Published 2026-09-01 · ideas',
    mockTags: ['method', 'writing'],
    linkedFrom: 'Linked from',
    backlinks: ['Linking over filing', 'Backlinks matter', 'Garden roadmap'],
    nearby: 'Nearby notes',
    footer: 'github.com/wxxb789/anc',
    pipeline: [
      { icon: 'git', title: 'Markdown in git', items: ['<code>[[wikilinks]]</code> and Markdown links', 'frontmatter tags and aliases', 'dates from git history'] },
      { icon: 'gear', title: '<code>anc build</code>', items: ['exclusion gates, then validation', 'links and backlinks resolved', 'pages rendered ahead of time'] },
      { icon: 'folder', title: '<code>dist/</code>', items: ['static HTML for every note', 'Pagefind full-text index', 'one SQLite snapshot, feed, sitemap'] },
      { icon: 'globe', title: 'Any static host', items: ['GitHub Pages', 'Cloudflare Pages, Netlify', 'any web server'] },
    ],
    flowRepo: 'Your git repository',
    flowGate: 'anc build decides',
    flowRules: [
      ['ok', 'every Markdown file publishes by default'],
      ['no', '<code>publish: false</code> withholds a note'],
      ['no', '<code>exclude:</code> globs withhold a folder'],
      ['warn', 'a glob matching nothing fails the build'],
    ],
    files: [
      ['ideas/evergreen-notes.md', 'ok', 'published'],
      ['projects/roadmap.md', 'ok', 'published'],
      ['drafts/half-done.md', 'no', 'exclude glob'],
      ['journal/salary.md', 'no', 'publish: false'],
    ],
    publicTitle: '<code>dist/</code> — public',
    publicItems: ['static pages, backlinks, graph', 'search index, feed, sitemap', 'withheld links land on /private/'],
    privateTitle: '<code>content-report.json</code> — private',
    privateItems: ['names of withheld files', 'kept under .git/, never in dist/', 'the build log prints counts only'],
  },
  'zh-cn': {
    lang: 'zh-CN',
    tagline: '把 <em>Markdown 笔记</em>发布为静态数字花园',
    sub: '隐私优先的静态网站生成器。反向链接、链接图谱与全文搜索，直接来自你已有的 Git 仓库。',
    chips: ['[[wikilinks]]', '反向链接', '链接图谱', 'Pagefind 搜索', '无需服务器', '无追踪'],
    mockTitle: 'Evergreen notes',
    mockMeta: 'Published 2026-09-01 · ideas',
    mockTags: ['method', 'writing'],
    linkedFrom: 'Linked from',
    backlinks: ['Linking over filing', 'Backlinks matter', 'Garden roadmap'],
    nearby: 'Nearby notes',
    footer: 'github.com/wxxb789/anc',
    pipeline: [
      { icon: 'git', title: 'Markdown 笔记', items: ['<code>[[wikilinks]]</code> 与 Markdown 链接', 'frontmatter 标签与别名', '日期取自 Git 历史'] },
      { icon: 'gear', title: '<code>anc build</code>', items: ['先过排除关卡，再做校验', '解析链接与反向链接', '预先渲染全部页面'] },
      { icon: 'folder', title: '<code>dist/</code>', items: ['每篇笔记一个静态 HTML', 'Pagefind 全文索引', '一个 SQLite 快照、订阅源、站点地图'] },
      { icon: 'globe', title: '任意静态主机', items: ['GitHub Pages', 'Cloudflare Pages、Netlify', '任意 Web 服务器'] },
    ],
    flowRepo: '你的 Git 仓库',
    flowGate: 'anc build 判定',
    flowRules: [
      ['ok', '每个 Markdown 文件默认发布'],
      ['no', '<code>publish: false</code> 撤回单篇笔记'],
      ['no', '<code>exclude:</code> glob 撤回整个目录'],
      ['warn', '匹配不到文件的 glob 会让构建失败'],
    ],
    files: [
      ['ideas/evergreen-notes.md', 'ok', '发布'],
      ['projects/roadmap.md', 'ok', '发布'],
      ['drafts/half-done.md', 'no', 'exclude glob'],
      ['journal/salary.md', 'no', 'publish: false'],
    ],
    publicTitle: '<code>dist/</code> 公开',
    publicItems: ['静态页面、反向链接、图谱', '搜索索引、订阅源、站点地图', '指向撤回笔记的链接落到 /private/'],
    privateTitle: '<code>content-report.json</code> 私有',
    privateItems: ['被撤回文件的名称', '留在 .git/ 下，绝不进入 dist/', '构建日志只打印计数'],
  },
};

// A stylised note page, drawn in HTML rather than photographed: the banner has
// to read at thumbnail size, which a real screenshot does not.
function mockup(s) {
  return `<div class="win">
    <div class="bar"><i></i><i></i><i></i><span class="url mono">notes.example.org/notes/evergreen-notes/</span></div>
    <div class="page">
      <div class="article">
        <div class="crumbs">Home / Notes / ideas</div>
        <div class="h1">${s.mockTitle}</div>
        <div class="meta">${s.mockMeta}</div>
        <div class="tags">${s.mockTags.map((t) => `<span>${t}</span>`).join('')}</div>
        <div class="ln w95"></div><div class="ln w80"><b></b></div><div class="ln w88"></div>
        <div class="callout"><div class="ln w60 acc"></div><div class="ln w75"></div></div>
        <div class="ln w70"></div>
      </div>
      <div class="side">
        <div class="panel"><div class="ph">${s.linkedFrom}</div>${s.backlinks.map((b) => `<div class="bl">← ${b}</div>`).join('')}</div>
        <div class="panel g"><div class="ph">${s.nearby}</div>${graph('width:100%;height:auto;display:block')}</div>
      </div>
    </div>
  </div>`;
}

const HERO_CSS = `
  .card { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
  .content { position: relative; height: 100%; display: grid; grid-template-columns: 1fr 540px;
    gap: 56px; align-items: center; padding: 0 72px; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .wordmark { font-size: 54px; font-weight: 800; letter-spacing: -.04em; line-height: 1; }
  .badge { margin-left: 6px; font-size: 14px; color: ${C.muted}; border: 1px solid ${C.line};
    border-radius: 999px; padding: 4px 11px; }
  .tagline { margin-top: 22px; font-size: 44px; font-weight: 750; letter-spacing: -.02em; line-height: 1.12; }
  .tagline em { font-style: normal; color: ${C.accent}; }
  .sub { margin-top: 18px; font-size: 19px; line-height: 1.55; color: ${C.muted}; max-width: 40em; }
  .chips { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 24px; }
  .chip { font-size: 15px; padding: 7px 14px; border-radius: 999px; border: 1px solid ${C.line};
    background: rgba(22,27,33,.8); color: #cdd6e0; }
  .chip:first-child { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; color: ${C.link}; }
  .footer { position: absolute; left: 72px; bottom: 38px; font-size: 17px; color: ${C.muted}; }
  .win { border: 1px solid ${C.line}; border-radius: 14px; background: ${C.surface}; overflow: hidden;
    box-shadow: 0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.02), 0 0 60px rgba(134,200,230,.08); }
  .bar { display: flex; align-items: center; gap: 7px; height: 34px; padding: 0 14px;
    background: ${C.surfaceAlt}; border-bottom: 1px solid ${C.line}; }
  .bar i { width: 10px; height: 10px; border-radius: 50%; background: #3a424d; }
  .url { margin-left: 14px; font-size: 12px; color: ${C.muted}; background: ${C.bg};
    padding: 3px 12px; border-radius: 6px; }
  .page { display: grid; grid-template-columns: 1fr 190px; gap: 18px; padding: 20px; }
  .crumbs { font-size: 11px; color: ${C.link}; }
  .h1 { margin-top: 8px; font-size: 25px; font-weight: 750; letter-spacing: -.02em; }
  .meta { margin-top: 6px; font-size: 11px; color: ${C.muted}; }
  .tags { display: flex; gap: 6px; margin: 10px 0 14px; }
  .tags span { font-size: 11px; color: ${C.link}; border: 1px solid ${C.lineStrong}; border-radius: 6px; padding: 1px 7px; }
  .ln { height: 8px; border-radius: 4px; background: #2a313a; margin: 9px 0; position: relative; }
  .ln b { position: absolute; left: 38%; width: 22%; height: 100%; border-radius: 4px; background: rgba(134,200,230,.6); }
  .ln.acc { background: rgba(138,216,132,.55); }
  .w95 { width: 95%; } .w88 { width: 88%; } .w80 { width: 80%; } .w75 { width: 75%; } .w70 { width: 70%; } .w60 { width: 40%; }
  .callout { border-left: 3px solid ${C.accent}; background: rgba(138,216,132,.06); border-radius: 0 8px 8px 0;
    padding: 6px 12px; margin: 14px 0; }
  .panel { border: 1px solid ${C.line}; border-radius: 10px; padding: 10px 12px; background: ${C.bg}; }
  .panel + .panel { margin-top: 12px; }
  .ph { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: ${C.muted}; margin-bottom: 6px; }
  .bl { font-size: 12px; color: ${C.link}; margin: 5px 0; white-space: nowrap; }
  .panel.g svg { max-height: 130px; }
`;

function hero(s, { social }) {
  const css = HERO_CSS + (social ? `
    .content { grid-template-columns: 1fr 520px; padding: 0 64px 40px; }
    .tagline { font-size: 46px; }
  ` : `
    .content { padding: 0 64px; }
    .tagline { font-size: 42px; max-width: 16em; }
    .sub { font-size: 18px; }
  `);
  return doc(css, `<div class="card" lang="${s.lang}"><div class="glow"></div><div class="grid"></div>
    <div class="content">
      <div>
        <div class="brand">${mark(48)}<div class="wordmark">anc</div><span class="badge">MIT · open source</span></div>
        <div class="tagline">${s.tagline}</div>
        <div class="sub">${s.sub}</div>
        <div class="chips">${s.chips.map((c) => `<span class="chip">${c}</span>`).join('')}</div>
      </div>
      <div>${mockup(s)}</div>
    </div>
    ${social ? `<div class="footer">${s.footer}</div>` : ''}
  </div>`);
}

function pipeline(s) {
  const colors = [C.muted, C.accent, C.link, C.text];
  const css = `
    html, body { height: auto; } body { padding: 36px 40px; }
    .row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; align-items: stretch; }
    .step { position: relative; display: flex; align-items: stretch; }
    .box { flex: 1; border: 1px solid ${C.line}; background: ${C.surface}; border-radius: 14px; padding: 20px 22px; }
    .step.key .box { border-color: rgba(138,216,132,.5); box-shadow: 0 0 40px rgba(138,216,132,.08); }
    .arrow { width: 40px; flex: none; display: flex; align-items: center; justify-content: center; }
    .head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
    .num { font-size: 12px; font-weight: 700; color: ${C.muted}; letter-spacing: .08em; }
    .title { font-size: 20px; font-weight: 700; }
    .title code { font-size: 18px; color: ${C.accent}; }
    ul { list-style: none; }
    li { font-size: 15.5px; line-height: 1.45; color: #cdd6e0; padding-left: 16px; position: relative; margin: 7px 0; }
    li::before { content: ''; position: absolute; left: 2px; top: .62em; width: 5px; height: 5px; border-radius: 50%; background: ${C.lineStrong}; }
    li code { font-size: 14px; color: ${C.link}; }
  `;
  const arrow = `<div class="arrow"><svg width="26" height="16" viewBox="0 0 26 16" fill="none" stroke="${C.link}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8h23M17 1l7 7-7 7"/></svg></div>`;
  return doc(css, `<div class="row" lang="${s.lang}">${s.pipeline.map((p, i) => `
    <div class="step${i === 1 ? ' key' : ''}">
      <div class="box"><div class="head">${icon(p.icon, colors[i])}<div><div class="num">0${i + 1}</div><div class="title">${p.title}</div></div></div>
      <ul>${p.items.map((t) => `<li>${t}</li>`).join('')}</ul></div>
      ${i < 3 ? arrow : ''}
    </div>`).join('')}</div>`);
}

function flow(s) {
  const mark = { ok: `<b class="ok">✓</b>`, no: `<b class="no">✕</b>`, warn: `<b class="warn">!</b>` };
  const css = `
    html, body { height: auto; } body { padding: 36px 40px; }
    .row { display: grid; grid-template-columns: 1.15fr 44px 1.1fr 44px 1.15fr; align-items: center; }
    .box { border: 1px solid ${C.line}; background: ${C.surface}; border-radius: 14px; padding: 18px 20px; }
    h3 { display: flex; align-items: center; gap: 10px; font-size: 14px; letter-spacing: .07em; text-transform: uppercase;
      color: ${C.muted}; margin-bottom: 12px; font-weight: 700; }
    h3 code { text-transform: none; letter-spacing: 0; font-size: 14px; }
    .file { display: flex; justify-content: space-between; align-items: center; gap: 12px;
      padding: 8px 10px; border-radius: 8px; background: ${C.bg}; margin: 7px 0; }
    .file code { font-size: 14px; color: #cdd6e0; }
    .file.no code { color: ${C.muted}; text-decoration: line-through; text-decoration-color: rgba(240,140,140,.6); }
    .pill { font-size: 12px; white-space: nowrap; border-radius: 999px; padding: 2px 9px; border: 1px solid; }
    .pill.ok { color: ${C.accent}; border-color: rgba(138,216,132,.4); }
    .pill.no { color: ${C.danger}; border-color: rgba(240,140,140,.4); }
    .rule { display: flex; gap: 10px; font-size: 15.5px; line-height: 1.4; margin: 10px 0; color: #cdd6e0; }
    .rule b { width: 20px; flex: none; text-align: center; }
    .rule code { font-size: 14px; color: ${C.link}; }
    .ok { color: ${C.accent}; } .no { color: ${C.danger}; } .warn { color: #e8c170; }
    .arrow { display: flex; justify-content: center; }
    .out { display: grid; gap: 14px; }
    .out .box { padding: 16px 20px; }
    .pub { border-color: rgba(138,216,132,.45); } .priv { border-color: rgba(240,140,140,.4); }
    .out li { list-style: none; font-size: 15px; line-height: 1.4; margin: 6px 0; color: #cdd6e0; }
    .out li::before { content: '·'; color: ${C.lineStrong}; margin-right: 8px; }
    .out h3 { margin-bottom: 8px; }
  `;
  const arrow = `<div class="arrow"><svg width="26" height="16" viewBox="0 0 26 16" fill="none" stroke="${C.link}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8h23M17 1l7 7-7 7"/></svg></div>`;
  return doc(css, `<div class="row" lang="${s.lang}">
    <div class="box"><h3>${icon('git', C.muted, 18)}${s.flowRepo}</h3>
      ${s.files.map(([f, k, why]) => `<div class="file ${k}"><code>${f}</code><span class="pill ${k}">${why}</span></div>`).join('')}</div>
    ${arrow}
    <div class="box"><h3>${icon('gear', C.accent, 18)}${s.flowGate}</h3>
      ${s.flowRules.map(([k, t]) => `<div class="rule">${mark[k]}<span>${t}</span></div>`).join('')}</div>
    ${arrow}
    <div class="out">
      <div class="box pub"><h3>${icon('globe', C.accent, 18)}<span>${s.publicTitle}</span></h3><ul>${s.publicItems.map((t) => `<li>${t}</li>`).join('')}</ul></div>
      <div class="box priv"><h3>${icon('lock', C.danger, 18)}<span>${s.privateTitle}</span></h3><ul>${s.privateItems.map((t) => `<li>${t}</li>`).join('')}</ul></div>
    </div>
  </div>`);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
async function shot(file, html, width, height, scale, { fit = false } = {}) {
  const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await p.setContent(html, { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  const png = await p.screenshot({ fullPage: fit });
  if (file.endsWith('.webp')) {
    const data = await p.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = Object.assign(document.createElement('canvas'), { width: image.naturalWidth, height: image.naturalHeight });
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas.toDataURL('image/webp', 0.9).split(',')[1];
    }, png.toString('base64'));
    writeFileSync(`${OUT}${file}`, Buffer.from(data, 'base64'));
  } else {
    writeFileSync(`${OUT}${file}`, png);
  }
  await p.close();
  console.log(`wrote ${file}`);
}

try {
  await shot('social-preview.png', hero(STRINGS.en, { social: true }), 1280, 640, 1);
  for (const [key, s] of Object.entries(STRINGS)) {
    const suffix = key === 'en' ? '' : `.${key}`;
    await shot(`readme-banner${suffix}.webp`, hero(s, { social: false }), 1280, 520, 2);
    await shot(`build-pipeline${suffix}.webp`, pipeline(s), 1280, 100, 1.5, { fit: true });
    await shot(`publication-flow${suffix}.webp`, flow(s), 1280, 100, 1.5, { fit: true });
  }
} finally {
  await browser.close();
}
