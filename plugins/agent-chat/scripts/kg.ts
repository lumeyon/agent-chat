// kg.ts — per-edge knowledge graph for agent-chat conversations.
//
// Mirrors ruflo's knowledge architecture (`ruflo-knowledge-graph` plugin):
//   - Entities = nodes with typed kinds + 384-dim embeddings (Xenova/all-MiniLM-L6-v2)
//   - Relations = causal edges with direction, type, weight
//   - Hyperbolic embeddings = Poincaré-ball projection for hierarchy
//   - Pathfinder traversal = score = edge_weight * semantic_similarity
//
// Per-edge storage layout (under <conv>/<topology>/<edge>/kg/):
//   nodes.jsonl       — one JSON per node:
//                         {id, kind, source, archive_id?, section_idx,
//                          sha256, header, text_excerpt,
//                          eu_embedding[384], po_embedding[384]}
//   edges.jsonl       — one JSON per edge:
//                         {src, dst, relation, weight}
//   manifest.json     — metadata about the build
//   embeddings.db     — SQLite cache (sha256 → Float32) via persistent-cache
//
// Node kinds (start small, extend as agent-chat grows):
//   "section"  — a `## ` block in CONVO.md (live) or BODY.md (archived)
//   "archive"  — a leaf archive (synthesized from SUMMARY.md TL;DR)
//
// Edge relations (start small, mirroring ruflo's causal-edge model):
//   "temporal"    — section A immediately precedes section B in same source
//   "belongs-to"  — section is part of archive (child → parent)
//   "parent-of"   — archive parent → section child (used for hyperbolic projection)
//
// CLI:
//   bun kg.ts build [<edge>]            build/refresh KG for one edge or all
//   bun kg.ts query <edge> "<text>"     pathfinder query on the edge
//   bun kg.ts stats <edge>              counts + dimensions + last_built_at
//   bun kg.ts list                      list all edges with KG state
//
// Library API:
//   import { buildEdgeKG, queryEdgeKG, getEdgeStats } from "./kg.ts";

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  embed,
  embedBatch,
  cosineSimilarity,
  MODEL_ID,
  MODEL_DIM,
} from "./embed.ts";
import { batchEuclideanToPoincare, hyperbolicDistance } from "./lib/hyperbolic.ts";
import { PersistentEmbeddingCache } from "./lib/persistent-cache.ts";

// ─── Schema ─────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;
const POINCARE_CURVATURE = 1.0;       // matches ruflo's default
const SECTION_HEADER_RE = /^## /m;     // standard agent-chat section delimiter
const TEXT_EXCERPT_LEN = 280;          // chars stored in node for grep/preview

export interface KGNode {
  id: string;
  kind: "section" | "archive";
  source: "convo" | "archive";
  archive_id?: string;        // present for kind=section in archived BODY, and kind=archive
  section_idx?: number;       // present for kind=section
  sha256: string;
  header: string;             // first line of the section (## boss — ...)
  text_excerpt: string;       // first ~280 chars of body
  eu_embedding: number[];     // 384-dim Euclidean (L2-normalized)
  po_embedding: number[];     // 384-dim Poincaré (open ball, |x| < 1)
}

export interface KGEdge {
  src: string;
  dst: string;
  relation: "temporal" | "belongs-to" | "parent-of";
  weight: number;
}

export interface KGManifest {
  schema_version: number;
  edge_id: string;
  topology: string;
  model_id: string;
  model_dim: number;
  poincare_curvature: number;
  built_at: string;
  node_count: number;
  edge_count: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function defaultConvDir(): string {
  return process.env.AGENT_CHAT_CONVERSATIONS_DIR ??
    "/data/lumeyon/agent-chat/conversations";
}

/**
 * Parse a markdown file (CONVO.md or BODY.md) into ## sections.
 * Returns array of { header, body, idx } in order of appearance.
 * The header is the first line; body excludes the header.
 */
function parseSections(content: string): { header: string; body: string; idx: number }[] {
  // Split on a leading ## that opens a new section. We rejoin the heading
  // marker so each section starts with `## …`.
  const parts = content.split(/(?=^## )/m).filter((p) => p.trim().startsWith("## "));
  return parts.map((part, idx) => {
    const nl = part.indexOf("\n");
    const header = nl < 0 ? part.trim() : part.slice(0, nl).trim();
    const body = nl < 0 ? "" : part.slice(nl + 1).trim();
    return { header, body, idx };
  });
}

function nodeIdSection(source: "convo" | "archive", archiveId: string | null, idx: number, sha: string): string {
  const a = archiveId ?? "live";
  return `sec:${source}:${a}:${idx}:${sha.slice(0, 8)}`;
}
function nodeIdArchive(archiveId: string): string {
  return `arc:${archiveId}`;
}

interface EdgeDescriptor {
  topology: string;
  edgeId: string;
  edgeDir: string;       // <conv>/<topology>/<edgeId>
  kgDir: string;         // <conv>/<topology>/<edgeId>/kg
  convoPath: string;     // <conv>/<topology>/<edgeId>/CONVO.md
  archivesDir: string;   // <conv>/<topology>/<edgeId>/archives/leaf
}

function listEdges(convDir: string): EdgeDescriptor[] {
  const out: EdgeDescriptor[] = [];
  if (!fs.existsSync(convDir)) return out;
  for (const topo of fs.readdirSync(convDir)) {
    if (topo.startsWith(".") || topo === "spawns") continue;  // skip dotdirs and spawns/
    const topoDir = path.join(convDir, topo);
    if (!fs.statSync(topoDir).isDirectory()) continue;
    for (const edgeId of fs.readdirSync(topoDir)) {
      const edgeDir = path.join(topoDir, edgeId);
      if (!fs.statSync(edgeDir).isDirectory()) continue;
      const convoPath = path.join(edgeDir, "CONVO.md");
      if (!fs.existsSync(convoPath)) continue;
      out.push({
        topology: topo,
        edgeId,
        edgeDir,
        kgDir: path.join(edgeDir, "kg"),
        convoPath,
        archivesDir: path.join(edgeDir, "archives", "leaf"),
      });
    }
  }
  return out;
}

// ─── Build ──────────────────────────────────────────────────────────────

export async function buildEdgeKG(edge: EdgeDescriptor): Promise<KGManifest> {
  fs.mkdirSync(edge.kgDir, { recursive: true });

  const cache = new PersistentEmbeddingCache({
    dbPath: path.join(edge.kgDir, "embeddings.db"),
    maxSize: 50000,
    ttlMs: 365 * 24 * 60 * 60 * 1000, // 1 year
  });

  const nodes: KGNode[] = [];
  const edges: KGEdge[] = [];

  // ─── Collect raw sections from active CONVO.md ───
  const convoText = fs.readFileSync(edge.convoPath, "utf-8");
  const liveSections = parseSections(convoText);

  // ─── Collect raw sections from each leaf archive ───
  interface ArchiveEntry { id: string; sections: ReturnType<typeof parseSections>; tldr: string }
  const archives: ArchiveEntry[] = [];
  if (fs.existsSync(edge.archivesDir)) {
    for (const archiveId of fs.readdirSync(edge.archivesDir).sort()) {
      const archiveDir = path.join(edge.archivesDir, archiveId);
      const bodyPath = path.join(archiveDir, "BODY.md");
      const summaryPath = path.join(archiveDir, "SUMMARY.md");
      if (!fs.existsSync(bodyPath)) continue;
      const body = fs.readFileSync(bodyPath, "utf-8");
      const sections = parseSections(body);
      let tldr = "";
      if (fs.existsSync(summaryPath)) {
        const sum = fs.readFileSync(summaryPath, "utf-8");
        const m = sum.match(/## TL;DR\s*\n([^\n]+(?:\n(?!##)[^\n]*)*)/);
        if (m) tldr = m[1].trim();
      }
      archives.push({ id: archiveId, sections, tldr });
    }
  }

  // ─── Pass 1: collect texts + sha256s + cache lookups ───
  type Pending = {
    text: string;
    sha: string;
    nodeFactory: (eu: number[]) => Omit<KGNode, "po_embedding">;
  };
  const pending: Pending[] = [];

  for (const sec of liveSections) {
    const fullText = `${sec.header}\n${sec.body}`;
    const sha = sha256(fullText);
    pending.push({
      text: fullText,
      sha,
      nodeFactory: (eu) => ({
        id: nodeIdSection("convo", null, sec.idx, sha),
        kind: "section",
        source: "convo",
        section_idx: sec.idx,
        sha256: sha,
        header: sec.header,
        text_excerpt: sec.body.slice(0, TEXT_EXCERPT_LEN),
        eu_embedding: eu,
      }),
    });
  }

  for (const arc of archives) {
    // Archive node — text is the TL;DR (or first body section if no TL;DR)
    const archiveText = arc.tldr || arc.sections[0]?.body.slice(0, 500) || arc.id;
    const archiveSha = sha256(archiveText);
    pending.push({
      text: archiveText,
      sha: archiveSha,
      nodeFactory: (eu) => ({
        id: nodeIdArchive(arc.id),
        kind: "archive",
        source: "archive",
        archive_id: arc.id,
        sha256: archiveSha,
        header: `# Archive ${arc.id}`,
        text_excerpt: archiveText.slice(0, TEXT_EXCERPT_LEN),
        eu_embedding: eu,
      }),
    });
    // Section nodes within this archive
    for (const sec of arc.sections) {
      const fullText = `${sec.header}\n${sec.body}`;
      const sha = sha256(fullText);
      pending.push({
        text: fullText,
        sha,
        nodeFactory: (eu) => ({
          id: nodeIdSection("archive", arc.id, sec.idx, sha),
          kind: "section",
          source: "archive",
          archive_id: arc.id,
          section_idx: sec.idx,
          sha256: sha,
          header: sec.header,
          text_excerpt: sec.body.slice(0, TEXT_EXCERPT_LEN),
          eu_embedding: eu,
        }),
      });
    }
  }

  // ─── Pass 2: cache → embed misses ───
  const euEmbeddings = new Map<string, number[]>();
  const toEmbedTexts: string[] = [];
  const toEmbedShas: string[] = [];

  for (const p of pending) {
    if (euEmbeddings.has(p.sha)) continue;
    const cached = await cache.get(p.sha);
    if (cached) {
      euEmbeddings.set(p.sha, Array.from(cached));
    } else {
      toEmbedShas.push(p.sha);
      toEmbedTexts.push(p.text);
    }
  }

  if (toEmbedTexts.length > 0) {
    const BATCH = 16;
    for (let i = 0; i < toEmbedTexts.length; i += BATCH) {
      const batch = toEmbedTexts.slice(i, i + BATCH);
      const shas = toEmbedShas.slice(i, i + BATCH);
      const vecs = await embedBatch(batch);
      for (let j = 0; j < batch.length; j++) {
        const arr = Array.from(vecs[j]);
        euEmbeddings.set(shas[j], arr);
        await cache.set(shas[j], vecs[j]);
      }
    }
    await cache.flush();
  }

  // ─── Pass 3: hyperbolic projection (batch — matches ruflo's API) ───
  const allEu: Float32Array[] = [];
  const allShasOrdered: string[] = [];
  // Iterate in the order pending was built so the position-indexed
  // batchEuclideanToPoincare result aligns with our nodes.
  for (const p of pending) {
    const euArr = euEmbeddings.get(p.sha);
    if (!euArr) throw new Error(`missing embedding for sha ${p.sha}`);
    if (!allShasOrdered.includes(p.sha)) {
      allShasOrdered.push(p.sha);
      allEu.push(new Float32Array(euArr));
    }
  }
  // Note: batchEuclideanToPoincare in ruflo takes Float32Array[] and returns
  // Float32Array[] — let's verify the signature lazily.
  const allPo = batchEuclideanToPoincare(allEu, { curvature: POINCARE_CURVATURE });
  const poBySha = new Map<string, number[]>();
  for (let i = 0; i < allShasOrdered.length; i++) {
    poBySha.set(allShasOrdered[i], Array.from(allPo[i]));
  }

  // ─── Pass 4: materialize nodes ───
  const seenIds = new Set<string>();
  for (const p of pending) {
    const eu = euEmbeddings.get(p.sha)!;
    const partial = p.nodeFactory(eu);
    if (seenIds.has(partial.id)) continue;
    const po = poBySha.get(p.sha)!;
    nodes.push({ ...partial, po_embedding: po });
    seenIds.add(partial.id);
  }

  // ─── Pass 5: edges ───

  // (a) temporal edges within each source (live convo, then each archive)
  const liveSecNodes = nodes.filter((n) => n.kind === "section" && n.source === "convo");
  liveSecNodes.sort((a, b) => (a.section_idx ?? 0) - (b.section_idx ?? 0));
  for (let i = 0; i < liveSecNodes.length - 1; i++) {
    edges.push({
      src: liveSecNodes[i].id,
      dst: liveSecNodes[i + 1].id,
      relation: "temporal",
      weight: 1.0,
    });
  }
  // Group archive-section nodes by archive_id and chain temporally
  const byArc = new Map<string, KGNode[]>();
  for (const n of nodes) {
    if (n.kind === "section" && n.source === "archive" && n.archive_id) {
      const list = byArc.get(n.archive_id) ?? [];
      list.push(n);
      byArc.set(n.archive_id, list);
    }
  }
  for (const [, list] of byArc) {
    list.sort((a, b) => (a.section_idx ?? 0) - (b.section_idx ?? 0));
    for (let i = 0; i < list.length - 1; i++) {
      edges.push({
        src: list[i].id,
        dst: list[i + 1].id,
        relation: "temporal",
        weight: 1.0,
      });
    }
  }

  // (b) belongs-to + parent-of edges between archive nodes and their sections
  for (const arc of archives) {
    const archiveNode = nodes.find((n) => n.kind === "archive" && n.archive_id === arc.id);
    if (!archiveNode) continue;
    const sectionNodes = byArc.get(arc.id) ?? [];
    for (const sec of sectionNodes) {
      edges.push({
        src: sec.id,
        dst: archiveNode.id,
        relation: "belongs-to",
        weight: 1.0,
      });
      edges.push({
        src: archiveNode.id,
        dst: sec.id,
        relation: "parent-of",
        weight: 1.0,
      });
    }
  }

  // ─── Write outputs ───
  const nodesPath = path.join(edge.kgDir, "nodes.jsonl");
  const edgesPath = path.join(edge.kgDir, "edges.jsonl");
  const manifestPath = path.join(edge.kgDir, "manifest.json");

  const nodesContent = nodes.map((n) => JSON.stringify(n)).join("\n") + "\n";
  const edgesContent = edges.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(nodesPath, nodesContent);
  fs.writeFileSync(edgesPath, edgesContent);

  const manifest: KGManifest = {
    schema_version: SCHEMA_VERSION,
    edge_id: edge.edgeId,
    topology: edge.topology,
    model_id: MODEL_ID,
    model_dim: MODEL_DIM,
    poincare_curvature: POINCARE_CURVATURE,
    built_at: new Date().toISOString(),
    node_count: nodes.length,
    edge_count: edges.length,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  await cache.close();
  return manifest;
}

// ─── Query ──────────────────────────────────────────────────────────────

export interface QueryHit {
  id: string;
  kind: KGNode["kind"];
  archive_id?: string;
  header: string;
  text_excerpt: string;
  cosine: number;
  hyperbolic_distance_to_query: number;
  pathfinder_score: number;
}

export async function queryEdgeKG(
  edge: EdgeDescriptor,
  queryText: string,
  topK: number = 5,
): Promise<QueryHit[]> {
  const nodesPath = path.join(edge.kgDir, "nodes.jsonl");
  if (!fs.existsSync(nodesPath)) {
    throw new Error(`KG not built for ${edge.edgeId}; run \`kg build ${edge.edgeId}\` first`);
  }
  // Embed query in both Euclidean and Poincaré spaces
  const qEuVec = await embed(queryText);
  const qEu = new Float32Array(qEuVec);
  const [qPo] = batchEuclideanToPoincare([qEu], { curvature: POINCARE_CURVATURE });

  const lines = fs.readFileSync(nodesPath, "utf-8").split("\n").filter(Boolean);
  const hits: QueryHit[] = [];
  for (const line of lines) {
    const node: KGNode = JSON.parse(line);
    const eu = new Float32Array(node.eu_embedding);
    const po = new Float32Array(node.po_embedding);
    const cos = cosineSimilarity(qEu, eu);
    const hyp = hyperbolicDistance(qPo, po, { curvature: POINCARE_CURVATURE });
    // Pathfinder score = cos * 1/(1+hyp). Tunable later.
    const score = cos * (1 / (1 + hyp));
    hits.push({
      id: node.id,
      kind: node.kind,
      archive_id: node.archive_id,
      header: node.header,
      text_excerpt: node.text_excerpt,
      cosine: cos,
      hyperbolic_distance_to_query: hyp,
      pathfinder_score: score,
    });
  }
  hits.sort((a, b) => b.pathfinder_score - a.pathfinder_score);
  return hits.slice(0, topK);
}

// ─── Stats / list ───────────────────────────────────────────────────────

export function getEdgeStats(edge: EdgeDescriptor): KGManifest | null {
  const manifestPath = path.join(edge.kgDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as KGManifest;
}

// ─── CLI ────────────────────────────────────────────────────────────────

async function cmdBuild(args: string[]): Promise<void> {
  const convDir = defaultConvDir();
  const targetEdgeId = args[0];
  const all = listEdges(convDir);
  const edges = targetEdgeId ? all.filter((e) => e.edgeId === targetEdgeId) : all;
  if (edges.length === 0) {
    console.error(`no edges to build${targetEdgeId ? ` (filter: ${targetEdgeId})` : ""}`);
    process.exit(2);
  }
  for (const e of edges) {
    process.stdout.write(`[kg] building ${e.topology}/${e.edgeId} ... `);
    const t0 = Date.now();
    try {
      const m = await buildEdgeKG(e);
      const dt = Date.now() - t0;
      console.log(`✓ ${m.node_count} nodes, ${m.edge_count} edges (${dt}ms)`);
    } catch (err) {
      console.log(`✗ ${err}`);
    }
  }
}

async function cmdQuery(args: string[]): Promise<void> {
  const [edgeId, ...queryParts] = args;
  if (!edgeId || queryParts.length === 0) {
    console.error('usage: kg.ts query <edge> "<query text>"');
    process.exit(2);
  }
  const queryText = queryParts.join(" ");
  const all = listEdges(defaultConvDir());
  const edge = all.find((e) => e.edgeId === edgeId);
  if (!edge) {
    console.error(`edge not found: ${edgeId}`);
    process.exit(2);
  }
  const hits = await queryEdgeKG(edge, queryText, 10);
  console.log(JSON.stringify(hits, null, 2));
}

function cmdStats(args: string[]): void {
  const edgeId = args[0];
  const all = listEdges(defaultConvDir());
  if (edgeId) {
    const edge = all.find((e) => e.edgeId === edgeId);
    if (!edge) { console.error(`edge not found: ${edgeId}`); process.exit(2); }
    const m = getEdgeStats(edge);
    if (!m) { console.error(`KG not built for ${edgeId}`); process.exit(2); }
    console.log(JSON.stringify(m, null, 2));
  } else {
    for (const e of all) {
      const m = getEdgeStats(e);
      if (m) {
        console.log(`${e.topology}/${e.edgeId}: ${m.node_count} nodes, ${m.edge_count} edges, built ${m.built_at}`);
      } else {
        console.log(`${e.topology}/${e.edgeId}: (not built)`);
      }
    }
  }
}

function cmdList(): void {
  for (const e of listEdges(defaultConvDir())) {
    const built = fs.existsSync(path.join(e.kgDir, "manifest.json"));
    console.log(`${e.topology}/${e.edgeId}\t${built ? "built" : "(empty)"}`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "build": await cmdBuild(rest); break;
    case "query": await cmdQuery(rest); break;
    case "stats": cmdStats(rest); break;
    case "list":  cmdList(); break;
    case "-h":
    case "--help":
    case undefined:
      console.log(
        "kg.ts <build [edge] | query <edge> \"<text>\" | stats [edge] | list>",
      );
      process.exit(cmd ? 0 : 2);
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`kg.ts: ${err}`);
    process.exit(1);
  });
}
