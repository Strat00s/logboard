'use strict';
/* Markdown rendering for message bodies.
 *
 * marked turns the text into HTML, DOMPurify sanitises it — the bodies are
 * posted by arbitrary scripts, so the output is treated as hostile input:
 * no scripts, no event handlers, no javascript: links. Both libraries are
 * served by this same app from /vendor; if they ever fail to load, render()
 * returns null and the caller falls back to plain text.
 *
 * Exposes window.MVmd: { available(), render(text) -> DocumentFragment|null,
 *                        highlightIn(root, re) }
 */
window.MVmd = (() => {
  const clean = () => typeof window.marked !== 'undefined' && typeof window.DOMPurify !== 'undefined';

  function render(text) {
    if (!clean()) return null;
    let html;
    try {
      html = window.marked.parse(text, { gfm: true, breaks: true });
    } catch {
      return null;
    }
    const safe = window.DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'fieldset', 'object', 'embed', 'iframe', 'math', 'svg'],
      FORBID_ATTR: ['style', 'srcset', 'background'],
    });
    const tpl = document.createElement('template');
    tpl.innerHTML = safe;
    // DOMPurify already drops scripts/handlers/evil urls; this only makes the
    // surviving links open safely in their own tab.
    for (const a of tpl.content.querySelectorAll('a[href]')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    return tpl.content;
  }

  // Same <mark> highlighting the raw view gets, applied to the text nodes of
  // already-rendered markdown (code blocks included — you search, you want it).
  function highlightIn(root, re) {
    if (!re) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      re.lastIndex = 0;
      let m, last = 0;
      const hits = [];
      while ((m = re.exec(text)) !== null) {
        hits.push([m.index, m[0]]);
        if (m[0] === '') re.lastIndex += 1; // zero-width match: advance manually
      }
      if (!hits.length) continue;
      const frag = document.createDocumentFragment();
      for (const [idx, hit] of hits) {
        if (idx > last) frag.append(text.slice(last, idx));
        if (hit) {
          const mark = document.createElement('mark');
          mark.textContent = hit;
          frag.append(mark);
        }
        last = idx + hit.length;
      }
      frag.append(text.slice(last));
      node.parentNode.replaceChild(frag, node);
    }
  }

  return { available: clean, render, highlightIn };
})();
