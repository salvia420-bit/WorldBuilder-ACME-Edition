//! Chess minigame GameEvents (the in-world drudge-chess board) — S2C.
//!
//! SG-C1a (2026-06-09): decode + pack only. The board is sent to the
//! player(s) at a chess board as ordered GameEvents; without these arms the
//! whole minigame is dead client-side (the recv loop logs "Unknown GameEvent
//! Opcode"). SG-C1b wires the wasm client-event + a minimal JS board plugin.
//!
//! Wire formats locked against ACE source:
//!   - `Source/ACE.Server/Network/GameEvent/Events/GameEvent{JoinGameResponse,
//!     MoveResponse,OpponentTurn,OpponentStalemate,GameOver}.cs`
//!   - `Source/ACE.Server/Network/Structure/ChessMoveData.cs`
//!     (`ChestMoveDataExtensions.Write`)
//!   - `Source/ACE.Server/Entity/Chess/ChessPieceCoord.cs`
//!     (`ChessPieceCoordExtensions.Write`)
//!   - opcodes from `GameEventType.cs`: JoinGameResponse=0x0281,
//!     MoveResponse=0x0283, OpponentTurn=0x0284, OpponentStalemate=0x0285,
//!     GameOver=0x028C.

use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};
use holtburger_common::Guid;

/// `ChessMoveType` raw i32 values (`ACE.Entity/Enum/ChessMoveType.cs`) — the
/// discriminator `ChessMoveData` switches on for its type-selected tail.
pub mod chess_move_type {
    pub const INVALID: i32 = 0;
    pub const PASS: i32 = 1;
    pub const RESIGN: i32 = 2;
    pub const STALEMATE: i32 = 3;
    pub const GRID: i32 = 4;
    pub const FROM_TO: i32 = 5;
    pub const SELECTED_PIECE: i32 = 6;
}

/// `ChessColor` raw i32 values (`ACE.Entity/Enum/ChessColor.cs`).
/// `None`/`-1` doubles as the JoinGameResponse failure marker.
pub mod chess_color {
    pub const NONE: i32 = -1;
    pub const WHITE: i32 = 0;
    pub const BLACK: i32 = 1;
}

/// A board square. Wire `[i32 x, i32 y]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ChessPieceCoord {
    pub x: i32,
    pub y: i32,
}

impl ProtocolUnpack for ChessPieceCoord {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let x = LittleEndian::read_i32(&data[*offset..*offset + 4]);
        let y = LittleEndian::read_i32(&data[*offset + 4..*offset + 8]);
        *offset += 8;
        Some(Self { x, y })
    }
}

impl ProtocolPack for ChessPieceCoord {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_i32::<LittleEndian>(self.x).unwrap();
        buf.write_i32::<LittleEndian>(self.y).unwrap();
    }
}

/// One chess move. Mirrors `ChessMoveData` (the C# class carries a `Color`
/// field but the writer's `(int)Color` line is COMMENTED OUT, so it is not
/// serialised here — `OpponentTurn` writes color separately, before the move).
///
/// Wire: `[i32 move_type, u32 player_guid]` then a `move_type`-selected tail:
///   - `Grid` (4):          `[ChessPieceCoord to]`
///   - `FromTo` (5):        `[ChessPieceCoord from, ChessPieceCoord to]`
///   - `SelectedPiece` (6): `[u32 piece_guid]`
///   - all others:          no tail
///
/// The tail fields not selected by `move_type` stay at `Default`, so a
/// pack→unpack round-trip is byte- and value-exact.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChessMoveData {
    pub move_type: i32,
    pub player_guid: Guid,
    /// Wire-present only for `SelectedPiece` (6).
    pub piece_guid: Guid,
    /// Wire-present only for `FromTo` (5).
    pub from: ChessPieceCoord,
    /// Wire-present for `Grid` (4) and `FromTo` (5).
    pub to: ChessPieceCoord,
}

impl ProtocolUnpack for ChessMoveData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let move_type = LittleEndian::read_i32(&data[*offset..*offset + 4]);
        *offset += 4;
        let player_guid = Guid::unpack(data, offset)?;
        let mut out = Self {
            move_type,
            player_guid,
            ..Default::default()
        };
        match move_type {
            chess_move_type::GRID => out.to = ChessPieceCoord::unpack(data, offset)?,
            chess_move_type::FROM_TO => {
                out.from = ChessPieceCoord::unpack(data, offset)?;
                out.to = ChessPieceCoord::unpack(data, offset)?;
            }
            chess_move_type::SELECTED_PIECE => out.piece_guid = Guid::unpack(data, offset)?,
            _ => {}
        }
        Some(out)
    }
}

impl ProtocolPack for ChessMoveData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_i32::<LittleEndian>(self.move_type).unwrap();
        self.player_guid.pack(buf);
        match self.move_type {
            chess_move_type::GRID => self.to.pack(buf),
            chess_move_type::FROM_TO => {
                self.from.pack(buf);
                self.to.pack(buf);
            }
            chess_move_type::SELECTED_PIECE => self.piece_guid.pack(buf),
            _ => {}
        }
    }
}

/// `GameEventJoinGameResponse` (0x0281). `[u32 board_guid, i32 color]`.
/// `color == -1` (`ChessColor::None`) indicates join failure; otherwise it is
/// the team (White=0 / Black=1) the player joined as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinGameResponseEventData {
    pub board_guid: Guid,
    pub color: i32,
}

impl ProtocolUnpack for JoinGameResponseEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let board_guid = Guid::unpack(data, offset)?;
        if *offset + 4 > data.len() {
            return None;
        }
        let color = LittleEndian::read_i32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self { board_guid, color })
    }
}

impl ProtocolPack for JoinGameResponseEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.board_guid.pack(buf);
        buf.write_i32::<LittleEndian>(self.color).unwrap();
    }
}

/// `GameEventMoveResponse` (0x0283). `[u32 board_guid, i32 result]`.
/// `result` is `ChessMoveResult` (positive = OK move + flags; negative = a
/// `BadMove*` rejection reason).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveResponseEventData {
    pub board_guid: Guid,
    pub result: i32,
}

impl ProtocolUnpack for MoveResponseEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let board_guid = Guid::unpack(data, offset)?;
        if *offset + 4 > data.len() {
            return None;
        }
        let result = LittleEndian::read_i32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self { board_guid, result })
    }
}

impl ProtocolPack for MoveResponseEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.board_guid.pack(buf);
        buf.write_i32::<LittleEndian>(self.result).unwrap();
    }
}

/// `GameEventOpponentTurn` (0x0284). `[u32 board_guid, i32 color,
/// ChessMoveData move_data]` — the move the opponent just made (color is the
/// opponent's team, written separately before the move per the C# writer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpponentTurnEventData {
    pub board_guid: Guid,
    pub color: i32,
    pub move_data: ChessMoveData,
}

impl ProtocolUnpack for OpponentTurnEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let board_guid = Guid::unpack(data, offset)?;
        if *offset + 4 > data.len() {
            return None;
        }
        let color = LittleEndian::read_i32(&data[*offset..*offset + 4]);
        *offset += 4;
        let move_data = ChessMoveData::unpack(data, offset)?;
        Some(Self {
            board_guid,
            color,
            move_data,
        })
    }
}

impl ProtocolPack for OpponentTurnEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.board_guid.pack(buf);
        buf.write_i32::<LittleEndian>(self.color).unwrap();
        self.move_data.pack(buf);
    }
}

/// `GameEventOpponentStalemate` (0x0285). `[u32 board_guid, i32 color,
/// i32 stalemate]`. `stalemate`: 1 = offering a stalemate, 0 = retracting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpponentStalemateEventData {
    pub board_guid: Guid,
    pub color: i32,
    pub stalemate: i32,
}

impl ProtocolUnpack for OpponentStalemateEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let board_guid = Guid::unpack(data, offset)?;
        if *offset + 8 > data.len() {
            return None;
        }
        let color = LittleEndian::read_i32(&data[*offset..*offset + 4]);
        let stalemate = LittleEndian::read_i32(&data[*offset + 4..*offset + 8]);
        *offset += 8;
        Some(Self {
            board_guid,
            color,
            stalemate,
        })
    }
}

impl ProtocolPack for OpponentStalemateEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.board_guid.pack(buf);
        buf.write_i32::<LittleEndian>(self.color).unwrap();
        buf.write_i32::<LittleEndian>(self.stalemate).unwrap();
    }
}

/// `GameEventGameOver` (0x028C). `[u32 board_guid, i32 team_winner]`.
/// `team_winner` is the winning `ChessColor` (or `-1` for a draw/no winner).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameOverEventData {
    pub board_guid: Guid,
    pub team_winner: i32,
}

impl ProtocolUnpack for GameOverEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let board_guid = Guid::unpack(data, offset)?;
        if *offset + 4 > data.len() {
            return None;
        }
        let team_winner = LittleEndian::read_i32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self {
            board_guid,
            team_winner,
        })
    }
}

impl ProtocolPack for GameOverEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.board_guid.pack(buf);
        buf.write_i32::<LittleEndian>(self.team_winner).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::game_event::{GameEvent, GameEventMessage};
    use crate::messages::game_message::GameMessage;
    use crate::traits::{ProtocolPack, ProtocolUnpack};

    fn round_trip(event: GameEvent) -> (GameMessage, GameMessage, usize) {
        let original = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid(0x5000_00AB),
            sequence: 0x42,
            event,
        }));
        let mut packed = Vec::new();
        original.pack(&mut packed);
        let mut offset = 0;
        let unpacked = GameMessage::unpack(&packed, &mut offset).unwrap();
        (original, unpacked, packed.len())
    }

    #[test]
    fn join_game_response_round_trip() {
        // Wire: 4 outer opcode + 4 target + 4 seq + 4 event opcode + 4 board + 4 color = 24.
        let (orig, back, len) = round_trip(GameEvent::JoinGameResponse(Box::new(
            JoinGameResponseEventData {
                board_guid: Guid(0x8000_0123),
                color: chess_color::BLACK,
            },
        )));
        assert_eq!(orig, back);
        assert_eq!(len, 24);
    }

    #[test]
    fn join_game_response_failure_round_trip() {
        let (orig, back, _) = round_trip(GameEvent::JoinGameResponse(Box::new(
            JoinGameResponseEventData {
                board_guid: Guid(0x8000_0123),
                color: chess_color::NONE, // -1 = join failed
            },
        )));
        assert_eq!(orig, back);
    }

    #[test]
    fn move_response_round_trip() {
        let (orig, back, len) = round_trip(GameEvent::MoveResponse(Box::new(
            MoveResponseEventData {
                board_guid: Guid(0x8000_0123),
                result: -3, // BadMoveNotYourTurn
            },
        )));
        assert_eq!(orig, back);
        assert_eq!(len, 24);
    }

    #[test]
    fn opponent_turn_fromto_round_trip() {
        let (orig, back, len) = round_trip(GameEvent::OpponentTurn(Box::new(
            OpponentTurnEventData {
                board_guid: Guid(0x8000_0123),
                color: chess_color::WHITE,
                move_data: ChessMoveData {
                    move_type: chess_move_type::FROM_TO,
                    player_guid: Guid(0x5000_00AB),
                    piece_guid: Guid::NULL,
                    from: ChessPieceCoord { x: 4, y: 1 },
                    to: ChessPieceCoord { x: 4, y: 3 },
                },
            },
        )));
        assert_eq!(orig, back);
        // 16 header + 4 board + 4 color + (4 type + 4 pguid + 8 from + 8 to) = 48.
        assert_eq!(len, 48);
    }

    #[test]
    fn opponent_turn_selected_piece_round_trip() {
        let (orig, back, len) = round_trip(GameEvent::OpponentTurn(Box::new(
            OpponentTurnEventData {
                board_guid: Guid(0x8000_0123),
                color: chess_color::BLACK,
                move_data: ChessMoveData {
                    move_type: chess_move_type::SELECTED_PIECE,
                    player_guid: Guid(0x5000_00AB),
                    piece_guid: Guid(0x8000_0456),
                    ..Default::default()
                },
            },
        )));
        assert_eq!(orig, back);
        // 16 header + 4 board + 4 color + (4 type + 4 pguid + 4 piece) = 36.
        assert_eq!(len, 36);
    }

    #[test]
    fn opponent_turn_pass_round_trip() {
        // A Pass (type 1) carries no tail — just type + player guid.
        let (orig, back, len) = round_trip(GameEvent::OpponentTurn(Box::new(
            OpponentTurnEventData {
                board_guid: Guid(0x8000_0123),
                color: chess_color::WHITE,
                move_data: ChessMoveData {
                    move_type: chess_move_type::PASS,
                    player_guid: Guid(0x5000_00AB),
                    ..Default::default()
                },
            },
        )));
        assert_eq!(orig, back);
        // 16 header + 4 board + 4 color + (4 type + 4 pguid) = 32.
        assert_eq!(len, 32);
    }

    #[test]
    fn opponent_stalemate_round_trip() {
        let (orig, back, len) = round_trip(GameEvent::OpponentStalemate(Box::new(
            OpponentStalemateEventData {
                board_guid: Guid(0x8000_0123),
                color: chess_color::WHITE,
                stalemate: 1,
            },
        )));
        assert_eq!(orig, back);
        // 16 header + 4 board + 4 color + 4 stalemate = 28.
        assert_eq!(len, 28);
    }

    #[test]
    fn game_over_round_trip() {
        let (orig, back, len) = round_trip(GameEvent::GameOver(Box::new(GameOverEventData {
            board_guid: Guid(0x8000_0123),
            team_winner: chess_color::BLACK,
        })));
        assert_eq!(orig, back);
        assert_eq!(len, 24);
    }
}
