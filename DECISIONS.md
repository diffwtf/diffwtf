# DECISIONS

## D1 — Whitespace semantics: Rust is canonical (M3, 2026-07)
The JS reference and Rust disagree on exotic whitespace: JS `trim()`/`\s` treat
U+FEFF (BOM) as whitespace, Rust `char::is_whitespace`/`str::trim` do not; the
inverse holds for U+0085 (NEL). These are JS string-model quirks with no user
value. The engine keeps Rust semantics; the reference defines behavior except
here. Consequence: a BOM-only input is "empty" to the reference but a one-line
diff to the engine; a BOM adjacent to whitespace may tokenize into different
segment boundaries. Not fixtured deliberately — fixtures pin behavior both
implementations share.
