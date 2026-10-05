//! recv_loop split (2026-10-05): the wasm session loop's shared state.
//!
//! `recv_loop` (lib.rs) used to keep ~55 parameters and ~35 loop-scoped
//! locals as bare bindings that every `select!` arm reached directly. They
//! now live in one [`LoopCtx`], built once just before the loop. Each loop
//! iteration (and each extracted handler) destructures the fields it uses
//! back into bindings with the ORIGINAL names (`&mut` to the field), so the
//! moved arm bodies stay verbatim apart from `*` on mutable scalars.
//! RefCell borrow scopes are untouched: the `Rc<RefCell<..>>` handles are
//! only reached through `&mut`, never borrowed by the destructure itself.

use crate::*;

pub(crate) mod commands;
pub(crate) mod messages;

/// What the loop does after a handler returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LoopFlow {
    /// Keep looping (the old arm fell through / `continue`d).
    Continue,
    /// Return from `recv_loop` (the old arm `return`ed).
    Exit,
}

/// The startup URL-flag reads `recv_loop` takes once before the loop.
/// `Copy`, so handlers read them by value (`let LoopFlags { x, .. } = ctx.flags;`).
#[derive(Clone, Copy)]
pub(crate) struct LoopFlags {
    pub(crate) seq_debug: bool,
    pub(crate) spawn_motion_state_on: bool,
    pub(crate) spawn_door_collision_on: bool,
    pub(crate) skip_contained_spawn_on: bool,
    pub(crate) spawn_hidden_state_on: bool,
    pub(crate) wielded_spawn_on: bool,
    pub(crate) world_lifecycle_on: bool,
    pub(crate) unified_tick_on: bool,
    pub(crate) maint_prune_on: bool,
    pub(crate) pose_publish_post_tick_on: bool,
    pub(crate) wire_state_packs_stage1_on: bool,
    pub(crate) routine_pos_guard_on: bool,
    pub(crate) remote_interp_on: bool,
    pub(crate) remote_root_motion_on: bool,
    pub(crate) remote_sticky_on: bool,
    pub(crate) combat_radii_on: bool,
    pub(crate) server_run_rate_on: bool,
    pub(crate) retail_leash_on: bool,
    pub(crate) leash_echo_gate_on: bool,
}

/// Everything the recv loop's arms share; see the module doc.
pub(crate) struct LoopCtx {
    pub(crate) session: net_worker::LoopSession,
    pub(crate) queued_events: std::rc::Rc<std::cell::RefCell<Vec<ClientEvent>>>,
    pub(crate) character_list: std::rc::Rc<std::cell::RefCell<Vec<CharacterSummary>>>,
    pub(crate) entity_updates: std::rc::Rc<std::cell::RefCell<Vec<EntityUpdate>>>,
    pub(crate) charlist_tx: Option<futures::channel::oneshot::Sender<CharListReady>>,
    pub(crate) world_bootstrap:
        std::rc::Rc<std::cell::RefCell<Option<std::sync::Arc<holtburger_world::WorldBootstrap>>>>,
    pub(crate) latest_stats: std::rc::Rc<std::cell::RefCell<Option<LatestStats>>>,
    pub(crate) latest_inventory: std::rc::Rc<std::cell::RefCell<Vec<InventoryItem>>>,
    pub(crate) latest_vendor_state:
        std::rc::Rc<std::cell::RefCell<std::collections::HashMap<u32, VendorState>>>,
    pub(crate) latest_container_contents:
        std::rc::Rc<std::cell::RefCell<std::collections::HashMap<u32, Vec<u32>>>>,
    pub(crate) latest_object_icons:
        std::rc::Rc<std::cell::RefCell<std::collections::HashMap<u32, u32>>>,
    pub(crate) latest_inscriptions:
        std::rc::Rc<std::cell::RefCell<std::collections::HashMap<u32, String>>>,
    pub(crate) latest_appraisals:
        std::rc::Rc<std::cell::RefCell<std::collections::HashMap<u32, String>>>,
    pub(crate) latest_enchantments: std::rc::Rc<std::cell::RefCell<Vec<PlayerEnchantment>>>,
    pub(crate) latest_fellowship: std::rc::Rc<std::cell::RefCell<Option<FellowshipSnapshot>>>,
    pub(crate) latest_trade: std::rc::Rc<std::cell::RefCell<Option<TradeSnapshot>>>,
    pub(crate) latest_book: std::rc::Rc<std::cell::RefCell<Option<BookSnapshot>>>,
    pub(crate) latest_allegiance: std::rc::Rc<std::cell::RefCell<Option<AllegianceSnapshot>>>,
    pub(crate) latest_allegiance_info: std::rc::Rc<
        std::cell::RefCell<Option<holtburger_protocol::messages::AllegianceInfoResponseEventData>>,
    >,
    pub(crate) latest_friends: std::rc::Rc<std::cell::RefCell<Option<FriendsSnapshot>>>,
    pub(crate) latest_squelch: std::rc::Rc<std::cell::RefCell<Option<SquelchSnapshot>>>,
    pub(crate) latest_title: std::rc::Rc<std::cell::RefCell<Option<TitleSnapshot>>>,
    pub(crate) latest_house_status: std::rc::Rc<std::cell::RefCell<Option<HouseStatus>>>,
    pub(crate) latest_house_data: std::rc::Rc<std::cell::RefCell<Option<HouseData>>>,
    pub(crate) latest_house_profile: std::rc::Rc<std::cell::RefCell<Option<HouseProfile>>>,
    pub(crate) latest_house_restrictions:
        std::rc::Rc<std::cell::RefCell<Option<HouseRestrictions>>>,
    pub(crate) latest_contracts: std::rc::Rc<std::cell::RefCell<Option<ContractsSnapshot>>>,
    pub(crate) latest_known_spells: std::rc::Rc<std::cell::RefCell<Vec<u32>>>,
    pub(crate) wielder_index:
        std::rc::Rc<std::cell::RefCell<std::collections::HashMap<u32, Vec<WieldedWeaponEntry>>>>,
    pub(crate) projectile_index: std::rc::Rc<std::cell::RefCell<std::collections::HashSet<u32>>>,
    pub(crate) physics_script_table_index:
        std::rc::Rc<std::cell::RefCell<std::collections::HashMap<u32, u32>>>,
    pub(crate) entity_enchantments_index:
        std::rc::Rc<std::cell::RefCell<std::collections::HashMap<u32, Vec<PlayerEnchantment>>>>,
    pub(crate) identify_meta_index:
        std::rc::Rc<std::cell::RefCell<std::collections::HashMap<u32, (bool, u32)>>>,
    pub(crate) latest_server_info: std::rc::Rc<std::cell::RefCell<Option<ServerInfoJs>>>,
    pub(crate) latest_sanctuary: std::rc::Rc<std::cell::RefCell<Option<SanctuaryJs>>>,
    pub(crate) latest_localization: std::rc::Rc<std::cell::RefCell<Option<LocalizationJs>>>,
    pub(crate) cell_scene_snapshot: std::rc::Rc<std::cell::RefCell<CellSceneSnapshot>>,
    pub(crate) door_part_snapshot:
        std::rc::Rc<std::cell::RefCell<std::collections::HashMap<u32, DoorPartSnapshot>>>,
    pub(crate) local_player_pose: std::rc::Rc<std::cell::RefCell<Option<LocalPlayerPose>>>,
    pub(crate) local_player_can_jump: std::rc::Rc<std::cell::RefCell<bool>>,
    pub(crate) local_player_jump_charge_level: std::rc::Rc<std::cell::RefCell<f32>>,
    pub(crate) local_player_pursuit_status: std::rc::Rc<std::cell::RefCell<u32>>,
    pub(crate) rynth_use_done_seq: std::rc::Rc<std::cell::RefCell<u32>>,
    pub(crate) rynth_busy: std::rc::Rc<std::cell::RefCell<(u32, Option<web_time::Instant>)>>,
    pub(crate) rynth_id_times: std::rc::Rc<std::cell::RefCell<std::collections::HashMap<u32, f64>>>,
    pub(crate) rynth_ground_container: std::rc::Rc<std::cell::RefCell<u32>>,
    pub(crate) last_recv_instant: std::rc::Rc<std::cell::RefCell<Option<web_time::Instant>>>,
    pub(crate) last_ping_rtt_ms: std::rc::Rc<std::cell::RefCell<Option<u32>>>,
    pub(crate) collision_scene: std::rc::Rc<std::cell::RefCell<holtburger_world::SpatialScene>>,
    pub(crate) terrain_heights_shadow:
        std::rc::Rc<std::cell::RefCell<std::collections::HashMap<u32, [f32; 81]>>>,
    pub(crate) turbine_chat_state:
        std::rc::Rc<std::cell::RefCell<holtburger_core::client::types::TurbineChatState>>,
    pub(crate) pending_confirmations: std::rc::Rc<std::cell::RefCell<Vec<PendingConfirmation>>>,
    pub(crate) plugin_list: std::rc::Rc<std::cell::RefCell<Option<String>>>,
    pub(crate) world: std::rc::Rc<std::cell::RefCell<Option<holtburger_world::WorldState>>>,
    pub(crate) state: LoopState,
    pub(crate) account_name: String,
    pub(crate) movement: holtburger_core::MovementSystemHandle,
    pub(crate) tick_spine: holtburger_core::TickSpineHandle,
    pub(crate) entity_seeded: bool,
    pub(crate) heartbeat_armed: bool,
    pub(crate) pending_post_teleport_login_complete: bool,
    /// Portal-space arrival edge: the `teleport_sequence` of the last
    /// `PlayerTeleport`, consumed by the first local-player `UpdatePosition`
    /// carrying that (or a newer) sequence -> kind=66 TeleportArrived.
    pub(crate) pending_teleport_arrival_seq: Option<u16>,
    pub(crate) last_diag_force_seq: Option<u16>,
    pub(crate) local_player_kind1_emitted: bool,
    pub(crate) local_player_spawn_emitted: bool,
    pub(crate) last_local_player_position_emit: Option<web_time::Instant>,
    pub(crate) cached_player_description: Option<holtburger_protocol::messages::GameMessage>,
    pub(crate) cached_time_sync: Option<(f64, web_time::Instant)>,
    pub(crate) js_spawned_guids: std::collections::HashSet<u32>,
    pub(crate) seq_tracker:
        std::rc::Rc<std::cell::RefCell<std::collections::HashMap<(u32, u32), u32>>>,
    pub(crate) flags: LoopFlags,
}
