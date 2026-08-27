//! The tracr core daemon.
//!
//! Owns the hash-consed provenance DAG, the static skeleton, and the
//! aggregation from DAG to function to module. Agents feed it MessagePack over
//! a unix socket (Node) or a WebSocket (browser); it emits the skeleton once to
//! the UI and then deltas.

pub mod aggregate;
pub mod dag;
pub mod emit;
pub mod ingest;
pub mod skeleton;
pub mod wire;

/// Reserved. Every operation must short-circuit on this before doing any work.
pub const UNTAINTED: u32 = 0;

/// Reserved. Tainted, but the derivation chain was capped before reaching here.
///
/// Distinct from [`UNTAINTED`] on purpose: "clean" and "dirty with no history"
/// are opposite answers, and collapsing them would let a sink claim safety it
/// never established. `u32::MAX` rather than a low index so reserving it costs
/// no renumbering — a DAG that large dies on memory long before it wraps.
pub const TRUNCATED: u32 = u32::MAX;
