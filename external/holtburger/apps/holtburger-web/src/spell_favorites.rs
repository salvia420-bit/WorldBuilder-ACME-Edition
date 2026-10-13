//! input-options-2 (2026-10-13) — the local copy of the character's 8
//! spell-bar favourite lists (`PlayerState::hotbar_spells`, hydrated from
//! PlayerDescription `SpellLists8`), updated when the client sends an edit.
//!
//! Retail edits its `PlayerModule` first and then tells the server:
//! `SpellCastSubMenu::AddSpellToPlayerModule` (acclient.c:247988) calls
//! `PlayerModule::AddSpellFavorite` (:512742, `PackableList::InsertPos` into
//! `favorite_spells_[list]`, lists 0..7 only) and then
//! `CM_Character::Event_AddSpellFavorite`; the remove twin
//! (`RemoveSpellFromPlayerModule`, :247949) calls
//! `PlayerModule::RemoveSpellFavorite` (:513127, `PackableList::Remove`). The
//! recv loop does the same so `playerSpellBars()` matches what the server now
//! holds. The rules are ACE's, which decide the stored result:
//! `HandleActionAddSpellFavorite` ignores a bar past 7 and a spell the
//! character does not know, and `CharacterExtensions.AddSpellToBar` ignores a
//! spell already on that bar and inserts at `min(index, count)`.
//!
//! Gated `wasm32 OR test` like `house_payments` so
//! `cargo test -p holtburger-web --lib spell_favorites` runs natively.

#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

/// Number of spell-bar favourite lists (retail `favorite_spells_[8]`).
pub(crate) const SPELL_FAVORITE_LISTS: usize = 8;

/// Apply an AddSpellFavorite to `lists`. Returns `true` when the list
/// changed. `known` = the character knows `spell_id` (ACE `SpellIsKnown`).
pub(crate) fn add_spell_favorite(
    lists: &mut Vec<Vec<u32>>,
    spell_id: u32,
    index: u32,
    list: u32,
    known: bool,
) -> bool {
    let list = list as usize;
    if list >= SPELL_FAVORITE_LISTS || !known {
        return false;
    }
    if lists.len() < SPELL_FAVORITE_LISTS {
        lists.resize(SPELL_FAVORITE_LISTS, Vec::new());
    }
    let bar = &mut lists[list];
    if bar.contains(&spell_id) {
        return false;
    }
    let at = (index as usize).min(bar.len());
    bar.insert(at, spell_id);
    true
}

/// Apply a RemoveSpellFavorite to `lists`. Returns `true` when the spell was
/// on that list.
pub(crate) fn remove_spell_favorite(lists: &mut [Vec<u32>], spell_id: u32, list: u32) -> bool {
    let Some(bar) = lists.get_mut(list as usize) else {
        return false;
    };
    match bar.iter().position(|&s| s == spell_id) {
        Some(i) => {
            bar.remove(i);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_inserts_at_the_index_and_clamps_to_the_end() {
        let mut lists = vec![vec![10, 20, 30]];
        assert!(add_spell_favorite(&mut lists, 15, 1, 0, true));
        assert_eq!(lists[0], vec![10, 15, 20, 30]);
        assert!(add_spell_favorite(&mut lists, 99, 50, 0, true));
        assert_eq!(lists[0], vec![10, 15, 20, 30, 99]);
        // Short PlayerDescription lists are padded to all 8 bars.
        assert_eq!(lists.len(), SPELL_FAVORITE_LISTS);
        assert!(add_spell_favorite(&mut lists, 7, 0, 7, true));
        assert_eq!(lists[7], vec![7]);
    }

    #[test]
    fn add_ignores_a_duplicate_an_unknown_spell_and_a_bar_past_seven() {
        let mut lists = vec![vec![10, 20]; SPELL_FAVORITE_LISTS];
        assert!(!add_spell_favorite(&mut lists, 20, 0, 0, true), "already on the bar");
        assert!(!add_spell_favorite(&mut lists, 30, 0, 0, false), "not known");
        assert!(!add_spell_favorite(&mut lists, 30, 0, 8, true), "no ninth bar");
        assert_eq!(lists, vec![vec![10, 20]; SPELL_FAVORITE_LISTS]);
    }

    #[test]
    fn remove_closes_the_gap_and_ignores_a_missing_spell() {
        let mut lists = vec![vec![10, 20, 30], vec![20]];
        assert!(remove_spell_favorite(&mut lists, 20, 0));
        assert_eq!(lists[0], vec![10, 30]);
        assert_eq!(lists[1], vec![20], "other bars untouched");
        assert!(!remove_spell_favorite(&mut lists, 20, 0));
        assert!(!remove_spell_favorite(&mut lists, 20, 5), "bar not in the list");
    }

    #[test]
    fn a_move_is_remove_then_add_at_the_final_index() {
        // Retail SpellCastSubMenu::AddFavorite (acclient.c:248597): moving
        // 10 from position 0 to the end of [10, 20, 30].
        let mut lists = vec![vec![10, 20, 30]];
        assert!(remove_spell_favorite(&mut lists, 10, 0));
        assert!(add_spell_favorite(&mut lists, 10, 2, 0, true));
        assert_eq!(lists[0], vec![20, 30, 10]);
    }
}
