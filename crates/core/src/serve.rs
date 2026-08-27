//! WebSocket transport.
//!
//! # Threads, not an async runtime
//!
//! A daemon serves one UI and a handful of agents. That is the concurrency of a
//! thread per connection, not of an event loop, and taking `tokio` for it would
//! pull a large tree into a binary shipped per-platform under
//! `optionalDependencies`. Synchronous `tungstenite` over `std::net` costs a
//! blocked thread per connection and nothing else.
//!
//! # One port, routed by path
//!
//! `/agent` sends events in; anything else subscribes to the graph. Browser
//! agents already speak WebSocket, so sharing the listener means one port to
//! configure and one thing to get past a dev server.
//!
//! # Locking
//!
//! Every thread contends on one [`Session`] mutex. That is deliberate: the
//! session is the run's single source of truth, and the work under the lock is
//! a fold or a rollup over structures bounded by the static topology. The lock
//! is never held across a socket write, because a slow reader would then stall
//! ingest for every agent.

use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tungstenite::handshake::server::{Request, Response};
use tungstenite::{accept_hdr, Message, WebSocket};

use crate::session::{ConnId, Session};
use crate::skeleton::NodeId;

/// Shared because agent threads write to the session while UI threads read it.
pub type Shared = Arc<Mutex<Session>>;

/// Path that marks a connection as an event source rather than a viewer.
pub const AGENT_PATH: &str = "/agent";

/// Frames per second sent to a viewer. The renderer cannot use more, and
/// holding events between ticks is what turns forty thousand increments into
/// one edge count.
pub const DEFAULT_TICK_HZ: u64 = 20;

static NEXT_CONN: AtomicU32 = AtomicU32::new(1);

pub fn shared(session: Session) -> Shared {
    Arc::new(Mutex::new(session))
}

/// Accepts forever. Returns only if the listener itself fails.
pub fn serve(session: Shared, addr: impl ToSocketAddrs) -> std::io::Result<()> {
    let listener = TcpListener::bind(addr)?;
    let tick = Duration::from_millis(1000 / DEFAULT_TICK_HZ);

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let session = Arc::clone(&session);
                // One bad connection must not take the daemon down with it.
                std::thread::spawn(move || handle(session, stream, tick));
            }
            Err(error) => eprintln!("tracr-core: accept failed: {error}"),
        }
    }
    Ok(())
}

/// The address a listener actually bound, for a caller that passed port 0.
pub fn bind(addr: impl ToSocketAddrs) -> std::io::Result<TcpListener> {
    TcpListener::bind(addr)
}

/// Serves an already-bound listener. Lets a test bind port 0 and learn the port
/// before anything connects.
pub fn serve_listener(session: Shared, listener: TcpListener, tick: Duration) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let session = Arc::clone(&session);
                std::thread::spawn(move || handle(session, stream, tick));
            }
            Err(error) => eprintln!("tracr-core: accept failed: {error}"),
        }
    }
}

// The handshake callback's `Result<Response, ErrorResponse>` is tungstenite's
// signature, not ours: the error variant is a whole HTTP response and there is
// nothing to box on our side of it. Runs once per connection, so the size costs
// nothing.
#[allow(clippy::result_large_err)]
fn handle(session: Shared, stream: TcpStream, tick: Duration) {
    let mut path = String::new();
    let socket = accept_hdr(stream, |request: &Request, response: Response| {
        path = request.uri().path().to_owned();
        Ok(response)
    });

    let Ok(socket) = socket else {
        return;
    };

    if path == AGENT_PATH {
        serve_agent(session, socket);
    } else {
        serve_viewer(session, socket, tick);
    }
}

fn serve_agent(session: Shared, mut socket: WebSocket<TcpStream>) {
    let id: ConnId = NEXT_CONN.fetch_add(1, Ordering::Relaxed);
    session.lock().unwrap().connect(id);

    loop {
        match socket.read() {
            // One WebSocket message is exactly one frame: the transport already
            // has message boundaries, so there is no length prefix to strip.
            Ok(Message::Binary(payload)) => {
                session.lock().unwrap().feed_frame(id, &payload);
            }
            Ok(Message::Close(_)) => break,
            // Text, ping and pong are not the event format. Ignored rather than
            // counted: they are transport chatter, not a protocol disagreement.
            Ok(_) => {}
            Err(_) => break,
        }
    }

    session.lock().unwrap().disconnect(id);
}

fn serve_viewer(session: Shared, mut socket: WebSocket<TcpStream>, tick: Duration) {
    let sub = session.lock().unwrap().subscribe();

    // Skeleton first: a delta names edge ids, which mean nothing without it.
    let skeleton = session.lock().unwrap().skeleton_frame(sub);
    if socket.send(Message::Text(skeleton.into())).is_err() {
        session.lock().unwrap().unsubscribe(sub);
        return;
    }

    // The read doubles as the clock. Without a timeout it would block forever
    // on a viewer that never speaks, which is every viewer.
    let _ = socket.get_ref().set_read_timeout(Some(tick));

    loop {
        match socket.read() {
            Ok(Message::Text(text)) => match parse_request(&text) {
                Some(ViewerRequest::Level(level)) => session.lock().unwrap().set_level(sub, level),
                Some(ViewerRequest::Chain(node)) => {
                    // Answered immediately rather than on the next tick: this is
                    // a reply to a click, and a delta's worth of latency on it
                    // would feel like the click did nothing.
                    let reply = {
                        let session = session.lock().unwrap();
                        session
                            .level(sub)
                            .and_then(|level| session.chain_frame(node, level))
                    };
                    if let Some(reply) = reply {
                        if socket.send(Message::Text(reply.into())).is_err() {
                            break;
                        }
                    }
                }
                None => {}
            },
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(error) if is_timeout(&error) => {}
            Err(_) => break,
        }

        // Locked to build the frame, released before the write: a viewer that
        // stops reading must not stall the agents feeding the session.
        let frame = session.lock().unwrap().tick(sub);
        if let Some(frame) = frame {
            if socket.send(Message::Text(frame.into())).is_err() {
                break;
            }
        }
    }

    session.lock().unwrap().unsubscribe(sub);
}

/// A read timeout is the normal path here, not a failure. Windows reports it as
/// `TimedOut` and Unix as `WouldBlock`, so both have to count.
fn is_timeout(error: &tungstenite::Error) -> bool {
    matches!(
        error,
        tungstenite::Error::Io(io)
            if io.kind() == ErrorKind::TimedOut || io.kind() == ErrorKind::WouldBlock
    )
}

/// What a viewer may ask for. Named for the sender to avoid colliding with
/// tungstenite's HTTP `Request` in the handshake above.
enum ViewerRequest {
    /// `{"level": 0 | 1 | 2}` — the granularity to render.
    Level(u8),
    /// `{"chain": <nodeId>}` — the derivation behind a node's sink hits.
    Chain(NodeId),
}

/// Anything unrecognised is ignored rather than closing the connection — a
/// newer UI against an older daemon should degrade, not disconnect.
fn parse_request(text: &str) -> Option<ViewerRequest> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;

    if let Some(level) = value.get("level").and_then(serde_json::Value::as_u64) {
        return u8::try_from(level).ok().map(ViewerRequest::Level);
    }
    if let Some(node) = value.get("chain").and_then(serde_json::Value::as_u64) {
        return u32::try_from(node).ok().map(ViewerRequest::Chain);
    }
    None
}
