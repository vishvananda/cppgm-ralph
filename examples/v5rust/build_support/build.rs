//! Reviewed scaffold: capture host configuration only, never compiler inputs.
#[path = "build_support/host_configuration.rs"]
mod host_configuration;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    host_configuration::capture()
}
