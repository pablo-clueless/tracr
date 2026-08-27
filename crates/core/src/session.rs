//! One run, end to end: agent bytes in, UI frames out.
//!
//! Every other module in this crate is a pure function of its input. This is
//! the one place that holds state across a whole run and decides *when* things
//! happen, which keeps the transport underneath it dumb — a socket loop only
//! has to call [`Session::feed`] and [`Session::tick`].
//!
//! # Connections are not agents
//!
//! A connection exists from the moment a socket opens; an [`Agent`] exists only
//! once its hello arrives, because an agent is defined by its label space and
//! there is no label space before the hello names one. Events arriving in
//! between cannot be translated, so they are counted and dropped rather than
//! folded into whatever agent happened to be there.
//!
//! # Why a tick, rather than emitting per event
//!
//! Agents send thousands of events a second and the UI can repaint sixty times
//! a second at best. Aggregating between ticks is not an optimisation, it is
//! what makes the graph readable: a frame carries "this edge moved to 40,000",
//! never forty thousand increments.

use std::collections::HashMap;

use crate::aggregate::{roll_up, DeltaTracker, Rollup, Totals};
use crate::emit::{encode_delta, encode_skeleton};
use crate::ingest::{Agent, Core};
use crate::skeleton::{node_kind, Skeleton};
use crate::wire::{decode_frame, Frame, FrameReader, WireError};

pub type ConnId = u32;

/// The UI degrades past a few thousand elements, so the daemon caps before it
/// sends rather than letting the renderer discover the limit on its own.
pub const DEFAULT_ELEMENT_CAP: usize = 2_000;

struct Connection {
    /// `None` until the hello arrives.
    agent: Option<Agent>,
    reader: FrameReader,
}

impl Connection {
    fn new() -> Self {
        Self {
            agent: None,
            reader: FrameReader::new(),
        }
    }
}

/// Everything that went wrong but did not stop the run. All first-class: a
/// silent parse failure looks exactly like an application that never ran.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SessionStats {
    /// Frames that were well-formed MessagePack but not a shape we define.
    pub malformed: u64,
    /// Frames tagged for something this build has never heard of. Expected:
    /// a newer agent against an older core.
    pub unknown: u64,
    /// Frames that arrived before the connection said hello.
    pub before_hello: u64,
    /// Frames accepted and folded in.
    pub accepted: u64,
}

pub struct Session {
    core: Core,
    skeleton: Skeleton,
    connections: HashMap<ConnId, Connection>,
    tracker: DeltaTracker,
    level: u8,
    element_cap: usize,
    stats: SessionStats,
    /// Counters as of the last frame sent, so a tick where only the dropped
    /// total moved still reaches the UI.
    sent_totals: Option<(Totals, u64)>,
}

impl Session {
    pub fn new(skeleton: Skeleton) -> Self {
        Self {
            core: Core::new(),
            skeleton,
            connections: HashMap::new(),
            tracker: DeltaTracker::new(),
            level: node_kind::FILE,
            element_cap: DEFAULT_ELEMENT_CAP,
            stats: SessionStats::default(),
            sent_totals: None,
        }
    }

    pub fn with_level(mut self, level: u8) -> Self {
        self.level = level;
        self
    }

    pub fn with_element_cap(mut self, cap: usize) -> Self {
        self.element_cap = cap;
        self
    }

    pub fn stats(&self) -> SessionStats {
        self.stats
    }

    pub fn core(&self) -> &Core {
        &self.core
    }

    pub fn level(&self) -> u8 {
        self.level
    }

    pub fn connect(&mut self, id: ConnId) {
        self.connections.insert(id, Connection::new());
    }

    /// Drops the connection's buffer and label space. The DAG keeps everything
    /// that connection contributed: provenance outlives the process that
    /// reported it, which is the point of a run-wide graph.
    pub fn disconnect(&mut self, id: ConnId) {
        self.connections.remove(&id);
    }

    pub fn connection_count(&self) -> usize {
        self.connections.len()
    }

    /// Feeds bytes from a stream transport, applying every frame they complete.
    ///
    /// A read boundary is not a frame boundary, so a call that completes nothing
    /// is normal and not an error.
    pub fn feed(&mut self, id: ConnId, bytes: &[u8]) {
        let Some(connection) = self.connections.get_mut(&id) else {
            return;
        };
        connection.reader.push(bytes);

        while let Some(payload) = connection.reader.next_payload() {
            let frame = decode_frame(&payload);
            Self::apply(&mut self.core, connection, &mut self.stats, frame);
        }
    }

    /// Feeds one complete frame, for a transport that already has message
    /// boundaries. A WebSocket message is exactly one frame, with no prefix.
    pub fn feed_frame(&mut self, id: ConnId, payload: &[u8]) {
        let Some(connection) = self.connections.get_mut(&id) else {
            return;
        };
        let frame = decode_frame(payload);
        Self::apply(&mut self.core, connection, &mut self.stats, frame);
    }

    /// Associated rather than a method so it can borrow one connection mutably
    /// while the rest of the session stays reachable.
    fn apply(
        core: &mut Core,
        connection: &mut Connection,
        stats: &mut SessionStats,
        frame: Result<Frame, WireError>,
    ) {
        let frame = match frame {
            Ok(frame) => frame,
            Err(WireError::UnknownTag(_)) => {
                stats.unknown += 1;
                return;
            }
            // Truncated is impossible from a length-prefixed payload and means
            // a genuinely short frame, so it lands with the other bad shapes.
            Err(WireError::Malformed(_) | WireError::Truncated) => {
                stats.malformed += 1;
                return;
            }
        };

        match (&mut connection.agent, frame) {
            (slot @ None, Frame::Hello(hello)) => {
                *slot = Some(Agent::new(hello));
                stats.accepted += 1;
            }
            (None, Frame::Batch { .. }) => stats.before_hello += 1,
            (Some(agent), frame) => {
                core.apply_frame(agent, frame);
                stats.accepted += 1;
            }
        }
    }

    /// The granularity the UI is rendering.
    ///
    /// Resets the delta tracker: edge ids at one level mean nothing at another,
    /// so what the UI has been told is void. The next tick resends in full.
    pub fn set_level(&mut self, level: u8) {
        if self.level != level {
            self.level = level;
            self.tracker.reset();
            self.sent_totals = None;
        }
    }

    /// What a UI client needs before any delta can mean anything.
    ///
    /// Resets the tracker for the same reason `set_level` does: a client that
    /// just took the skeleton has seen no counts, so the next tick must carry
    /// everything rather than only what moved since some earlier client.
    pub fn skeleton_frame(&mut self) -> String {
        self.tracker.reset();
        self.sent_totals = None;
        encode_skeleton(&self.skeleton)
    }

    /// Replaces the static topology, e.g. after a rebuild changed the code.
    /// The caller must send [`Session::skeleton_frame`] again.
    pub fn set_skeleton(&mut self, skeleton: Skeleton) {
        self.skeleton = skeleton;
        self.tracker.reset();
        self.sent_totals = None;
    }

    /// The current rollup, capped, without touching delta state.
    pub fn rollup(&self) -> Rollup {
        let mut rollup = roll_up(
            &self.skeleton,
            &self.core.flows(),
            &self.core.sinks(),
            self.level,
        );
        rollup.cap_edges(self.element_cap);
        rollup
    }

    /// One frame of change, or `None` when nothing moved.
    ///
    /// Returning `None` is the common case on an idle app, and it matters: a
    /// frame the UI does not need still costs it a parse, a store write, and a
    /// layout pass.
    pub fn tick(&mut self) -> Option<String> {
        let rollup = self.rollup();
        let totals = self.core.totals();
        let delta = self.tracker.diff(&rollup, totals);

        // The counters move independently of the graph: a run can drop events
        // or truncate chains during a tick where no edge count changed, and
        // that still has to reach the UI.
        let counters = (totals, delta.unresolved);
        let counters_moved = self.sent_totals != Some(counters);

        if delta.is_empty() && !counters_moved {
            return None;
        }

        self.sent_totals = Some(counters);
        Some(encode_delta(&delta))
    }
}
