//! Building the static topology from the side table the transform emits.
//!
//! `sites.json` is produced by the real Babel pass (`scripts/gen-site-fixture.mjs`),
//! not written by hand, for the same reason the wire fixtures are: the only
//! test worth having is one where the transform's actual output crosses into
//! the core.

use tracr_core::skeleton::{node_kind, SiteInfo, SiteTable, Skeleton};

fn site(site_id: u32, file: &str, line: u32, col: u32, fn_name: Option<&str>) -> SiteInfo {
    SiteInfo {
        site_id,
        file: file.into(),
        line,
        col,
        fn_name: fn_name.map(str::to_owned),
    }
}

fn fixture() -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("sites.json");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("missing fixture {}: {e}", path.display()))
}

#[test]
fn reads_the_table_the_babel_pass_actually_wrote() {
    let skeleton = Skeleton::from_site_table_json(&fixture()).expect("parses");

    // One file, two functions (helper, handler), five call sites.
    assert_eq!(skeleton.nodes().len(), 8);
    let files = skeleton
        .nodes()
        .iter()
        .filter(|n| n.kind == node_kind::FILE)
        .count();
    assert_eq!(files, 1);
}

#[test]
fn puts_a_sink_call_under_the_function_it_sits_in() {
    // Site 5 is the `query(...)` call inside `handler`. It used to record the
    // callee as its function name, which parented it to a `query` node that
    // src/routes.ts does not define.
    let skeleton = Skeleton::from_site_table_json(&fixture()).expect("parses");

    let function = skeleton
        .resolve(5, node_kind::FUNCTION)
        .and_then(|id| skeleton.node(id))
        .expect("site 5 resolves to a function");

    assert_eq!(function.label, "handler");
}

#[test]
fn every_site_in_the_table_resolves_to_a_file() {
    let table: SiteTable = serde_json::from_str(&fixture()).expect("parses");
    let skeleton = Skeleton::from_site_table(&table);

    for site in &table.sites {
        assert!(
            skeleton.resolve(site.site_id, node_kind::FILE).is_some(),
            "site {} resolved to nothing",
            site.site_id
        );
    }
}

#[test]
fn nests_a_call_site_under_its_function_under_its_file() {
    let skeleton = Skeleton::from_sites(&[site(1, "src/a.ts", 3, 4, Some("handler"))]);

    let call = skeleton.site_node(1).expect("call site");
    let function = skeleton.lift(call, node_kind::FUNCTION).expect("function");
    let file = skeleton.lift(call, node_kind::FILE).expect("file");

    assert_eq!(skeleton.node(function).unwrap().label, "handler");
    assert_eq!(skeleton.node(file).unwrap().label, "src/a.ts");
    assert_eq!(skeleton.node(function).unwrap().parent, Some(file));
}

#[test]
fn hangs_top_level_code_off_the_file_directly() {
    // There is no function frame for it to belong to, so inventing one would
    // put a node on screen that the source does not contain.
    let skeleton = Skeleton::from_sites(&[site(1, "src/a.ts", 1, 0, None)]);

    let call = skeleton.site_node(1).expect("call site");
    let parent = skeleton.node(call).unwrap().parent.expect("has a parent");

    assert_eq!(skeleton.node(parent).unwrap().kind, node_kind::FILE);
    assert_eq!(skeleton.lift(call, node_kind::FUNCTION), None);
}

#[test]
fn keeps_same_named_functions_in_different_files_apart() {
    let skeleton = Skeleton::from_sites(&[
        site(1, "src/a.ts", 1, 0, Some("handler")),
        site(2, "src/b.ts", 1, 0, Some("handler")),
    ]);

    let first = skeleton.resolve(1, node_kind::FUNCTION);
    let second = skeleton.resolve(2, node_kind::FUNCTION);

    assert_ne!(first, second);
    assert_ne!(
        skeleton.resolve(1, node_kind::FILE),
        skeleton.resolve(2, node_kind::FILE)
    );
}

#[test]
fn collapses_two_sites_in_one_function_onto_one_node() {
    let skeleton = Skeleton::from_sites(&[
        site(1, "src/a.ts", 3, 4, Some("handler")),
        site(2, "src/a.ts", 4, 8, Some("handler")),
    ]);

    assert_eq!(
        skeleton.resolve(1, node_kind::FUNCTION),
        skeleton.resolve(2, node_kind::FUNCTION)
    );
    // One file, one function, two call sites.
    assert_eq!(skeleton.nodes().len(), 4);
}

#[test]
fn assigns_the_same_ids_every_time() {
    // A viewer's deltas are keyed on these ids. If a restart renumbered them,
    // a reconnecting UI would apply counts to the wrong edges.
    let sites = [
        site(2, "src/b.ts", 1, 0, Some("second")),
        site(1, "src/a.ts", 1, 0, Some("first")),
    ];

    let once = Skeleton::from_sites(&sites);
    let twice = Skeleton::from_sites(&sites);

    assert_eq!(once.nodes(), twice.nodes());
}

#[test]
fn does_not_depend_on_the_order_sites_arrive_in() {
    let forward = [
        site(1, "src/a.ts", 1, 0, Some("first")),
        site(2, "src/b.ts", 1, 0, Some("second")),
    ];
    let reversed = [forward[1].clone(), forward[0].clone()];

    assert_eq!(
        Skeleton::from_sites(&forward).nodes(),
        Skeleton::from_sites(&reversed).nodes()
    );
}

#[test]
fn declares_no_edges_it_cannot_justify() {
    // The table records where code is, never what calls what. Every observed
    // crossing therefore arrives as `unmapped`, which is accurate: the parse
    // made no prediction to contradict.
    let skeleton = Skeleton::from_site_table_json(&fixture()).expect("parses");

    assert!(skeleton.edges().is_empty());
}

#[test]
fn an_empty_table_is_an_empty_graph_not_an_error() {
    let skeleton = Skeleton::from_site_table_json(r#"{"runId":0,"sites":[]}"#).expect("parses");

    assert!(skeleton.is_empty());
}

#[test]
fn reports_a_table_it_cannot_read_rather_than_guessing() {
    assert!(Skeleton::from_site_table_json("not json").is_err());
}
