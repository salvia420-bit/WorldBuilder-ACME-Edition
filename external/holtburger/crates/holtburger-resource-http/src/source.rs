//! Browser-side `HttpResourceSource` — implements
//! `holtburger_dat::ResourceSource` over an HBA fetched once via
//! `web_sys` `fetch()`.

use holtburger_dat::{
    FileMetadata, HbaReader, ResourceKey, ResourceSource, Result as DatResult,
};
use js_sys::{ArrayBuffer, Function, Promise, Reflect, Uint8Array};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::JsValue;
use wasm_bindgen_futures::JsFuture;
use web_sys::Response;

/// Result of [`HttpResourceSource::connect`]. Distinguishes the three
/// failure surfaces a caller might want to display differently.
#[derive(Debug)]
pub enum ConnectError {
    /// Couldn't reach a `fetch()` global. Browser tabs always have one;
    /// classic-script Workers have one too. Shouldn't happen in any
    /// supported runtime.
    NoFetchGlobal,
    /// `fetch()` itself rejected (network error, CORS, bad URL).
    Network(String),
    /// HTTP responded but with a non-2xx status.
    Http { status: u16, status_text: String },
    /// `Response::array_buffer()` rejected (rare — usually means the
    /// stream was aborted mid-flight).
    Body(String),
    /// Bytes downloaded but didn't parse as a valid HBA archive.
    Parse(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::NoFetchGlobal => write!(f, "no fetch() in global scope"),
            ConnectError::Network(s) => write!(f, "fetch network error: {s}"),
            ConnectError::Http { status, status_text } => {
                write!(f, "fetch HTTP {status} {status_text}")
            }
            ConnectError::Body(s) => write!(f, "fetch body read error: {s}"),
            ConnectError::Parse(s) => write!(f, "HBA parse error: {s}"),
        }
    }
}

impl std::error::Error for ConnectError {}

/// HTTP-backed `ResourceSource`. Holds the parsed HBA in memory and
/// serves all `ResourceSource` queries synchronously from it.
///
/// Construct with [`HttpResourceSource::connect`]; pass into
/// `LayeredResourceResolver` (or any `Arc<dyn ResourceSource>` slot)
/// once the returned `Future` resolves.
pub struct HttpResourceSource {
    reader: HbaReader<Vec<u8>>,
}

impl HttpResourceSource {
    /// Fetch `url` (expected to point at a single HBA file produced by
    /// `dat2hba`), parse it, and return the wrapped reader.
    ///
    /// Same-origin requests just work; cross-origin requires the server
    /// to send appropriate CORS headers.
    pub async fn connect(url: &str) -> Result<Self, ConnectError> {
        let bytes = fetch_bytes(url).await?;
        let reader = HbaReader::<Vec<u8>>::from_bytes(bytes)
            .map_err(|e| ConnectError::Parse(e.to_string()))?;
        Ok(Self { reader })
    }

    /// Number of entries across all namespaces in the loaded archive.
    /// Smoke tests use this as an "is the archive non-empty?" probe.
    pub fn entry_count(&self) -> u32 {
        self.reader.header.entry_count
    }
}

impl ResourceSource for HttpResourceSource {
    fn get_file_by_key(&self, key: ResourceKey<'_>) -> DatResult<Vec<u8>> {
        self.reader.get_file_by_key(key)
    }

    fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata> {
        self.reader.get_metadata_by_key(key)
    }

    fn has_namespace(&self, namespace: &str) -> bool {
        self.reader.has_namespace(namespace)
    }
}

async fn fetch_bytes(url: &str) -> Result<Vec<u8>, ConnectError> {
    // Resolve `fetch` from the runtime's global. Three paths to cover
    // every environment we ship into:
    //   1. Browser tabs: `globalThis` is `Window`; `web_sys::Window`
    //      casts cleanly and `fetch_with_str` returns a typed Promise.
    //   2. Web Workers: `globalThis` is `WorkerGlobalScope`; same
    //      story with `web_sys::WorkerGlobalScope`.
    //   3. Node 18+: `globalThis` is *not* a `Window` (the cast
    //      fails) but it does have a global `fetch` function attached.
    //      We reach for it via `Reflect::get` and call it like any
    //      other JS function. This is the path the Node smoke test
    //      takes; without it, the test could only do symbol-presence
    //      checks.
    let global = js_sys::global();
    let fetch_promise = if let Ok(window) = global.clone().dyn_into::<web_sys::Window>() {
        window.fetch_with_str(url)
    } else if let Ok(worker) = global.clone().dyn_into::<web_sys::WorkerGlobalScope>() {
        worker.fetch_with_str(url)
    } else {
        let fetch_fn_value = Reflect::get(&global, &JsValue::from_str("fetch"))
            .map_err(|_| ConnectError::NoFetchGlobal)?;
        let fetch_fn: Function = fetch_fn_value
            .dyn_into()
            .map_err(|_| ConnectError::NoFetchGlobal)?;
        let promise_value = fetch_fn
            .call1(&JsValue::UNDEFINED, &JsValue::from_str(url))
            .map_err(|e| ConnectError::Network(jsval_string(&e)))?;
        promise_value
            .dyn_into::<Promise>()
            .map_err(|e| ConnectError::Network(format!("fetch did not return a Promise: {}", jsval_string(&e))))?
    };

    let resp_value = JsFuture::from(fetch_promise)
        .await
        .map_err(|e| ConnectError::Network(jsval_string(&e)))?;
    let resp: Response = resp_value
        .dyn_into()
        .map_err(|e| ConnectError::Network(format!("not a Response: {}", jsval_string(&e))))?;

    if !resp.ok() {
        return Err(ConnectError::Http {
            status: resp.status(),
            status_text: resp.status_text(),
        });
    }

    let buf_promise = resp
        .array_buffer()
        .map_err(|e| ConnectError::Body(jsval_string(&e)))?;
    let buf_value = JsFuture::from(buf_promise)
        .await
        .map_err(|e| ConnectError::Body(jsval_string(&e)))?;
    let array_buffer: ArrayBuffer = buf_value
        .dyn_into()
        .map_err(|e| ConnectError::Body(format!("not an ArrayBuffer: {}", jsval_string(&e))))?;
    Ok(Uint8Array::new(&array_buffer).to_vec())
}

fn jsval_string(v: &JsValue) -> String {
    v.as_string()
        .or_else(|| js_sys::JSON::stringify(v).ok().and_then(|s| s.as_string()))
        .unwrap_or_else(|| format!("{v:?}"))
}
