//! The tracr daemon.
//!
//! Agents connect to `/agent` and send events; the UI connects to anything else
//! and receives the skeleton once, then deltas.
//!
//! ```text
//! tracr-core [addr] [site-table.json]
//! ```
//!
//! Without a site table every event names a site the skeleton has never heard
//! of, and the daemon reports that as `unresolved` rather than drawing a graph
//! it cannot justify.

use tracr_core::serve::{self, AGENT_PATH};
use tracr_core::session::Session;
use tracr_core::skeleton::Skeleton;

const DEFAULT_ADDR: &str = "127.0.0.1:9231";

fn main() {
    let mut args = std::env::args().skip(1);
    let addr = args.next().unwrap_or_else(|| DEFAULT_ADDR.to_owned());
    let table = args.next();

    let skeleton = match table.as_deref() {
        Some(path) => match load(path) {
            Ok(skeleton) => {
                eprintln!("tracr-core: {} nodes from {path}", skeleton.nodes().len());
                skeleton
            }
            Err(error) => {
                eprintln!("tracr-core: could not read {path}: {error}");
                std::process::exit(1);
            }
        },
        None => {
            eprintln!("tracr-core: no site table given, so every site is unresolved");
            Skeleton::default()
        }
    };

    let session = serve::shared(Session::new(skeleton));

    eprintln!("tracr-core: listening on ws://{addr}");
    eprintln!("tracr-core:   agents -> ws://{addr}{AGENT_PATH}");
    eprintln!("tracr-core:   ui     -> ws://{addr}/");

    if let Err(error) = serve::serve(session, addr.as_str()) {
        eprintln!("tracr-core: could not listen on {addr}: {error}");
        std::process::exit(1);
    }
}

fn load(path: &str) -> Result<Skeleton, Box<dyn std::error::Error>> {
    let json = std::fs::read_to_string(path)?;
    Ok(Skeleton::from_site_table_json(&json)?)
}
