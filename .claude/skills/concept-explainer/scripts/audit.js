/* Explainer page audit — paste into the page (browser javascript_tool) and read
 * the JSON. Catches the failures that eyeballing reliably misses.
 *
 * Serve the file over http (a static server on any port) rather than file://;
 * some hosts behave differently and you want the served behavior.
 */
(() => {
  const px = (v) => parseFloat(v);

  const lum = (c) => {
    const m = (c || '').match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    if (m.length >= 4 && parseFloat(m[3]) === 0) return null; // transparent
    const [r, g, b] = m.slice(0, 3).map((n) => {
      n /= 255;
      return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  const ratio = (fg, bg) => {
    const a = lum(fg), b = lum(bg);
    if (a === null || b === null) return null;
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
  };

  // effective background: walk up until something actually paints
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (lum(c) !== null) return c;
      n = n.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  };

  const leaves = [...document.querySelectorAll('body *')]
    .filter((e) => !e.children.length && e.textContent.trim() && e.offsetParent !== null);

  const label = (e) => e.textContent.trim().slice(0, 44);

  // --- theme pin: force the host's dark stamp and see whether anything flips
  const root = document.documentElement;
  const had = root.getAttribute('data-theme');
  root.setAttribute('data-theme', 'dark');
  const themeUnderDarkStamp = {
    htmlBg: getComputedStyle(root).backgroundColor,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
    colorScheme: getComputedStyle(root).colorScheme,
  };
  had === null ? root.removeAttribute('data-theme') : root.setAttribute('data-theme', had);

  // --- contrast (WCAG AA: 4.5 normal, 3.0 for >=24px or >=19px bold)
  const lowContrast = leaves
    .map((e) => {
      const cs = getComputedStyle(e);
      const size = px(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
      const r = ratio(cs.color, bgOf(e));
      return { text: label(e), px: +size.toFixed(1), ratio: r, needs: large ? 3 : 4.5 };
    })
    .filter((x) => x.ratio !== null && x.ratio < x.needs)
    .sort((a, b) => a.ratio - b.ratio);

  // --- tiny text (rem resolves against the 16px root, not your body size)
  const tinyText = leaves
    .map((e) => ({ text: label(e), px: +px(getComputedStyle(e).fontSize).toFixed(1) }))
    .filter((x) => x.px < 13)
    .sort((a, b) => a.px - b.px);

  // --- wide content that is not scrollable in its own box
  const wideContentNotScrollable = [
    ...new Set(
      [...document.querySelectorAll('body *')]
        .filter((e) => e.scrollWidth > e.clientWidth + 1)
        .filter((e) => !/auto|scroll/.test(getComputedStyle(e).overflowX))
        .map((e) => e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).trim().split(/\s+/).join('.') : ''))
    ),
  ];

  // --- fonts: did the stack actually resolve, or silently fall back?
  const resolved = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const first = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim();
    return { family: first, available: document.fonts ? document.fonts.check(`16px "${first}"`) : null };
  };

  return JSON.stringify(
    {
      themeUnderDarkStamp,          // all light? then the pin holds
      pageScrollsSideways: root.scrollWidth > window.innerWidth,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      lowContrast: lowContrast.slice(0, 10),
      tinyText: tinyText.slice(0, 10),
      wideContentNotScrollable,
      fonts: { body: resolved('body'), display: resolved('h1') },
      emDashesInBodyCopy: (document.body.innerText.match(/—/g) || []).length,
    },
    null,
    2
  );
})();
