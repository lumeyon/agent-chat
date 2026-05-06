// embed.ts — vectorize text using the same ONNX model ruflo uses for its
// knowledge graph + RAG memory: Xenova/all-MiniLM-L6-v2 (384 dimensions).
//
// This is the foundation for agent-chat's per-edge knowledge graph. Every
// archive (and ultimately every CONVO.md section) gets a 384-dim embedding
// stored alongside it. Downstream code (kg-build, semantic-recall) uses
// these vectors for similarity search, causal-edge weighting, and
// pathfinder-style traversal across an edge's history.
//
// Why this model:
// - Matches ruflo's @claude-flow/embeddings choice (drop-in compatibility
//   if we ever want to bridge into AgentDB)
// - Pure JS via @xenova/transformers; ONNX runtime ships as WASM, no
//   native deps to manage across user platforms
// - 384 dims is a good size/quality tradeoff for short conversational
//   sections (much cheaper than 768/1024 OpenAI dims, plenty signal)
// - First call downloads the model (~25MB ONNX + tokenizer) from
//   huggingface.co into ~/.cache/huggingface; subsequent calls are
//   purely local
//
// Performance budget (on this host, ad-hoc):
//   first-load:   3-8s (one-time model download + WASM init)
//   warm-call:    50-150ms per text (single)
//   batch of 10:  ~300ms (transformers.js batches internally)
//
// CLI:
//   bun embed.ts text "<text>"           # one-shot embed, prints float32 array
//   bun embed.ts file <path>             # embed file content as one block
//   bun embed.ts sections <CONVO.md>     # embed each `## ` section, JSONL
//   bun embed.ts dim                     # print the model dim (384)
//
// Library API (used by other scripts):
//   import { embed, embedSection, MODEL_ID, MODEL_DIM } from "./embed.ts";

import * as fs from "node:fs";
import { pipeline, env } from "@xenova/transformers";

export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const MODEL_DIM = 384;

// Disable transformers.js' built-in cache misuse warnings; we're fine with
// the default ~/.cache/huggingface location.
env.allowRemoteModels = true;

let _pipelinePromise: Promise<any> | null = null;

async function getPipeline(): Promise<any> {
  if (!_pipelinePromise) {
    _pipelinePromise = pipeline("feature-extraction", MODEL_ID, {
      // Quantized model is significantly smaller / faster with
      // negligible quality loss for similarity tasks.
      quantized: true,
    });
  }
  return _pipelinePromise;
}

/**
 * Embed a single text string. Returns a 384-dim Float32Array (mean-pooled,
 * L2-normalized — the standard pattern for sentence-similarity).
 */
export async function embed(text: string): Promise<Float32Array> {
  const pipe = await getPipeline();
  const output = await pipe(text, { pooling: "mean", normalize: true });
  // output is a Tensor; .data is a Float32Array of shape [dim]
  return output.data as Float32Array;
}

/**
 * Embed many texts in one batch. Returns an array of Float32Arrays, one
 * per input.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const pipe = await getPipeline();
  const output = await pipe(texts, { pooling: "mean", normalize: true });
  // Multi-input tensors come back as a single tensor of shape [n, dim]
  // We split them into individual Float32Arrays.
  const flat = output.data as Float32Array;
  const n = texts.length;
  if (flat.length !== n * MODEL_DIM) {
    throw new Error(
      `embedBatch shape mismatch: got ${flat.length} values, expected ${n} x ${MODEL_DIM}`,
    );
  }
  const result: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    result.push(flat.slice(i * MODEL_DIM, (i + 1) * MODEL_DIM));
  }
  return result;
}

// ─── Similarity primitives ──────────────────────────────────────────────
//
// Mirrors @claude-flow/embeddings (ruflo) so anything bridged in/out
// of AgentDB-shaped code uses identical semantics. Same naming,
// same return ranges:
//   cosineSimilarity:    [-1, 1]   (1 = identical, 0 = orthogonal, -1 = opposite)
//   euclideanDistance:   [0, ∞)    (0 = identical)
//   dotProduct:          [-∞, ∞]   (for unit vectors: same as cosine)
//
// computeSimilarity is the dispatcher; default metric is cosine.

export type SimilarityMetric = "cosine" | "euclidean" | "dot";

export interface SimilarityResult {
  metric: SimilarityMetric;
  score: number;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error("dim mismatch");
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function euclideanDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error("dim mismatch");
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error("dim mismatch");
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function computeSimilarity(
  a: Float32Array,
  b: Float32Array,
  metric: SimilarityMetric = "cosine",
): SimilarityResult {
  if (metric === "cosine") return { metric, score: cosineSimilarity(a, b) };
  if (metric === "euclidean") {
    // Map distance to a [0, 1] similarity score: score = 1 / (1 + dist).
    // Identical vectors → 1.0; matches ruflo's transform exactly.
    const dist = euclideanDistance(a, b);
    return { metric, score: 1 / (1 + dist) };
  }
  if (metric === "dot") return { metric, score: dotProduct(a, b) };
  throw new Error(`unknown metric: ${metric}`);
}

/** @deprecated Use cosineSimilarity. Kept for back-compat with stop-hook. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  return cosineSimilarity(a, b);
}

// ─── CLI ────────────────────────────────────────────────────────────────

async function cliText(text: string): Promise<void> {
  const v = await embed(text);
  console.log(JSON.stringify(Array.from(v)));
}

async function cliFile(path: string): Promise<void> {
  const text = fs.readFileSync(path, "utf-8");
  const v = await embed(text);
  console.log(JSON.stringify(Array.from(v)));
}

async function cliSections(path: string): Promise<void> {
  const text = fs.readFileSync(path, "utf-8");
  // Split on the standard agent-chat section separator: blank line + `---` + blank line.
  // Each section starts with `## <agent>` and ends before the next `---`.
  const sections = text
    .split(/\n---\n/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("## "));
  if (sections.length === 0) {
    console.error("no `## ` sections found");
    process.exit(2);
  }
  // Embed in batches of 16 to keep memory reasonable on long files.
  const BATCH = 16;
  for (let i = 0; i < sections.length; i += BATCH) {
    const batch = sections.slice(i, i + BATCH);
    const vecs = await embedBatch(batch);
    for (let j = 0; j < batch.length; j++) {
      const header = batch[j].split("\n", 1)[0];
      const out = {
        idx: i + j,
        header,
        len: batch[j].length,
        embedding: Array.from(vecs[j]),
      };
      console.log(JSON.stringify(out));
    }
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "text") {
    if (!rest[0]) { console.error("usage: embed.ts text <text>"); process.exit(2); }
    await cliText(rest.join(" "));
  } else if (cmd === "file") {
    if (!rest[0]) { console.error("usage: embed.ts file <path>"); process.exit(2); }
    await cliFile(rest[0]);
  } else if (cmd === "sections") {
    if (!rest[0]) { console.error("usage: embed.ts sections <CONVO.md>"); process.exit(2); }
    await cliSections(rest[0]);
  } else if (cmd === "dim") {
    console.log(MODEL_DIM);
  } else {
    console.error(
      "usage: embed.ts <text <text> | file <path> | sections <CONVO.md> | dim>",
    );
    process.exit(2);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`embed.ts: ${err}`);
    process.exit(1);
  });
}
