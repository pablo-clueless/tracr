//! The static topology, parsed once before execution.
//!
//! Runtime is an overlay on this: edges light up and carry counts. A node per
//! call would make the graph unrenderable within seconds.
//!
//! # Why this owns the indexes
//!
//! Events carry a `SiteId` and nothing else — no file, no function name. Turning
//! a flow between two sites into an edge between two boxes on screen is a
//! lookup, and it happens once per distinct flow pair per emit. Building the
//! maps at load time keeps that off the hot path, and the skeleton is immutable
//! after construction, so there is nothing to keep in sync.
//!
//! # Containment is the rollup
//!
//! `parent` runs call site -> function -> file, so rolling a flow up to module
//! level is an ancestor walk rather than a separate aggregation index. The kinds
//! are ordered coarse-to-fine deliberately: a smaller `kind` is always further
//! up the chain, which is what makes [`Skeleton::lift`] a simple loop.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::Deserialize;

use crate::dag::SiteId;

pub type NodeId = u32;
pub type EdgeId = u32;

/// Granularity, coarse to fine. Mirrors `SkeletonNodeKind` in `@tracr/protocol`.
pub mod node_kind {
    pub const FILE: u8 = 0;
    pub const FUNCTION: u8 = 1;
    pub const CALL_SITE: u8 = 2;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkeletonNode {
    pub id: NodeId,
    pub kind: u8,
    pub label: String,
    pub parent: Option<NodeId>,
    /// Set on nodes an event can name. Files and functions without an
    /// instrumented site carry `None` and are reachable only as ancestors.
    pub site: Option<SiteId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SkeletonEdge {
    pub id: EdgeId,
    pub source: NodeId,
    pub target: NodeId,
}

#[derive(Default)]
pub struct Skeleton {
    nodes: Vec<SkeletonNode>,
    edges: Vec<SkeletonEdge>,
    by_id: HashMap<NodeId, usize>,
    by_site: HashMap<SiteId, NodeId>,
    by_endpoints: HashMap<(NodeId, NodeId), EdgeId>,
}

impl Skeleton {
    /// Builds the lookup tables once. Later duplicates lose: a malformed
    /// skeleton is a parser bug, and dropping the graph over it would be worse
    /// than rendering the first definition.
    pub fn new(nodes: Vec<SkeletonNode>, edges: Vec<SkeletonEdge>) -> Self {
        let mut by_id = HashMap::with_capacity(nodes.len());
        let mut by_site = HashMap::new();

        for (index, node) in nodes.iter().enumerate() {
            by_id.entry(node.id).or_insert(index);
            if let Some(site) = node.site {
                by_site.entry(site).or_insert(node.id);
            }
        }

        let mut by_endpoints = HashMap::with_capacity(edges.len());
        for edge in &edges {
            by_endpoints
                .entry((edge.source, edge.target))
                .or_insert(edge.id);
        }

        Self {
            nodes,
            edges,
            by_id,
            by_site,
            by_endpoints,
        }
    }

    pub fn nodes(&self) -> &[SkeletonNode] {
        &self.nodes
    }

    pub fn edges(&self) -> &[SkeletonEdge] {
        &self.edges
    }

    pub fn node(&self, id: NodeId) -> Option<&SkeletonNode> {
        self.by_id.get(&id).map(|&index| &self.nodes[index])
    }

    /// The node an event's `SiteId` names, before any rollup.
    pub fn site_node(&self, site: SiteId) -> Option<NodeId> {
        self.by_site.get(&site).copied()
    }

    pub fn parent(&self, id: NodeId) -> Option<NodeId> {
        self.node(id).and_then(|node| node.parent)
    }

    /// Walks up the containment chain to the first ancestor of `kind`.
    ///
    /// Returns `id` itself when it already matches. The walk is bounded by the
    /// node count so a skeleton whose parent pointers form a cycle degrades to
    /// "unresolved" instead of hanging the daemon.
    pub fn lift(&self, id: NodeId, kind: u8) -> Option<NodeId> {
        let mut current = id;
        for _ in 0..=self.nodes.len() {
            let node = self.node(current)?;
            if node.kind == kind {
                return Some(current);
            }
            current = node.parent?;
        }
        None
    }

    /// A site resolved all the way to the granularity the UI is rendering.
    pub fn resolve(&self, site: SiteId, kind: u8) -> Option<NodeId> {
        self.lift(self.site_node(site)?, kind)
    }

    /// The declared edge between two nodes, if the static parse found one.
    pub fn edge_between(&self, source: NodeId, target: NodeId) -> Option<EdgeId> {
        self.by_endpoints.get(&(source, target)).copied()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

/// One row of the side table a transform emits alongside its output.
///
/// Deliberately language-neutral: a file, a position, and the name of the
/// enclosing function is something a Go or C# frontend can produce as easily as
/// the Babel pass, which is what keeps the protocol from growing a JavaScript
/// shape.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiteInfo {
    pub site_id: SiteId,
    pub file: String,
    pub line: u32,
    pub col: u32,
    /// `None` for top-level code, which belongs to the file and no function.
    pub fn_name: Option<String>,
}

/// A call the parse found, before anything ran.
///
/// The static half of the graph: sites say where code is, this says what calls
/// what. Without it the skeleton declares no edges and every observed crossing
/// is reported as unpredicted, which drains that signal of meaning.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallEdge {
    /// Enclosing function, matching [`SiteInfo::fn_name`]. `None` at top level.
    pub from: Option<String>,
    pub to: String,
    /// Module the callee came from, or `None` if declared in `file`.
    pub module: Option<String>,
    pub file: String,
    pub line: u32,
    pub col: u32,
}

/// What one transform unit emits. Matches `SiteTable` in `@tracr/protocol`.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiteTable {
    pub run_id: u32,
    #[serde(default)]
    pub sites: Vec<SiteInfo>,
    /// Absent from an older transform, which simply yields a graph with no
    /// declared edges.
    #[serde(default)]
    pub calls: Vec<CallEdge>,
}

impl Skeleton {
    /// Builds the containment tree from the side table the transform already
    /// emits.
    ///
    /// # Why this needs no second parse
    ///
    /// Every site already carries its file and its enclosing function name, so
    /// file -> function -> call site is derivable from the table alone. A
    /// dedicated parse would re-derive what the transform pass computed while
    /// it was walking the tree anyway, and could disagree with it.
    ///
    /// # Edges
    ///
    /// Declared edges come from the transform's call list. A call whose target
    /// cannot be resolved to a function in the graph — a global, a bare module
    /// specifier, a method on a value — produces no edge, because an edge the
    /// parse could not verify is a claim on screen that nothing supports.
    ///
    /// Ids are assigned in a fixed order — files, then functions, then call
    /// sites, each sorted — so the same table always produces the same graph.
    /// A viewer's deltas are keyed on these ids and would otherwise scramble
    /// whenever the daemon restarted.
    pub fn from_sites(sites: &[SiteInfo]) -> Self {
        Self::build(sites, &[])
    }

    /// The containment tree plus the declared call edges.
    pub fn from_sites_and_calls(sites: &[SiteInfo], calls: &[CallEdge]) -> Self {
        Self::build(sites, calls)
    }

    fn build(sites: &[SiteInfo], calls: &[CallEdge]) -> Self {
        let mut files: BTreeMap<&str, NodeId> = BTreeMap::new();
        // Keyed on (file, function): the same name in two files is two
        // functions. Two same-named functions in one file do collapse, which is
        // the limit of what a name-only table can distinguish.
        let mut functions: BTreeMap<(&str, &str), NodeId> = BTreeMap::new();

        for site in sites {
            files.entry(&site.file).or_insert(0);
            if let Some(name) = site.fn_name.as_deref() {
                functions.entry((&site.file, name)).or_insert(0);
            }
        }

        let mut nodes = Vec::with_capacity(files.len() + functions.len() + sites.len());
        let mut next: NodeId = 1;

        for (file, id) in files.iter_mut() {
            *id = next;
            next += 1;
            nodes.push(SkeletonNode {
                id: *id,
                kind: node_kind::FILE,
                label: (*file).to_owned(),
                parent: None,
                site: None,
            });
        }

        for ((file, name), id) in functions.iter_mut() {
            *id = next;
            next += 1;
            nodes.push(SkeletonNode {
                id: *id,
                kind: node_kind::FUNCTION,
                label: (*name).to_owned(),
                parent: files.get(file).copied(),
                site: None,
            });
        }

        let mut ordered: Vec<&SiteInfo> = sites.iter().collect();
        ordered.sort_by_key(|site| site.site_id);

        for site in ordered {
            // Top-level code hangs off the file directly; there is no function
            // frame for it to belong to.
            let parent = match site.fn_name.as_deref() {
                Some(name) => functions.get(&(site.file.as_str(), name)).copied(),
                None => files.get(site.file.as_str()).copied(),
            };

            nodes.push(SkeletonNode {
                id: next,
                kind: node_kind::CALL_SITE,
                label: format!("{}:{}", site.line, site.col),
                parent,
                site: Some(site.site_id),
            });
            next += 1;
        }

        let edges = declared_edges(calls, &files, &functions, &mut next);
        Self::new(nodes, edges)
    }

    pub fn from_site_table(table: &SiteTable) -> Self {
        Self::from_sites_and_calls(&table.sites, &table.calls)
    }

    /// Reads a site table as the transform wrote it.
    pub fn from_site_table_json(json: &str) -> Result<Self, serde_json::Error> {
        let table: SiteTable = serde_json::from_str(json)?;
        Ok(Self::from_site_table(&table))
    }
}

/// Compares module specifiers and file paths without caring about separators or
/// extensions.
///
/// The transform emits what the source wrote — `./helper.js` for a file on disk
/// called `helper.ts` — and paths arrive with whichever slash the platform
/// uses. Matching literally would resolve almost nothing on Windows or in any
/// TypeScript project.
fn normalize(path: &str) -> String {
    let slashed = path.replace('\\', "/");
    let trimmed = slashed
        .strip_suffix(".tsx")
        .or_else(|| slashed.strip_suffix(".jsx"))
        .or_else(|| slashed.strip_suffix(".mjs"))
        .or_else(|| slashed.strip_suffix(".cjs"))
        .or_else(|| slashed.strip_suffix(".ts"))
        .or_else(|| slashed.strip_suffix(".js"))
        .unwrap_or(&slashed);

    // `/index` is how a directory import names its entry point.
    trimmed.strip_suffix("/index").unwrap_or(trimmed).to_owned()
}

/// Resolves a relative specifier against the importing file's directory.
fn resolve_relative(from_file: &str, specifier: &str) -> String {
    let base = normalize(from_file);
    let mut parts: Vec<&str> = base.split('/').collect();
    parts.pop(); // drop the file itself, leaving its directory

    let target = normalize(specifier);
    for segment in target.split('/') {
        match segment {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// Turns calls into edges between nodes that actually exist.
fn declared_edges(
    calls: &[CallEdge],
    files: &BTreeMap<&str, NodeId>,
    functions: &BTreeMap<(&str, &str), NodeId>,
    next: &mut NodeId,
) -> Vec<SkeletonEdge> {
    // Files are matched on their normalized form, so a specifier can find them.
    let by_normalized: BTreeMap<String, (&str, NodeId)> = files
        .iter()
        .map(|(&file, &id)| (normalize(file), (file, id)))
        .collect();

    let mut pairs: BTreeSet<(NodeId, NodeId)> = BTreeSet::new();

    for call in calls {
        // Which file holds the callee.
        let target_file = match call.module.as_deref() {
            // Declared here, or a global we will fail to find in a moment.
            None => normalize(&call.file),
            // A bare specifier is a package: never part of this graph.
            Some(module) if !module.starts_with('.') => continue,
            Some(module) => resolve_relative(&call.file, module),
        };

        let Some(&(target_path, target_file_id)) = by_normalized.get(&target_file) else {
            continue;
        };
        let Some(&callee) = functions.get(&(target_path, call.to.as_str())) else {
            continue;
        };

        let source_file = normalize(&call.file);
        let Some(&(source_path, source_file_id)) = by_normalized.get(&source_file) else {
            continue;
        };

        // Top-level code has no function frame, so the file itself is the caller.
        let caller = match call.from.as_deref() {
            Some(name) => functions
                .get(&(source_path, name))
                .copied()
                .unwrap_or(source_file_id),
            None => source_file_id,
        };

        if caller != callee {
            pairs.insert((caller, callee));
        }
        // The module-level view needs its own edge; a call inside one file is
        // internal there and contributes none.
        if source_file_id != target_file_id {
            pairs.insert((source_file_id, target_file_id));
        }
    }

    pairs
        .into_iter()
        .map(|(source, target)| {
            let id = *next;
            *next += 1;
            SkeletonEdge { id, source, target }
        })
        .collect()
}
