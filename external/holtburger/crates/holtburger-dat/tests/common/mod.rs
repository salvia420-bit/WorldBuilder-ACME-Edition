use std::path::PathBuf;

pub mod motion_command_names;

pub fn get_portal_dat_path() -> Option<PathBuf> {
    holtburger_dat::utils::get_portal_dat_path()
}
