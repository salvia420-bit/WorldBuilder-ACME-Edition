//! One-time JSON handshake exchanged before binary frames.
//!
//! Browser → Bridge:
//!   `{"v":1,"host":"play.coldeve.ac","login_port":9000,"world_port":9001}`
//! Bridge  → Browser:
//!   `{"v":1,"ok":true,"ip":"1.2.3.4","login_port":9000,"world_port":9001}`
//! On failure, bridge replies with `{"v":1,"ok":false,"error":"..."}`
//! and closes the connection.
//!
//! `world_port` is optional in the request; bridge fills in
//! `login_port + offset` (see `Config::default_world_port_offset`).

use serde::{Deserialize, Serialize};

pub const HANDSHAKE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ClientHello {
    pub v: u32,
    pub host: String,
    pub login_port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub world_port: Option<u16>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ServerHello {
    pub v: u32,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub world_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ServerHello {
    pub fn ok(ip: std::net::IpAddr, login_port: u16, world_port: u16) -> Self {
        Self {
            v: HANDSHAKE_VERSION,
            ok: true,
            ip: Some(ip.to_string()),
            login_port: Some(login_port),
            world_port: Some(world_port),
            error: None,
        }
    }

    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            v: HANDSHAKE_VERSION,
            ok: false,
            ip: None,
            login_port: None,
            world_port: None,
            error: Some(msg.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_hello_round_trips_with_optional_world_port() {
        let h = ClientHello {
            v: HANDSHAKE_VERSION,
            host: "play.coldeve.ac".into(),
            login_port: 9000,
            world_port: None,
        };
        let s = serde_json::to_string(&h).unwrap();
        assert!(!s.contains("world_port"));
        let parsed: ClientHello = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed.host, "play.coldeve.ac");
        assert_eq!(parsed.login_port, 9000);
        assert!(parsed.world_port.is_none());
    }

    #[test]
    fn client_hello_accepts_explicit_world_port() {
        let s = r#"{"v":1,"host":"x","login_port":9000,"world_port":9100}"#;
        let h: ClientHello = serde_json::from_str(s).unwrap();
        assert_eq!(h.world_port, Some(9100));
    }

    #[test]
    fn server_hello_ok_serializes_ip() {
        let h = ServerHello::ok("1.2.3.4".parse().unwrap(), 9000, 9001);
        let s = serde_json::to_string(&h).unwrap();
        assert!(s.contains("\"ip\":\"1.2.3.4\""));
        assert!(s.contains("\"ok\":true"));
        assert!(!s.contains("error"));
    }

    #[test]
    fn server_hello_err_omits_ip() {
        let h = ServerHello::err("DNS NXDOMAIN");
        let s = serde_json::to_string(&h).unwrap();
        assert!(!s.contains("\"ip\""));
        assert!(s.contains("\"ok\":false"));
        assert!(s.contains("\"error\":\"DNS NXDOMAIN\""));
    }
}
