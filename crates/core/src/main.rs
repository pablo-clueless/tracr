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

    // Bound before it is announced. Printing first would claim the port even
    // when the bind failed, and anything waiting on that line — a supervisor, a
    // test — would go on to connect to nothing.
    let listener = match serve::bind(addr.as_str()) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("tracr-core: could not listen on {addr}: {error}");
            std::process::exit(1);
        }
    };

    eprintln!("tracr-core: listening on ws://{addr}");
    eprintln!("tracr-core:   agents -> ws://{addr}{AGENT_PATH}");
    eprintln!("tracr-core:   ui     -> ws://{addr}/");

    let tick = std::time::Duration::from_millis(1000 / serve::DEFAULT_TICK_HZ);
    serve::serve_listener(session, listener, tick);
}

fn load(path: &str) -> Result<Skeleton, Box<dyn std::error::Error>> {
    let json = std::fs::read_to_string(path)?;
    Ok(Skeleton::from_site_table_json(&json)?)
}
