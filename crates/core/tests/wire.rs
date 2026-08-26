//! Cross-language wire contract.
//!
//! Every fixture here was produced by the JavaScript agent's encoder
//! (`scripts/gen-wire-fixtures.mjs`), not by this crate. That is the whole
//! point: the encoder is hand-rolled in TypeScript and the decoder is `rmp` in
//! Rust, so the only test that means anything is one where the bytes actually
//! cross the boundary.
//!
//! Regenerate with `node scripts/gen-wire-fixtures.mjs` after a protocol change.

use tracr_core::wire::{decode_frame, Event, Frame, FrameReader, WireError};

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("missing fixture {}: {e}", path.display()))
}

#[test]
fn decodes_a_hello_frame_from_the_js_agent() {
    let Frame::Hello(hello) = decode_frame(&fixture("hello.bin")).expect("hello decodes") else {
        panic!("expected a hello frame");
    };

    assert_eq!(hello.protocol_version, 1);
    assert_eq!(hello.run_id, 0);
    assert_eq!(hello.proc_id, 4242);
    assert_eq!(hello.language, "javascript");
    assert_eq!(hello.platform, "node");
}

#[test]
fn decodes_every_event_kind() {
    let Frame::Batch { events, dropped } = decode_frame(&fixture("batch.bin")).expect("decodes")
    else {
        panic!("expected a batch frame");
    };

    assert_eq!(dropped, 0);
    assert_eq!(
        events,
        vec![
            Event::Origin {
                site: 1,
                label: 1,
                source_id: 0
            },
            // site 200 crosses into uint8.
            Event::Combine {
                site: 200,
                label: 2,
                op: 3,
                parents: vec![1]
            },
            // site 70000 crosses into uint32.
            Event::Combine {
                site: 70000,
                label: 3,
                op: 8,
                parents: vec![1, 2]
            },
            // label 65535 sits exactly on the uint16 boundary.
            Event::Flow {
                from: 5,
                to: 65535,
                label: 3
            },
            Event::Sink {
                site: 300,
                label: 3,
                sink_id: 7
            },
            Event::Dropped { count: 4294967295 },
        ]
    );
}

#[test]
fn decodes_a_batch_that_only_reports_loss() {
    // Drop-on-overflow is a first-class outcome; a batch with no events still
    // has to carry the count, or the UI silently understates what happened.
    let Frame::Batch { events, dropped } =
        decode_frame(&fixture("dropped-only.bin")).expect("decodes")
    else {
        panic!("expected a batch frame");
    };

    assert!(events.is_empty());
    assert_eq!(dropped, 9001);
}

#[test]
fn decodes_past_the_fixarray_boundary() {
    // 300 events forces an array16 header rather than fixarray.
    let Frame::Batch { events, .. } = decode_frame(&fixture("large.bin")).expect("decodes") else {
        panic!("expected a batch frame");
    };

    assert_eq!(events.len(), 300);
    assert_eq!(
        events[299],
        Event::Origin {
            site: 300,
            label: 300,
            source_id: 0
        }
    );
}

#[test]
fn reassembles_length_prefixed_frames() {
    let mut reader = FrameReader::new();
    reader.push(&fixture("stream.bin"));

    let first = decode_frame(&reader.next_payload().expect("first frame")).expect("decodes");
    let second = decode_frame(&reader.next_payload().expect("second frame")).expect("decodes");

    assert!(matches!(first, Frame::Hello(_)));
    assert!(matches!(second, Frame::Batch { .. }));
    assert_eq!(reader.next_payload(), None);
    assert_eq!(reader.pending(), 0);
}

#[test]
fn waits_for_a_frame_split_across_reads() {
    // A socket read boundary has nothing to do with a frame boundary.
    let bytes = fixture("stream.bin");
    let mut reader = FrameReader::new();

    for chunk in bytes.chunks(7) {
        reader.push(chunk);
    }

    let mut frames = 0;
    while let Some(payload) = reader.next_payload() {
        decode_frame(&payload).expect("each reassembled frame decodes");
        frames += 1;
    }
    assert_eq!(frames, 2);
}

#[test]
fn yields_nothing_from_a_partial_prefix() {
    let mut reader = FrameReader::new();
    reader.push(&[0, 0]);
    assert_eq!(reader.next_payload(), None);
    assert_eq!(reader.pending(), 2);
}

#[test]
fn reports_an_unknown_tag_rather_than_guessing() {
    // Forward compatibility: a newer agent may send events this build predates.
    // Misreading one as a known shape would corrupt the DAG silently.
    let unknown_event = [0x93, 0x01, 0x91, 0x92, 0x63, 0x01, 0x00];
    assert!(matches!(
        decode_frame(&unknown_event),
        Err(WireError::UnknownTag(0x63))
    ));
}

#[test]
fn rejects_a_truncated_frame() {
    let mut bytes = fixture("batch.bin");
    bytes.truncate(bytes.len() / 2);
    assert!(decode_frame(&bytes).is_err());
}

#[test]
fn rejects_an_event_with_the_wrong_arity() {
    // `[[0, 1, 1]]` — an origin missing its source id.
    let short_origin = [0x93, 0x01, 0x91, 0x93, 0x00, 0x01, 0x01, 0x00];
    assert!(matches!(
        decode_frame(&short_origin),
        Err(WireError::Malformed(_))
    ));
}
