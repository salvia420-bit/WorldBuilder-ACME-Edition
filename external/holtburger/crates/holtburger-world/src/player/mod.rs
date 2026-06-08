pub mod magic;
pub mod movement;
pub mod mutations;
pub mod skill_formula;
pub mod stats_calc;
pub mod types;

pub use types::{
    MotionCommandCode, PlayerState, SkillBase, VitalBase, expand_motion_command_low16,
    is_action_motion_command, motion_allows_jump,
};

#[cfg(test)]
pub(crate) use crate::stats;
#[cfg(test)]
pub(crate) use holtburger_common::Guid;
#[cfg(test)]
pub(crate) use holtburger_protocol::messages::magic::Enchantment;

#[cfg(test)]
mod tests;
