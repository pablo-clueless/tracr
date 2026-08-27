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
//! # One tracker per viewer
//!
//! Deltas are stateful: "what changed since you last heard" is a question about
//! a particular listener. A single shared tracker would let the first UI client
//! to tick consume the change and leave the second with nothing, so two open
//! tabs would each show half a graph. Every subscriber carries its own tracker
//! and its own granularity.
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

/// Identifies one UI viewer. Handed out by [`Session::subscribe`].
pub type SubId = u32;

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

/// One viewer's state. What it has been told, and at what granularity.
struct Subscriber {
    tracker: DeltaTracker,
    level: u8,
    /// Counters as of the last frame sent, so a tick where only the dropped
    /// total moved still reaches this viewer.
    sent_totals: Option<(Totals, u64)>,
}

impl Subscriber {
    fn new(level: u8) -> Self {
        Self {
            tracker: DeltaTracker::new(),
            level,
            sent_totals: None,
        }
    }

    /// Forgets everything this viewer has been told, so its next tick resends
    /// in full.
    fn rewind(&mut self) {
        self.tracker.reset();
        self.sent_totals = None;
    }
}

pub struct Session {
    core: Core,
    skeleton: Skeleton,
    connections: HashMap<ConnId, Connection>,
    subscribers: HashMap<SubId, Subscriber>,
    next_sub: SubId,
    default_level: u8,
    element_cap: usize,
    stats: SessionStats,
}

impl Session {
    pub fn new(skeleton: Skeleton) -> Self {
        Self {
            core: Core::new(),
            skeleton,
            connections: HashMap::new(),
            subscribers: HashMap::new(),
            next_sub: 0,
            default_level: node_kind::FILE,
            element_cap: DEFAULT_ELEMENT_CAP,
            stats: SessionStats::default(),
        }
    }

    /// Granularity new subscribers start at.
    pub fn with_level(mut self, level: u8) -> Self {
        self.default_level = level;
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

    /// Registers a viewer. Its first tick carries everything, because it has
    /// been told nothing yet.
    pub fn subscribe(&mut self) -> SubId {
        let id = self.next_sub;
        self.next_sub += 1;
        self.subscribers
            .insert(id, Subscriber::new(self.default_level));
        id
    }

    pub fn unsubscribe(&mut self, id: SubId) {
        self.subscribers.remove(&id);
    }

    pub fn subscriber_count(&self) -> usize {
        self.subscribers.len()
    }

    /// The granularity one viewer is rendering.
    pub fn level(&self, id: SubId) -> Option<u8> {
        self.subscribers.get(&id).map(|sub| sub.level)
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

    /// Changes one viewer's granularity.
    ///
    /// Rewinds that viewer: edge ids at one level mean nothing at another, so
    /// what it has been told is not merely stale, it describes a different
    /// graph. Other viewers are untouched.
    pub fn set_level(&mut self, id: SubId, level: u8) {
        if let Some(sub) = self.subscribers.get_mut(&id) {
            if sub.level != level {
                sub.level = level;
                sub.rewind();
            }
        }
    }

    /// What a UI client needs before any delta can mean anything.
    ///
    /// Rewinds that viewer for the same reason `set_level` does: a client
    /// holding a fresh skeleton has seen no counts, so its next tick must carry
    /// everything rather than only what moved since some earlier frame.
    pub fn skeleton_frame(&mut self, id: SubId) -> String {
        if let Some(sub) = self.subscribers.get_mut(&id) {
            sub.rewind();
        }
        encode_skeleton(&self.skeleton)
    }

    /// Replaces the static topology, e.g. after a rebuild changed the code.
    ///
    /// Rewinds every viewer and requires each to be sent a fresh skeleton: node
    /// and edge ids are only meaningful against the skeleton that defined them.
    pub fn set_skeleton(&mut self, skeleton: Skeleton) {
        self.skeleton = skeleton;
        for sub in self.subscribers.values_mut() {
            sub.rewind();
        }
    }

    /// The current rollup at `level`, capped, without touching delta state.
    pub fn rollup(&self, level: u8) -> Rollup {
        let mut rollup = roll_up(
            &self.skeleton,
            &self.core.flows(),
            &self.core.sinks(),
            level,
        );
        rollup.cap_edges(self.element_cap);
        rollup
    }

    /// One frame of change for one viewer, or `None` when nothing moved for it.
    ///
    /// Returning `None` is the common case on an idle app, and it matters: a
    /// frame the UI does not need still costs it a parse, a store write, and a
    /// layout pass.
    pub fn tick(&mut self, id: SubId) -> Option<String> {
        let level = self.subscribers.get(&id)?.level;
        let rollup = self.rollup(level);
        let totals = self.core.totals();

        let sub = self.subscribers.get_mut(&id)?;
        let delta = sub.tracker.diff(&rollup, totals);

        // The counters move independently of the graph: a run can drop events
        // or truncate chains during a tick where no edge count changed, and
        // that still has to reach the UI.
        let counters = (totals, delta.unresolved);
        let counters_moved = sub.sent_totals != Some(counters);

        if delta.is_empty() && !counters_moved {
            return None;
        }

        sub.sent_totals = Some(counters);
        Some(encode_delta(&delta))
    }
}
