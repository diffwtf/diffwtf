# DECISIONS

## D6: Sparse wasm boundary contract v2 (M9, pending Alex ratification)
Root cause (issue #9): the v1 boundary marshalled the full DiffResult, both
views including every Equal row, through serde-wasm-bindgen one JS object at
a time, so transfer cost scaled with document size and the end-to-end wasm
path lost to the in-page JS reference on every measured input. M9 replaces
what crosses the boundary, not the serializer: compute() now returns
run-length ops (one Equal run per unchanged span) as parallel typed arrays
plus a highlight side channel carrying intra-line ranges for Modify rows
only, and web/js/assemble.js derives the Split and Unified views from the
ops plus the two original input strings. Full shape: docs/scaffold-spec.md,
"Wasm boundary contract v2".
Decisions inside the contract, each an interpretation call ratified with the
M9 review: (a) run kinds stay Equal/Delete/Insert, mirroring diff_lines and
the unified-view convention, rather than a paired Change encoding; (b) span
offsets are UTF-16 code units, the unit JS slices by, chosen over byte
offsets so the assembler never rescans changed lines (Rust consumers who
want text use diff(), whose Segments carry it); (c) starts are 0-based line
indices, the slicing currency, with display numbers derived as index + 1;
(d) the boundary object is a plain JS object, not a wasm-bindgen class, so
no .free() obligation leaks into page code; (e) Rust diff() and diff_lines()
are unchanged, the crate gains diff_sparse(), and only the wasm wrapper and
web shell switch to it; (f) identical inputs (byte equality) short-circuit
to a single Equal run, a disclosed product optimization that never backs an
engine-speed claim; (g) the perf badge times compute plus JS view assembly,
since renderable rows only exist after both.
Consequences: transfer scales with edits. On the 150 KB sparse fixture the
post-M9 marshal cost is measured at under 0.1 ms (the benchmark's derived
marshal phase); the pre-M9 cost was never isolated by the M8 benchmark and
is inferred at roughly 8 ms (the old 10.1 ms end-to-end minus engine time
as measured post-M9, corroborated by the old identical-input case's ~9 ms
transfer floor). The wasm binary lost
the serde machinery (49.5 KB to 45.7 KB), and the conformance surface grew a
second fixture tier (ops.json) plus a JS-side runner
(scripts/conformance-web.mjs) that pins the shipped wasm and assembler to
the reference. Known staleness, deliberate: the "Why it's fast" chart in
web/index.html still shows the M8 numbers; site copy is Alex's call at the
review gate and reconciling the chart from the committed M9 results is
issue #11.

## D5: Responsive behavior (M6 follow-up)
The design handoff is desktop only; this entry defines mobile (Alex-authorized
scope, 2026-07). Desktop stays pixel-faithful: rendering at 1024px and up is
unchanged, verified by an element-by-element computed-style and geometry
comparison against the pre-change build. Below 768px: the input panes stack
(ORIGINAL above CHANGED, full width), Unified is the default view when the
user has no stored preference (a stored preference always wins; Split stays
selectable and scrolls horizontally inside the results panel), the toolbar
wraps in a fixed order (toggles, then Load example and Clear, then the status
badge right-aligned on its own line), and the hero scales down. Touch devices
(hover: none) do not advertise drag-drop: the overlay is suppressed and the
hint copy drops "or drop a file". Benchmark card rows are hardened below
1024px (the width where three-across cards get narrow) so the value never
wraps or interleaves with the label. Live diff on every input applies on all
viewports; there is no compute button anywhere.
Deliberate divergences from competitor patterns: no Find-difference button
(the engine is fast enough for live), and session-content restore is deferred
to a tracked issue for privacy reasons (the product promises pasted text has
zero exposure, so persisting it on disk must be opt-in or clearly disclosed).

## D4: PRO teaser buttons removed pre-launch (M6 follow-up)
The design handoff includes two non-functional teaser buttons in the results
toolbar, Export PDF (PRO) and AI summary (PRO). Both are removed for launch by
Alex's decision (2026-07). Reasons: non-functional buttons read as broken
rather than as roadmap, and AI summary as commonly implemented (server-side
inference) would contradict the product's core promise that nothing leaves the
browser. PRO affordances may return post-launch as deliberate features; any AI
feature must be consistent with the no-upload guarantee or clearly disclosed.
This entry supersedes the design handoff for these elements: future fidelity
checks against the design must treat the absence of these buttons (and of any
replacement in their place) as correct. The rest of the results toolbar keeps
the design layout exactly.

## D3: line-level search depth cap, MAX_D = 2048 (M4 review, 2026-07)
Supersedes D2's "documented, not capped" stance. Plain O(ND) Myers keeps a
per-round trace of sum(2d + 1 for d in 0..D) = D^2 words to recover the edit
path; uncapped, two unrelated 5 000-line inputs reach D near 10 000, about
10^8 words (roughly 400 MB in wasm32 linear memory), a tab crash. The forward
search now stops after MAX_D = 2048 rounds, chosen from the budget
D^2 * 8 bytes <= 32 MiB, so D <= sqrt(4 194 304) = 2048: the trace tops out
at 32 MiB (roughly 34 MB) at 8-byte words on 64-bit hosts and 16 MiB
(roughly 17 MB) on wasm32.
Semantics in the engine: prefix/suffix trimming applies first; any input
whose minimal line diff needs at most 2048 edits after trimming is unaffected
and stays minimal; past the cap the trimmed middle degrades to del-all then
ins-all, the reference LCS bailout's degradation mode, with added/removed
counts and byte-exact reconstructability intact (the diff is just not
minimal). Linear-space Myers (the middle-snake refinement) is the planned
post-launch replacement; it removes the trace and with it the need for the
cap.

## D2: line level has no bailout; worst case is documented, not capped (M4, 2026-07)
M4 replaces the line-level LCS DP with Myers O(ND) and removes the reference's
600 000-cell bailout at that level: the engine now always returns a minimal
line diff. The cost moves from output quality to resources on pathological
inputs: with the plain V-array trace, memory is O(D^2) words (D = deleted plus
inserted lines after prefix/suffix trimming), about 800 MB on 64-bit for two
completely unrelated 5 000-line inputs. Documented in src/myers.rs; the
linear-space middle-snake refinement is the known follow-up if production
inputs ever hit it. Two related calls: Myers output is canonicalized per hunk
to all deletions before all insertions (pure op ordering, required by the
unified-view contract, matches the reference), and the token-level intraline
pass keeps the LCS DP with its bailout, because the reference applies that
bailout inside intraDiff too and token streams are small.

## D1 — Whitespace semantics: Rust is canonical (M3, 2026-07)
The JS reference and Rust disagree on exotic whitespace: JS `trim()`/`\s` treat
U+FEFF (BOM) as whitespace, Rust `char::is_whitespace`/`str::trim` do not; the
inverse holds for U+0085 (NEL). These are JS string-model quirks with no user
value. The engine keeps Rust semantics; the reference defines behavior except
here. Consequence: a BOM-only input is "empty" to the reference but a one-line
diff to the engine; a BOM adjacent to whitespace may tokenize into different
segment boundaries. Not fixtured deliberately — fixtures pin behavior both
implementations share.
