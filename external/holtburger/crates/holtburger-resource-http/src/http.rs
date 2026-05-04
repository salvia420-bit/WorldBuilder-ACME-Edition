//! Shared HTTP fetch primitive used by both `HttpResourceSource`
//! (legacy single-HBA path) and `ManifestResourceSource` (Phase 5.0
//! manifest+shards path).

use js_sys::{ArrayBuffer, Function, Promise, Reflect, Uint8Array};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::JsValue;
use wasm_bindgen_futures::JsFuture;
use web_sys::Response;

/// Failure modes for HTTP fetch + body read. Distinguishes the
/// surfaces a caller might want to display differently (network vs.
/// HTTP status vs. body read).
#[derive(Debug)]
pub enum HttpError {
    NoFetchGlobal,
    Network(String),
    Http { status: u16, status_text: String },
    Body(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::NoFetchGlobal => write!(f, "no fetch() in global scope"),
            HttpError::Network(s) => write!(f, "fetch network error: {s}"),
            HttpError::Http { status, status_text } => {
                write!(f, "fetch HTTP {status} {status_text}")
            }
            HttpError::Body(s) => write!(f, "fetch body read error: {s}"),
        }
    }
}

impl std::error::Error for HttpError {}

/// Fetch a URL and return the response body as a `Vec<u8>`.
///
/// Resolves `fetch` from the runtime's global across three
/// environments: browser tabs (`Window`), Web Workers
/// (`WorkerGlobalScope`), and Node 18+ (global `fetch` reached via
/// `Reflect::get`). The Node path is the one the smoke test under
/// `apps/holtburger-web/smoke_test.cjs` takes.
pub async fn fetch_bytes(url: &str) -> Result<Vec<u8>, HttpError> {
    let global = js_sys::global();
    let fetch_promise = if let Ok(window) = global.clone().dyn_into::<web_sys::Window>() {
        window.fetch_with_str(url)
    } else if let Ok(worker) = global.clone().dyn_into::<web_sys::WorkerGlobalScope>() {
        worker.fetch_with_str(url)
    } else {
        let fetch_fn_value = Reflect::get(&global, &JsValue::from_str("fetch"))
            .map_err(|_| HttpError::NoFetchGlobal)?;
        let fetch_fn: Function = fetch_fn_value
            .dyn_into()
            .map_err(|_| HttpError::NoFetchGlobal)?;
        let promise_value = fetch_fn
            .call1(&JsValue::UNDEFINED, &JsValue::from_str(url))
            .map_err(|e| HttpError::Network(jsval_string(&e)))?;
        promise_value.dyn_into::<Promise>().map_err(|e| {
            HttpError::Network(format!(
                "fetch did not return a Promise: {}",
                jsval_string(&e)
            ))
        })?
    };

    let resp_value = JsFuture::from(fetch_promise)
        .await
        .map_err(|e| HttpError::Network(jsval_string(&e)))?;
    let resp: Response = resp_value
        .dyn_into()
        .map_err(|e| HttpError::Network(format!("not a Response: {}", jsval_string(&e))))?;

    if !resp.ok() {
        return Err(HttpError::Http {
            status: resp.status(),
            status_text: resp.status_text(),
        });
    }

    let buf_promise = resp
        .array_buffer()
        .map_err(|e| HttpError::Body(jsval_string(&e)))?;
    let buf_value = JsFuture::from(buf_promise)
        .await
        .map_err(|e| HttpError::Body(jsval_string(&e)))?;
    let array_buffer: ArrayBuffer = buf_value
        .dyn_into()
        .map_err(|e| HttpError::Body(format!("not an ArrayBuffer: {}", jsval_string(&e))))?;
    Ok(Uint8Array::new(&array_buffer).to_vec())
}

pub fn jsval_string(v: &JsValue) -> String {
    v.as_string()
        .or_else(|| js_sys::JSON::stringify(v).ok().and_then(|s| s.as_string()))
        .unwrap_or_else(|| format!("{v:?}"))
}

/// Resolve a relative URL against a base. Mirrors browser URL
/// resolution rules well enough for the manifest+shard case:
///
/// - Absolute (`http://...`, `/...`): returned as-is.
/// - Relative: appended to the base's directory portion (everything
///   before the last `/`).
pub fn join_url(base_url: &str, relative: &str) -> String {
    if relative.starts_with("http://")
        || relative.starts_with("https://")
        || relative.starts_with('/')
    {
        return relative.to_owned();
    }
    let dir = base_url.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    if dir.is_empty() {
        relative.to_owned()
    } else {
        format!("{dir}/{relative}")
    }
}
