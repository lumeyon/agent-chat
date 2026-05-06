// embed.test.ts — mirrors ruflo's
// v3/@claude-flow/embeddings/src/__tests__/embedding-service.test.ts so
// agent-chat's embedding stack is verified to the same correctness bar
// that ruflo holds. Drop-in compatibility with ruflo's similarity
// semantics is the goal: anything that passes there should pass here.
//
// Categories tested:
//   1. Real ONNX embedding service (Xenova/all-MiniLM-L6-v2):
//      - dim, batch shape, deterministic same-text, L2-normalized output
//   2. Similarity primitives on hand-crafted unit vectors:
//      - cosine  identical=1 / orthogonal=0 / opposite=-1
//      - euclid  identical=0 / orthogonal=√2 / opposite=2
//      - dot     same as cosine for unit vectors
//   3. computeSimilarity dispatcher (default metric, all metrics)
//   4. Real-text semantic ordering: similar topics > unrelated topics
//
// Run: bun test tests/embed.test.ts

import { describe, it, expect } from "bun:test";
import {
  embed,
  embedBatch,
  cosineSimilarity,
  euclideanDistance,
  dotProduct,
  computeSimilarity,
  MODEL_DIM,
  MODEL_ID,
} from "../scripts/embed.ts";

// ─── 1. Real ONNX embedding service ─────────────────────────────────────

describe("ONNX embedding service (Xenova/all-MiniLM-L6-v2)", () => {
  it("uses the same model id ruflo uses", () => {
    expect(MODEL_ID).toBe("Xenova/all-MiniLM-L6-v2");
    expect(MODEL_DIM).toBe(384);
  });

  it("generates embeddings with correct dimensions", async () => {
    const v = await embed("Hello, world!");
    expect(v.length).toBe(384);
  }, 60_000); // first call may download model

  it("L2-normalizes output (unit length within float tolerance)", async () => {
    const v = await embed("test text");
    let sq = 0;
    for (let i = 0; i < v.length; i++) sq += v[i] * v[i];
    expect(Math.sqrt(sq)).toBeCloseTo(1.0, 3);
  });

  it("is deterministic for the same input", async () => {
    const v1 = await embed("identical input");
    const v2 = await embed("identical input");
    expect(Array.from(v1)).toEqual(Array.from(v2));
  });

  it("handles batch embeddings with correct count and per-item dim", async () => {
    const texts = ["first", "second", "third"];
    const vecs = await embedBatch(texts);
    expect(vecs.length).toBe(3);
    for (const v of vecs) expect(v.length).toBe(384);
  });

  it("batch is consistent with single (within float tolerance)", async () => {
    const text = "consistency check between batch and single calls";
    const single = await embed(text);
    const batch = await embedBatch([text]);
    // Allow tiny float drift from batched vs. single forward pass
    for (let i = 0; i < single.length; i++) {
      expect(batch[0][i]).toBeCloseTo(single[i], 4);
    }
  });
});

// ─── 2. Similarity primitives on hand-crafted unit vectors ──────────────
//
// These mirror ruflo's table exactly. Identical vector tests use the
// same vec1/vec2/vec3/vec4 layout so any correctness regression vs
// ruflo's semantics surfaces here.

describe("Similarity Functions", () => {
  const vec1 = new Float32Array([1, 0, 0]);
  const vec2 = new Float32Array([1, 0, 0]);
  const vec3 = new Float32Array([0, 1, 0]);
  const vec4 = new Float32Array([-1, 0, 0]);

  describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
      expect(cosineSimilarity(vec1, vec2)).toBeCloseTo(1);
    });
    it("returns 0 for orthogonal vectors", () => {
      expect(cosineSimilarity(vec1, vec3)).toBeCloseTo(0);
    });
    it("returns -1 for opposite vectors", () => {
      expect(cosineSimilarity(vec1, vec4)).toBeCloseTo(-1);
    });
    it("throws on dim mismatch", () => {
      const v = new Float32Array([1, 0]);
      expect(() => cosineSimilarity(vec1, v)).toThrow("dim mismatch");
    });
  });

  describe("euclideanDistance", () => {
    it("returns 0 for identical vectors", () => {
      expect(euclideanDistance(vec1, vec2)).toBeCloseTo(0);
    });
    it("returns sqrt(2) for unit orthogonal vectors", () => {
      expect(euclideanDistance(vec1, vec3)).toBeCloseTo(Math.sqrt(2));
    });
    it("returns 2 for opposite unit vectors", () => {
      expect(euclideanDistance(vec1, vec4)).toBeCloseTo(2);
    });
  });

  describe("dotProduct", () => {
    it("returns 1 for identical unit vectors", () => {
      expect(dotProduct(vec1, vec2)).toBeCloseTo(1);
    });
    it("returns 0 for orthogonal vectors", () => {
      expect(dotProduct(vec1, vec3)).toBeCloseTo(0);
    });
    it("returns -1 for opposite unit vectors", () => {
      expect(dotProduct(vec1, vec4)).toBeCloseTo(-1);
    });
  });

  describe("computeSimilarity", () => {
    it("uses cosine metric by default", () => {
      const r = computeSimilarity(vec1, vec2);
      expect(r.metric).toBe("cosine");
      expect(r.score).toBeCloseTo(1);
    });
    it("supports euclidean metric (mapped to 1/(1+d))", () => {
      const r = computeSimilarity(vec1, vec3, "euclidean");
      expect(r.metric).toBe("euclidean");
      expect(r.score).toBeCloseTo(1 / (1 + Math.sqrt(2)));
    });
    it("supports dot product metric", () => {
      const r = computeSimilarity(vec1, vec4, "dot");
      expect(r.metric).toBe("dot");
      expect(r.score).toBeCloseTo(-1);
    });
  });
});

// ─── 3. End-to-end semantic ordering ────────────────────────────────────
//
// Beyond mathematical correctness, verify the embedding model produces
// semantically meaningful clusters: paraphrases of the same idea should
// score higher than unrelated topics. This is the contract the per-edge
// knowledge graph relies on.

describe("Semantic ordering (real embeddings)", () => {
  const a = "the orchestrator polls firestore every 30 seconds for due scans";
  const b = "the scan-orchestrator checks firestore every half minute for scheduled scans";
  const c = "starter tier costs $29 per month and includes weekly scans";
  const d = "the cookie banner accept button does not respond to taps";

  it("near-paraphrases have cosine > 0.7", async () => {
    const [va, vb] = await embedBatch([a, b]);
    expect(cosineSimilarity(va, vb)).toBeGreaterThan(0.7);
  });

  it("unrelated topics have cosine < 0.5", async () => {
    const [va, vc, vd] = await embedBatch([a, c, d]);
    expect(cosineSimilarity(va, vc)).toBeLessThan(0.5);
    expect(cosineSimilarity(va, vd)).toBeLessThan(0.5);
  });

  it("similar > unrelated (ordinal ranking holds)", async () => {
    const [va, vb, vc, vd] = await embedBatch([a, b, c, d]);
    const sim_ab = cosineSimilarity(va, vb);
    const sim_ac = cosineSimilarity(va, vc);
    const sim_ad = cosineSimilarity(va, vd);
    // a is closest to b (paraphrase) and farther from c, d
    expect(sim_ab).toBeGreaterThan(sim_ac);
    expect(sim_ab).toBeGreaterThan(sim_ad);
  });
});
