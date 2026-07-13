# Handoff: diff.wtf — Rust/WASM diff checker

## Overview
diff.wtf is a client-side text/file diff checker. The diff engine will be written in Rust (Myers algorithm) compiled to WebAssembly; the site is a minimal static shell around it. No backend, no uploads — everything runs in the browser. This bundle contains the finished UI design for the launch site: the tool page, a privacy page, and a 1200×630 OG social card.

## About the Design Files
The files in this bundle are **design references created in HTML** (interactive prototypes showing intended look and behavior), not production code to copy directly. The task is to **recreate these designs in the real product**: a minimal static HTML/CSS/vanilla-JS shell (no framework needed — the product's whole pitch is being lightweight) around a Rust→WASM diff module via wasm-bindgen. The prototype's diff logic is a JS stand-in for the WASM engine; its `compute/lcs/intraDiff` functions define the exact output contract the Rust engine should satisfy.

## Fidelity
**High-fidelity.** Colors, typography, spacing, copy, and interactions are final. Recreate pixel-perfectly.

## Screens / Views

### 1. Diff tool + landing (`Diff Checker.dc.html`)
Single page: tool first, marketing below. Page bg `#0a0d11`, text `#e6edf3`, max content width 1240px centered, 24px side padding.

**Header** — full-width, 16px 28px padding, 1px bottom border `#1a212b`.
- Wordmark: JetBrains Mono 19px bold — `diff` in `#e6edf3`, `.wtf` in accent `#3fd68f`, followed by a blinking `_` cursor in accent (steps(1), 1.1s loop, opacity 1→0 at 55%).
- Right nav: "Why it's fast" text link (`#8b98a9`, hover `#e6edf3`, 13px, anchors to #how) and a "Star on GitHub" ghost button (12.5px, 6px 12px padding, 1px border `#232b36`, radius 6, hover border `#3a4657`). **Point this at the real repo before launch.**

**Hero** — centered, 42px top padding.
- H1: Space Grotesk 700, 42px, letter-spacing −0.5px: "The fastest diff on the web."
- Sub: 15px `#8b98a9`: "Rust → WebAssembly · runs entirely in your browser · nothing is ever uploaded"

**Input panes** — 2-col grid, 14px gap.
- Label row: JetBrains Mono 11px — left label 700, letter-spacing 1.5px, `#8b98a9` ("ORIGINAL" / "CHANGED"); right side `#46515f`: "{n} chars · or drop a file" (live char count, locale-formatted).
- Textareas: min-height 190px, vertical resize, bg `#0d1218`, 1px border `#1a212b` (focus `#2d3a4c`), radius 8, padding 14px, JetBrains Mono 12.5px/1.55, text `#cdd6e0`, placeholder `#46515f` ("Paste original text… or drop a file").
- Drag-over state: absolutely-positioned overlay inside the pane — 2px dashed accent border, radius 8, bg = accent at 7% opacity, centered JetBrains Mono 12px accent label "drop file to load", pointer-events none.
- Privacy line under the grid, 8px top margin: JetBrains Mono 11px `#46515f`: `// nothing you paste or drop ever leaves this tab — the diff runs locally`

**Controls bar** — flex row, 10px gap, wraps.
- Two segmented controls (bg `#0d1218`, 1px border `#1a212b`, radius 8, 3px padding): Split|Unified and Word|Character. Segment buttons: 6px 14px, 12.5px, radius 6; active bg `#1c2531` text `#e6edf3`; inactive transparent, text `#8b98a9`.
- Ghost buttons "Load example" and "Clear" (8px 14px, border `#232b36`, radius 8, text `#8b98a9`; hover text `#e6edf3` border `#3a4657`).
- Right-aligned perf badge: 7px accent dot + JetBrains Mono 12px `#8b98a9`: "{lines} lines · {ms} ms" — **wire to real WASM timing** (prototype says "wasm-simulated"). Empty state: "ready · engine loaded".

**Ad slot (free tier)** — 728×90 centered leaderboard between controls and results (AdSense/Carbon). Prototype shows a dashed placeholder; hidden by default via tweak.

**Results panel** — 1px border `#1a212b`, radius 10, bg `#0d1218`, overflow hidden.
- Header row (10px 16px, bottom border): JetBrains Mono 12px bold "+{added}" in `#3fb950` and "−{removed}" in `#f85149`; 12px `#46515f` label ("lines changed" / "texts are identical" / "paste text above to see the diff"); right-aligned PRO teaser buttons "Export PDF" and "AI summary" — ghost style with a 9px JetBrains Mono "PRO" chip (accent text + 1px accent border, radius 3).
- **Split view**: rows are 4-col grid `44px minmax(0,1fr) 44px minmax(0,1fr)`. Number cells: right-aligned, 1px 8px, JetBrains Mono 11px/1.85, `#46515f`, user-select none. Content cells: 1px 12px, JetBrains Mono 12.5px/1.6, white-space pre-wrap, word-break break-word, min-height 20px.
- **Unified view**: 3-col grid `40px 40px minmax(0,1fr)` (old line no, new line no, content). Deleted lines precede inserted lines within a hunk.
- Row colors: deleted bg `rgba(248,81,73,.12)` (number cell same bg, number text `#a05a57`); inserted bg `rgba(63,185,80,.11)` (number text `#4e7d5c`); unchanged transparent; missing-side cells in split view get a 45° stripe pattern (`repeating-linear-gradient(45deg, transparent 0 6px, rgba(255,255,255,.025) 6px 12px)`).
- Intra-line highlights (on paired modified lines): deleted tokens `rgba(248,81,73,.42)`, inserted `rgba(63,185,80,.38)`, radius 2px. Token granularity per the Word/Character toggle (word tokenization: `\w+|\s+|[^\w\s]`).

**"Why it's fast" section (#how)** — 3 equal cards, 14px gap. Cards: bg `#0d1218`, border `#1a212b`, radius 10, padding 22px. H3 Space Grotesk 17px; body 13px/1.6 `#8b98a9`.
1. "50–100× faster" + mini bar chart: two labeled bars (track `#161c24`, 6px, radius 3) — "diff.wtf (WASM) — 4 ms" accent fill at 3% width vs "typical JS diff tool — ~210 ms" `#3a4657` full width; caption 10.5px `#46515f`. **Replace with a real, reproducible benchmark before launch.**
2. "Your text never leaves the browser" — privacy copy.
3. "Open source core" + inline code chip `$ cargo add diffwtf-core` (JetBrains Mono 11.5px, bg `#10161e`, border `#1a212b`, radius 6, 7px 10px).

**Footer** — top border, 20px 28px, 12px `#46515f`: "© 2026 diff.wtf · MIT-licensed engine"; right links GitHub / API / Privacy in `#8b98a9`.

### 2. Privacy page (`Privacy.dc.html`)
Same shell (header wordmark links home, "← back to the tool"). Content column max-width 640px. H1 Space Grotesk 32px; "Last updated" line JetBrains Mono 12px `#46515f`; H2s Space Grotesk 18px; body 14px/1.7 `#a9b4c0`. Sections: local processing guarantee, anonymous analytics, advertising disclosure (AdSense/Carbon + Google Ad Settings opt-out link), contact. Required for AdSense approval.

### 3. OG card (`OG Card.dc.html`)
1200×630 static image (render/screenshot to `og-card.png`). Bg `#0a0d11`; wordmark JetBrains Mono 56px; headline Space Grotesk 64px/1.1, letter-spacing −1px, max-width 640px; sub JetBrains Mono 22px `#8b98a9`; top-right abstract diff rows (− red / + green pills); 6px bottom bar, gradient `#f85149 → #3fd68f`.

## Interactions & Behavior
- **Live diff**: recompute on every input change (no Compare button). With WASM this stays instant; debounce only if profiling says so.
- **Drag-drop**: dragover shows the overlay; drop reads the file as text into that pane and recomputes. Handle dragleave to clear the overlay.
- **Split/Unified** toggle re-renders the same computed diff; **Word/Character** re-runs intra-line refinement.
- **Load example** restores the two bundled Rust snippets (see prototype logic — they demo intra-line highlights nicely); **Clear** empties both panes.
- **Empty state**: results panel shows only its header with "paste text above to see the diff".
- **PRO buttons** are non-functional teasers at launch.
- Hover states as specified per component above. No page transitions.

## Diff algorithm contract (for the Rust engine)
The prototype's JS defines expected behavior:
1. Line-level diff (Myers / LCS) with common prefix–suffix trimming.
2. Group consecutive del+ins runs into hunks; pair them index-wise as "modified" lines.
3. For each modified pair, run a token-level diff (word or char granularity) to produce eq/del/ins segments for intra-line highlighting.
4. Output per-line ops with line numbers on both sides, plus added/removed counts and elapsed ms.

## State Management
`leftText, rightText, view ('split'|'unified'), granularity ('word'|'char'), dragOverLeft/Right, computed {rows, unifiedRows, added, removed, ms, lineCount}`. All local; no persistence needed (optionally persist view/granularity to localStorage).

## Design Tokens
- **Accent**: `#3fd68f` (alternates explored: `#f0883e`, `#58a6ff`, `#bc8cff`)
- **Backgrounds**: page `#0a0d11`, panel `#0d1218`, chip `#10161e`, track `#161c24`, active segment `#1c2531`
- **Borders**: `#1a212b` (default), `#232b36` (buttons), `#2d3a4c` / `#3a4657` (focus/hover)
- **Text**: primary `#e6edf3`, code `#cdd6e0`, body-secondary `#a9b4c0`, secondary `#8b98a9`, faint `#46515f`
- **Diff**: green `#3fb950`, red `#f85149`; line bgs at .11/.12 alpha, intra-line at .38/.42
- **Type**: Space Grotesk (500/700) for headings; JetBrains Mono (400/500/700) for wordmark, code, labels, badges; system-ui for body/UI
- **Radii**: 3 (chips), 6 (buttons), 8 (inputs/segments), 10 (panels)
- **Sizes**: H1 42, H2/H3 17–18, body 13–15, code 12.5, labels/badges 11–12

## Assets
No image assets. Fonts from Google Fonts (Space Grotesk, JetBrains Mono). OG image generated from `OG Card.dc.html`.

## Files
- `standalone/diff-checker.html` — **open these to view the designs**: self-contained, work offline by double-clicking, fully interactive
- `standalone/privacy.html`
- `standalone/og-card.html`
- `Diff Checker.dc.html`, `Privacy.dc.html`, `OG Card.dc.html` — original design sources. Note: these depend on a design-tool runtime and will NOT render correctly outside it; they're included because their markup and JS logic (the reference diff implementation) are the readable source of truth. View with the standalone versions.
