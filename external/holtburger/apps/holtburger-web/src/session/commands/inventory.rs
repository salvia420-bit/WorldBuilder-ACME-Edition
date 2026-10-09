//! `SessionCommand` arms: Items: use/appraise, tinkering, give, vendors, secure
//! trade, books and inscriptions, wield/drop/move/split/merge, contracts.
//!
//! Moved verbatim from the `recv_loop` command `select!` arm (2026-10-05
//! split); see `session::commands::handle_command` for the routing.

use crate::*;
use crate::session::{LoopCtx, LoopFlow};

pub(super) async fn handle(ctx: &mut LoopCtx, cmd: SessionCommand) -> LoopFlow {
    let LoopCtx { session, queued_events, world, movement, .. } = &mut *ctx;
    match cmd {
        SessionCommand::UseObject { guid } => {
            // Phase 4 step 5 (interactive entities): wrap
            // the click target in `GameAction::Use(UseActionData { guid })`
            // and send via the same path the cli's
            // ClientCommand::Use uses (see
            // `apps/holtburger-cli/src/.../commands.rs` —
            // confirmed in the explore-agent grounding).
            // ACE's response routes through GameEvent
            // (ApproachVendor / UseDone / WeenieError) +
            // top-level (PlayerTeleport / position
            // updates) variants we handle elsewhere in
            // this match.
            let action = holtburger_protocol::messages::GameAction::Use(
                Box::new(holtburger_protocol::messages::UseActionData {
                    guid: holtburger_common::Guid::from(guid),
                }),
            );
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(Use): {e}",
                "use_object: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::NoLongerViewingContents { container_guid } => {
            // HUD overhaul 2026-10-05: the loot window closed.
            let action = holtburger_protocol::messages::GameAction::NoLongerViewingContents(
                Box::new(holtburger_protocol::messages::NoLongerViewingContentsActionData {
                    container_guid: holtburger_common::Guid::from(container_guid),
                }),
            );
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(NoLongerViewingContents): {e}",
                "noLongerViewingContents: {e}",
                LoopFlow::Exit
            );
        }
        // EX-05 (2026-06-05) — examine refactor: fire
        // `GameAction::IdentifyObject(guid)` (sub-opcode 0x00C8).
        // ACE replies with `GameEvent::IdentifyObjectResponse`
        // (opcode 0x00C9) which lands in the world's
        // `inventory::handle_event` arm and is folded into
        // the entity's `properties.*` + AppraisalProfile
        // sub-bodies. The post-fold `WorldEvent::EntityIdentified`
        // already emits `kind=32 ObjectAppraised` so the JS
        // examine plugin just subscribes to that event and
        // re-reads via [`SessionHandle::get_object_appraisal`].
        SessionCommand::RequestAppraisal { guid } => {
            let action = holtburger_protocol::messages::GameAction::IdentifyObject(
                Box::new(holtburger_protocol::messages::IdentifyObjectActionData {
                    guid: holtburger_common::Guid::from(guid),
                }),
            );
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(IdentifyObject guid=0x{guid:08X}): {e}",
                "request_appraisal: {e}",
                LoopFlow::Exit
            );
        }
        // === Wave 5.A — tradeskill useWithTarget (2026-05-28) ===
        SessionCommand::UseWithTarget {
            item_guid,
            target_guid,
        } => {
            // Wrap (item, target) in
            // `GameAction::UseWithTarget(UseWithTargetActionData {...})`
            // (action opcode 0x0035 — Chorizite
            // `Inventory_UseWithTargetEvent`, ACE
            // `GameActionType.UseWithTarget`). The same
            // path the cli's ClientCommand::UseWithTarget
            // takes via send_game_action
            // (`crates/holtburger-core/src/client/commands.rs:436`).
            //
            // ACE handles the response in
            // `Player_Use.cs::HandleActionUseWithTarget`
            // (`~/ace-server/Source/ACE.Server/WorldObjects/
            // Player_Use.cs:29`) → `Managers/RecipeManager.cs`.
            // Success/failure flows back as chat (existing
            // ChatBroadcast / Communication_* handlers) +
            // inventory deltas (existing InventoryChange /
            // UpdateObject handlers) — no new recv arm.
            let action =
                holtburger_protocol::messages::GameAction::UseWithTarget(Box::new(
                    holtburger_protocol::messages::UseWithTargetActionData {
                        item_guid: holtburger_common::Guid::from(item_guid),
                        target_guid: holtburger_common::Guid::from(target_guid),
                    },
                ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(UseWithTarget): {e}",
                "use_with_target: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::SalvageItemsWith { tool_guid, items } => {
            // R14: GameActionCreateTinkeringTool (0x027D). The
            // actiondata pack order + parity fixture
            // (test_salvage_items_with_parity) are locked in the
            // protocol crate; this arm only bridges the wasm cmd.
            let action =
                holtburger_protocol::messages::GameAction::SalvageItemsWith(Box::new(
                    holtburger_protocol::messages::SalvageItemsWithActionData {
                        tool_guid: holtburger_common::Guid::from(tool_guid),
                        items: items
                            .into_iter()
                            .map(holtburger_common::Guid::from)
                            .collect(),
                    },
                ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(SalvageItemsWith): {e}",
                "salvage_items_with: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::GiveObject {
            target_guid,
            item_guid,
            amount,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, GiveObjectRequestActionData,
            };
            let action = GameAction::GiveObjectRequest(Box::new(
                GiveObjectRequestActionData {
                    target_guid: Guid(target_guid),
                    item_guid: Guid(item_guid),
                    amount,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(GiveObject): {e}",
                "give_object: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[give] target=0x{target_guid:08X} item=0x{item_guid:08X} amount={amount}",
            ));
        }
        SessionCommand::BuyFromVendor { vendor_guid, items } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                BuyActionData, GameAction, ItemProfileActionData,
            };
            let item_count = items.len();
            let log_preview: String = items
                .iter()
                .take(4)
                .map(|(g, a)| format!("0x{g:08X}×{a}"))
                .collect::<Vec<_>>()
                .join(",");
            let profiles: Vec<ItemProfileActionData> = items
                .into_iter()
                .map(|(guid, amount)| ItemProfileActionData {
                    amount,
                    object_guid: Guid(guid),
                })
                .collect();
            let action = GameAction::Buy(Box::new(BuyActionData {
                vendor_guid: Guid(vendor_guid),
                items: profiles,
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(Buy): {e}",
                "buy_from_vendor: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[buy] vendor=0x{vendor_guid:08X} count={item_count} items=[{log_preview}]",
            ));
        }
        SessionCommand::SellToVendor { vendor_guid, items } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, ItemProfileActionData, SellActionData,
            };
            let item_count = items.len();
            let log_preview: String = items
                .iter()
                .take(4)
                .map(|(g, a)| format!("0x{g:08X}×{a}"))
                .collect::<Vec<_>>()
                .join(",");
            let profiles: Vec<ItemProfileActionData> = items
                .into_iter()
                .map(|(guid, amount)| ItemProfileActionData {
                    amount,
                    object_guid: Guid(guid),
                })
                .collect();
            let action = GameAction::Sell(Box::new(SellActionData {
                vendor_guid: Guid(vendor_guid),
                items: profiles,
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(Sell): {e}",
                "sell_to_vendor: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[sell] vendor=0x{vendor_guid:08X} count={item_count} items=[{log_preview}]",
            ));
        }
        SessionCommand::OpenTrade { partner_guid } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, OpenTradeNegotiationsActionData,
            };
            let action = GameAction::OpenTradeNegotiations(Box::new(
                OpenTradeNegotiationsActionData {
                    trade_partner_guid: Guid(partner_guid),
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(OpenTrade): {e}",
                "open_trade: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[trade/open] partner=0x{partner_guid:08X}",
            ));
        }
        SessionCommand::CloseTrade => {
            use holtburger_protocol::messages::{
                CloseTradeNegotiationsActionData, GameAction,
            };
            let action = GameAction::CloseTradeNegotiations(Box::new(
                CloseTradeNegotiationsActionData {},
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(CloseTrade): {e}",
                "close_trade: {e}",
                LoopFlow::Exit
            );
            console_log_str("[trade/close]");
        }
        SessionCommand::AddToTrade {
            item_guid,
            trade_slot,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                AddToTradeActionData, GameAction,
            };
            let action = GameAction::AddToTrade(Box::new(AddToTradeActionData {
                item_guid: Guid(item_guid),
                trade_slot,
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(AddToTrade): {e}",
                "add_to_trade: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[trade/add] item=0x{item_guid:08X} slot={trade_slot}",
            ));
        }
        SessionCommand::AcceptTrade => {
            // ACE's HandleActionAcceptTrade primarily reads
            // who_accepted server-side; the 5 ancillary
            // fields exist for client-mirror bookkeeping.
            // Fill them from the live trade snapshot when
            // present, default to zeros pre-trade (ACE will
            // reject the action via TradeFailure).
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                AcceptTradeActionData, GameAction,
            };
            let (partner_guid, initiator_guid, trade_stamp,
                 initiator_accepts, partner_accepts) = world.borrow()
                .as_ref()
                .and_then(|w| w.trade.as_ref().map(|t| (
                    t.partner_guid,
                    t.initiator_guid,
                    t.trade_stamp,
                    u32::from(t.self_side.accepted),
                    u32::from(t.partner_side.accepted),
                )))
                .unwrap_or((
                    Guid(0),
                    Guid(0),
                    0.0,
                    0,
                    0,
                ));
            let action = GameAction::AcceptTrade(Box::new(AcceptTradeActionData {
                partner_guid,
                trade_stamp,
                trade_status: 1,
                initiator_guid,
                initiator_accepts,
                partner_accepts,
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(AcceptTrade): {e}",
                "accept_trade: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[trade/accept] partner=0x{:08X}",
                u32::from(partner_guid),
            ));
        }
        SessionCommand::DeclineTrade => {
            use holtburger_protocol::messages::{
                DeclineTradeActionData, GameAction,
            };
            let action = GameAction::DeclineTrade(Box::new(
                DeclineTradeActionData {},
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(DeclineTrade): {e}",
                "decline_trade: {e}",
                LoopFlow::Exit
            );
            console_log_str("[trade/decline]");
        }
        SessionCommand::ResetTrade => {
            use holtburger_protocol::messages::{
                GameAction, ResetTradeActionData,
            };
            let action = GameAction::ResetTrade(Box::new(
                ResetTradeActionData {},
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(ResetTrade): {e}",
                "reset_trade: {e}",
                LoopFlow::Exit
            );
            console_log_str("[trade/reset]");
        }
        SessionCommand::BookData { object_guid } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{BookDataActionData, GameAction};
            let action = GameAction::BookData(Box::new(BookDataActionData {
                object_guid: Guid(object_guid),
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(BookData): {e}",
                "book_data: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[book/data] guid=0x{object_guid:08X}",
            ));
        }
        SessionCommand::BookAddPage { object_guid } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{BookAddPageActionData, GameAction};
            let action = GameAction::BookAddPage(Box::new(BookAddPageActionData {
                object_guid: Guid(object_guid),
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(BookAddPage): {e}",
                "book_add_page: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[book/add-page] guid=0x{object_guid:08X}",
            ));
        }
        SessionCommand::BookModifyPage {
            object_guid,
            page_num,
            text,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                BookModifyPageActionData, GameAction,
            };
            let text_len = text.len();
            let action = GameAction::BookModifyPage(Box::new(
                BookModifyPageActionData {
                    object_guid: Guid(object_guid),
                    page_num,
                    text,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(BookModifyPage): {e}",
                "book_modify_page: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[book/modify-page] guid=0x{object_guid:08X} page={page_num} len={text_len}",
            ));
        }
        SessionCommand::BookDeletePage {
            object_guid,
            page_num,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                BookDeletePageActionData, GameAction,
            };
            let action = GameAction::BookDeletePage(Box::new(
                BookDeletePageActionData {
                    object_guid: Guid(object_guid),
                    page_num,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(BookDeletePage): {e}",
                "book_delete_page: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[book/delete-page] guid=0x{object_guid:08X} page={page_num}",
            ));
        }
        SessionCommand::BookPageData {
            object_guid,
            page_num,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{BookPageDataActionData, GameAction};
            let action = GameAction::BookPageData(Box::new(BookPageDataActionData {
                guid: Guid(object_guid),
                page_index: page_num,
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(BookPageData): {e}",
                "book_page_data: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[book/page-data] guid=0x{object_guid:08X} page={page_num}",
            ));
        }
        SessionCommand::SetInscription {
            object_guid,
            inscription,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, SetInscriptionActionData,
            };
            let insc_len = inscription.len();
            let action = GameAction::SetInscription(Box::new(
                SetInscriptionActionData {
                    object_guid: Guid(object_guid),
                    inscription,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(SetInscription): {e}",
                "set_inscription: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[inscription/set] guid=0x{object_guid:08X} len={insc_len}",
            ));
        }
        SessionCommand::WieldFromPack {
            item_guid,
            equip_mask,
        } => {
            // Wave-D4 (paperdoll): GetAndWieldItem (0x001A).
            // ACE: `{ u32 itemGuid, u32 equipMask }`. The
            // server pulls the item out of the player's pack
            // and wields it in the matching slot.
            use holtburger_common::Guid;
            use holtburger_protocol::messages::inventory::types::EquipMask;
            use holtburger_protocol::messages::{
                GameAction, GetAndWieldItemActionData,
                PutItemInContainerActionData,
            };
            // Retail parity: the client auto-unequips
            // conflicting items BEFORE GetAndWieldItem —
            // ACE Player_Inventory.cs:1873 ("Client will
            // automatically send any unequip
            // (PutItemInContainer) message before the
            // GetAndWield") and rejects with
            // InventoryServerSaveFailed when the client
            // skips it (slot occupied / weapon collision).
            // items-4 (2026-10-08): the conflict set lives in
            // `holtburger_world::equip::wield_unequip_conflicts`
            // — ACE CheckWeaponCollision for the HELD slots,
            // but a pure armor/clothing wear (retail
            // AutoWearIsLegal refuses, it never strips) and a
            // same-wcid ammo stack (retail AttemptMerge) move
            // nothing.
            if let Some(w) = world.borrow().as_ref() {
                use holtburger_common::properties::EquipMask as PropEquipMask;
                let requested =
                    PropEquipMask::from_bits_truncate(equip_mask);
                let to_unequip: Vec<u32> =
                    holtburger_world::equip::wield_unequip_conflicts(
                        w,
                        Guid(item_guid),
                        requested,
                    )
                    .into_iter()
                    .map(|g| g.0)
                    .collect();
                let pack_guid = w.player.guid.0;
                for g in to_unequip {
                    console_log_str(&format!(
                        "[paperdoll/wield] auto-unequip 0x{g:08X} → pack (slot conflict)",
                    ));
                    let act = GameAction::PutItemInContainer(
                        Box::new(PutItemInContainerActionData {
                            item_guid: Guid(g),
                            container_guid: Guid(pack_guid),
                            placement: 0,
                        }),
                    );
                    if let Err(e) = send_ordered!(movement, session, act)
                    {
                        log::warn!(
                            "recv_loop: wield auto-unequip: {e}"
                        );
                        break;
                    }
                }
            }
            let action = GameAction::GetAndWieldItem(Box::new(
                GetAndWieldItemActionData {
                    item_guid: Guid(item_guid),
                    equip_mask: EquipMask::from_bits_truncate(equip_mask),
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(GetAndWieldItem): {e}",
                "wield_from_pack: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[paperdoll/wield] item=0x{item_guid:08X} slot=0x{equip_mask:08X}",
            ));
        }
        SessionCommand::DropItem { item_guid } => {
            // Wave-D4 (paperdoll): DropItem (0x001B).
            // ACE: `{ u32 itemGuid }`. Server moves the item
            // from the player's possession to the world at
            // the player's feet, auto-unequipping if needed.
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                DropItemActionData, GameAction,
            };
            let action = GameAction::DropItem(Box::new(
                DropItemActionData {
                    item_guid: Guid(item_guid),
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(DropItem): {e}",
                "drop_item: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[paperdoll/drop] item=0x{item_guid:08X}",
            ));
        }
        SessionCommand::MoveItem {
            item_guid,
            container_guid,
            placement,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, PutItemInContainerActionData,
            };
            let action = GameAction::PutItemInContainer(Box::new(
                PutItemInContainerActionData {
                    item_guid: Guid(item_guid),
                    container_guid: Guid(container_guid),
                    placement,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(PutItemInContainer): {e}",
                "move_item: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[inventory/move] item=0x{item_guid:08X} container=0x{container_guid:08X} slot={placement}",
            ));
        }
        SessionCommand::UnwieldToPack { item_guid } => {
            // Wave A / PR2 (2026-06-06): resolve container_guid
            // to the local player's GUID, then issue the same
            // PutItemInContainer wire packet (0x0019) with
            // placement=0. ACE accepts the move and broadcasts
            // the WieldObject clear + PrivateUpdateProperty
            // events that drive the paperdoll detach.
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, PutItemInContainerActionData,
            };
            let world_guard = world.borrow();
            let Some(w) = world_guard.as_ref() else {
                console_log_str(
                    "[inventory/unwield] before WorldState ready — dropping",
                );
                return LoopFlow::Continue;
            };
            let player_guid_raw = u32::from(w.player.guid);
            if player_guid_raw == 0 {
                console_log_str(
                    "[inventory/unwield] player guid not yet resolved — dropping",
                );
                return LoopFlow::Continue;
            }
            drop(world_guard);
            let action = GameAction::PutItemInContainer(Box::new(
                PutItemInContainerActionData {
                    item_guid: Guid(item_guid),
                    container_guid: Guid(player_guid_raw),
                    placement: 0,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(PutItemInContainer/Unwield): {e}",
                "unwield_to_pack: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[inventory/unwield] item=0x{item_guid:08X} player=0x{player_guid_raw:08X}",
            ));
        }
        SessionCommand::SplitStackToWield {
            stack_guid,
            equip_mask,
            amount,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::inventory::types::EquipMask;
            use holtburger_protocol::messages::{
                GameAction, StackableSplitToWieldActionData,
            };
            let action = GameAction::StackableSplitToWield(Box::new(
                StackableSplitToWieldActionData {
                    stack_guid: Guid(stack_guid),
                    equip_mask: EquipMask::from_bits_truncate(equip_mask),
                    amount: amount as i32,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(StackableSplitToWield): {e}",
                "split_stack_to_wield: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[inventory/split-wield] stack=0x{stack_guid:08X} slot=0x{equip_mask:08X} amount={amount}",
            ));
        }
        SessionCommand::SplitStackToContainer {
            stack_guid,
            container_guid,
            placement,
            amount,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, StackableSplitToContainerActionData,
            };
            let action = GameAction::StackableSplitToContainer(Box::new(
                StackableSplitToContainerActionData {
                    stack_guid: Guid(stack_guid),
                    container_guid: Guid(container_guid),
                    place: placement as i32,
                    amount: amount as i32,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(StackableSplitToContainer): {e}",
                "split_stack_to_container: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[inventory/split-container] stack=0x{stack_guid:08X} container=0x{container_guid:08X} slot={placement} amount={amount}",
            ));
        }
        SessionCommand::SplitStackTo3D {
            stack_guid,
            amount,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, StackableSplitTo3DActionData,
            };
            let action = GameAction::StackableSplitTo3D(Box::new(
                StackableSplitTo3DActionData {
                    stack_guid: Guid(stack_guid),
                    amount: amount as i32,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(StackableSplitTo3D): {e}",
                "split_stack_to_3d: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[inventory/split-3d] stack=0x{stack_guid:08X} amount={amount}",
            ));
        }
        SessionCommand::MergeStacks {
            src_guid,
            dst_guid,
            amount,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, StackableMergeActionData,
            };
            let action = GameAction::StackableMerge(Box::new(
                StackableMergeActionData {
                    merge_from_guid: Guid(src_guid),
                    merge_to_guid: Guid(dst_guid),
                    amount: amount as i32,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(StackableMerge): {e}",
                "merge_stacks: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[inventory/merge] src=0x{src_guid:08X} dst=0x{dst_guid:08X} amount={amount}",
            ));
        }
        SessionCommand::AbandonContract { contract_id } => {
            // Wave F.5 (2026-05-27): AbandonContract
            // (0x0316). ACE:
            // `Player.HandleActionAbandonContract` →
            // `ContractManager.Abandon → Erase`. Server
            // broadcasts `SendClientContractTracker` with
            // `DeleteContract=true` so we don't optimistically
            // mutate `latest_contracts` here — the contract
            // panel waits for the server echo.
            use holtburger_protocol::messages::{
                AbandonContractActionData, GameAction,
            };
            let action = GameAction::AbandonContract(Box::new(
                AbandonContractActionData { contract_id },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(AbandonContract): {e}",
                "abandon_contract: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[contracts/abandon] contract_id={contract_id}",
            ));
        }
        _ => unreachable!("SessionCommand routed to the wrong handler module"),
    }
    LoopFlow::Continue
}
