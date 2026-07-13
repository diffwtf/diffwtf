use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn compute(left: &str, right: &str, granularity: &str) -> JsValue {
    let gran = match granularity {
        "char" => diffwtf_core::Granularity::Char,
        _ => diffwtf_core::Granularity::Word,
    };
    let result = diffwtf_core::diff(left, right, gran);
    serde_wasm_bindgen::to_value(&result).expect("serialize DiffResult")
}
