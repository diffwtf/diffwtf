// The bundled example pair behind "Load example". Single source of truth for
// the shell; must stay byte-identical to fixtures/cases/sample-rust.*.txt,
// which pin the design prototype's sample texts in the conformance suite.

export const sampleA = `use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn diff(old_text: &str, new_text: &str) -> String {
    let ops = myers::diff_lines(old_text, new_text);
    serde_json::to_string(&ops).unwrap()
}

fn normalize(s: &str) -> String {
    s.trim().to_string()
}

// TODO: add word-level refinement
fn refine(ops: Vec<Op>) -> Vec<Op> {
    ops
}`;

export const sampleB = `use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn diff(old_text: &str, new_text: &str) -> JsValue {
    let ops = myers::diff_lines(old_text, new_text);
    refine(&mut ops);
    serde_wasm_bindgen::to_value(&ops).unwrap()
}

fn normalize(s: &str) -> String {
    s.trim().to_lowercase()
}

fn refine(ops: &mut Vec<Op>) {
    intraline::split_words(ops);
}`;
