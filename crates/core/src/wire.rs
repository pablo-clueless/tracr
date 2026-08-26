//! The agent -> core wire format.
//!
//! Frames are fixed-shape MessagePack arrays whose element 0 is a tag, decoded
//! positionally. Nothing here reads a map key: the shapes are known statically,
//! so decoding an event never allocates a string.
//!
//! Two transports share this format. A stream (unix socket, named pipe) prefixes
//! every frame with a 4-byte big-endian length, because TCP-like streams have no
//! message boundaries; a WebSocket carries one frame per message and needs no
//! prefix.

use std::io::Cursor;

use rmp::decode;

use crate::dag::{Label, SiteId};

/// Element 0 of a frame.
mod frame_type {
    pub const HELLO: u64 = 0;
    pub const BATCH: u64 = 1;
}

/// Element 0 of an event.
mod event_tag {
    pub const ORIGIN: u64 = 0;
    pub const COMBINE: u64 = 1;
    pub const FLOW: u64 = 2;
    pub const SINK: u64 = 3;
    pub const DROPPED: u64 = 4;
}

#[derive(Debug, PartialEq, Eq)]
pub struct Hello {
    pub protocol_version: u32,
    pub run_id: u32,
    pub proc_id: u32,
    pub language: String,
    pub platform: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    Origin {
        site: SiteId,
        label: Label,
        source_id: u32,
    },
    Combine {
        site: SiteId,
        label: Label,
        op: u8,
        parents: Vec<Label>,
    },
    Flow {
        from: SiteId,
        to: SiteId,
        label: Label,
    },
    Sink {
        site: SiteId,
        label: Label,
        sink_id: u32,
    },
    /// The agent's ring buffer overflowed. Never silently discarded: losing data
    /// is a first-class outcome and the UI has to be able to say so.
    Dropped { count: u64 },
}

#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    Hello(Hello),
    Batch { events: Vec<Event>, dropped: u64 },
}

#[derive(Debug, PartialEq, Eq)]
pub enum WireError {
    /// Ran out of bytes mid-frame.
    Truncated,
    /// Well-formed MessagePack, but not a shape the protocol defines.
    Malformed(&'static str),
    /// A tag this build does not know. Forward compatibility: a newer agent may
    /// send events an older core has never heard of.
    UnknownTag(u64),
}

type Result<T> = std::result::Result<T, WireError>;

fn malformed<T>(what: &'static str) -> Result<T> {
    Err(WireError::Malformed(what))
}

fn read_uint(cursor: &mut Cursor<&[u8]>) -> Result<u64> {
    decode::read_int(cursor).map_err(|_| WireError::Malformed("expected an unsigned integer"))
}

fn read_array_len(cursor: &mut Cursor<&[u8]>) -> Result<u32> {
    decode::read_array_len(cursor).map_err(|_| WireError::Malformed("expected an array"))
}

/// Reads the body straight out of the underlying slice.
///
/// Deliberately not `RmpRead::read_exact_buf`: that trait method resolves to a
/// different signature under rust-analyzer than under rustc, so the file
/// compiles clean while every editor shows a type error on it. Slicing the
/// cursor's buffer needs no trait in scope, allocates once instead of twice,
/// and does the bounds check explicitly.
fn read_str(cursor: &mut Cursor<&[u8]>) -> Result<String> {
    let len = decode::read_str_len(cursor).map_err(|_| WireError::Malformed("expected a string"))?
        as usize;

    let start = cursor.position() as usize;
    let end = start.checked_add(len).ok_or(WireError::Truncated)?;

    let buffer = *cursor.get_ref();
    if end > buffer.len() {
        return Err(WireError::Truncated);
    }

    let text = std::str::from_utf8(&buffer[start..end])
        .map_err(|_| WireError::Malformed("string was not utf-8"))?
        .to_owned();

    cursor.set_position(end as u64);
    Ok(text)
}

fn read_labels(cursor: &mut Cursor<&[u8]>) -> Result<Vec<Label>> {
    let len = read_array_len(cursor)?;
    let mut parents = Vec::with_capacity(len as usize);
    for _ in 0..len {
        parents.push(read_uint(cursor)? as Label);
    }
    Ok(parents)
}

fn decode_event(cursor: &mut Cursor<&[u8]>) -> Result<Event> {
    let len = read_array_len(cursor)?;
    if len == 0 {
        return malformed("event array was empty");
    }
    let tag = read_uint(cursor)?;

    // Arities are fixed, so a wrong one means the two sides disagree about the
    // protocol — worth failing loudly rather than reading past the event.
    let expect = |got: u32, want: u32| -> Result<()> {
        if got == want {
            Ok(())
        } else {
            malformed("event had the wrong number of fields")
        }
    };

    match tag {
        event_tag::ORIGIN => {
            expect(len, 4)?;
            Ok(Event::Origin {
                site: read_uint(cursor)? as SiteId,
                label: read_uint(cursor)? as Label,
                source_id: read_uint(cursor)? as u32,
            })
        }
        event_tag::COMBINE => {
            expect(len, 5)?;
            Ok(Event::Combine {
                site: read_uint(cursor)? as SiteId,
                label: read_uint(cursor)? as Label,
                op: read_uint(cursor)? as u8,
                parents: read_labels(cursor)?,
            })
        }
        event_tag::FLOW => {
            expect(len, 4)?;
            Ok(Event::Flow {
                from: read_uint(cursor)? as SiteId,
                to: read_uint(cursor)? as SiteId,
                label: read_uint(cursor)? as Label,
            })
        }
        event_tag::SINK => {
            expect(len, 4)?;
            Ok(Event::Sink {
                site: read_uint(cursor)? as SiteId,
                label: read_uint(cursor)? as Label,
                sink_id: read_uint(cursor)? as u32,
            })
        }
        event_tag::DROPPED => {
            expect(len, 2)?;
            Ok(Event::Dropped {
                count: read_uint(cursor)?,
            })
        }
        other => Err(WireError::UnknownTag(other)),
    }
}

/// Decodes one complete frame. The slice must hold exactly one frame's payload.
pub fn decode_frame(payload: &[u8]) -> Result<Frame> {
    let mut cursor = Cursor::new(payload);

    let len = read_array_len(&mut cursor)?;
    if len == 0 {
        return malformed("frame array was empty");
    }

    match read_uint(&mut cursor)? {
        frame_type::HELLO => {
            if len != 6 {
                return malformed("hello frame had the wrong number of fields");
            }
            Ok(Frame::Hello(Hello {
                protocol_version: read_uint(&mut cursor)? as u32,
                run_id: read_uint(&mut cursor)? as u32,
                proc_id: read_uint(&mut cursor)? as u32,
                language: read_str(&mut cursor)?,
                platform: read_str(&mut cursor)?,
            }))
        }
        frame_type::BATCH => {
            if len != 3 {
                return malformed("batch frame had the wrong number of fields");
            }
            let count = read_array_len(&mut cursor)?;
            let mut events = Vec::with_capacity(count as usize);
            for _ in 0..count {
                events.push(decode_event(&mut cursor)?);
            }
            Ok(Frame::Batch {
                events,
                dropped: read_uint(&mut cursor)?,
            })
        }
        other => Err(WireError::UnknownTag(other)),
    }
}

/// Length prefix on stream transports.
const PREFIX: usize = 4;

/// Reassembles length-prefixed frames from a byte stream.
///
/// A socket read boundary has nothing to do with a frame boundary: one read can
/// deliver half a frame, or three frames and a fragment. This buffers until a
/// frame is whole.
#[derive(Default)]
pub struct FrameReader {
    buffer: Vec<u8>,
}

impl FrameReader {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    /// How many bytes are buffered but not yet a complete frame.
    pub fn pending(&self) -> usize {
        self.buffer.len()
    }

    /// The next complete frame's payload, or None while one is still arriving.
    pub fn next_payload(&mut self) -> Option<Vec<u8>> {
        if self.buffer.len() < PREFIX {
            return None;
        }
        let len = u32::from_be_bytes([
            self.buffer[0],
            self.buffer[1],
            self.buffer[2],
            self.buffer[3],
        ]) as usize;

        if self.buffer.len() < PREFIX + len {
            return None;
        }

        let payload = self.buffer[PREFIX..PREFIX + len].to_vec();
        self.buffer.drain(..PREFIX + len);
        Some(payload)
    }
}
