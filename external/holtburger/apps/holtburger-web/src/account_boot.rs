//! inventory-session-6 (2026-10-13) — the account-boot line.
//!
//! Retail `CPlayerSystem::Handle_AccountBooted` (acclient.c:400213) unpacks
//! an optional reason string and formats
//! `"You have been booted from Asheron's Call%s."` with it, substituting
//! `" for Code of Conduct Violations"` when the reason is missing or empty
//! (`oldText.m_buffer->m_len != 1`), then hands the line to the disconnected
//! screen (UIFlow mode 0x10000002).
//!
//! ACE sends `GameMessageBootAccount` (0xF7DC) only through
//! `Session.Terminate`, which queues the message and then drops the session:
//! a wrong password (AuthenticationHandler.cs:174), a client-version or DAT
//! mismatch, a forced log-off, the world closing, an admin boot. ACE's
//! reasons start with a space (" because ..."), and an admin boot without a
//! reason writes an EMPTY string, so the empty case is the common default.
//!
//! The recv-loop arm (session/messages/login.rs) turns the boot into the
//! session's last kind=4 Disconnected event: `stringPayload` = this line,
//! `u32Payload` = [`ACCOUNT_BOOT_DISCONNECT_MARKER`]. No other Disconnected
//! event carries a `u32Payload`.

use holtburger_protocol::opcodes::GameOpcode;

/// `u32Payload` of the kind=4 Disconnected event that ends a session on an
/// AccountBoot: the AccountBoot opcode itself (0xF7DC). Mirrored by
/// `ACCOUNT_BOOT_MARKER` in app/account_boot.js.
pub(crate) const ACCOUNT_BOOT_DISCONNECT_MARKER: u32 = GameOpcode::AccountBoot as u32;

/// Retail's boot line for an AccountBoot reason (`BootAccountData::reason`).
pub(crate) fn account_boot_text(reason: Option<&str>) -> String {
    let reason = match reason {
        Some(r) if !r.is_empty() => r,
        _ => " for Code of Conduct Violations",
    };
    format!("You have been booted from Asheron's Call{reason}.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_protocol::messages::GameMessage;
    use holtburger_protocol::messages::misc::BootAccountData;
    use holtburger_protocol::traits::{ProtocolPack, ProtocolUnpack};

    #[test]
    fn wrong_password_reason_is_appended() {
        assert_eq!(
            account_boot_text(Some(
                " because the password entered for this account was not correct"
            )),
            "You have been booted from Asheron's Call because the password entered for this account was not correct."
        );
    }

    #[test]
    fn missing_reason_is_code_of_conduct() {
        assert_eq!(
            account_boot_text(None),
            "You have been booted from Asheron's Call for Code of Conduct Violations."
        );
    }

    #[test]
    fn empty_reason_is_code_of_conduct() {
        // Retail tests `m_len != 1` (the terminator alone), so an empty
        // string is the same as no string.
        assert_eq!(
            account_boot_text(Some("")),
            "You have been booted from Asheron's Call for Code of Conduct Violations."
        );
    }

    #[test]
    fn admin_boot_reason_keeps_its_own_separator() {
        // SentinelCommands.cs @boot: `" - {reason}"`.
        assert_eq!(
            account_boot_text(Some(" - spamming")),
            "You have been booted from Asheron's Call - spamming."
        );
    }

    #[test]
    fn marker_is_the_account_boot_opcode() {
        assert_eq!(ACCOUNT_BOOT_DISCONNECT_MARKER, 0xF7DC);
    }

    #[test]
    fn empty_reason_on_the_wire_gives_the_default_line() {
        // An admin @boot with no reason: ACE writes an empty String16L.
        let msg = GameMessage::AccountBoot(Box::new(BootAccountData {
            reason: Some(String::new()),
        }));
        let mut buf = Vec::new();
        msg.pack(&mut buf);
        let mut offset = 0;
        let parsed = GameMessage::unpack(&buf, &mut offset).expect("AccountBoot unpacks");
        let data = match parsed {
            GameMessage::AccountBoot(data) => data,
            other => panic!("expected GameMessage::AccountBoot, got {other:?}"),
        };
        assert_eq!(
            account_boot_text(data.reason.as_deref()),
            "You have been booted from Asheron's Call for Code of Conduct Violations."
        );
    }
}
