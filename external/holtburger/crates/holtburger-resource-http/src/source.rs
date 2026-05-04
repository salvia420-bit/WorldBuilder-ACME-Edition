//! Browser-side `HttpResourceSource` — implements
//! `holtburger_dat::ResourceSource` over an HBA fetched once via
//! `web_sys` `fetch()`.
//!
//! Pre-Phase 5.0 path. Keeps working for native callers / smoke
//! fixtures that pass an `asset_url` directly. The browser path
//! after Phase 5.0 obj 5 lands uses [`super::ManifestResourceSource`]
//! instead.

use holtburger_dat::{
    FileMetadata, HbaReader, ResourceKey, ResourceSource, Result as DatResult,
};

use crate::http::{HttpError, fetch_bytes};

/// Result of [`HttpResourceSource::connect`]. Distinguishes the four
/// failure surfaces a caller might want to display differently.
#[derive(Debug)]
pub enum ConnectError {
    /// Network-layer failure — see [`HttpError`].
    Http(HttpError),
    /// Bytes downloaded but didn't parse as a valid HBA archive.
    Parse(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::Http(e) => write!(f, "{e}"),
            ConnectError::Parse(s) => write!(f, "HBA parse error: {s}"),
        }
    }
}

impl std::error::Error for ConnectError {}

impl From<HttpError> for ConnectError {
    fn from(value: HttpError) -> Self {
        ConnectError::Http(value)
    }
}

/// HTTP-backed `ResourceSource`. Holds the parsed HBA in memory and
/// serves all `ResourceSource` queries synchronously from it.
pub struct HttpResourceSource {
    reader: HbaReader<Vec<u8>>,
}

impl HttpResourceSource {
    /// Fetch `url` (expected to point at a single HBA file produced by
    /// `dat2hba`), parse it, and return the wrapped reader.
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
