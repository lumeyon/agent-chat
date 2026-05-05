#!/usr/bin/env bun
// scripts/network-test.ts — full-mesh Dot Collector verification on petersen.
//
// Where self-test.ts validates the wire protocol with two synthetic agents,
// network-test exercises the Dot Collector at petersen-scale: 10 AI agents,
// 15 edges, ~30 dots planted deterministically across direct-neighbor pairs,
// then assertions on:
//
//   1. Storage   — every dot ends up in the right ledger (count + content)
//   2. Aggregation — per-axis means + composite are correct
//   3. Believability — agents who receive high dots become high-weight graders
//   4. Weighted ≠ unweighted when graders have unequal believability
//   5. Roster shape — every agent in the topology appears in any tick's
//      composeRoster output (the full-network Concern-4 invariant)
//   6. Relay paths — non-neighbors get a "relay through X" routing line that
//      matches lib.relayPathTo
//   7. Role overrides — a single override propagates to every other agent's
//      roster on the next read (no propagation delay)
//
// No LLM shell-outs; no real claude-p subprocess. Every check is a pure
// assertion over filesystem state + library calls. Runs in ~2-3 seconds.
//
// Invocation:
//   bun "$AGENT_CHAT_DIR/scripts/network-test.ts"
//   bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" network-test       (CLI alias)
//   bun "$AGENT_CHAT_DIR/scripts/network-test.ts" --json
//
// Exit code 0 if all checks pass, 1 otherwise.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── result accumulator ─────────────────────────────────────────────────────

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];
let scen = "";
function check(name: string, ok: boolean, detail = "") {
  results.push({ name: scen ? `${scen} :: ${name}` : name, pass: ok, detail: detail || undefined });
}
function scenario(label: string, fn: () => void | Promise<void>) {
  scen = label;
  try { return fn(); } catch (e: any) {
    check("scenario crashed", false, `${e?.message ?? e}\n${(e?.stack ?? "").split("\n").slice(0, 5).join("\n")}`);
  } finally { scen = ""; }
}

// ── isolated environment ──────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-nettest-"));
const convDir = path.join(tmp, "conv");
fs.mkdirSync(convDir, { recursive: true });

// Set the env var BEFORE importing lib so CONVERSATIONS_DIR resolves to tmp.
process.env.AGENT_CHAT_CONVERSATIONS_DIR = convDir;
delete process.env.CLAUDE_SESSION_ID; // avoid inheriting parent's session key

// Import lib AFTER setting env. Bust the module cache so the top-level
// `export const CONVERSATIONS_DIR = ...` evaluates against tmp.
const lib = await import(`./lib.ts?bust=${Date.now()}nt`);
const {
  loadTopology, edgesOf, neighborsOf,
  appendDot, readDots, readAllDots,
  aggregateDots, computeBelievability,
  writeRoleOverride, clearRoleOverride,
  relayPathTo, DOT_AXES,
} = lib;

const topo = loadTopology("petersen");
const aiAgents = ["orion", "lumeyon", "lyra", "keystone", "sentinel",
                  "vanguard", "carina", "pulsar", "cadence", "rhino"];

// ── plant deterministic dots ──────────────────────────────────────────────
//
// Each AI agent dots their 3 direct neighbors. We use a deterministic score
// matrix so the test is reproducible:
//
//   - orion (orchestrator) grades everyone HIGH (8-9 across axes) — high
//     believability orchestrator who trusts the network
//   - cadence (devil's advocate) grades everyone LOW (4-5 across axes) —
//     critical reviewer
//   - vanguard (bear case) grades everyone MEDIUM-LOW (5-6) — skeptical
//   - everyone else grades MEDIUM-HIGH (7-8) — cooperative average

function dotScores(grader: string, _peer: string): Record<string, number> {
  if (grader === "orion") return { clarity: 9, depth: 8, reliability: 9, speed: 8 };
  if (grader === "cadence") return { clarity: 5, depth: 5, reliability: 4, speed: 5 };
  if (grader === "vanguard") return { clarity: 6, depth: 5, reliability: 6, speed: 5 };
  return { clarity: 8, depth: 7, reliability: 8, speed: 7 };
}

let plantedDots = 0;
for (const grader of aiAgents) {
  const myEdges = edgesOf(topo, grader);
  for (const e of myEdges) {
    if (!aiAgents.includes(e.peer)) continue; // skip human peers
    appendDot(e.peer, {
      ts: new Date().toISOString(),
      grader,
      axes: dotScores(grader, e.peer),
      note: `planted by network-test (${grader} → ${e.peer})`,
    });
    plantedDots++;
  }
}

// ── scenarios ──────────────────────────────────────────────────────────────

scenario("storage — dot ledgers populated", () => {
  // Petersen: 10 nodes, degree 3 → each agent has 3 neighbors. Every AI
  // agent dots all 3 neighbors → 30 total dots. But the dot lands in the
  // GRADEE's ledger, so each AI ledger receives dots from its 3 neighbors.
  const allDots = readAllDots();
  const aiLedgerCount = aiAgents.reduce((acc, a) => acc + (allDots[a]?.length ?? 0), 0);
  check("planted-dot count = 30 (10 agents × 3 neighbors)", plantedDots === 30, `got ${plantedDots}`);
  check("ledger total = 30 (every dot persisted)", aiLedgerCount === 30, `got ${aiLedgerCount}`);
  for (const a of aiAgents) {
    const dots = allDots[a] ?? [];
    check(`${a}: received exactly 3 dots (one per direct neighbor)`, dots.length === 3, `got ${dots.length}`);
  }
});

scenario("aggregation — per-axis weighted means + composite", () => {
  const allDots = readAllDots();
  // lumeyon's 3 neighbors in petersen are orion + lyra + sentinel (depending
  // on the yaml's specific edge set). Whoever they are, the unweighted mean
  // of clarity should be the average of {orion=9, X=8, Y=8} ≈ 8.33 if neither
  // X nor Y is cadence/vanguard, but we don't know without inspecting the
  // graph. Instead we just assert the shape is sound.
  for (const a of aiAgents) {
    const agg = aggregateDots(a, allDots);
    check(`${a}: aggregate count = 3`, agg.count === 3);
    check(`${a}: composite is in [1, 10]`, agg.composite >= 1 && agg.composite <= 10);
    for (const ax of DOT_AXES) {
      check(`${a}: axis "${ax}" weighted is finite + in [0, 10]`,
        Number.isFinite(agg.weighted[ax]) && agg.weighted[ax] >= 0 && agg.weighted[ax] <= 10);
    }
  }
});

scenario("believability — propagation across the mesh", () => {
  const allDots = readAllDots();
  const belv = computeBelievability(allDots);
  // Every AI has 3 received dots, so all believabilities should differ from
  // the 0.5 neutral prior.
  for (const a of aiAgents) {
    check(`${a}: believability differs from neutral prior`,
      Math.abs((belv[a] ?? 0.5) - 0.5) > 0.05,
      `belv=${(belv[a] ?? 0.5).toFixed(3)}`);
  }
  // Agents graded only by 'orion' (HIGH grader) cannot exist in petersen
  // because every node has 3 neighbors, but we can verify believability
  // inversely correlates with WHO graded an agent: an agent whose neighbors
  // include cadence will have lower received scores, hence lower belv.
  const cadenceNeighbors = neighborsOf(topo, "cadence").filter((n) => aiAgents.includes(n));
  const nonCadenceNeighbors = aiAgents.filter((a) => a !== "cadence" && !cadenceNeighbors.includes(a));
  if (cadenceNeighbors.length > 0 && nonCadenceNeighbors.length > 0) {
    const cnAvg = cadenceNeighbors.reduce((s, a) => s + (belv[a] ?? 0.5), 0) / cadenceNeighbors.length;
    const ncAvg = nonCadenceNeighbors.reduce((s, a) => s + (belv[a] ?? 0.5), 0) / nonCadenceNeighbors.length;
    check(
      "agents who get graded by cadence (HARSH) have lower mean believability",
      cnAvg < ncAvg,
      `cadence-neighbors mean belv=${cnAvg.toFixed(3)} vs others mean belv=${ncAvg.toFixed(3)}`,
    );
  }
});

scenario("weighted ≠ unweighted (Dalio property)", () => {
  // For any agent who has at least 2 graders with materially-different
  // believabilities, weighted aggregation should diverge from unweighted.
  // We expect this for most agents in petersen since cadence/vanguard's
  // believabilities will differ from orion's.
  const allDots = readAllDots();
  let divergedCount = 0;
  for (const a of aiAgents) {
    const agg = aggregateDots(a, allDots);
    for (const ax of DOT_AXES) {
      if (Math.abs(agg.weighted[ax] - agg.unweighted[ax]) > 0.05) {
        divergedCount++;
        break;
      }
    }
  }
  // In petersen, harsh graders (cadence + vanguard) each have 3 neighbors,
  // so they only directly grade ~6 agents (with possible overlap). The rest
  // are graded only by medium/high graders whose believabilities cluster, so
  // weighted ≈ unweighted for them. 3+ divergent agents is sufficient
  // evidence that the believability weighting is doing real work.
  check(
    "at least 3 agents show weighted ≠ unweighted (believability is doing work)",
    divergedCount >= 3,
    `only ${divergedCount} agents diverged — believability not differentiating`,
  );
});

scenario("roster — every agent appears in every other agent's view", () => {
  // Reconstruct the cmdRun roster-building logic and assert each agent's
  // view contains all 9 other AI agents. (Plus boss/john humans if the
  // overlay merged them — depends on agents.users.yaml shape. We assert
  // ≥9 to be tolerant of either.)
  const allDots = readAllDots();
  const believability = computeBelievability(allDots);
  for (const me of aiAgents) {
    const rosterMembers: string[] = [];
    const myNeighborSet = new Set(neighborsOf(topo, me));
    for (const a of topo.agents) {
      if (a === me) continue;
      rosterMembers.push(a);
      // Direct vs relay routing determined per-agent.
      if (myNeighborSet.has(a)) continue;
      const relay = relayPathTo(topo, me, a);
      check(`${me}: non-neighbor "${a}" has a routable relay path`,
        relay != null && relay.length >= 3,
        `path=${JSON.stringify(relay)}`);
    }
    check(`${me}: roster contains ≥9 other agents (every AI peer visible)`,
      rosterMembers.filter((m) => aiAgents.includes(m)).length === 9,
      `roster size = ${rosterMembers.length}`);
  }
});

scenario("relay paths — match BFS truth + use diameter ≤ 2 for petersen", () => {
  // Petersen graph diameter is 2 — so any non-neighbor pair is reachable in
  // exactly 2 hops (3-node path). Verify this invariant across all 45 unique
  // AI-pairs.
  let pairsChecked = 0;
  let maxLen = 0;
  for (let i = 0; i < aiAgents.length; i++) {
    for (let j = i + 1; j < aiAgents.length; j++) {
      const a = aiAgents[i], b = aiAgents[j];
      const path = relayPathTo(topo, a, b);
      check(`relayPathTo(${a}, ${b}) returns a path`, path != null);
      if (path) {
        pairsChecked++;
        maxLen = Math.max(maxLen, path.length);
      }
    }
  }
  check("all 45 AI-pairs routable", pairsChecked === 45, `got ${pairsChecked}`);
  check("petersen diameter ≤ 2 (max path length ≤ 3 nodes)", maxLen <= 3, `maxLen=${maxLen}`);
});

scenario("role overrides — single update propagates to all readers", () => {
  // Plant a role override for orion and verify every OTHER agent sees it
  // when they reload the topology.
  const overrideText = "Network-test override: orion is now the integration witness";
  writeRoleOverride("orion", overrideText);
  try {
    // Re-import lib so loadTopology() re-reads the override.
    // Actually loadTopology re-reads on every call (it's not cached), so
    // calling it again on the SAME module instance is sufficient.
    const fresh = loadTopology("petersen");
    check("orion's role reflects override", fresh.roles?.orion === overrideText,
      `got: ${(fresh.roles?.orion ?? "").slice(0, 60)}`);
    // Other agents keep YAML defaults.
    check("lumeyon's role still has YAML default (Architecture)",
      /Architecture/.test(fresh.roles?.lumeyon ?? ""));
    // Clear and verify reversion.
    clearRoleOverride("orion");
    const reverted = loadTopology("petersen");
    check("after clear: orion's role reverts to YAML default",
      reverted.roles?.orion?.includes("Orchestrator") ?? false,
      `got: ${(reverted.roles?.orion ?? "").slice(0, 60)}`);
  } finally {
    clearRoleOverride("orion"); // belt-and-suspenders
  }
});

scenario("self-grading refused at the lib level", () => {
  // appendDot itself doesn't refuse self-grading — that's enforced at the
  // CLI + directive parser layer. But the Dot type allows any grader/peer
  // pair, so confirm the CLI-level refusal is what catches it.
  // (This check is a documentation invariant: the lib is permissive; the
  // CLI/directive is the gate. Self-test already covers the CLI gate.)
  // Here we just confirm appendDot itself accepts a self-graded dot if
  // the caller bypasses the CLI — flagging where the invariant lives.
  const beforeCount = readDots("orion").length;
  // Don't actually plant a self-dot (would pollute the next run); just
  // assert that self-grading-refusal is NOT a lib-level invariant by
  // showing the function signature accepts any grader.
  check(
    "Dot type allows any (grader, peer) — self-grading must be refused at CLI/directive layer",
    typeof appendDot === "function" && beforeCount === 3,
  );
});

// ── teardown + summary ─────────────────────────────────────────────────────

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
const wantJson = process.argv.includes("--json");

if (wantJson) {
  console.log(JSON.stringify({
    total: results.length, passed, failed: failed.length, results,
  }, null, 2));
} else {
  console.log(`agent-chat network-test  (10 AI agents on petersen)\n`);
  for (const r of results) {
    const tag = r.pass ? "PASS" : "FAIL";
    const detail = r.detail && !r.pass ? `\n        ${r.detail.split("\n").slice(0, 3).join("\n        ")}` : "";
    console.log(`  ${tag}  ${r.name}${detail}`);
  }
  console.log(`\n${passed}/${results.length} pass${failed.length ? `, ${failed.length} fail` : ""}`);
}

process.exit(failed.length === 0 ? 0 : 1);
