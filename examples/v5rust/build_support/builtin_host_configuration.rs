//! Reviewed data imports: only empty-input configuration captured by build.rs.
pub const MACROS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/cppgm-host-macros"));
pub const STRICT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/cppgm-host-strict"));
pub const INCLUDES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/cppgm-host-includes"));
pub const TARGET: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/cppgm-host-target"));
pub const VERSION: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/cppgm-host-version"));
pub const SEARCH: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/cppgm-host-search"));
pub const COMMAND: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/cppgm-host-command"));
pub const FLAGS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/cppgm-host-flags"));
