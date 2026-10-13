//! maps-chargen-barber-1 (2026-10-13) — wasm glue for the barber page
//! (plugins/barber-panel.js).
//!
//! The retail page logic lives in `holtburger_core::barber` (pure, native
//! tests against the real portal.dat). This module only feeds it: the
//! CharGen ObjDescs (`CharacterGenFaceTable`, parsed once and cached) and the
//! skin / hair PalSets plus the colour-wheel Palettes, fetched through the
//! manifest source on first use and cached for the page. Both calls resolve
//! to a JSON string (plain objects on the JS side, no serde `Map`s); the
//! `SessionHandle.barberInit` / `.barberApply` exports (lib.rs) wrap them in
//! Promises so plugins reach them through `window.__sessionHandle`.
//!
//! - `barberInit(heritage, gender, fields)` — gmBarberUI::InitializePage
//!   (acclient.c:270582): the face for the 16 StartBarber fields, the list
//!   sizes, the heritage option and the colour-wheel spots.
//! - `barberApply(heritage, gender, face)` — gmBarberUI Apply
//!   (acclient.c:270145-270366): the 16 FinishBarber fields (or null), the
//!   local effects, and ACE's checks (`problems`, empty when ACE accepts).

#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;
use std::sync::Arc;

use holtburger_content::character_gen::{CharacterGenFaceSex, CharacterGenFaceTable};
use holtburger_core::barber::{
    BarberDatCache, BarberFace, BarberOption, BarberPart, barber_apply, barber_init,
    barber_palette_set_ids, barber_spot_colors, barber_spot_palette_ids, is_gear_or_olthoi,
    validate_finish_barber,
};
use holtburger_dat::file_type::{CharGen, Palette, PaletteSet};
use holtburger_dat::{ResourceKey, ResourceSource};
use holtburger_protocol::messages::StartBarberEventData;
use wasm_bindgen::JsValue;

const PORTAL: &str = "eor/portal";

thread_local! {
    static FACE_TABLE: RefCell<Option<Arc<CharacterGenFaceTable>>> = RefCell::new(None);
    /// PalSets and Palettes, shared with the chargen colour rows
    /// (src/chargen_colors.rs, maps-chargen-barber-3).
    pub(crate) static DAT: RefCell<BarberDatCache> = RefCell::new(BarberDatCache::default());
}

/// The CharGen face table, parsed on first use.
async fn face_table() -> Result<Arc<CharacterGenFaceTable>, JsValue> {
    if let Some(t) = FACE_TABLE.with(|c| c.borrow().clone()) {
        return Ok(t);
    }
    let source = crate::global_source::try_global_source()
        .ok_or_else(|| JsValue::from_str("barber: init_resource_source has not run"))?;
    source
        .prefetch(&[ResourceKey::new(PORTAL, CharGen::FILE_ID)])
        .await
        .map_err(|e| JsValue::from_str(&format!("barber: prefetch CharGen: {e}")))?;
    let mounts: Vec<Arc<dyn ResourceSource>> = vec![source];
    let repo = holtburger_content::ContentRepository::from_mounts(mounts);
    let char_gen = repo
        .read_asset::<CharGen>("character generator table")
        .map_err(|e| JsValue::from_str(&format!("barber: CharGen: {e}")))?;
    let table = Arc::new(CharacterGenFaceTable::from_char_gen(&char_gen));
    FACE_TABLE.with(|c| *c.borrow_mut() = Some(table.clone()));
    Ok(table)
}

async fn sex_for(heritage: u32, gender: u32) -> Result<CharacterGenFaceSex, JsValue> {
    let table = face_table().await?;
    table.sex(heritage, gender).cloned().ok_or_else(|| {
        JsValue::from_str(&format!(
            "barber: no Sex_CG for heritage {heritage} gender {gender}"
        ))
    })
}

/// Fetch and cache the PalSets (`palettes == false`) or Palettes named by
/// `ids`. A fetch or parse miss leaves the record out; the core functions
/// treat a missing record as retail's failed DBObj::Get.
pub(crate) async fn ensure_records(ids: &[u32], palettes: bool) {
    let missing: Vec<u32> = DAT.with(|d| {
        let d = d.borrow();
        ids.iter()
            .copied()
            .filter(|id| {
                *id != 0
                    && if palettes {
                        !d.palettes.contains_key(id)
                    } else {
                        !d.palette_sets.contains_key(id)
                    }
            })
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
        log::warn!("barber: prefetch {} records: {e}", keys.len());
    }
    for id in missing {
        let Ok(bytes) = source.get_file_by_key(ResourceKey::new(PORTAL, id)) else {
            continue;
        };
        if palettes {
            if let Ok(p) = Palette::unpack(&bytes) {
                DAT.with(|d| {
                    d.borrow_mut().palettes.insert(id, p.colors);
                });
            }
        } else if let Ok(ps) = PaletteSet::unpack(&bytes) {
            DAT.with(|d| {
                d.borrow_mut().palette_sets.insert(id, ps.palettes);
            });
        }
    }
}

fn option_name(option: BarberOption) -> Option<&'static str> {
    match option {
        BarberOption::None => None,
        BarberOption::EmpyreanEarthbound => Some("earthbound"),
        BarberOption::UndeadNoFlame => Some("noflame"),
        BarberOption::ShadowNoCrown => Some("nocrown"),
    }
}

pub(crate) fn spots_json(spots: &[Option<[u8; 3]>]) -> serde_json::Value {
    serde_json::Value::Array(
        spots
            .iter()
            .map(|s| match s {
                Some(c) => serde_json::json!([c[0], c[1], c[2]]),
                None => serde_json::Value::Null,
            })
            .collect(),
    )
}

fn face_json(face: &BarberFace) -> serde_json::Value {
    serde_json::json!({
        "hairStyle": face.hair_style,
        "eyesStrip": face.eyes_strip,
        "noseStrip": face.nose_strip,
        "mouthStrip": face.mouth_strip,
        "hairColor": face.hair_color,
        "hairShade": face.hair_shade,
        "skinShade": face.skin_shade,
        "eyeColor": face.eye_color,
        "option": face.option,
    })
}

/// maps-chargen-barber-1 — gmBarberUI::InitializePage for the player's
/// heritage / gender (PropertyInt 188 / 113) and the 16 StartBarber fields.
///
/// Returns JSON:
/// `{ heritage, gender, option: "earthbound"|"noflame"|"nocrown"|null,
///    optionToken, gearOlthoi, counts: { hairStyles, eyeStrips, noseStrips,
///    mouthStrips, hairColors, eyeColors }, face: { hairStyle, eyesStrip,
///    noseStrip, mouthStrip, hairColor, hairShade, skinShade, eyeColor,
///    option }, spots: { hair: [[r,g,b]|null…], eyes: […], skin: […] } }`.
pub(crate) async fn barber_init_json(
    heritage: u32,
    gender: u32,
    fields: Vec<u32>,
) -> Result<String, JsValue> {
    let fields: [u32; 16] = fields.as_slice().try_into().map_err(|_| {
        JsValue::from_str(&format!("barberInit: expected 16 fields, got {}", fields.len()))
    })?;
    let fields = StartBarberEventData::from_fields(&fields);
    let sex = sex_for(heritage, gender).await?;
    ensure_records(&barber_palette_set_ids(&sex), false).await;
    let spot_palettes = DAT.with(|d| barber_spot_palette_ids(&sex, &*d.borrow()));
    ensure_records(&spot_palettes, true).await;

    let (face, hair, eyes, skin) = DAT.with(|d| {
        let d = d.borrow();
        (
            barber_init(&sex, &fields, &*d),
            barber_spot_colors(&sex, BarberPart::Hair, &*d),
            barber_spot_colors(&sex, BarberPart::Eyes, &*d),
            barber_spot_colors(&sex, BarberPart::Skin, &*d),
        )
    });
    let option = BarberOption::for_heritage(heritage);
    let json = serde_json::json!({
        "heritage": heritage,
        "gender": gender,
        "option": option_name(option),
        "optionToken": option.string_token(),
        "gearOlthoi": is_gear_or_olthoi(heritage),
        "counts": {
            "hairStyles": sex.hair_styles.len(),
            "eyeStrips": sex.eye_strips.len(),
            "noseStrips": sex.nose_strips.len(),
            "mouthStrips": sex.mouth_strips.len(),
            "hairColors": sex.hair_color_ids.len(),
            "eyeColors": sex.eye_color_ids.len(),
        },
        "face": face_json(&face),
        "spots": {
            "hair": spots_json(&hair),
            "eyes": spots_json(&eyes),
            "skin": spots_json(&skin),
        },
    });
    serde_json::to_string(&json).map_err(|e| JsValue::from_str(&format!("barberInit: {e}")))
}

/// The face object `barberApply` takes (the `face` of `barberInit`, edited).
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct BarberFaceJs {
    hair_style: u32,
    eyes_strip: u32,
    nose_strip: u32,
    mouth_strip: u32,
    hair_color: u32,
    hair_shade: f64,
    skin_shade: f64,
    eye_color: u32,
    option: bool,
}

/// maps-chargen-barber-1 — gmBarberUI Apply for an edited face.
///
/// Returns JSON:
/// `{ fields: [16 u32]|null, effects: { motionTableId, destroyParticles,
///    playScript }, problems: ["headObject", …] }` — `fields` is null when
/// GenerateBaseAppearanceData fails (retail sends nothing); `problems` lists
/// the fields ACE's HandleActionFinishBarber would reject (empty = send).
pub(crate) async fn barber_apply_json(
    heritage: u32,
    gender: u32,
    face: JsValue,
) -> Result<String, JsValue> {
    let f: BarberFaceJs = serde_wasm_bindgen::from_value(face)
        .map_err(|e| JsValue::from_str(&format!("barberApply: invalid face: {e}")))?;
    let face = BarberFace {
        hair_style: f.hair_style,
        eyes_strip: f.eyes_strip,
        nose_strip: f.nose_strip,
        mouth_strip: f.mouth_strip,
        hair_color: f.hair_color,
        hair_shade: f.hair_shade,
        skin_shade: f.skin_shade,
        eye_color: f.eye_color,
        option: f.option,
    };
    let sex = sex_for(heritage, gender).await?;
    ensure_records(&barber_palette_set_ids(&sex), false).await;
    let (result, problems) = DAT.with(|d| {
        let d = d.borrow();
        let result = barber_apply(&sex, &face, &*d);
        let problems: Vec<&'static str> = match &result.fields {
            Some(fields) => validate_finish_barber(&sex, fields, &*d)
                .into_iter()
                .map(|p| p.name())
                .collect(),
            None => Vec::new(),
        };
        (result, problems)
    });
    let json = serde_json::json!({
        "fields": result.fields.as_ref().map(|f| f.to_fields().to_vec()),
        "effects": {
            "motionTableId": result.effects.motion_table_id,
            "destroyParticles": result.effects.destroy_particles,
            "playScript": result.effects.play_script,
        },
        "problems": problems,
    });
    serde_json::to_string(&json).map_err(|e| JsValue::from_str(&format!("barberApply: {e}")))
}
