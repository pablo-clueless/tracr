//! The tracr daemon.
//!
//! Transport is still to come. Until it lands this drives a [`Session`] over a
//! length-prefixed stream on stdin and writes UI frames to stdout, which is
//! enough to run the core against a real agent and read what it emits.

use std::io::{Read, Write};

use tracr_core::session::Session;
use tracr_core::skeleton::Skeleton;

/// Frames per second sent to the UI. The renderer cannot use more, and holding
/// events between ticks is what turns forty thousand increments into one edge
/// count.
const TICK_HZ: u64 = 20;

fn main() {
    // The static parse is not wired up yet, so every site resolves to nothing
    // and the rollup reports it as unresolved rather than pretending otherwise.
    let mut session = Session::new(Skeleton::default());
    session.connect(0);

    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    let mut buffer = [0u8; 64 * 1024];
    let tick = std::time::Duration::from_millis(1000 / TICK_HZ);
    let mut last = std::time::Instant::now();

    loop {
        match stdin.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => session.feed(0, &buffer[..read]),
            Err(error) => {
                eprintln!("tracr-core: read failed: {error}");
                break;
            }
        }

        if last.elapsed() >= tick {
            last = std::time::Instant::now();
            if let Some(frame) = session.tick() {
                if writeln!(stdout, "{frame}").is_err() {
                    break;
                }
            }
        }
    }

    // Whatever the last tick did not cover, plus the counters, so a short run
    // still reports what it saw.
    if let Some(frame) = session.tick() {
        let _ = writeln!(stdout, "{frame}");
    }

    let stats = session.stats();
    eprintln!(
        "tracr-core: {} frames accepted, {} malformed, {} unknown, {} before hello",
        stats.accepted, stats.malformed, stats.unknown, stats.before_hello
    );
}
