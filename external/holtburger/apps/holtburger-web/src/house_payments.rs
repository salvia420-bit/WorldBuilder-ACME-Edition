//! hud-ui-1 (2026-10-13) — the buy / rent `HousePayment` lists that
//! HouseData (0x0225) and HouseProfile (0x021D) carry, kept for the house
//! panel instead of being dropped from the snapshots.
//!
//! Retail reads them straight off its house records: gmHouseUI::
//! DisplayBuyPayment / DisplayRentPayment (acclient.c:219114 / :219170)
//! print `HousePaymentList::ComposeText` ("num name, …") and `ComposeText2`
//! ("paid/num name, …", :486081 / :486112), DisplayRentTimes /
//! DisplayWarningText (:219228 / :219354) branch on
//! `HousePaymentList::IsPaidInFull(rent)` (:485423), and gmSlumlordUI::
//! RefreshHouse (:250255) shows the requirements on the Buy / Maintenance
//! pages. The text itself is built JS-side (plugins/commerce_logic.js
//! `housePaymentName` / `composeHousePaymentText*`); this module only copies
//! the wire entries (`HousePayment::UnPack`, :485719: num, paid, wcid, name,
//! pname) into the snapshot and, on wasm, into plain JS objects.
//!
//! Gated `wasm32 OR test` like `combat_toggle` so the conversion runs under
//! `cargo test -p holtburger-web --lib house_payments`.

use holtburger_protocol::messages::house::events::HousePaymentEntry;

/// One `HousePayment` row of a snapshot (retail `HousePayment`: num, paid,
/// wcid, name, pname).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HousePay {
    pub num: i32,
    pub paid: i32,
    pub weenie_id: u32,
    pub name: String,
    pub plural_name: String,
}

/// Copy a wire payment list into snapshot rows, order preserved (retail
/// composes the text in list order).
pub(crate) fn house_payments(list: &[HousePaymentEntry]) -> Vec<HousePay> {
    list.iter()
        .map(|p| HousePay {
            num: p.num,
            paid: p.paid,
            weenie_id: p.weenie_id,
            name: p.name.clone(),
            plural_name: p.plural_name.clone(),
        })
        .collect()
}

/// The rows as a JS array of PLAIN objects `{num, paid, weenieId, name,
/// pluralName}` (serde_wasm_bindgen would hand back Maps — see
/// `dereth_calendar_js`), so the panel needs no per-row `free()`.
#[cfg(target_arch = "wasm32")]
pub(crate) fn house_payments_js(list: &[HousePay]) -> js_sys::Array {
    use wasm_bindgen::JsValue;
    let out = js_sys::Array::new();
    for p in list {
        let obj = js_sys::Object::new();
        let fields: [(&str, JsValue); 5] = [
            ("num", JsValue::from_f64(p.num as f64)),
            ("paid", JsValue::from_f64(p.paid as f64)),
            ("weenieId", JsValue::from_f64(p.weenie_id as f64)),
            ("name", JsValue::from_str(&p.name)),
            ("pluralName", JsValue::from_str(&p.plural_name)),
        ];
        for (key, value) in fields {
            let _ = js_sys::Reflect::set(&obj, &JsValue::from_str(key), &value);
        }
        out.push(&obj);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::position::WorldPosition;
    use holtburger_common::Guid;
    use holtburger_protocol::messages::house::events::{
        HouseDataEventData, HouseProfileEventData,
    };
    use holtburger_protocol::traits::{ProtocolPack, ProtocolUnpack};

    fn entry(num: i32, paid: i32, wcid: u32, name: &str, plural: &str) -> HousePaymentEntry {
        HousePaymentEntry {
            num,
            paid,
            weenie_id: wcid,
            name: name.to_string(),
            plural_name: plural.to_string(),
        }
    }

    #[test]
    fn house_data_lists_survive_the_wire_and_the_snapshot_copy() {
        // A cottage: 2 buy requirements, 1 rent requirement half paid.
        let data = HouseDataEventData {
            buy_time: 1_700_000_000,
            rent_time: 1_702_592_000,
            house_type: 1,
            maintenance_free: 0,
            buy: vec![
                entry(10, 0, 273, "Pyreal", "Pyreals"),
                entry(1, 0, 6631, "Writ of Ownership", ""),
            ],
            rent: vec![entry(10, 5, 273, "Pyreal", "Pyreals")],
            position: WorldPosition::default(),
        };
        let mut buf = Vec::new();
        data.pack(&mut buf);
        let mut off = 0usize;
        let back = HouseDataEventData::unpack(&buf, &mut off).expect("HouseData round-trips");
        assert_eq!(off, buf.len());

        let buy = house_payments(&back.buy);
        let rent = house_payments(&back.rent);
        assert_eq!(buy.len(), 2);
        assert_eq!(rent.len(), 1);
        assert_eq!(
            buy[0],
            HousePay {
                num: 10,
                paid: 0,
                weenie_id: 273,
                name: "Pyreal".to_string(),
                plural_name: "Pyreals".to_string(),
            }
        );
        assert_eq!(buy[1].name, "Writ of Ownership");
        assert_eq!(buy[1].plural_name, "", "an empty pname stays empty (GetName falls back)");
        assert_eq!(buy[1].weenie_id, 6631);
        assert_eq!((rent[0].paid, rent[0].num), (5, 10));
    }

    #[test]
    fn house_profile_lists_survive_the_wire_and_the_snapshot_copy() {
        let data = HouseProfileEventData {
            crystal_guid: Guid(0x7A9B4001),
            dwelling_id: 77,
            owner_id: Guid(0),
            bitmask: 0,
            min_level: -1,
            max_level: -1,
            min_alleg_rank: -1,
            max_alleg_rank: -1,
            maintenance_free: 0,
            house_type: 2,
            owner_name: String::new(),
            buy: vec![entry(1, 0, 6631, "Writ of Ownership", "")],
            rent: vec![
                entry(5000, 0, 273, "Pyreal", "Pyreals"),
                entry(2, 1, 9999, "Box", ""),
            ],
        };
        let mut buf = Vec::new();
        data.pack(&mut buf);
        let mut off = 0usize;
        let back = HouseProfileEventData::unpack(&buf, &mut off).expect("HouseProfile round-trips");

        let buy = house_payments(&back.buy);
        let rent = house_payments(&back.rent);
        assert_eq!(buy.len(), 1);
        assert_eq!(rent.len(), 2);
        assert_eq!(rent[1].name, "Box");
        assert_eq!((rent[1].paid, rent[1].num, rent[1].weenie_id), (1, 2, 9999));
    }

    #[test]
    fn empty_list_maps_to_empty() {
        assert!(house_payments(&[]).is_empty());
    }
}
