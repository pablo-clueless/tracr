//! The tracr core daemon.
//!
//! Owns the hash-consed provenance DAG, the static skeleton, and the
//! aggregation from DAG to function to module. Agents feed it MessagePack over
//! a unix socket (Node) or a WebSocket (browser); it emits the skeleton once to
//! the UI and then deltas.

pub mod aggregate;
pub mod dag;
pub mod skeleton;

/// Reserved. Every operation must short-circuit on this before doing any work.
pub const UNTAINTED: u32 = 0;
