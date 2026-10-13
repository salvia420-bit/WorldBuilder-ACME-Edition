//! maps-chargen-barber-3 (2026-10-13) — wasm glue for the chargen
//! Appearance page's colour rows (plugins/character-creation.js).
//!
//! The retail logic lives in `holtburger_core::chargen_colors` (pure,
//! native tests against the real portal.dat). This module only feeds it:
//! the gears' ClothingTables, fetched through the manifest source and kept
//! for the page's life, and the PalSet / Palette records, shared with the
//! barber's cache (`crate::barber::DAT`).
//!
//! - `chargenGearColors(heritage, gender)` — every gear style's colour list
//!   (`CharGenState::StoreColorInformation`, acclient.c:495905).
//! - `chargenColorWheel(heritage, gender, part, style)` — one part's
//!   colour-wheel spots (`gmCGAppearancePage::SetSelection`, :186939).
//!
//! The cached tables also reach `sendCharGenResult` /
//! `createTestCharacter` ([`clothing_tables_snapshot`]), so the wire's
//! clothing colour is the chosen gear's key (`GetCharGenResult`,
//! :495612). `getCharacterGenAppearanceStrips` starts loading a sex's
//! tables in the background ([`warm_clothing_tables`]) without changing
//! what it returns.

#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;
use std::sync::Arc;

use holtburger_content::CharacterGenCatalog;
use holtburger_content::character_gen::CharacterGenGenderDefinition;
use holtburger_core::chargen_colors::{
    ChargenClothingTables, ChargenGearSlot, ChargenPart, chargen_clothing_table_ids,
    chargen_part_palette_ids, chargen_part_palette_set_ids, chargen_spot_colors,
};
use holtburger_dat::file_type::ClothingTable;
use holtburger_dat::{ResourceKey, ResourceSource};
use wasm_bindgen::JsValue;

const PORTAL: &str = "eor/portal";

thread_local! {
    static CLOTHING: RefCell<ChargenClothingTables> =
        RefCell::new(ChargenClothingTables::default());
}

/// A copy of the loaded ClothingTables for
/// `CharacterGenBuilder::with_clothing_tables`; `None` while none is
/// loaded (the builder then keeps the gender-list behaviour).
pub(crate) fn clothing_tables_snapshot() -> Option<Arc<ChargenClothingTables>> {
    CLOTHING.with(|c| {
        let c = c.borrow();
        if c.is_empty() {
            None
        } else {
            Some(Arc::new(c.clone()))
        }
    })
}

/// Fetch and cache the ClothingTables named by `ids`. A fetch or parse
/// miss leaves the table out (callers treat it as not loaded).
async fn ensure_clothing_tables(ids: &[u32]) {
    let missing: Vec<u32> = CLOTHING.with(|c| {
        let c = c.borrow();
        ids.iter()
            .copied()
            .filter(|id| *id != 0 && !c.contains(*id))
            .collect()
    });
    if missing.is_empty() {
        return;
    }
    let Some(source) = crate::global_source::try_global_source() else {
        return;
    };
    let keys: Vec<ResourceKey<'static>> =
        missing.iter().map(|id| ResourceKey::new(PORTAL, *id)).collect();
    if let Err(e) = source.prefetch(&keys).await {
        log::warn!("chargen colours: prefetch {} ClothingTables: {e}", keys.len());
    }
    for id in missing {
        let Ok(bytes) = source.get_file_by_key(ResourceKey::new(PORTAL, id)) else {
            continue;
        };
        if let Ok(table) = ClothingTable::unpack(&bytes) {
            CLOTHING.with(|c| c.borrow_mut().insert(id, &table));
        }
    }
}

fn gender_for(
    catalog: &CharacterGenCatalog,
    heritage: u32,
    gender: u32,
    what: &str,
) -> Result<CharacterGenGenderDefinition, JsValue> {
    catalog
        .heritage_group(heritage)
        .and_then(|h| h.genders.get(&gender))
        .cloned()
        .ok_or_else(|| {
            JsValue::from_str(&format!(
                "{what}: no Sex_CG for heritage {heritage} gender {gender}"
            ))
        })
}

/// Start loading the ClothingTables of one sex's gear in the background,
/// unless they are all cached. Called by `getCharacterGenAppearanceStrips`
/// so a build submitted soon after has its gears' colour lists.
pub(crate) fn warm_clothing_tables(catalog: &CharacterGenCatalog, heritage: u32, gender: u32) {
    let Some(sex) = catalog
        .heritage_group(heritage)
        .and_then(|h| h.genders.get(&gender))
    else {
        return;
    };
    let ids = chargen_clothing_table_ids(&sex.appearance);
    let all_cached = CLOTHING.with(|c| {
        let c = c.borrow();
        ids.iter().all(|id| c.contains(*id))
    });
    if all_cached || crate::global_source::try_global_source().is_none() {
        return;
    }
    wasm_bindgen_futures::spawn_local(async move {
        ensure_clothing_tables(&ids).await;
    });
}

/// maps-chargen-barber-3 — every gear style's colour list for one sex.
///
/// Returns JSON: `{ heritage, gender, headgear: [entry…], shirt: […],
/// trousers: […], footwear: […] }`, one entry per style of the Sex_CG
/// list: `{ templateIds: [u32…], palSetIds: [u32…] }`, or `null` when that
/// gear's ClothingTable did not load.
pub(crate) async fn gear_colors_json(
    catalog: Arc<CharacterGenCatalog>,
    heritage: u32,
    gender: u32,
) -> Result<String, JsValue> {
    let sex = gender_for(&catalog, heritage, gender, "chargenGearColors")?;
    ensure_clothing_tables(&chargen_clothing_table_ids(&sex.appearance)).await;
    let json = CLOTHING.with(|c| {
        let c = c.borrow();
        let slot_json = |slot: ChargenGearSlot| -> serde_json::Value {
            let styles = slot.gear_list(&sex.appearance).len() as u32;
            serde_json::Value::Array(
                (0..styles)
                    .map(|style| match c.gear_choices(&sex.appearance, slot, style) {
                        Some(choices) => serde_json::json!({
                            "templateIds": choices.template_ids,
                            "palSetIds": choices.pal_set_ids,
                        }),
                        None => serde_json::Value::Null,
                    })
                    .collect(),
            )
        };
        serde_json::json!({
            "heritage": heritage,
            "gender": gender,
            "headgear": slot_json(ChargenGearSlot::Headgear),
            "shirt": slot_json(ChargenGearSlot::Shirt),
            "trousers": slot_json(ChargenGearSlot::Trousers),
            "footwear": slot_json(ChargenGearSlot::Footwear),
        })
    });
    serde_json::to_string(&json).map_err(|e| JsValue::from_str(&format!("chargenGearColors: {e}")))
}

/// maps-chargen-barber-3 — `gmCGAppearancePage::SetSelection`'s colour
/// wheel for `part` (`"hair"`, `"eyes"`, `"nose"`, `"mouth"`, `"skin"`,
/// `"headgear"`, `"shirt"`, `"trousers"`, `"footwear"`); `style` picks the
/// gear for the clothing parts and is ignored otherwise.
///
/// Returns JSON: `{ part, style, shade: bool, count, spots: [[r,g,b]|null…],
/// templateIds: [u32…]|null }` — `shade` is false for the eyes (no shade
/// scroll); `templateIds` is the gear's list (clothing parts only, null
/// when its table did not load or the style is out of range).
pub(crate) async fn color_wheel_json(
    catalog: Arc<CharacterGenCatalog>,
    heritage: u32,
    gender: u32,
    part: String,
    style: u32,
) -> Result<String, JsValue> {
    let Some(part) = ChargenPart::from_name(&part) else {
        return Err(JsValue::from_str(&format!(
            "chargenColorWheel: unknown part {part:?}"
        )));
    };
    let sex = gender_for(&catalog, heritage, gender, "chargenColorWheel")?;
    let gear = match part.gear_slot() {
        Some(slot) => {
            if let Some(g) = slot.gear_list(&sex.appearance).get(style as usize) {
                ensure_clothing_tables(&[g.clothing_table]).await;
            }
            CLOTHING.with(|c| c.borrow().gear_choices(&sex.appearance, slot, style))
        }
        None => None,
    };
    let sets = chargen_part_palette_set_ids(&sex, part, gear.as_ref());
    crate::barber::ensure_records(&sets, false).await;
    let palettes = crate::barber::DAT
        .with(|d| chargen_part_palette_ids(&sex, part, gear.as_ref(), &*d.borrow()));
    crate::barber::ensure_records(&palettes, true).await;
    let spots = crate::barber::DAT
        .with(|d| chargen_spot_colors(&sex, part, gear.as_ref(), &*d.borrow()));
    let json = serde_json::json!({
        "part": part.name(),
        "style": style,
        "shade": part.has_shade(),
        "count": spots.len(),
        "spots": crate::barber::spots_json(&spots),
        "templateIds": gear.as_ref().map(|g| g.template_ids.clone()),
    });
    serde_json::to_string(&json).map_err(|e| JsValue::from_str(&format!("chargenColorWheel: {e}")))
}
