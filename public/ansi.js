'use strict';
/* ANSI colour rendering for message bodies — no vendor library needed.
 *
 * Exposes window.MAnsi: { has(text), transform(root) }
 *
 * transform() walks the text nodes of a DOM subtree and interprets SGR
 * escape sequences (\x1b[ … m) as colours and attributes rendered through
 * spans it builds itself; every other escape sequence (cursor moves, OSC
 * titles, stray ESC) is dropped. Nothing is ever parsed as HTML: the text
 * reaches the page through text nodes, and a span only ever receives a
 * class from the fixed list below or a self-generated #rrggbb inline style,
 * so a hostile message cannot smuggle markup in this way either.
 *
 * The 16 base palette entries become .ans-fg-N / .ans-bg-N classes, so the
 * palette follows the current theme (style.css owns the values). 256-colour
 * and truecolour codes become fixed hex inline styles — there the poster
 * asked for an exact colour and themes must not override it.
 *
 * Style state resets at every text node: a sequence that opens a colour
 * never leaks its state across element boundaries.
 */
window.MAnsi = (() => {
  // one scan for everything a terminal would swallow: CSI (SGR is kept, the
  // rest dropped), OSC … BEL|ST — and an OSC whose terminator never arrives
  // runs to the next escape or the end, two-character escapes, stray ESC
  const SEQ = /\x1b\[([0-9;:?]*)([@-~])|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\][^\x1b]*|\x1b[@-Z\\-_]|\x1b/g;

  const HEX16 = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
  // xterm palette for the exact-colour range 16..255; 0..15 route back to
  // the theme classes above
  const CUBE = [0, 95, 135, 175, 215, 255];
  const hex256safe = (n) => {
    if (n < 16) return null; // caller falls back to the class palette
    if (n < 232) {
      const i = n - 16;
      return '#' + HEX16(CUBE[(i / 36) % 6 | 0]) + HEX16(CUBE[(i / 6) % 6 | 0]) + HEX16(CUBE[i % 6]);
    }
    const g = 8 + (n - 232) * 10;
    return '#' + HEX16(g) + HEX16(g) + HEX16(g);
  };

  const defaults = () => ({
    bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false,
    fg: null, bg: null, // number 0..15 → theme class, '#rrggbb' string → inline
  });
  const isDefault = (st) =>
    !st.bold && !st.dim && !st.italic && !st.underline && !st.inverse && !st.strike &&
    st.fg === null && st.bg === null;

  // fg/bg value: null default, number palette class, string exact hex
  function applySgr(raw, st) {
    const p = raw.length
      ? raw.split(';').map((s) => (s === '' ? 0 : Math.min(255, parseInt(s, 10) || 0)))
      : [0];
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) Object.assign(st, defaults());
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 7) st.inverse = true;
      else if (c === 9) st.strike = true;
      else if (c === 22) { st.bold = false; st.dim = false; }
      else if (c === 23) st.italic = false;
      else if (c === 24) st.underline = false;
      else if (c === 27) st.inverse = false;
      else if (c === 29) st.strike = false;
      else if (c === 39) st.fg = null;
      else if (c === 49) st.bg = null;
      else if (c >= 30 && c <= 37) st.fg = c - 30;
      else if (c >= 90 && c <= 97) st.fg = c - 82; // 90..97 → bright 8..15
      else if (c >= 40 && c <= 47) st.bg = c - 40;
      else if (c >= 100 && c <= 107) st.bg = c - 92;
      else if (c === 38 || c === 48) {
        const set = (v) => { if (c === 38) st.fg = v; else st.bg = v; };
        const mode = p[++i];
        if (mode === 5) {
          const n = p[++i] ?? 0;
          set(n < 16 ? n : hex256safe(n));
        } else if (mode === 2) {
          const r = p[++i] ?? 0, g = p[++i] ?? 0, b = p[++i] ?? 0;
          set('#' + HEX16(r) + HEX16(g) + HEX16(b));
        }
      }
      // every other SGR code (framing, fonts, overline, …): recognised, ignored
    }
  }

  function spanFor(st) {
    const cls = [];
    if (st.bold) cls.push('ans-b');
    if (st.dim) cls.push('ans-dim');
    if (st.italic) cls.push('ans-i');
    if (st.underline) cls.push('ans-u');
    if (st.strike) cls.push('ans-s');
    let inline = '';
    if (st.inverse) {
      cls.push('ans-inv');
      // swap the exact colours inline; palette colours fall back to the
      // .ans-inv default swap — inverse plus palette colour is rare in logs
      if (typeof st.fg === 'string') inline += `background-color:${st.fg};`;
      if (typeof st.bg === 'string') inline += `color:${st.bg};`;
    } else {
      if (typeof st.fg === 'number') cls.push(`ans-fg-${st.fg}`);
      if (typeof st.bg === 'number') cls.push(`ans-bg-${st.bg}`);
      if (typeof st.fg === 'string') inline += `color:${st.fg};`;
      if (typeof st.bg === 'string') inline += `background-color:${st.bg};`;
    }
    if (!cls.length && !inline) return null;
    const span = document.createElement('span');
    if (cls.length) span.className = cls.join(' ');
    if (inline) span.setAttribute('style', inline);
    return span;
  }

  function renderNode(node) {
    const text = node.nodeValue;
    const st = defaults();
    const frag = document.createDocumentFragment();
    let runStart = 0;
    let runStyle = { ...st };
    const flush = (end) => {
      const chunk = text.slice(runStart, end);
      if (!chunk) return;
      if (isDefault(runStyle)) frag.append(chunk);
      else {
        const span = spanFor(runStyle);
        span.textContent = chunk;
        frag.append(span);
      }
    };
    SEQ.lastIndex = 0;
    let m;
    while ((m = SEQ.exec(text)) !== null) {
      flush(m.index);
      if (m[2] === 'm') applySgr(m[1] || '', st);
      runStart = SEQ.lastIndex;
      runStyle = { ...st };
    }
    flush(text.length);
    node.replaceWith(frag);
  }

  const has = (text) => text.includes('\x1b');

  function transform(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) if (node.nodeValue.includes('\x1b')) renderNode(node);
  }

  return { has, transform };
})();
