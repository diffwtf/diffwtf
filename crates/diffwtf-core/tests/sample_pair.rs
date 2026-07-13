//! Milestone 2 test: diff the prototype's bundled sample texts (the "Load example"
//! content) at Word granularity and assert facts hand-verified against the JS
//! reference in `docs/design-handoff/Diff Checker.dc.html`.

use diffwtf_core::{diff, DiffResult, Granularity, RowKind, Segment, UnifiedKind};

const LEFT: &str = include_str!("../../../fixtures/cases/sample-rust.left.txt");
const RIGHT: &str = include_str!("../../../fixtures/cases/sample-rust.right.txt");

fn sample() -> DiffResult {
    diff(LEFT, RIGHT, Granularity::Word)
}

fn seg(text: &str, highlighted: bool) -> Segment {
    Segment {
        text: text.to_string(),
        highlighted,
    }
}

fn cell_text(segments: &[Segment]) -> String {
    segments.iter().map(|s| s.text.as_str()).collect()
}

#[test]
fn counts_match_the_reference() {
    let result = sample();
    assert_eq!(result.added, 6);
    assert_eq!(result.removed, 6);
    assert_eq!(result.line_count, 16);
}

#[test]
fn split_rows_match_the_reference() {
    use RowKind::*;
    let result = sample();
    let kinds: Vec<RowKind> = result.rows.iter().map(|r| r.kind).collect();
    assert_eq!(
        kinds,
        vec![
            Equal, Equal, Equal, Modify, Equal, Modify, Insert, Equal, Equal, Equal, Modify, Equal,
            Equal, Modify, Modify, Delete, Equal
        ]
    );

    // Contract invariants: Equal/Modify have both sides, Delete has no right,
    // Insert has no left.
    for row in &result.rows {
        match row.kind {
            Equal | Modify => assert!(row.left.is_some() && row.right.is_some()),
            Delete => assert!(row.left.is_some() && row.right.is_none()),
            Insert => assert!(row.left.is_none() && row.right.is_some()),
        }
    }

    // Line numbers on each side are 1-based and consecutive: 1..=16.
    let left_numbers: Vec<u32> = result
        .rows
        .iter()
        .filter_map(|r| r.left.as_ref())
        .map(|c| c.number)
        .collect();
    let right_numbers: Vec<u32> = result
        .rows
        .iter()
        .filter_map(|r| r.right.as_ref())
        .map(|c| c.number)
        .collect();
    assert_eq!(left_numbers, (1..=16).collect::<Vec<u32>>());
    assert_eq!(right_numbers, (1..=16).collect::<Vec<u32>>());

    // The lone Insert row is right line 7; the lone Delete row is left line 15.
    assert_eq!(result.rows[6].right.as_ref().unwrap().number, 7);
    assert_eq!(
        cell_text(&result.rows[6].right.as_ref().unwrap().segments),
        "    serde_wasm_bindgen::to_value(&ops).unwrap()"
    );
    assert_eq!(result.rows[15].left.as_ref().unwrap().number, 15);
    assert_eq!(
        cell_text(&result.rows[15].left.as_ref().unwrap().segments),
        "    ops"
    );
}

#[test]
fn unified_rows_match_the_reference() {
    use UnifiedKind::*;
    let result = sample();
    let kinds: Vec<UnifiedKind> = result.unified.iter().map(|u| u.kind).collect();
    assert_eq!(
        kinds,
        vec![
            Equal, Equal, Equal, Delete, Insert, Equal, Delete, Insert, Insert, Equal, Equal,
            Equal, Delete, Insert, Equal, Equal, Delete, Delete, Delete, Insert, Insert, Equal
        ]
    );

    for row in &result.unified {
        match row.kind {
            Equal => assert!(row.old_number.is_some() && row.new_number.is_some()),
            Delete => assert!(row.old_number.is_some() && row.new_number.is_none()),
            Insert => assert!(row.old_number.is_none() && row.new_number.is_some()),
        }
    }

    // Old/new numbering is 1..=16 in order on each side.
    let old_numbers: Vec<u32> = result.unified.iter().filter_map(|u| u.old_number).collect();
    let new_numbers: Vec<u32> = result.unified.iter().filter_map(|u| u.new_number).collect();
    assert_eq!(old_numbers, (1..=16).collect::<Vec<u32>>());
    assert_eq!(new_numbers, (1..=16).collect::<Vec<u32>>());

    // Within a hunk all deletes precede all inserts, so Insert directly followed
    // by Delete can never occur.
    for pair in result.unified.windows(2) {
        assert!(!(pair[0].kind == Insert && pair[1].kind == Delete));
    }
}

#[test]
fn both_inputs_reconstruct_from_the_rows() {
    let result = sample();

    let left_join = result
        .rows
        .iter()
        .filter_map(|r| r.left.as_ref())
        .map(|c| cell_text(&c.segments))
        .collect::<Vec<String>>()
        .join("\n");
    let right_join = result
        .rows
        .iter()
        .filter_map(|r| r.right.as_ref())
        .map(|c| cell_text(&c.segments))
        .collect::<Vec<String>>()
        .join("\n");
    assert_eq!(left_join, LEFT);
    assert_eq!(right_join, RIGHT);

    // Same through the unified view.
    let unified_old = result
        .unified
        .iter()
        .filter(|u| u.old_number.is_some())
        .map(|u| cell_text(&u.segments))
        .collect::<Vec<String>>()
        .join("\n");
    let unified_new = result
        .unified
        .iter()
        .filter(|u| u.new_number.is_some())
        .map(|u| cell_text(&u.segments))
        .collect::<Vec<String>>()
        .join("\n");
    assert_eq!(unified_old, LEFT);
    assert_eq!(unified_new, RIGHT);
}

#[test]
fn intra_line_highlights_match_the_reference() {
    let result = sample();

    // Line 4: `String` → `JsValue`, everything else common.
    let row = &result.rows[3];
    assert_eq!(
        row.left.as_ref().unwrap().segments,
        vec![
            seg("pub fn diff(old_text: &str, new_text: &str) -> ", false),
            seg("String", true),
            seg(" {", false),
        ]
    );
    assert_eq!(
        row.right.as_ref().unwrap().segments,
        vec![
            seg("pub fn diff(old_text: &str, new_text: &str) -> ", false),
            seg("JsValue", true),
            seg(" {", false),
        ]
    );

    // Line 6/6: proves adjacent same-state tokens merge (".unwrap()" is
    // `.`+`unwrap`+`(`+`)` in the token stream, one segment out).
    let row = &result.rows[5];
    assert_eq!(
        row.left.as_ref().unwrap().segments,
        vec![
            seg("    ", false),
            seg("serde_json::to_string", true),
            seg("(&ops)", false),
            seg(".unwrap()", true),
        ]
    );
    assert_eq!(
        row.right.as_ref().unwrap().segments,
        vec![
            seg("    ", false),
            seg("refine", true),
            seg("(&", false),
            seg("mut ", true),
            seg("ops)", false),
            seg(";", true),
        ]
    );

    // Line 10/11: `to_string` → `to_lowercase`.
    let row = &result.rows[10];
    assert_eq!(
        row.left.as_ref().unwrap().segments,
        vec![
            seg("    s.trim().", false),
            seg("to_string", true),
            seg("()", false),
        ]
    );
    assert_eq!(
        row.right.as_ref().unwrap().segments,
        vec![
            seg("    s.trim().", false),
            seg("to_lowercase", true),
            seg("()", false),
        ]
    );

    // Unified rows carry the same refined segments as their split counterparts.
    assert_eq!(
        result.unified[3].segments,
        result.rows[3].left.as_ref().unwrap().segments
    );
    assert_eq!(
        result.unified[4].segments,
        result.rows[3].right.as_ref().unwrap().segments
    );
}
