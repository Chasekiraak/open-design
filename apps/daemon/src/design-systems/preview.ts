/**
 * Build a showcase HTML page from a DESIGN.md so the user can see what each
 * design system looks like *before* generating anything. We don't try to
 * render a unique product mockup — we extract the palette, typography, and
 * a couple of component conventions, then drop them into one fixed
 * template. The full DESIGN.md is rendered below as prose for reference.
 *
 * Parsing is deliberately permissive: imported systems vary in section
 * naming and bullet style, so we use loose regexes and fall back to sane
 * defaults when a token isn't found.
 */

type ColorToken = { name: string; value: string };
type FontHints = { display?: string; heading?: string; body?: string; mono?: string };
type ListTag = 'ul' | 'ol';
type TableAlign = 'left' | 'center' | 'right' | null;

export function renderDesignSystemPreview(id: string, raw: string): string {
  const titleMatch = /^#\s+(.+?)\s*$/m.exec(raw);
  const title = cleanTitle(titleMatch?.[1] ?? id);
  const subtitle = extractSubtitle(raw);
  const colors = extractColors(raw);
  const fonts = extractFonts(raw);

  const bg =
    pickColor(colors, ['page background', 'background', 'canvas', 'paper', 'bg ', 'page bg'])
    ?? pickColor(colors, ['white'])
    ?? '#ffffff';
  const fg =
    pickColor(colors, ['heading', 'foreground', 'ink', 'fg', 'text', 'navy', 'graphite'])
    ?? '#111111';
  // Accent: brand/primary names first, then fall back to the first color
  // that doesn't look like a neutral white/black/grey so we always show
  // something punchy in the showcase header.
  const accent =
    pickColor(colors, ['primary brand', 'brand primary', 'primary', 'brand', 'accent'])
    ?? firstNonNeutral(colors)
    ?? '#2f6feb';
  const muted = pickColor(colors, ['muted', 'secondary', 'neutral', 'subtle', 'caption']) ?? '#777777';
  const border = pickColor(colors, ['border', 'divider', 'rule', 'stroke']) ?? '#e5e5e5';
  const surface =
    pickColor(colors, ['surface', 'card', 'background-secondary', 'panel', 'elevated'])
    ?? '#ffffff';

  const display = sanitizeFontStack(
    fonts.display ?? fonts.heading,
    "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  );
  const body = sanitizeFontStack(fonts.body, display);
  const mono = sanitizeFontStack(fonts.mono, "ui-monospace, 'JetBrains Mono', monospace");

  const renderedMarkdown = renderMarkdownLite(raw);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — design system preview</title>
  <style>
    :root {
      --bg: ${bg};
      --fg: ${fg};
      --accent: ${accent};
      --muted: ${muted};
      --border: ${border};
      --surface: ${surface};
      --display: ${display};
      --body: ${body};
      --mono: ${mono};
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--body);
      line-height: 1.55;
      font-size: 16px;
    }
    .wrap { max-width: 960px; margin: 0 auto; padding: 56px 32px 96px; }
    .badge {
      display: inline-block;
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--muted);
      margin-bottom: 24px;
    }
    h1 {
      font-family: var(--display);
      font-size: clamp(40px, 6vw, 72px);
      line-height: 1.05;
      letter-spacing: -0.02em;
      margin: 0 0 16px;
    }
    .lede {
      max-width: 60ch;
      font-size: 18px;
      color: var(--muted);
      margin: 0 0 56px;
    }
    section { margin-bottom: 72px; }
    .section-title {
      font-family: var(--display);
      font-size: 22px;
      font-weight: 600;
      margin: 0 0 16px;
      letter-spacing: -0.01em;
    }
    .palette {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 16px;
    }
    .swatch {
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      background: var(--surface);
    }
    .swatch .chip {
      height: 96px;
    }
    .swatch .meta {
      padding: 10px 12px 12px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .swatch .name { font-size: 13px; font-weight: 500; }
    .swatch .hex { font-family: var(--mono); font-size: 11px; color: var(--muted); }
    .typo-row {
      display: grid;
      grid-template-columns: 88px 1fr;
      gap: 24px;
      padding: 18px 0;
      border-top: 1px solid var(--border);
    }
    .typo-row:first-child { border-top: none; padding-top: 0; }
    .typo-row .label {
      font-family: var(--mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      padding-top: 4px;
    }
    .typo-display { font-family: var(--display); font-size: 40px; line-height: 1.1; letter-spacing: -0.02em; }
    .typo-body { font-family: var(--body); font-size: 16px; }
    .typo-mono { font-family: var(--mono); font-size: 14px; color: var(--muted); }
    .components {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
    }
    @media (max-width: 640px) { .components { grid-template-columns: 1fr; } }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
    }
    .card .eyebrow {
      font-family: var(--mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--accent);
      margin-bottom: 8px;
    }
    .card h3 {
      font-family: var(--display);
      font-size: 20px;
      margin: 0 0 8px;
      letter-spacing: -0.01em;
    }
    .card p { margin: 0; color: var(--muted); }
    .btn-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
    button {
      font: inherit;
      cursor: pointer;
      border-radius: 8px;
      padding: 10px 18px;
    }
    .btn-primary {
      background: var(--accent);
      color: ${pickReadableForeground(accent)};
      border: 1px solid var(--accent);
    }
    .btn-secondary {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
    }
    .btn-link {
      background: transparent;
      border: none;
      color: var(--accent);
      padding: 10px 0;
      font-weight: 500;
    }
    .prose {
      border-top: 1px solid var(--border);
      padding-top: 32px;
      color: var(--fg);
    }
    .prose h1, .prose h2, .prose h3 { font-family: var(--display); letter-spacing: -0.01em; }
    .prose h1 { font-size: 28px; margin-top: 0; }
    .prose h2 { font-size: 20px; margin-top: 32px; }
    .prose h3 { font-size: 16px; margin-top: 24px; }
    .prose p, .prose ul, .prose ol { margin: 12px 0; }
    .prose code { font-family: var(--mono); background: var(--surface); border: 1px solid var(--border); padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }
    .prose blockquote { margin: 16px 0; padding: 8px 16px; border-left: 3px solid var(--accent); color: var(--muted); }
    .prose ul, .prose ol { padding-left: 22px; }
    .prose pre { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; overflow: auto; font-family: var(--mono); font-size: 12.5px; line-height: 1.55; }
    .prose pre code { background: transparent; border: none; padding: 0; font-size: inherit; }
    .prose hr { border: none; border-top: 1px solid var(--border); margin: 28px 0; }
    .prose a { color: var(--accent); text-decoration: none; border-bottom: 1px solid transparent; }
    .prose a:hover { border-bottom-color: var(--accent); }
    .prose img { max-width: 100%; height: auto; border-radius: 6px; }
    .prose .table-wrap { overflow-x: auto; margin: 18px 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    .prose table { width: 100%; border-collapse: collapse; font-size: 13.5px; line-height: 1.5; }
    .prose th, .prose td { padding: 9px 14px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
    .prose th { background: var(--bg); font-weight: 600; font-size: 12px; letter-spacing: 0.02em; text-transform: uppercase; color: var(--muted); }
    .prose tr:last-child td { border-bottom: none; }
    .prose td code, .prose th code { white-space: nowrap; }
    .prose td[align="right"], .prose th[align="right"] { text-align: right; }
    .prose td[align="center"], .prose th[align="center"] { text-align: center; }
  </style>
</head>
<body>
  <main class="wrap">
    <span class="badge">Design system preview · ${escapeHtml(id)}</span>
    <h1>${escapeHtml(title)}</h1>
    ${subtitle ? `<p class="lede">${escapeHtml(subtitle)}</p>` : ''}

    <section>
      <h2 class="section-title">Palette</h2>
      <div class="palette">
        ${colors
          .slice(0, 12)
          .map(
            (c) => `<div class="swatch">
              <div class="chip" style="background:${c.value};"></div>
              <div class="meta">
                <span class="name">${escapeHtml(c.name)}</span>
                <span class="hex">${escapeHtml(c.value)}</span>
              </div>
            </div>`,
          )
          .join('')}
      </div>
    </section>

    <section>
      <h2 class="section-title">Typography</h2>
      <div class="typo-row">
        <span class="label">Display</span>
        <div class="typo-display">The grid carries weight; the line carries pace.</div>
      </div>
      <div class="typo-row">
        <span class="label">Body</span>
        <div class="typo-body">Body copy reads at sixteen pixels with a 1.55 leading. Restraint and rhythm matter more than novelty — pick a stack that earns the page.</div>
      </div>
      <div class="typo-row">
        <span class="label">Mono</span>
        <div class="typo-mono">/* monospace · ${escapeHtml(mono.split(',')[0]?.replace(/['"]/g, '').trim() ?? 'mono')} */</div>
      </div>
    </section>

    <section>
      <h2 class="section-title">Components</h2>
      <div class="components">
        <div class="card">
          <div class="eyebrow">Card</div>
          <h3>Production-quality artifact</h3>
          <p>Sample card showing how surfaces, borders, and accent text behave in this system.</p>
        </div>
        <div class="card">
          <div class="eyebrow">Buttons</div>
          <h3>Three weights, one accent</h3>
          <div class="btn-row" style="margin-top: 12px;">
            <button class="btn-primary">Primary</button>
            <button class="btn-secondary">Secondary</button>
            <button class="btn-link">Link →</button>
          </div>
        </div>
      </div>
    </section>

    <section class="prose">
      ${renderedMarkdown}
    </section>
  </main>
</body>
</html>`;
}

/**
 * Compact card renderer for pickers (inspiration step, galleries): one
 * self-contained HTML document sized for a small embed, showing the pieces
 * a brand card needs — font-name label, title in the display face, a color
 * ramp, a type specimen with a primary button, and an imagery slot (first
 * DESIGN.md image when present, otherwise a palette graphic). Reuses the
 * same permissive DESIGN.md extractors as the full preview above.
 */
export function renderDesignSystemCard(id: string, raw: string): string {
  const titleMatch = /^#\s+(.+?)\s*$/m.exec(raw);
  const title = cleanTitle(titleMatch?.[1] ?? id);
  const colors = extractColors(raw);
  const fonts = extractFonts(raw);

  const bg =
    pickColor(colors, ['page background', 'background', 'canvas', 'paper', 'bg ', 'page bg'])
    ?? '#ffffff';
  const fg =
    pickColor(colors, ['heading', 'foreground', 'ink', 'fg', 'text', 'navy', 'graphite'])
    ?? '#111111';
  const accent =
    pickColor(colors, ['primary brand', 'brand primary', 'primary', 'brand', 'accent'])
    ?? firstNonNeutral(colors)
    ?? '#2f6feb';
  const border = pickColor(colors, ['border', 'divider', 'rule', 'stroke']) ?? 'rgba(0,0,0,0.12)';
  const surface =
    pickColor(colors, ['surface', 'card', 'background-secondary', 'panel', 'elevated'])
    ?? bg;

  const display = sanitizeFontStack(fonts.display ?? fonts.heading, 'system-ui, -apple-system, sans-serif');
  const body = sanitizeFontStack(fonts.body, display);
  const displayName = display.split(',')[0]?.replace(/['"]/g, '').trim() || 'System';
  const bodyName = body.split(',')[0]?.replace(/['"]/g, '').trim() || displayName;
  const fontLabel = displayName === bodyName ? displayName : `${displayName} / ${bodyName}`;

  // Ramp: up to 8 chips from the extracted palette, deduped by value so a
  // DESIGN.md that repeats a token under several names still reads as a ramp.
  const seen = new Set<string>();
  const ramp: string[] = [];
  for (const c of colors) {
    if (seen.has(c.value)) continue;
    seen.add(c.value);
    ramp.push(c.value);
    if (ramp.length >= 8) break;
  }
  while (ramp.length < 8 && ramp.length > 0) ramp.push(ramp[ramp.length - 1]!);
  if (ramp.length === 0) ramp.push(bg, surface, accent, fg, bg, surface, accent, fg);

  const image = /!\[[^\]]*\]\((https?:\/\/[^)\s]+|[^)\s]+\.(?:png|jpe?g|webp|gif))\)/i.exec(raw)?.[1] ?? null;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — card</title>
  <style>
    /* Sized entirely in viewport units so the document reads correctly at
       ANY embed size — the picker renders it in a card-sized iframe with no
       transform, and a bigger dialog gets proportionally bigger type. */
    * { box-sizing: border-box; margin: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      background: ${bg};
      color: ${fg};
      font-family: ${body};
      padding: 4vh 5vw 5vh;
      display: flex;
      flex-direction: column;
      gap: 3.2vh;
    }
    .head { display: flex; align-items: baseline; justify-content: space-between; gap: 2vw; }
    .font-label {
      font-size: 3.4vw;
      letter-spacing: 0.02em;
      color: ${accent};
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 70%;
    }
    .marks { font-size: 2.8vw; color: ${fg}; opacity: 0.55; letter-spacing: 0.6vw; white-space: nowrap; }
    h1 {
      font-family: ${display};
      font-size: 10.5vw;
      line-height: 1.02;
      letter-spacing: -0.02em;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ramp { display: flex; gap: 1vw; }
    .ramp i {
      flex: 1;
      height: 8vh;
      border-radius: 1.2vw;
      /* Faint inset keyline instead of a hard border: reads as one clean
         color band without top/bottom divider lines between chips. */
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
    }
    .row { display: flex; gap: 2.6vw; flex: 1; min-height: 0; }
    .spec {
      flex: 1.35;
      background: ${surface};
      border: 1px solid ${border};
      border-radius: 2.6vw;
      padding: 3vw;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 2vh;
      min-width: 0;
    }
    .spec p { font-size: 3.8vw; line-height: 1.4; overflow: hidden; }
    .btn {
      align-self: flex-start;
      font-family: ${display};
      font-size: 3.4vw;
      padding: 1.4vh 3.6vw;
      border-radius: 1.6vw;
      background: ${accent};
      color: ${pickReadableForeground(accent)};
      white-space: nowrap;
    }
    .img {
      flex: 1;
      border-radius: 2.6vw;
      border: 1px solid ${border};
      overflow: hidden;
      position: relative;
      background: ${accent};
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .img img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .img .aa {
      font-family: ${display};
      font-size: 11vw;
      font-weight: 700;
      color: ${pickReadableForeground(accent)};
    }
  </style>
</head>
<body>
  <div class="head">
    <span class="font-label">${escapeHtml(fontLabel)}</span>
    <span class="marks">✦ ▤ ◯</span>
  </div>
  <h1>${escapeHtml(title)}</h1>
  <div class="ramp">${ramp.map((v) => `<i style="background:${v}"></i>`).join('')}</div>
  <div class="row">
    <div class="spec">
      <p>The quick brown fox jumps over the lazy dog.</p>
      <span class="btn">Continue →</span>
    </div>
    <div class="img">${image ? `<img src="${escapeHtml(image)}" alt="" />` : '<span class="aa">Aa</span>'}</div>
  </div>
</body>
</html>`;
}

function extractSubtitle(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const h1 = lines.findIndex((l) => /^#\s+/.test(l));
  if (h1 === -1) return '';
  const after = lines.slice(h1 + 1);
  const nextHeading = after.findIndex((l) => /^#{1,6}\s+/.test(l));
  const window = (nextHeading === -1 ? after : after.slice(0, nextHeading))
    .join('\n')
    .replace(/^>\s*Category:.*$/gim, '')
    .replace(/^>\s*/gm, '')
    .trim();
  return window.split(/\n\n/)[0]?.slice(0, 240) ?? '';
}

function extractColors(raw: string): ColorToken[] {
  const colors: ColorToken[] = [];
  const seen = new Set<string>();

  function push(name: string, value: string): void {
    const cleanName = name.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
    if (!cleanName || cleanName.length > 60) return;
    const v = normalizeHex(value);
    const key = `${cleanName.toLowerCase()}|${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    colors.push({ name: cleanName, value: v });
  }

  // Form A: "- **Background:** `#FAFAFA`" / "- Background: #FAFAFA".
  // The closing bold may sit on either side of the colon ("**Background:**"
  // keeps the colon INSIDE the bold), so stars are tolerated both before
  // and after `[:：]` — the bundled packages all use the colon-inside form.
  const reA = /^[\s>*-]*\**\s*([A-Za-z][A-Za-z0-9 /&()+_-]{1,40}?)\s*\**\s*[:：]\s*\**\s*`?(#[0-9a-fA-F]{3,8})/gm;
  let m;
  while ((m = reA.exec(raw)) !== null) push(m[1] ?? '', m[2] ?? '');

  // Form B: "**Stripe Purple** (`#533afd`)" — common in awesome-design-md.
  // Token name is whatever's bolded; the hex follows in parens/backticks.
  const reB = /\*\*([A-Za-z][A-Za-z0-9 /&()+_-]{1,40}?)\*\*\s*\(?\s*`?(#[0-9a-fA-F]{3,8})/g;
  while ((m = reB.exec(raw)) !== null) push(m[1] ?? '', m[2] ?? '');

  return colors;
}

function extractFonts(raw: string): FontHints {
  const out: FontHints = {};
  // "- **Display / headings:** `'GT Sectra', ...`"
  // We want the backticked stack OR the rest of the line.
  const re = /^[\s>*-]*\**\s*([A-Za-z][A-Za-z /]{1,30}?)\s*\**\s*[:：]\s*\**\s*`?([^`\n]+?)`?\s*$/gm;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const label = (m[1] ?? '').toLowerCase();
    // Cut trailing "— explanation" clauses and stray emphasis before
    // validating; a stack like `'GT Sectra', serif — display face` should
    // yield just the stack.
    const value = (m[2] ?? '')
      .split(/\s+[—–]\s+/)[0]!
      .trim()
      .replace(/[*_`]+$/g, '')
      .trim();
    if (!/[a-zA-Z]/.test(value)) continue;
    if (value.startsWith('#')) continue;
    // A hex anywhere in the value means this is a color line whose label
    // merely resembles a type role ("Display: Ink Black (#222222) …").
    if (/#[0-9a-fA-F]{3,8}/.test(value)) continue;
    // Only accept values that plausibly ARE font stacks. Prose lines about
    // type ("4–8px (very tight)", "runs at 1.18–1.25") share the labels but
    // carry sizes, ranges, or parentheticals — injecting them into a
    // `font-family:` declaration can break the whole stylesheet.
    if (/[(){};]/.test(value)) continue;
    if (/\d\s*(?:px|pt|em|rem|%)/i.test(value)) continue;
    if (/\d\s*[–—-]\s*\d/.test(value)) continue;
    if (value.length > 90) continue;
    if (/display|heading|h1|title/.test(label) && !out.display) out.display = value;
    else if (/body|text|paragraph|copy/.test(label) && !out.body) out.body = value;
    else if (/mono|code/.test(label) && !out.mono) out.mono = value;
  }
  return out;
}

// CSS generic/system family keywords that must stay unquoted to keep their
// meaning (quoting `serif` would turn it into a literal face name).
const GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
  '-apple-system',
]);

// One font-family name: letters/digits, spaces, hyphens, underscores, with an
// optional leading hyphen for vendor names like `-apple-system`.
const FONT_FAMILY_NAME_RE = /^-?[A-Za-z0-9][A-Za-z0-9 _-]*$/;

/**
 * Serialize a DESIGN.md-extracted font stack through a strict font-family
 * grammar. `extractFonts` is deliberately permissive about prose shapes, and
 * its output is interpolated into generated `<style>` raw text, so this is
 * the HTML boundary: each comma-separated family must be a plain name
 * (optionally quoted); families containing any other character are dropped,
 * and a stack with no surviving family falls back to the trusted default.
 * The result is rebuilt from the validated names only — input text never
 * reaches the document verbatim, so a value like
 * "Karla</style><img src=…>" can never close the style element.
 */
function sanitizeFontStack(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const families: string[] = [];
  for (const part of value.split(',')) {
    let name = part.trim();
    const quoted = /^(['"])(.+)\1$/.exec(name);
    if (quoted) name = (quoted[2] ?? '').trim();
    if (!name || name.length > 60 || !FONT_FAMILY_NAME_RE.test(name)) continue;
    families.push(GENERIC_FONT_FAMILIES.has(name.toLowerCase()) ? name : `'${name}'`);
  }
  return families.length > 0 ? families.join(', ') : fallback;
}

function pickColor(colors: ColorToken[], hints: string[]): string | null {
  for (const hint of hints) {
    const needle = hint.toLowerCase();
    const found = colors.find((c) => c.name.toLowerCase().includes(needle));
    if (found) return found.value;
  }
  return null;
}

function firstNonNeutral(colors: ColorToken[]): string | null {
  for (const c of colors) {
    const v = c.value.replace('#', '').toLowerCase();
    if (v.length !== 6) continue;
    const r = parseInt(v.slice(0, 2), 16);
    const g = parseInt(v.slice(2, 4), 16);
    const b = parseInt(v.slice(4, 6), 16);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat > 0.25) return c.value;
  }
  return null;
}

function pickReadableForeground(hex: string): string {
  const n = normalizeHex(hex);
  if (n.length !== 7) return '#ffffff';
  const r = parseInt(n.slice(1, 3), 16);
  const g = parseInt(n.slice(3, 5), 16);
  const b = parseInt(n.slice(5, 7), 16);
  // Standard luminance check.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#0a0a0a' : '#ffffff';
}

function normalizeHex(hex: string): string {
  let h = hex.toLowerCase();
  if (h.length === 4) {
    h = '#' + h.slice(1).split('').map((c) => c + c).join('');
  }
  return h;
}

function cleanTitle(raw: string): string {
  return String(raw).replace(/^Design System (Inspired by|for)\s+/i, '').trim();
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// Tiny markdown renderer — enough for our DESIGN.md prose: H1–H4, paragraphs,
// bullet/ordered lists, blockquotes, fenced code, GFM pipe tables, horizontal
// rules, inline `code` / **bold** / *italic* / [link](url). Not a full markdown
// implementation but covers everything the DESIGN.md files actually use.
function renderMarkdownLite(src: string): string {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let inList: ListTag | null = null;
  let inBlockquote = false;
  let inCode = false;
  let i = 0;

  function closeList() {
    if (inList) {
      out.push(`</${inList}>`);
      inList = null;
    }
  }
  function closeBlockquote() {
    if (inBlockquote) {
      out.push('</blockquote>');
      inBlockquote = false;
    }
  }

  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const line = raw.trimEnd();

    if (line.startsWith('```')) {
      closeList();
      closeBlockquote();
      if (!inCode) {
        out.push('<pre><code>');
        inCode = true;
      } else {
        out.push('</code></pre>');
        inCode = false;
      }
      i++;
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(raw));
      i++;
      continue;
    }
    if (!line.trim()) {
      closeList();
      closeBlockquote();
      i++;
      continue;
    }

    // GFM pipe table — at least a header row, a separator row of dashes,
    // and one body row. Look ahead from `i` so we can consume the whole
    // block in one step.
    if (looksLikeTableHeader(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? '')) {
      closeList();
      closeBlockquote();
      const headerCells = splitTableRow(line);
      const aligns = parseAlignments(lines[i + 1] ?? '', headerCells.length);
      const bodyRows: string[][] = [];
      let j = i + 2;
      while (j < lines.length) {
        const next = (lines[j] ?? '').trimEnd();
        if (!next.trim() || !next.includes('|')) break;
        bodyRows.push(splitTableRow(next));
        j++;
      }
      out.push(renderTable(headerCells, bodyRows, aligns));
      i = j;
      continue;
    }

    // ATX headings #..####
    const h = /^(#{1,4})\s+(.+)$/.exec(line);
    if (h) {
      closeList();
      closeBlockquote();
      const level = h[1]?.length ?? 1;
      out.push(`<h${level}>${inline(h[2] ?? '')}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^([-*_])\1{2,}\s*$/.test(line)) {
      closeList();
      closeBlockquote();
      out.push('<hr />');
      i++;
      continue;
    }

    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      closeList();
      if (!inBlockquote) {
        out.push('<blockquote>');
        inBlockquote = true;
      }
      out.push(`<p>${inline(bq[1] || '')}</p>`);
      i++;
      continue;
    }

    closeBlockquote();
    const li = /^([-*])\s+(.+)$/.exec(line);
    if (li) {
      if (inList !== 'ul') {
        closeList();
        out.push('<ul>');
        inList = 'ul';
      }
      out.push(`<li>${inline(li[2] ?? '')}</li>`);
      i++;
      continue;
    }
    const oli = /^\d+\.\s+(.+)$/.exec(line);
    if (oli) {
      if (inList !== 'ol') {
        closeList();
        out.push('<ol>');
        inList = 'ol';
      }
      out.push(`<li>${inline(oli[1] ?? '')}</li>`);
      i++;
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  closeList();
  closeBlockquote();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

function looksLikeTableHeader(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  // At least one pipe between non-pipe content.
  return /\|/.test(trimmed.replace(/^\||\|$/g, ''));
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  // Each cell must be only dashes / colons / whitespace.
  return splitTableRow(trimmed).every((cell) => /^:?-{1,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function parseAlignments(separatorLine: string, count: number): TableAlign[] {
  const cells = splitTableRow(separatorLine);
  const aligns: TableAlign[] = [];
  for (let k = 0; k < count; k++) {
    const cell = (cells[k] ?? '').trim();
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) aligns.push('center');
    else if (right) aligns.push('right');
    else aligns.push(null);
  }
  return aligns;
}

function renderTable(header: string[], rows: string[][], aligns: TableAlign[]): string {
  const th = header
    .map((cell, k) => {
      const align = aligns[k];
      const attr = align ? ` align="${align}"` : '';
      return `<th${attr}>${inline(cell)}</th>`;
    })
    .join('');
  const body = rows
    .map((row) => {
      const tds = row
        .map((cell, k) => {
          const align = aligns[k];
          const attr = align ? ` align="${align}"` : '';
          return `<td${attr}>${inline(cell)}</td>`;
        })
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function inline(s: string): string {
  // Process inline tokens. Order matters: code spans first so their content
  // isn't further parsed; then bold/italic; then links; finally bare URLs.
  const escaped = escapeHtml(s);
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
}
