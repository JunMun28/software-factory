/* PROTOTYPE — throwaway. All 70 AIRES mark concepts.
   Each entry: { n: name, idea: one-line rationale, svg: (strokeWidth) => innerSVG }
   Square marks draw into viewBox "0 0 48 48". Wordmark lockups set wide:true
   (and optionally vw: viewBox width) and draw into "0 0 <vw> 26".
   Family separators are { fam, note }. */
const A = 'var(--a500)';

const MARKS = [
  /* ─────────────── ROUND 1 ─────────────── */
  { fam: 'A — monogram', round: 1 },
  {
    n: 'Apex', idea: 'The A as a clean peak. Accent crossbar is the one coloured element.',
    svg: (w) => `<path d="M9 38 L24 12 L39 38" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>
                 <path d="M16.5 27.5 H31.5" stroke="${A}" stroke-width="${w}" stroke-linecap="round"/>`,
  },
  {
    n: 'Gate', idea: 'A built from two brackets — request enters, execution leaves.',
    svg: (w) => `<path d="M19 11 H12 V37 H19 M29 11 H36 V37 H29" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>
                 <circle cx="24" cy="24" r="${w * 0.62}" fill="${A}"/>`,
  },
  {
    n: 'Split A', idea: 'The two legs never touch. Reads as an A, but also as a funnel.',
    svg: (w) => `<path d="M11 38 L22.5 15" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M25.5 15 L37 38" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M17 29 H31" stroke="${A}" stroke-width="${w}" stroke-linecap="round"/>`,
  },
  {
    n: 'Round a', idea: 'Lowercase geometric a — friendlier, closest in spirit to the old S.',
    svg: (w) => `<circle cx="22" cy="26" r="11" fill="none" stroke="currentColor" stroke-width="${w}"/>
                 <path d="M33 15 V33" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="33" cy="37" r="${w * 0.62}" fill="${A}"/>`,
  },

  { fam: 'Aries — the ram, the first sign', round: 1 },
  {
    n: 'Aries Glyph', idea: 'The zodiac ram symbol, geometric. AIRES/ARIES is one letter apart.',
    svg: (w) => `<path d="M24 38 V23" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M24 23 C24 13 18 10 14 12.5 C10 15 10.5 21.5 15 22" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M24 23 C24 13 30 10 34 12.5 C38 15 37.5 21.5 33 22" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>`,
  },
  {
    n: 'Horns', idea: 'Just the curls — no stem. More abstract, less zodiac-literal.',
    svg: (w) => `<path d="M24 34 C24 20 18 13 13.5 16 C9 19 11 26 16 25" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M24 34 C24 20 30 13 34.5 16 C39 19 37 26 32 25" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="24" cy="36" r="${w * 0.6}" fill="${A}"/>`,
  },
  {
    n: 'Single Horn', idea: 'One continuous stroke that doubles back — a spiral of intent.',
    svg: (w) => `<path d="M12 36 C12 18 22 11 30 15 C37 18.5 35 29 27 28 C22 27.4 21 22 25 20" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>`,
  },
  {
    n: 'Aries Dot', idea: 'The glyph, with the old brand dot kept at the stem base.',
    svg: (w) => `<path d="M24 34 V24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M24 24 C24 14 18.5 11 15 13.5 C11.5 16 12 21.5 16 22" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M24 24 C24 14 29.5 11 33 13.5 C36.5 16 36 21.5 32 22" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="24" cy="39" r="${w * 0.62}" fill="${A}"/>`,
  },

  { fam: 'Request → Execution', round: 1 },
  {
    n: 'Ascend', idea: 'A request rises off the baseline and becomes a shipped thing.',
    svg: (w) => `<path d="M24 36 V13" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M15.5 21 L24 12.5 L32.5 21" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>
                 <path d="M11 40 H37" stroke="${A}" stroke-width="${w}" stroke-linecap="round"/>`,
  },
  {
    n: 'Pipeline', idea: 'Three chevrons — the stages. The last one has landed.',
    svg: (w) => `<path d="M11 15 L19 24 L11 33" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>
                 <path d="M22 15 L30 24 L22 33" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>
                 <path d="M33 15 L41 24 L33 33" fill="none" stroke="${A}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    n: 'Transform', idea: 'A rough ask (square) becomes a finished thing (circle).',
    fails: '23px — collapses to two dots',
    svg: (w) => `<rect x="7" y="17" width="14" height="14" rx="3.5" fill="none" stroke="currentColor" stroke-width="${w}"/>
                 <circle cx="34" cy="24" r="7" fill="none" stroke="${A}" stroke-width="${w}"/>`,
  },
  {
    n: 'Throughput', idea: 'One line in, one line out, accent where it exits.',
    svg: (w) => `<path d="M8 24 H25" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M31 24 H40" fill="none" stroke="${A}" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M22 16 L30 24 L22 32" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  { fam: 'Automation — the loop', round: 1 },
  {
    n: 'Loop', idea: 'A cycle with one gap: the human decision the factory waits on.',
    svg: (w) => `<path d="M35 15 A14 14 0 1 0 37 27" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="35" cy="15" r="${w * 0.62}" fill="${A}"/>`,
  },
  {
    n: 'Orbit', idea: 'A core with one thing in motion around it. Reads at any size.',
    svg: (w) => `<circle cx="24" cy="24" r="13" fill="none" stroke="currentColor" stroke-width="${w * 0.72}"/>
                 <circle cx="24" cy="24" r="${w * 0.75}" fill="currentColor"/>
                 <circle cx="24" cy="11" r="${w * 0.68}" fill="${A}"/>`,
  },
  {
    n: 'Return', idea: 'The refine loop — output curls back to become new input.',
    svg: (w) => `<path d="M14 16 H29 A8.5 8.5 0 0 1 29 33 H17" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M23 27 L16.5 33 L23 39" fill="none" stroke="${A}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  { fam: 'Intelligence', round: 1 },
  {
    n: 'Node', idea: 'One brain, three arms — the agent and the work it dispatches.',
    svg: (w) => `<path d="M24 20 V9 M28.5 27 L38 34 M19.5 27 L10 34" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="24" cy="24" r="${w * 0.95}" fill="${A}"/>`,
  },
  {
    n: 'Spark', idea: 'The four-point AI sparkle. Instantly legible, but very of-its-moment.',
    svg: (w) => `<path d="M24 7 C25.4 18.6 29.4 22.6 41 24 C29.4 25.4 25.4 29.4 24 41 C22.6 29.4 18.6 25.4 7 24 C18.6 22.6 22.6 18.6 24 7 Z" fill="currentColor"/>
                 <circle cx="38" cy="11" r="${w * 0.6}" fill="${A}"/>`,
  },
  {
    n: 'Constellation', idea: 'Five points that imply an A without drawing one.',
    fails: '23px — the points nearly vanish',
    svg: (w) => `<path d="M24 11 L13 37 M24 11 L35 37 M17.5 27 H30.5" fill="none" stroke="currentColor" stroke-width="${w * 0.5}" stroke-linecap="round" opacity=".45"/>
                 <circle cx="24" cy="11" r="${w * 0.68}" fill="${A}"/>
                 <circle cx="13" cy="37" r="${w * 0.6}" fill="currentColor"/>
                 <circle cx="35" cy="37" r="${w * 0.6}" fill="currentColor"/>
                 <circle cx="17.5" cy="27" r="${w * 0.5}" fill="currentColor"/>
                 <circle cx="30.5" cy="27" r="${w * 0.5}" fill="currentColor"/>`,
  },

  { fam: 'System', round: 1 },
  {
    n: 'Stack', idea: 'Three ascending bars — keeps the old mark’s "stacked" language.',
    svg: (w) => `<path d="M9 35 H25" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M14 24 H30" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M19 13 H35" fill="none" stroke="${A}" stroke-width="${w}" stroke-linecap="round"/>`,
  },
  {
    n: 'Aperture', idea: 'A notched square — the wafer/Micron nod, carried over abstractly.',
    svg: (w) => `<path d="M31 10 H14 A4 4 0 0 0 10 14 V34 A4 4 0 0 0 14 38 H34 A4 4 0 0 0 38 34 V17" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>
                 <circle cx="35.5" cy="12.5" r="${w * 0.65}" fill="${A}"/>`,
  },

  /* ─────────────── ROUND 2 ─────────────── */
  {
    fam: 'Continuous line', round: 2,
    note: 'The old Stacked S was one unbroken stroke — the strongest visual link back to it.',
  },
  {
    n: 'One-Line A', idea: 'Drawn without lifting: up, over, down, back along the bar.',
    svg: (w) => `<path d="M11 38 L24 12 L37 38 L30 27 L17 27" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    n: 'Zigzag', idea: 'One stroke folding through the frame — process, not object.',
    svg: (w) => `<path d="M9 32 L19 17 L28 32 L39 16" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>
                 <circle cx="39" cy="16" r="${w * 0.62}" fill="${A}"/>`,
  },
  {
    n: 'Thread', idea: 'Enters left, exits right, accent where it lands. Closest to the old S.',
    svg: (w) => `<path d="M8 32 C16 32 16 17 24 17 C32 17 32 32 40 32" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="9" cy="32" r="${w * 0.6}" fill="${A}"/>`,
  },
  {
    n: 'Link', idea: 'Two rings that share an edge — the request and the thing it became.',
    svg: (w) => `<circle cx="19" cy="24" r="9.5" fill="none" stroke="currentColor" stroke-width="${w}"/>
                 <circle cx="30" cy="24" r="9.5" fill="none" stroke="${A}" stroke-width="${w}"/>`,
  },

  { fam: 'Negative space', round: 2, note: 'Form knocked out of a solid tile. Reads strongest as an app icon.' },
  {
    n: 'Carved A', idea: 'Solid tile, A knocked out. This is the app-icon answer.',
    svg: () => `<path fill-rule="evenodd" d="M9 4 H39 A5 5 0 0 1 44 9 V39 A5 5 0 0 1 39 44 H9 A5 5 0 0 1 4 39 V9 A5 5 0 0 1 9 4 Z M24 14 L34 36 H29.2 L27 31 H21 L18.8 36 H14 Z M22.6 27 H25.4 L24 23.6 Z" fill="currentColor"/>`,
  },
  {
    n: 'Counter', idea: 'Only the triangle inside the A survives. Very abstract, very small-safe.',
    svg: (w) => `<path d="M11 38 L24 12 L37 38" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" opacity=".35"/>
                 <path d="M24 20 L31 34 H17 Z" fill="${A}"/>`,
  },
  {
    n: 'Void Ram', idea: 'The ram glyph knocked out of a solid tile.',
    svg: () => `<path fill-rule="evenodd" d="M9 4 H39 A5 5 0 0 1 44 9 V39 A5 5 0 0 1 39 44 H9 A5 5 0 0 1 4 39 V9 A5 5 0 0 1 9 4 Z M21.5 38 V25 C21.5 18 17 16 14.7 17.6 C12 19.5 12.6 23.4 15.6 23.8 L14.9 28.2 C8.4 27.3 6.9 19.6 12 16 C16.6 12.8 22.9 15.4 24 21.6 C25.1 15.4 31.4 12.8 36 16 C41.1 19.6 39.6 27.3 33.1 28.2 L32.4 23.8 C35.4 23.4 36 19.5 33.3 17.6 C31 16 26.5 18 26.5 25 V38 Z" fill="currentColor"/>`,
  },

  {
    fam: 'Wordmark lockups', round: 2,
    note: 'NOT square marks — these replace the mark + "AIRES" pair entirely, so there is nothing to shrink to 23px.',
  },
  {
    n: 'Letterspaced', idea: 'Caps, wide tracking, the I carrying the accent. Calm and institutional.',
    wide: true,
    svg: () => `<text x="0" y="17" font-family="Archivo, sans-serif" font-size="19" font-weight="800" letter-spacing="3.5" fill="currentColor">A<tspan fill="${A}">I</tspan>RES</text>`,
  },
  {
    n: 'AI Bind', idea: 'The A and I fused — the "AI" inside the name made literal.',
    wide: true,
    svg: () => `<path d="M2 21 L10 3 L18 21 M5.6 15 H14.4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M18 21 V3" stroke="${A}" stroke-width="2.6" stroke-linecap="round"/>
                <text x="23" y="21" font-family="Archivo, sans-serif" font-size="19" font-weight="800" letter-spacing="1" fill="currentColor">RES</text>`,
  },
  {
    n: 'Mono Tag', idea: 'Terminal voice — matches the ASCII hero field exactly.',
    wide: true, vw: 104,
    svg: () => `<text x="0" y="18" font-family="JetBrains Mono, ui-monospace, monospace" font-size="17" font-weight="700" letter-spacing="0.5" fill="currentColor">[<tspan fill="${A}">·</tspan>] aires</text>`,
  },
  {
    n: 'Stencil', idea: 'Cut caps — industrial, stencilled on the side of the machine.',
    wide: true,
    svg: () => `<text x="0" y="18" font-family="Archivo, sans-serif" font-size="20" font-weight="900" letter-spacing="1" fill="currentColor">AIRES</text>
                <rect x="-1" y="8.5" width="86" height="2.4" fill="var(--surface-2)"/>`,
  },

  { fam: 'Air', round: 2, note: 'The name reads as "air" before it reads as an acronym.' },
  {
    n: 'Currents', idea: 'Three moving lines of unequal length. Quiet, no letterform at all.',
    svg: (w) => `<path d="M9 17 H33" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M9 25 H39" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M9 33 H25" fill="none" stroke="${A}" stroke-width="${w}" stroke-linecap="round"/>`,
  },
  {
    n: 'Updraft', idea: 'Curves that rise and taper — the request lifting.',
    svg: (w) => `<path d="M13 37 C13 24 19 17 27 13" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M23 37 C23 28 27 22 34 18" fill="none" stroke="currentColor" stroke-width="${w * 0.8}" stroke-linecap="round"/>
                 <path d="M32 37 C32 32 34 28 38 25" fill="none" stroke="${A}" stroke-width="${w * 0.66}" stroke-linecap="round"/>`,
  },
  {
    n: 'Layers', idea: 'Concentric arcs — bands of atmosphere, or stages stacked.',
    svg: (w) => `<path d="M10 34 A14 14 0 0 1 38 34" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M17 34 A7 7 0 0 1 31 34" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="24" cy="34" r="${w * 0.6}" fill="${A}"/>`,
  },

  { fam: 'Semiconductor', round: 2, note: 'Micron heritage, carried further than the old mark took it.' },
  {
    n: 'Die', idea: 'A die with the wafer flat notched off one corner.',
    svg: (w) => `<path d="M16 9 H35 A4 4 0 0 1 39 13 V35 A4 4 0 0 1 35 39 H13 A4 4 0 0 1 9 35 V16 Z" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linejoin="round"/>
                 <circle cx="24" cy="24" r="${w * 0.75}" fill="${A}"/>`,
  },
  {
    n: 'Lattice', idea: 'Six nodes round one — crystal, or a fleet round a coordinator.',
    svg: (w) => `<circle cx="24" cy="24" r="${w * 0.8}" fill="${A}"/>
                 <circle cx="24" cy="11" r="${w * 0.62}" fill="currentColor"/>
                 <circle cx="35" cy="17.5" r="${w * 0.62}" fill="currentColor"/>
                 <circle cx="35" cy="30.5" r="${w * 0.62}" fill="currentColor"/>
                 <circle cx="24" cy="37" r="${w * 0.62}" fill="currentColor"/>
                 <circle cx="13" cy="30.5" r="${w * 0.62}" fill="currentColor"/>
                 <circle cx="13" cy="17.5" r="${w * 0.62}" fill="currentColor"/>`,
  },
  {
    n: 'Mask', idea: 'Two photomask rectangles overlapping — alignment, layering.',
    svg: (w) => `<rect x="9" y="13" width="21" height="21" rx="3" fill="none" stroke="currentColor" stroke-width="${w}"/>
                 <rect x="19" y="19" width="21" height="21" rx="3" fill="none" stroke="${A}" stroke-width="${w}"/>`,
  },

  { fam: 'Energy', round: 2, note: 'The hero’s ASCII field is literally called the "Ignition" glyph field.' },
  {
    n: 'Ignition', idea: 'A chamber with one spark leaving it. Ties the mark to the hero.',
    svg: (w) => `<path d="M30 11 A14 14 0 1 0 30 37" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="35" cy="24" r="${w * 0.72}" fill="${A}"/>`,
  },
  {
    n: 'Plume', idea: 'A dot with the trail it left — something already in flight.',
    svg: (w) => `<path d="M8 34 C18 34 26 27 32 17" fill="none" stroke="currentColor" stroke-width="${w * 0.72}" stroke-linecap="round" opacity=".5"/>
                 <path d="M15 37 C24 36 31 30 36 22" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="37" cy="15" r="${w * 0.85}" fill="${A}"/>`,
  },
  {
    n: 'Bloom', idea: 'One point, six things dispatched from it. The fan-out, literally.',
    svg: (w) => `<path d="M24 18 V8 M32 20.5 L39 13.5 M32 27.5 L39 34.5 M24 30 V40 M16 27.5 L9 34.5 M16 20.5 L9 13.5" fill="none" stroke="currentColor" stroke-width="${w * 0.85}" stroke-linecap="round"/>
                 <circle cx="24" cy="24" r="${w * 0.8}" fill="${A}"/>`,
  },

  /* ─────────────── ROUND 3 ─────────────── */
  {
    fam: 'Dialogue', round: 3,
    note: 'The thing AIRES actually does is interview you. No earlier round drew the conversation.',
  },
  {
    n: 'Bubble A', idea: 'A speech bubble with the A as its counter. Says "this thing talks".',
    svg: (w) => `<path d="M12 10 H36 A4 4 0 0 1 40 14 V30 A4 4 0 0 1 36 34 H24 L16 41 V34 H12 A4 4 0 0 1 8 30 V14 A4 4 0 0 1 12 10 Z" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linejoin="round"/>
                 <path d="M19 28 L24 16 L29 28" fill="none" stroke="${A}" stroke-width="${w * 0.85}" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    n: 'Two Voices', idea: 'Two bubbles overlapping — submitter and agent, the actual interview.',
    svg: (w) => `<path d="M8 13 H26 A3.5 3.5 0 0 1 29.5 16.5 V25 A3.5 3.5 0 0 1 26 28.5 H8 A3.5 3.5 0 0 1 4.5 25 V16.5 A3.5 3.5 0 0 1 8 13 Z" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linejoin="round"/>
                 <path d="M22 21 H40 A3.5 3.5 0 0 1 43.5 24.5 V33 A3.5 3.5 0 0 1 40 36.5 H22 A3.5 3.5 0 0 1 18.5 33 V24.5 A3.5 3.5 0 0 1 22 21 Z" fill="none" stroke="${A}" stroke-width="${w}" stroke-linejoin="round"/>`,
  },
  {
    n: 'The Question', idea: 'A bubble whose only content is the accent dot — the question being asked.',
    svg: (w) => `<path d="M13 11 H35 A5 5 0 0 1 40 16 V29 A5 5 0 0 1 35 34 H22 L14 40 V34 H13 A5 5 0 0 1 8 29 V16 A5 5 0 0 1 13 11 Z" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linejoin="round"/>
                 <circle cx="24" cy="22.5" r="${w * 0.78}" fill="${A}"/>`,
  },
  {
    n: 'Exchange', idea: 'Two arrows passing — ask and answer, back and forth.',
    svg: (w) => `<path d="M10 18 H34 M27 11 L34 18 L27 25" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>
                 <path d="M38 32 H14 M21 25 L14 32 L21 39" fill="none" stroke="${A}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    n: 'Prompt', idea: 'A terminal prompt caret and cursor. The most honest mark for a text-first tool.',
    svg: (w) => `<path d="M11 15 L21 24 L11 33" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>
                 <path d="M27 33 H39" fill="none" stroke="${A}" stroke-width="${w}" stroke-linecap="round"/>`,
  },

  { fam: 'Enclosure', round: 3, note: 'A contained mark sits better on crowded surfaces — tabs, avatars, badges.' },
  {
    n: 'Ring A', idea: 'The peak inside a ring. Self-contained, works as an avatar.',
    svg: (w) => `<circle cx="24" cy="24" r="16" fill="none" stroke="currentColor" stroke-width="${w * 0.8}"/>
                 <path d="M16 31 L24 16 L32 31" fill="none" stroke="currentColor" stroke-width="${w * 0.9}" stroke-linecap="round" stroke-linejoin="round"/>
                 <path d="M20 26 H28" stroke="${A}" stroke-width="${w * 0.9}" stroke-linecap="round"/>`,
  },
  {
    n: 'Hex', idea: 'Hexagon — the wafer-cell shape, and it tiles.',
    svg: (w) => `<path d="M24 6 L38 14.5 V31.5 L24 40 L10 31.5 V14.5 Z" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linejoin="round"/>
                 <path d="M24 17 V31" fill="none" stroke="currentColor" stroke-width="${w * 0.85}" stroke-linecap="round"/>
                 <circle cx="24" cy="13" r="${w * 0.6}" fill="${A}"/>`,
  },
  {
    n: 'Shield', idea: 'A gate that passed — governance made visible.',
    svg: (w) => `<path d="M24 7 L39 13 V25 C39 33 32 39 24 42 C16 39 9 33 9 25 V13 Z" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linejoin="round"/>
                 <path d="M17 24 L22 29 L32 19" fill="none" stroke="${A}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    n: 'Chip Badge', idea: 'A package with pins. The most literal semiconductor form here.',
    svg: (w) => `<rect x="13" y="13" width="22" height="22" rx="3" fill="none" stroke="currentColor" stroke-width="${w}"/>
                 <path d="M19 13 V7 M29 13 V7 M19 35 V41 M29 35 V41 M13 19 H7 M13 29 H7 M35 19 H41 M35 29 H41" fill="none" stroke="currentColor" stroke-width="${w * 0.62}" stroke-linecap="round"/>
                 <circle cx="24" cy="24" r="${w * 0.72}" fill="${A}"/>`,
  },
  {
    n: 'Notch Ring', idea: 'A ring with one bite taken out — the wafer flat, minimal.',
    svg: (w) => `<path d="M33 12.5 A15 15 0 1 0 38.5 25" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M33 12.5 L38.5 25" fill="none" stroke="${A}" stroke-width="${w}" stroke-linecap="round"/>`,
  },

  { fam: 'Matrix', round: 3, note: 'Built from repeated units — reads as a system rather than an object.' },
  {
    n: 'Dot Matrix', idea: 'Nine cells, one lit. The one request that needs you.',
    svg: (w) => `<circle cx="14" cy="14" r="${w * 0.5}" fill="currentColor"/><circle cx="24" cy="14" r="${w * 0.5}" fill="currentColor"/><circle cx="34" cy="14" r="${w * 0.5}" fill="currentColor"/>
                 <circle cx="14" cy="24" r="${w * 0.5}" fill="currentColor"/><circle cx="24" cy="24" r="${w * 0.78}" fill="${A}"/><circle cx="34" cy="24" r="${w * 0.5}" fill="currentColor"/>
                 <circle cx="14" cy="34" r="${w * 0.5}" fill="currentColor"/><circle cx="24" cy="34" r="${w * 0.5}" fill="currentColor"/><circle cx="34" cy="34" r="${w * 0.5}" fill="currentColor"/>`,
  },
  {
    n: 'Pixel A', idea: 'The A built from square cells — low-res on purpose.',
    svg: () => `<g fill="currentColor">
                  <rect x="20" y="9" width="8" height="7" rx="1"/>
                  <rect x="13" y="18" width="8" height="7" rx="1"/><rect x="27" y="18" width="8" height="7" rx="1"/>
                  <rect x="13" y="27" width="22" height="7" rx="1" fill="${A}"/>
                  <rect x="6" y="36" width="8" height="7" rx="1"/><rect x="34" y="36" width="8" height="7" rx="1"/>
                </g>`,
  },
  {
    n: 'Bars', idea: 'A small bar chart — throughput, made of the same unit repeated.',
    svg: (w) => `<path d="M11 36 V27" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M19.7 36 V20" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M28.3 36 V24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M37 36 V12" fill="none" stroke="${A}" stroke-width="${w}" stroke-linecap="round"/>`,
  },
  {
    n: 'Punch Card', idea: 'Rows of slots, one punched. Quietly computational.',
    svg: (w) => `<rect x="9" y="11" width="30" height="26" rx="3" fill="none" stroke="currentColor" stroke-width="${w * 0.8}"/>
                 <path d="M15 19 H23 M27 19 H33 M15 29 H21" fill="none" stroke="currentColor" stroke-width="${w * 0.72}" stroke-linecap="round"/>
                 <path d="M25 29 H33" fill="none" stroke="${A}" stroke-width="${w * 0.72}" stroke-linecap="round"/>`,
  },
  {
    n: 'Halftone', idea: 'Dots shrinking left to right — the glow fading, like the hero field.',
    svg: (w) => `<circle cx="10" cy="24" r="${w * 0.95}" fill="${A}"/>
                 <circle cx="20" cy="24" r="${w * 0.75}" fill="currentColor"/>
                 <circle cx="29" cy="24" r="${w * 0.55}" fill="currentColor"/>
                 <circle cx="36.5" cy="24" r="${w * 0.38}" fill="currentColor"/>
                 <circle cx="42" cy="24" r="${w * 0.24}" fill="currentColor"/>`,
  },

  { fam: 'Assembly', round: 3, note: 'Parts coming together — the factory metaphor without a conveyor belt.' },
  {
    n: 'Blocks', idea: 'Three modules stacked into one thing.',
    svg: (w) => `<rect x="16" y="7" width="16" height="10" rx="2.5" fill="none" stroke="currentColor" stroke-width="${w * 0.85}"/>
                 <rect x="10" y="19" width="28" height="10" rx="2.5" fill="none" stroke="currentColor" stroke-width="${w * 0.85}"/>
                 <rect x="16" y="31" width="16" height="10" rx="2.5" fill="none" stroke="${A}" stroke-width="${w * 0.85}"/>`,
  },
  {
    n: 'Interlock', idea: 'Two forms that only make sense together — human plus machine.',
    svg: (w) => `<path d="M10 12 H24 V24 H10 Z" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linejoin="round"/>
                 <path d="M24 24 H38 V36 H24 Z" fill="none" stroke="${A}" stroke-width="${w}" stroke-linejoin="round"/>`,
  },
  {
    n: 'Nested', idea: 'Brackets inside brackets — scope, contained.',
    svg: (w) => `<path d="M17 9 H9 V39 H17" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>
                 <path d="M31 9 H39 V39 H31" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>
                 <path d="M22 17 H26 V31 H22" fill="none" stroke="${A}" stroke-width="${w * 0.8}" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    n: 'Split Cube', idea: 'One volume divided — the spec and the build, same object.',
    svg: (w) => `<path d="M24 7 L40 16 V33 L24 42 L8 33 V16 Z" fill="none" stroke="currentColor" stroke-width="${w * 0.85}" stroke-linejoin="round"/>
                 <path d="M24 7 V42" fill="none" stroke="${A}" stroke-width="${w * 0.85}"/>`,
  },
  {
    n: 'Join', idea: 'Two halves meeting at a seam, accent at the join.',
    svg: (w) => `<path d="M8 24 A10 10 0 0 1 28 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M20 24 A10 10 0 0 0 40 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="24" cy="24" r="${w * 0.7}" fill="${A}"/>`,
  },

  { fam: 'Gates', round: 3, note: 'Your own domain language: the factory runs on gates, approvals and stages.' },
  {
    n: 'Checkpoint', idea: 'A barrier lifting — the approval gate, literally.',
    svg: (w) => `<path d="M12 40 V14" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M14 17 L39 11" fill="none" stroke="${A}" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M20 33 H39" fill="none" stroke="currentColor" stroke-width="${w * 0.7}" stroke-linecap="round" opacity=".45"/>`,
  },
  {
    n: 'Passed', idea: 'A check drawn as a rising arrow — approved and moving.',
    svg: (w) => `<path d="M10 26 L19 35 L38 12" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>
                 <circle cx="38" cy="12" r="${w * 0.68}" fill="${A}"/>`,
  },
  {
    n: 'Milestones', idea: 'Four stops on one track, the last one live.',
    svg: (w) => `<path d="M9 24 H39" fill="none" stroke="currentColor" stroke-width="${w * 0.62}" stroke-linecap="round" opacity=".4"/>
                 <circle cx="10" cy="24" r="${w * 0.58}" fill="currentColor"/>
                 <circle cx="20" cy="24" r="${w * 0.58}" fill="currentColor"/>
                 <circle cx="29" cy="24" r="${w * 0.58}" fill="currentColor"/>
                 <circle cx="38" cy="24" r="${w * 0.92}" fill="${A}"/>`,
  },
  {
    n: 'Threshold', idea: 'A doorway with something passing through it.',
    svg: (w) => `<path d="M14 40 V12 H34 V40" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linejoin="round"/>
                 <path d="M24 18 V32 M19 27 L24 32 L29 27" fill="none" stroke="${A}" stroke-width="${w * 0.8}" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    n: 'Stamp', idea: 'An approval stamp — a ring with a mark struck through it.',
    svg: (w) => `<circle cx="24" cy="24" r="15" fill="none" stroke="currentColor" stroke-width="${w * 0.8}"/>
                 <path d="M16 24 L22 30 L33 18" fill="none" stroke="${A}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  { fam: 'Dimensional', round: 3, note: 'Depth and folding — the only family here that is not flat.' },
  {
    n: 'Iso A', idea: 'The peak in isometric — an object with a footprint, not a drawing.',
    svg: (w) => `<path d="M24 8 L40 34 L24 40 L8 34 Z" fill="none" stroke="currentColor" stroke-width="${w * 0.85}" stroke-linejoin="round"/>
                 <path d="M24 8 L24 40" fill="none" stroke="currentColor" stroke-width="${w * 0.7}" opacity=".4"/>
                 <path d="M15 27 H33" stroke="${A}" stroke-width="${w * 0.85}" stroke-linecap="round"/>`,
  },
  {
    n: 'Fold', idea: 'A plane creased once — flat spec folded into something built.',
    svg: (w) => `<path d="M9 34 L24 10 L24 34 Z" fill="currentColor"/>
                 <path d="M24 10 L39 34 L24 34 Z" fill="${A}" opacity=".85"/>`,
  },
  {
    n: 'Prism', idea: 'One input, split into its parts. The spec becoming stages.',
    svg: (w) => `<path d="M24 9 L40 37 H8 Z" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linejoin="round"/>
                 <path d="M24 9 V37" fill="none" stroke="${A}" stroke-width="${w * 0.75}"/>`,
  },
  {
    n: 'Depth', idea: 'Squares rotating inward — a system with layers under it.',
    svg: (w) => `<rect x="8" y="8" width="32" height="32" rx="4" fill="none" stroke="currentColor" stroke-width="${w * 0.72}"/>
                 <rect x="14" y="14" width="20" height="20" rx="3" fill="none" stroke="currentColor" stroke-width="${w * 0.72}" transform="rotate(20 24 24)"/>
                 <circle cx="24" cy="24" r="${w * 0.62}" fill="${A}"/>`,
  },
  {
    n: 'Iris', idea: 'Camera blades mid-open — the aperture idea done properly.',
    svg: (w) => `<circle cx="24" cy="24" r="15" fill="none" stroke="currentColor" stroke-width="${w * 0.78}"/>
                 <path d="M24 9 L34 26 M39 32 L19 32 M14 40 L24 23" fill="none" stroke="currentColor" stroke-width="${w * 0.7}" stroke-linecap="round"/>
                 <circle cx="24" cy="24" r="${w * 0.6}" fill="${A}"/>`,
  },

  /* ─────────────── ROUND 4 ─────────────── */
  {
    fam: 'Continuous line — curved', round: 4,
    note: 'Curved siblings of 21–24 (appended here so earlier numbers stay stable). 71 is 22 Zigzag with every corner rounded into a curve; the rest vary amplitude, direction and where the stroke ends.',
  },
  {
    n: 'Wave', idea: '22 Zigzag with every corner curved. Same rhythm, none of the sharpness.',
    svg: (w) => `<path d="M8 31 C12 31 13 17 18 17 C23 17 24 31 29 31 C34 31 35 17 40 17" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="40" cy="17" r="${w * 0.62}" fill="${A}"/>`,
  },
  {
    n: 'Crescendo', idea: 'The swing grows as it travels — a small ask becoming a real thing.',
    svg: (w) => `<path d="M8 24 C11 24 11 21 14 21 C17 21 17 30 22 30 C27 30 27 12 34 12" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="37.5" cy="12" r="${w * 0.62}" fill="${A}"/>`,
  },
  {
    n: 'Settle', idea: 'Wild at the start, flat at the end. A messy ask resolving into a spec.',
    svg: (w) => `<path d="M8 13 C11 13 11 35 15.5 35 C20 35 20 17 24 17 C28 17 28 29 31.5 29 C35 29 35 24 40 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="40" cy="24" r="${w * 0.62}" fill="${A}"/>`,
  },
  {
    n: 'Crest', idea: 'One big wave instead of many. The simplest curve here — safest small.',
    svg: (w) => `<path d="M8 33 C14 33 16 15 24 15 C32 15 34 33 40 33" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="24" cy="9" r="${w * 0.62}" fill="${A}"/>`,
  },
  {
    n: 'Sweep', idea: 'The line travels up, not across — lift rather than rhythm.',
    svg: (w) => `<path d="M9 38 C9 25 17 18 26 15.5 C32 13.8 36 12 39 8" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="10" cy="38" r="${w * 0.6}" fill="${A}"/>`,
  },
  {
    n: 'Coil', idea: 'One open turn with an inward hook — the loop, unrolled.',
    svg: (w) => `<path d="M31 13 C21 9 12 17 14 26 C16 34 28 37 33 30 C36.5 25 32 20 27.5 22.5" fill="none" stroke="currentColor" stroke-width="${w * 0.9}" stroke-linecap="round"/>
                 <circle cx="31" cy="13" r="${w * 0.6}" fill="${A}"/>`,
  },
  {
    n: 'Knot', idea: 'The stroke crosses itself once — the refine loop, drawn in one go.',
    svg: (w) => `<path d="M9 33 C9 20 19 13 26 17 C32 20.5 30 30 24 30 C18 30 16 21 24 16 C31 11.6 38 15 40 21" fill="none" stroke="currentColor" stroke-width="${w * 0.9}" stroke-linecap="round"/>`,
  },
  {
    n: 'Bounce', idea: 'Arcs shrinking along a baseline — energy settling out.',
    svg: (w) => `<path d="M8 34 A7.5 7.5 0 0 1 23 34 A5.2 5.2 0 0 1 33.4 34 A3.3 3.3 0 0 1 40 34" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="9" cy="34" r="${w * 0.6}" fill="${A}"/>`,
  },
  {
    n: 'Meander', idea: 'A long, low wander. The quietest mark in the set.',
    svg: (w) => `<path d="M7 24 C12 24 12 19 17 19 C22 19 22 29 27 29 C32 29 32 21 41 21" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>`,
  },
  {
    n: 'Twist', idea: 'Two waves out of phase — the submitter and the agent, interleaved.',
    svg: (w) => `<path d="M8 31 C13 31 13 17 18 17 C23 17 23 31 28 31" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M20 31 C25 31 25 17 30 17 C35 17 35 31 40 31" fill="none" stroke="${A}" stroke-width="${w}" stroke-linecap="round"/>`,
  },

  /* ─────────────── ROUND 5 ─────────────── */
  {
    fam: 'The dot as counter — "A"', round: 5,
    note: 'From 74 Crest: move the accent dot from above the arch to inside it, and the arch stops being a bump and becomes an A. These vary the one thing that decides whether it reads as a letter — where the dot sits, how big it is, and the arch\'s proportions. 84 uses a crossbar instead of a dot as the control.',
  },
  {
    n: 'Crest A', idea: '74 Crest, dot moved into the counter. The arch becomes a letter.',
    svg: (w) => `<path d="M8 33 C14 33 16 15 24 15 C32 15 34 33 40 33" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="24" cy="26" r="${w * 0.7}" fill="${A}"/>`,
  },
  {
    n: 'Crest A · low', idea: 'Dot dropped toward the baseline, where a real A’s crossbar sits.',
    svg: (w) => `<path d="M8 33 C14 33 16 15 24 15 C32 15 34 33 40 33" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="24" cy="29.5" r="${w * 0.7}" fill="${A}"/>`,
  },
  {
    n: 'Crest A · bold', idea: 'A heavier dot. Fills the counter, so the A reads faster at 16px.',
    svg: (w) => `<path d="M8 33 C14 33 16 15 24 15 C32 15 34 33 40 33" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="24" cy="26.5" r="${w}" fill="${A}"/>`,
  },
  {
    n: 'Crest A · bar', idea: 'The control: a true crossbar instead of a dot. Clearer letter, less brand.',
    svg: (w) => `<path d="M8 33 C14 33 16 15 24 15 C32 15 34 33 40 33" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <path d="M17.5 27 H30.5" stroke="${A}" stroke-width="${w}" stroke-linecap="round"/>`,
  },
  {
    n: 'Narrow A', idea: 'Taller and tighter — letter proportions rather than landscape.',
    svg: (w) => `<path d="M12 37 C17 37 17.5 12 24 12 C30.5 12 31 37 36 37" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="24" cy="26" r="${w * 0.7}" fill="${A}"/>`,
  },
  {
    n: 'Splay A', idea: 'The feet kick outward — a letter with a stance.',
    svg: (w) => `<path d="M6 36 C14 37 15.5 14 24 14 C32.5 14 34 37 42 36" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="24" cy="26.5" r="${w * 0.7}" fill="${A}"/>`,
  },
  {
    n: 'Peak A', idea: 'A sharper apex — closer to a drawn A, still one continuous stroke.',
    svg: (w) => `<path d="M9 34 C15 34 18 13 24 13 C30 13 33 34 39 34" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>
                 <circle cx="24" cy="26" r="${w * 0.7}" fill="${A}"/>`,
  },
  {
    n: 'Heavy A', idea: 'Thick arch, dot punched through it. The app-icon weight.',
    svg: (w) => `<path d="M9 32 C15 32 16.5 16 24 16 C31.5 16 33 32 39 32" fill="none" stroke="currentColor" stroke-width="${w * 1.55}" stroke-linecap="round"/>
                 <circle cx="24" cy="27" r="${w * 0.82}" fill="${A}"/>`,
  },
];
