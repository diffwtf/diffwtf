//! Thin wasm-bindgen wrapper around `diffwtf-core`. Never published; all
//! JS-facing code lives here so the core crate stays pure.

use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn compute(left: &str, right: &str, granularity: &str) -> JsValue {
    let gran = match granularity {
        "char" => diffwtf_core::Granularity::Char,
        _ => diffwtf_core::Granularity::Word,
    };
    let result = diffwtf_core::diff(left, right, gran);
    // json_compatible() serializes Option::None as JS null rather than undefined,
    // so the object seen by JS matches the fixture JSON shape field for field.
    result
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .expect("DiffResult contains only plain data and always serializes")
}
