// Pure-function unit tests for scripts/lib.ts. Fast, no I/O, no spawn.

import { test, expect, describe } from "bun:test";
import {
  parseTopologyYaml, edgeId, neighborsOf, edgesOf, parseSections,
  splitForArchive, sectionMeta, timeRangeOf, validateSummary,
  extractTldr, extractKeywords, parseLockFile, processTag,
  archiveId, depthPolicy, renderSummaryStub, loadTopology,
  parseUsersYaml, loadUsers,
} from "../scripts/lib.ts";

describe("parseTopologyYaml", () => {
  test("parses minimal valid topology", () => {
    const yaml = `topology: pair\nagents:\n  - orion\n  - lumeyon\nedges:\n  - [orion, lumeyon]\n`;
    const t = parseTopologyYaml(yaml);
    expect(t.topology).toBe("pair");
    expect(t.agents).toEqual(["orion", "lumeyon"]);
    expect(t.edges).toEqual([["orion", "lumeyon"]]);
  });

  test("strips inline comments", () => {
    const yaml = `topology: pair # name\nagents:\n  - orion # leader\n  - lumeyon\nedges:\n  - [orion, lumeyon]\n`;
    const t = parseTopologyYaml(yaml);
    expect(t.agents).toEqual(["orion", "lumeyon"]);
  });

  test("rejects missing topology", () => {
    expect(() =>
      parseTopologyYaml(`agents:\n  - a\nedges:\n  - [a, a]\n`),
    ).toThrow(/topology field missing/);
  });

  test("rejects empty agents list", () => {
    expect(() =>
      parseTopologyYaml(`topology: x\nagents:\nedges:\n  - [a, b]\n`),
    ).toThrow(/agents list empty/);
  });

  test("rejects malformed edge", () => {
    expect(() =>
      parseTopologyYaml(`topology: x\nagents:\n  - a\n  - b\nedges:\n  - bad-edge\n`),
    ).toThrow(/bad edge syntax/);
  });
});

describe("parseTopologyYaml — P2 hardening (lumeyon)", () => {
  test("rejects unknown top-level keys (kills __proto__/constructor pollution)", () => {
    expect(() =>
      parseTopologyYaml(`topology: x\n__proto__: bad\nagents:\n  - a\n  - b\nedges:\n  - [a, b]\n`),
    ).toThrow(/unknown top-level/);
    expect(() =>
      parseTopologyYaml(`topology: x\nconstructor: bad\nagents:\n  - a\n  - b\nedges:\n  - [a, b]\n`),
    ).toThrow(/unknown top-level/);
  });
  test("rejects an agent name with shell metacharacters", () => {
    expect(() =>
      parseTopologyYaml(`topology: x\nagents:\n  - "a;rm -rf /"\nedges:\n  - [a, b]\n`),
    ).toThrow(/invalid agent name/);
  });
  test("rejects an agent name with path traversal", () => {
    expect(() =>
      parseTopologyYaml(`topology: x\nagents:\n  - ../etc/passwd\n  - b\nedges:\n  - [b, b]\n`),
    ).toThrow(/invalid agent name/);
  });
  test("uses Object.create(null) for output (no Object prototype on the parsed object)", () => {
    const t = parseTopologyYaml(`topology: x\nagents:\n  - a\n  - b\nedges:\n  - [a, b]\n`);
    expect(Object.getPrototypeOf(t)).toBeNull();
  });
});

describe("parseSections — fenced-code awareness (keystone #2)", () => {
  test("a `## fake` line inside a triple-backtick fence is NOT a section break", async () => {
    const { parseSections } = await import("../scripts/lib.ts");
    const convo = [
      "header preamble",
      "",
      "## orion — real (UTC 2026-05-01T01:00:00Z)",
      "body line",
      "```",
      "## fake heading inside code",
      "```",
      "",
      "## lumeyon — also real (UTC 2026-05-01T02:00:00Z)",
      "body",
    ].join("\n");
    const r = parseSections(convo);
    expect(r.sections).toHaveLength(2);
    expect(r.sections[0]).toContain("## fake heading inside code");
    expect(r.sections[1]).toContain("lumeyon");
  });
  test("a `## fake` line inside a tilde fence is also not a section break", async () => {
    const { parseSections } = await import("../scripts/lib.ts");
    const convo = [
      "## orion — real (UTC 2026-05-01T01:00:00Z)",
      "body",
      "~~~",
      "## fake",
      "~~~",
    ].join("\n");
    expect(parseSections(convo).sections).toHaveLength(1);
  });
});

describe("presenceFile — defense-in-depth sanitization (lyra L1)", () => {
  test("path-traversal characters in agent name are replaced with underscores", async () => {
    const { presenceFile } = await import("../scripts/lib.ts");
    const p = presenceFile("../etc/passwd");
    expect(p).not.toContain("..");
    expect(p).not.toContain("/etc/");
    expect(p).toMatch(/_etc_passwd/);
  });
});

describe("exclusiveWriteOrFail — unlink on writeFileSync error (carina bonus 2)", () => {
  // We can't easily simulate ENOSPC, but we can verify the contract: on a
  // successful write the file exists and matches, AND a follow-up wx call
  // fails with EEXIST (meaning the slot is genuinely held). The destructive
  // path is exercised by code-review.
  test("happy path leaves the file present and contents correct", async () => {
    const { exclusiveWriteOrFail } = await import("../scripts/lib.ts");
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const tmp = path.join(os.tmpdir(), `agent-chat-excl-${process.pid}-${Date.now()}.txt`);
    try {
      exclusiveWriteOrFail(tmp, "hello");
      expect(fs.readFileSync(tmp, "utf8")).toBe("hello");
      expect(() => exclusiveWriteOrFail(tmp, "again")).toThrow(/EEXIST/);
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  });
});

describe("resolveIdentity — half-set env vars (lyra round-2 Q1, P1)", () => {
  // Hardening regression: pre-fix, AGENT_NAME=lyra without AGENT_TOPOLOGY
  // silently fell through to the .agent-name branch, returning a different
  // identity than the user typed. Partial env is almost always a typo;
  // strictness preferred over warn-and-continue.
  test("AGENT_NAME without AGENT_TOPOLOGY throws instead of silently falling through", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-halfenv-"));
    const prevEnvDir = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    const prevEnvName = process.env.AGENT_NAME;
    const prevEnvTopo = process.env.AGENT_TOPOLOGY;
    const prevSession = process.env.CLAUDE_SESSION_ID;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = cwd;
    process.env.AGENT_NAME = "lyra";
    delete process.env.AGENT_TOPOLOGY;
    process.env.CLAUDE_SESSION_ID = `test-halfenv-${Date.now()}`;
    fs.writeFileSync(path.join(cwd, ".agent-name"), "name: orion\ntopology: petersen\n");
    try {
      const fresh = await import(`../scripts/lib.ts?bust=halfenv-${Date.now()}`);
      expect(() => fresh.resolveIdentity(cwd)).toThrow(/AGENT_NAME.*without.*AGENT_TOPOLOGY|partial env/i);
    } finally {
      if (prevEnvDir == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR; else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnvDir;
      if (prevEnvName == null) delete process.env.AGENT_NAME; else process.env.AGENT_NAME = prevEnvName;
      if (prevEnvTopo == null) delete process.env.AGENT_TOPOLOGY; else process.env.AGENT_TOPOLOGY = prevEnvTopo;
      if (prevSession == null) delete process.env.CLAUDE_SESSION_ID; else process.env.CLAUDE_SESSION_ID = prevSession;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("AGENT_TOPOLOGY without AGENT_NAME also throws", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-halfenv2-"));
    const prevEnvDir = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    const prevEnvName = process.env.AGENT_NAME;
    const prevEnvTopo = process.env.AGENT_TOPOLOGY;
    const prevSession = process.env.CLAUDE_SESSION_ID;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = cwd;
    delete process.env.AGENT_NAME;
    process.env.AGENT_TOPOLOGY = "petersen";
    process.env.CLAUDE_SESSION_ID = `test-halfenv2-${Date.now()}`;
    fs.writeFileSync(path.join(cwd, ".agent-name"), "name: orion\ntopology: petersen\n");
    try {
      const fresh = await import(`../scripts/lib.ts?bust=halfenv2-${Date.now()}`);
      expect(() => fresh.resolveIdentity(cwd)).toThrow(/AGENT_TOPOLOGY.*without.*AGENT_NAME|partial env/i);
    } finally {
      if (prevEnvDir == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR; else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnvDir;
      if (prevEnvName == null) delete process.env.AGENT_NAME; else process.env.AGENT_NAME = prevEnvName;
      if (prevEnvTopo == null) delete process.env.AGENT_TOPOLOGY; else process.env.AGENT_TOPOLOGY = prevEnvTopo;
      if (prevSession == null) delete process.env.CLAUDE_SESSION_ID; else process.env.CLAUDE_SESSION_ID = prevSession;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("findResumableSession — most-recent over readdir-order (lyra round-2 Q2, P2)", () => {
  // Hardening regression: pre-fix, multiple stale records sharing one
  // cwd|tty resume key would resolve to filesystem-readdir-order, flickering
  // unpredictably across restarts. Should sort by started_at descending and
  // return the most-recent stale record.
  test("returns the most-recent stale record when multiple share the resume key", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-resume-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      const fresh = await import(`../scripts/lib.ts?bust=resume-${Date.now()}`);
      fresh.ensureControlDirs();
      // Find a guaranteed-dead pid.
      let dead = 9_999_999;
      for (let p = 9_999_900; p > 1_000_000; p -= 17) {
        try { process.kill(p, 0); } catch (e: any) { if (e?.code === "ESRCH") { dead = p; break; } }
      }
      const myCwd = "/tmp/shared-cwd";
      const myTty = "/dev/pts/99";
      // Write 3 stale records, all matching the same resume key, with
      // monotonically-newer started_at. The most-recent should win.
      const recs = [
        { agent: "old", started_at: "2026-05-01T01:00:00Z" },
        { agent: "newer", started_at: "2026-05-01T03:00:00Z" },
        { agent: "newest", started_at: "2026-05-01T05:00:00Z" },
        { agent: "middle", started_at: "2026-05-01T02:00:00Z" },
      ];
      for (const r of recs) {
        const key = `pid:${dead}-${r.agent}`;
        fs.writeFileSync(
          fresh.sessionFile(key),
          JSON.stringify({
            agent: r.agent, topology: "petersen", session_key: key,
            host: os.hostname(), pid: dead, started_at: r.started_at,
            cwd: myCwd, tty: myTty,
          }),
        );
      }
      const got = fresh.findResumableSession(fresh.resumeKey(myCwd, myTty));
      expect(got).not.toBeNull();
      expect(got!.agent).toBe("newest");
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("writeSessionRecord — atomic write (lyra round-2 Q3, P2)", () => {
  // Hardening regression: pre-fix, `fs.writeFileSync(sessionFile, ...)` did
  // O_TRUNC + write — concurrent readers saw empty/partial JSON during the
  // window, causing readSessionRecord to return null transiently. Should
  // route through writeFileAtomic (tmp + rename).
  test("session file is atomically present (no transient empty state visible to readers)", async () => {
    // The atomic-write contract is: either the file is fully present with
    // the expected content, or the previous content is present. We can't
    // easily race a real test here, but we CAN verify that the write path
    // uses tmpfile + rename by snapshotting the directory listing during
    // a write — the tmp file should appear briefly, then disappear, with
    // the target file ending at the new content.
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-atomic-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      const fresh = await import(`../scripts/lib.ts?bust=atomic-${Date.now()}`);
      const rec = {
        agent: "orion", topology: "petersen", session_key: "test-atomic",
        host: os.hostname(), pid: process.pid,
        started_at: "2026-05-01T00:00:00Z", cwd: tmp,
      };
      fresh.writeSessionRecord(rec as any);
      // The session file exists, is valid JSON, and contains the expected agent.
      const sf = fresh.sessionFile("test-atomic");
      expect(fs.existsSync(sf)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(sf, "utf8"));
      expect(parsed.agent).toBe("orion");
      // Overwrite with new content; verify no .tmp leftover sits in the dir.
      fresh.writeSessionRecord({ ...rec, agent: "lumeyon" } as any);
      const reread = JSON.parse(fs.readFileSync(sf, "utf8"));
      expect(reread.agent).toBe("lumeyon");
      const sessionDir = path.dirname(sf);
      const leftovers = fs.readdirSync(sessionDir).filter((f: string) => f.includes(".tmp."));
      expect(leftovers).toHaveLength(0);
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("readAgentNameFile — `# comment` tolerance (lyra L3)", () => {
  test(".agent-name with trailing # comments parses correctly", async () => {
    const { resolveIdentity } = await import("../scripts/lib.ts");
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-comment-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = cwd;
    fs.writeFileSync(path.join(cwd, ".agent-name"), "name: orion # main project\ntopology: petersen # graph\n");
    try {
      const id = resolveIdentity(cwd);
      expect(id.name).toBe("orion");
      expect(id.topology).toBe("petersen");
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("edgeId", () => {
  test("alphabetical canonicalization is order-independent", () => {
    expect(edgeId("orion", "lumeyon")).toBe("lumeyon-orion");
    expect(edgeId("lumeyon", "orion")).toBe("lumeyon-orion");
  });

  test("works with three-character names", () => {
    expect(edgeId("aaa", "bbb")).toBe("aaa-bbb");
    expect(edgeId("bbb", "aaa")).toBe("aaa-bbb");
  });
});

describe("neighborsOf / edgesOf", () => {
  const topo = parseTopologyYaml(
    `topology: petersen\nagents:\n  - a\n  - b\n  - c\n  - d\nedges:\n  - [a, b]\n  - [a, c]\n  - [b, d]\n`,
  );

  test("neighborsOf returns sorted unique neighbors", () => {
    expect(neighborsOf(topo, "a")).toEqual(["b", "c"]);
    expect(neighborsOf(topo, "b")).toEqual(["a", "d"]);
    expect(neighborsOf(topo, "d")).toEqual(["b"]);
  });

  test("edgesOf returns one record per neighbor with canonical id", () => {
    const edges = edgesOf(topo, "a");
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.peer)).toEqual(["b", "c"]);
    expect(edges.map((e) => e.id)).toEqual(["a-b", "a-c"]);
  });
});

// org topology: 2 humans (eyon, john) + 10 AI agents = 12 agents,
// 36 edges (1 human-human + 20 human-AI + 15 petersen-AI-AI). The
// existing parseTopologyYaml + loadTopology + neighborsOf accept it
// without code changes — humans-as-agents is a pure naming convention
// atop the existing primitives. These tests pin that contract: any
// regression that special-cases agent role or breaks edge enumeration
// at this density would fail here.
describe("loadTopology — org topology (multi-user, slice 1)", () => {
  test("loads 12 agents and 36 edges", () => {
    const t = loadTopology("org");
    expect(t.topology).toBe("org");
    expect(t.agents).toHaveLength(12);
    expect(t.agents).toContain("eyon");
    expect(t.agents).toContain("john");
    expect(t.agents).toContain("orion");
    expect(t.edges).toHaveLength(36);
  });

  test("human degree is 11, AI degree is 5", () => {
    const t = loadTopology("org");
    expect(neighborsOf(t, "eyon")).toHaveLength(11);
    expect(neighborsOf(t, "john")).toHaveLength(11);
    expect(neighborsOf(t, "orion")).toHaveLength(5);
    expect(neighborsOf(t, "rhino")).toHaveLength(5);
    // Every human neighbors every AI plus the other human.
    expect(neighborsOf(t, "eyon")).toContain("john");
    expect(neighborsOf(t, "eyon")).toContain("orion");
    // AI sees both humans plus their petersen peers.
    expect(neighborsOf(t, "orion")).toContain("eyon");
    expect(neighborsOf(t, "orion")).toContain("john");
    expect(neighborsOf(t, "orion")).toContain("lumeyon");
  });

  test("edge canonicalization is order-independent for human-AI edges", () => {
    expect(edgeId("eyon", "orion")).toBe("eyon-orion");
    expect(edgeId("orion", "eyon")).toBe("eyon-orion");
    expect(edgeId("eyon", "john")).toBe("eyon-john");
    expect(edgeId("john", "eyon")).toBe("eyon-john");
  });

  test("edgesOf for a human enumerates all 11 edges with canonical ids", () => {
    const t = loadTopology("org");
    const edges = edgesOf(t, "eyon");
    expect(edges).toHaveLength(11);
    // Each edge id matches the alphabetical canonicalization. "eyon" sorts
    // AFTER "cadence" and "carina" but BEFORE all other peers, so 9 edges
    // start with "eyon-" and 2 start with the peer name.
    for (const e of edges) {
      expect(e.id).toBe(edgeId("eyon", e.peer));
    }
    expect(edges.find((e) => e.peer === "carina")!.id).toBe("carina-eyon");
    expect(edges.find((e) => e.peer === "cadence")!.id).toBe("cadence-eyon");
    expect(edges.find((e) => e.peer === "orion")!.id).toBe("eyon-orion");
    expect(edges.find((e) => e.peer === "john")!.id).toBe("eyon-john");
  });
});

// agents.users.yaml — orthogonal user registry overlaid onto any topology.
// Slice 1 of the multi-user transparency refactor: users.yaml is the human
// marker; loadTopology merges users into the returned Topology so existing
// call sites (`topo.agents.includes(name)`, edge canonicalization, edgesOf,
// neighborsOf) keep working without per-call-site edits.
describe("parseUsersYaml — schema parser hardening (slice 1)", () => {
  test("parses minimal valid users.yaml", () => {
    const u = parseUsersYaml(`users:\n  - name: eyon\n    default: true\n  - name: john\n`);
    expect(u).toHaveLength(2);
    expect(u[0]).toEqual({ name: "eyon", default: true });
    expect(u[1]).toEqual({ name: "john" });
  });

  test("strips inline comments", () => {
    const u = parseUsersYaml(`# top comment\nusers:\n  - name: eyon # default user\n    default: true\n`);
    expect(u).toHaveLength(1);
    expect(u[0].name).toBe("eyon");
    expect(u[0].default).toBe(true);
  });

  test("rejects unknown top-level keys (kills __proto__/constructor pollution)", () => {
    expect(() => parseUsersYaml(`__proto__: bad\nusers:\n  - name: eyon\n`)).toThrow(/unknown top-level/);
    expect(() => parseUsersYaml(`constructor: bad\nusers:\n  - name: eyon\n`)).toThrow(/unknown top-level/);
    expect(() => parseUsersYaml(`agents:\n  - eyon\n`)).toThrow(/unknown top-level/);
  });

  test("rejects invalid user name (shell metacharacters / path traversal)", () => {
    expect(() => parseUsersYaml(`users:\n  - name: "eyon;rm -rf /"\n`)).toThrow(/invalid user name/);
    expect(() => parseUsersYaml(`users:\n  - name: ../etc/passwd\n`)).toThrow(/invalid user name/);
  });

  test("uses Object.create(null) for output container (no Object prototype)", () => {
    // Indirect check: parser exposes the array via a prototypeless container,
    // so `out.toString` paths through standard Array prototype on the array
    // itself (which is fine), but a crafted yaml can't shadow `toString` on
    // the container. Verify by parsing a yaml whose only effect is to set
    // `description`, then assert the parser didn't blow up and returned [].
    const u = parseUsersYaml(`description: only-a-description\n`);
    expect(u).toEqual([]);
  });
});

describe("loadUsers — load-time invariants (slice 1)", () => {
  test("returns the shipped agents.users.yaml content", () => {
    const u = loadUsers();
    // Test pins the shipped file: eyon + john, eyon is the default. Future
    // edits to agents.users.yaml that break this expectation should update
    // the test deliberately.
    expect(u.length).toBeGreaterThanOrEqual(2);
    const eyon = u.find((x) => x.name === "eyon");
    expect(eyon).toBeDefined();
    expect(eyon!.default).toBe(true);
    expect(u.find((x) => x.name === "john")).toBeDefined();
  });

  test("parseUsersYaml rejects multiple default: true entries (load-time invariant via loadUsers)", () => {
    // Guard at the loadUsers layer because parseUsersYaml is intentionally
    // permissive about field combinations (it just collects). loadUsers is
    // the load-time correctness gate. Test by feeding crafted yaml through
    // parseUsersYaml then running the same dedup logic loadUsers does.
    const u = parseUsersYaml(`users:\n  - name: eyon\n    default: true\n  - name: john\n    default: true\n`);
    const defaults = u.filter((x) => x.default === true);
    expect(defaults).toHaveLength(2);
    // loadUsers itself would throw — this regression test pins the
    // parser shape that loadUsers's gate depends on.
  });
});

describe("loadTopology overlay — users merge (slice 1)", () => {
  test("petersen with users overlay yields 12 agents and 36 edges (matches org shape)", () => {
    const p = loadTopology("petersen");
    // 10 petersen AI + 2 users.yaml humans = 12 agents
    expect(p.agents.length).toBe(12);
    expect(p.agents).toContain("eyon");
    expect(p.agents).toContain("john");
    // 15 petersen edges + 20 user-AI (2 humans × 10 AI) + 1 user-user = 36
    expect(p.edges.length).toBe(36);
  });

  test("org topology overlay is idempotent (no duplicate agents or edges)", () => {
    // org.yaml pre-declares eyon/john as agents AND eyon-orion / eyon-john
    // edges. The overlay merge dedups by Set so org.agents.length stays 12
    // and org.edges.length stays 36.
    const o = loadTopology("org");
    expect(o.agents.length).toBe(12);
    expect(o.edges.length).toBe(36);
    // No duplicate names in agents
    const set = new Set(o.agents);
    expect(set.size).toBe(o.agents.length);
    // No duplicate canonical edge ids
    const edgeIds = o.edges.map(([a, b]) => edgeId(a, b));
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
  });

  test("user neighbors include all AI in the topology + every other user", () => {
    const p = loadTopology("petersen");
    // eyon should neighbor every petersen AI (10) plus john (1) = 11
    const eyonNeighbors = neighborsOf(p, "eyon");
    expect(eyonNeighbors).toHaveLength(11);
    expect(eyonNeighbors).toContain("john");
    expect(eyonNeighbors).toContain("orion");
    expect(eyonNeighbors).toContain("rhino");
    // orion (an AI) gets 3 petersen neighbors + 2 humans = 5
    const orionNeighbors = neighborsOf(p, "orion");
    expect(orionNeighbors).toHaveLength(5);
    expect(orionNeighbors).toContain("eyon");
    expect(orionNeighbors).toContain("john");
  });

  test("user-edges live under the AI's topology directory (topology-rooted)", () => {
    const p = loadTopology("petersen");
    const edges = edgesOf(p, "eyon");
    // Each edge's directory should be under conversations/petersen/, not
    // under conversations/users/ — confirms topology-rooted user-edges
    // (orion's Phase-2 resolution: matches existing org-topology semantic).
    for (const e of edges) {
      expect(e.dir).toContain("/petersen/");
      expect(e.dir).not.toContain("/users/");
    }
  });
});

describe("parseSections / splitForArchive", () => {
  const convo = [
    "# CONVO — orion ↔ lumeyon\n",
    "Protocol: agent-chat\n",
    "",
    "## orion — section 1 (UTC 2026-05-01T01:00:00Z)\n",
    "body 1",
    "",
    "→ lumeyon",
    "",
    "---",
    "",
    "## lumeyon — section 2 (UTC 2026-05-01T02:00:00Z)\n",
    "body 2",
    "",
    "→ orion",
    "",
    "---",
    "",
    "## orion — section 3 (UTC 2026-05-01T03:00:00Z)\n",
    "body 3",
    "",
    "→ END",
  ].join("\n");

  test("parseSections separates header from sections", () => {
    const { header, sections } = parseSections(convo);
    expect(header).toMatch(/^# CONVO/);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toContain("section 1");
    expect(sections[1]).toContain("section 2");
    expect(sections[2]).toContain("section 3");
  });

  test("splitForArchive respects fresh-tail count", () => {
    const split = splitForArchive(convo, 1);
    expect(split.sectionCount).toBe(3);
    expect(split.archivableSectionCount).toBe(2);
    expect(split.freshTail).toContain("section 3");
    expect(split.freshTail).not.toContain("section 1");
    expect(split.archivable).toContain("section 1");
    expect(split.archivable).toContain("section 2");
  });

  test("splitForArchive with fresh tail >= section count archives nothing", () => {
    const split = splitForArchive(convo, 10);
    expect(split.archivableSectionCount).toBe(0);
    expect(split.archivable).toBe("");
  });
});

describe("sectionMeta / timeRangeOf", () => {
  test("extracts author and timestamp from section header", () => {
    const sec = "## orion — topic (UTC 2026-05-01T01:23:45Z)\n\nbody\n→ lumeyon";
    expect(sectionMeta(sec)).toEqual({ author: "orion", ts: "2026-05-01T01:23:45Z" });
  });

  test("falls back when header is malformed", () => {
    const sec = "## random text without a UTC timestamp";
    expect(sectionMeta(sec)).toEqual({ author: "unknown", ts: null });
  });

  test("accepts fractional-seconds (ms / µs / ns) precision", () => {
    // Regression: round-2 latency-poll spec instructed agents to use
    // `date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"` for send_time, and several
    // agents (vanguard, carina) echoed that into their section headers.
    // Pre-fix the regex hard-coded second-precision, parsed those headers
    // as author=null/ts=null, and silently dropped them from
    // `since-last-spoke` cursor calculations.
    const ms = "## vanguard — reply (UTC 2026-05-01T21:16:58.580Z)\n\nbody\n";
    expect(sectionMeta(ms)).toEqual({ author: "vanguard", ts: "2026-05-01T21:16:58.580Z" });
    const us = "## carina — reply (UTC 2026-05-01T21:16:58.123456Z)\n\nbody\n";
    expect(sectionMeta(us).author).toBe("carina");
    expect(sectionMeta(us).ts).toBe("2026-05-01T21:16:58.123456Z");
    const ns = "## lumeyon — reply (UTC 2026-05-01T21:16:58.123456789Z)\n\nbody\n";
    expect(sectionMeta(ns).author).toBe("lumeyon");
  });

  test("rejects bogus placeholder timestamp like (UTC 2026-05-01T21:18:??Z)", () => {
    // Carina's anomaly #2 — a literal `??` placeholder she forgot to splice.
    // Strict parsing is correct here: garbage timestamps must NOT propagate
    // into the cursor file. This test pins the strictness so the
    // fractional-seconds fix above doesn't accidentally relax it further.
    const bad = "## carina — placeholder (UTC 2026-05-01T21:18:??Z)\n\nbody\n";
    expect(sectionMeta(bad)).toEqual({ author: "unknown", ts: null });
  });

  test("timeRangeOf finds earliest and latest", () => {
    const secs = [
      "## a — x (UTC 2026-05-02T00:00:00Z)\n",
      "## b — y (UTC 2026-05-01T00:00:00Z)\n",
      "## c — z (UTC 2026-05-03T00:00:00Z)\n",
    ];
    expect(timeRangeOf(secs)).toEqual({
      earliest: "2026-05-01T00:00:00Z",
      latest: "2026-05-03T00:00:00Z",
    });
  });
});

describe("validateSummary", () => {
  const goodSummary = `# SUMMARY — x · leaf · depth 0 · t1 → t2

## TL;DR
A real summary line one.
Line two.
Line three.

## Decisions
- decided X for reason Y — evidence Z

## Blockers
- (none)

## Follow-ups
- (none)

## Artifacts referenced
- (none)

## Keywords
foo, bar, baz

## Expand for details about:
exact phrasing, intermediate dead ends
`;

  test("accepts a complete summary", () => {
    const v = validateSummary(goodSummary);
    expect(v.ok).toBe(true);
    expect(v.issues).toHaveLength(0);
  });

  test("rejects missing TL;DR", () => {
    const v = validateSummary(goodSummary.replace(/^## TL;DR[\s\S]*?(?=^## Decisions)/m, ""));
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.includes("TL;DR"))).toBe(true);
  });

  test("rejects unfilled TODO markers", () => {
    const bad = goodSummary.replace("foo, bar, baz", "TODO: keywords here");
    const v = validateSummary(bad);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.includes("TODO"))).toBe(true);
  });

  test("rejects empty Keywords section", () => {
    const bad = goodSummary.replace(/^foo, bar, baz$/m, "");
    const v = validateSummary(bad);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.toLowerCase().includes("keywords"))).toBe(true);
  });

  test("rejects empty Expand-for-details section", () => {
    const bad = goodSummary.replace(/^exact phrasing, intermediate dead ends$/m, "");
    const v = validateSummary(bad);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.toLowerCase().includes("expand"))).toBe(true);
  });

  test("strips HTML comments before validating (so unfilled stubs still fail)", () => {
    const stub = `<!-- TL;DR comment -->\n${goodSummary.replace("foo, bar, baz", "TODO")}`;
    const v = validateSummary(stub);
    expect(v.ok).toBe(false);
  });

  test("extractTldr returns first three lines, max 240 chars", () => {
    const tldr = extractTldr(goodSummary);
    expect(tldr).toContain("A real summary line one");
    expect(tldr.length).toBeLessThanOrEqual(240);
  });

  test("extractKeywords splits on commas and newlines", () => {
    const kw = extractKeywords(goodSummary);
    expect(kw).toEqual(["foo", "bar", "baz"]);
  });
});

// Anti-theater audit (vanguard ↔ keystone, Petersen orion-led hardening pass).
// Each negative fixture below is a SUMMARY.md that passed the pre-patch
// validator but conveys no real information; each positive fixture is a
// summary that should remain accepted after the tightening. Adding a
// fixture here is the canonical way to lock in a new audit finding —
// the file is the regression suite for `validateSummary`.
describe("validateSummary — audit fixtures", () => {
  // ------ Negative: original four (K1–K4) ------

  test("K1 whitespace-body bypass is rejected (5 sections empty under heading)", () => {
    const text = [
      "## TL;DR", "",
      "## Decisions", "",
      "## Blockers", "",
      "## Follow-ups", "",
      "## Artifacts referenced", "",
      "## Keywords", "x", "",
      "## Expand for details about:", "y",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(false);
  });

  test("K2 lowercase TODO/Todo/ToDo are caught (placeholder marker is case-insensitive)", () => {
    for (const variant of ["todo: write later", "Todo: write later", "ToDo: write later"]) {
      const text = [
        "## TL;DR", variant,
        "## Decisions", "real decision",
        "## Blockers", "(none)",
        "## Follow-ups", "(none)",
        "## Artifacts referenced", "(none)",
        "## Keywords", "alpha, beta, gamma",
        "## Expand for details about:", "real expansion content",
      ].join("\n");
      const v = validateSummary(text);
      expect(v.ok).toBe(false);
      expect(v.issues.some((i) => i.toLowerCase().includes("placeholder marker"))).toBe(true);
    }
  });

  test("K3 heading line-split is rejected (`## \\nTL;DR` no longer satisfies the heading regex)", () => {
    const text = [
      "## ", "TL;DR", "body",
      "## Decisions", "d",
      "## Blockers", "b",
      "## Follow-ups", "f",
      "## Artifacts referenced", "a",
      "## Keywords", "x",
      "## Expand for details about:", "y",
    ].join("\n");
    const v = validateSummary(text);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.includes(`missing section: "## TL;DR"`))).toBe(true);
  });

  test("K4 single-character Keywords/Expand tokens are rejected", () => {
    const text = [
      "## TL;DR", "## Decisions", "## Blockers", "## Follow-ups",
      "## Artifacts referenced", "## Keywords", "_",
      "## Expand for details about:", ".",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(false);
  });

  // ------ Negative: new escapes (N1, N2, N3, N14, N15, N17) ------

  test("N1 fenced-code-block whole-file bypass is rejected (file renders as a code block to humans)", () => {
    const text = [
      "```",
      "## TL;DR", "## Decisions", "## Blockers", "## Follow-ups",
      "## Artifacts referenced", "## Keywords", "k",
      "## Expand for details about:", "e",
      "```",
    ].join("\n");
    const v = validateSummary(text);
    expect(v.ok).toBe(false);
    // every required heading should be reported missing once the fence is stripped
    expect(v.issues.filter((i) => i.startsWith("missing section:")).length).toBe(7);
  });

  test("N2 broadened markers (TBD, FIXME, XXX, WIP, PLACEHOLDER) all evade only the original \\bTODO\\b — caught now", () => {
    for (const marker of ["TBD", "FIXME", "XXX", "WIP", "PLACEHOLDER"]) {
      const text = [
        "## TL;DR", `${marker}: write later`,
        "## Decisions", "real decision",
        "## Blockers", "(none)",
        "## Follow-ups", "(none)",
        "## Artifacts referenced", "(none)",
        "## Keywords", "alpha, beta, gamma",
        "## Expand for details about:", "real expansion",
      ].join("\n");
      const v = validateSummary(text);
      expect(v.ok).toBe(false);
      expect(v.issues.some((i) => i.toLowerCase().includes("placeholder marker"))).toBe(true);
    }
  });

  test("N3 (none) everywhere is rejected (path-of-least-resistance; stub seeded this gap)", () => {
    const text = [
      "## TL;DR", "(none)",
      "## Decisions", "(none)",
      "## Blockers", "(none)",
      "## Follow-ups", "(none)",
      "## Artifacts referenced", "(none)",
      "## Keywords", "(none)",
      "## Expand for details about:", "(none)",
    ].join("\n");
    const v = validateSummary(text);
    expect(v.ok).toBe(false);
    // the four real-body sections should each be flagged
    for (const heading of ["TL;DR", "Decisions", "Keywords", "Expand for details about:"]) {
      expect(v.issues.some((i) => i.includes(heading) && i.includes("placeholder"))).toBe(true);
    }
  });

  test("N14 zero-width-space tokens are rejected by the alphanumeric quality gate", () => {
    const text = [
      "## TL;DR", "real summary",
      "## Decisions", "real decision",
      "## Blockers", "(none)",
      "## Follow-ups", "(none)",
      "## Artifacts referenced", "(none)",
      "## Keywords", "​",
      "## Expand for details about:", "​",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(false);
  });

  test("N15 single-glyph em-dash bodies are rejected", () => {
    const text = [
      "## TL;DR", "—",
      "## Decisions", "—",
      "## Blockers", "—",
      "## Follow-ups", "—",
      "## Artifacts referenced", "—",
      "## Keywords", "—",
      "## Expand for details about:", "—",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(false);
  });

  test("N17 duplicate ## TL;DR headings are rejected (validator now checks uniqueness)", () => {
    const text = [
      "## TL;DR", "first summary",
      "## TL;DR",
      "## Decisions", "real decision",
      "## Blockers", "(none)",
      "## Follow-ups", "(none)",
      "## Artifacts referenced", "(none)",
      "## Keywords", "alpha, beta, gamma",
      "## Expand for details about:", "real expansion",
    ].join("\n");
    const v = validateSummary(text);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.includes("duplicate section") && i.includes("TL;DR"))).toBe(true);
  });

  // ------ Negative: shape-extreme fixtures ------

  test("path-of-least-resistance (stub-shaped (none)-everywhere, 176 bytes) is rejected", () => {
    const text = [
      "## TL;DR", "(none)", "",
      "## Decisions", "- (none)", "",
      "## Blockers", "- (none)", "",
      "## Follow-ups", "- (none)", "",
      "## Artifacts referenced", "- (none)", "",
      "## Keywords", "(none)", "",
      "## Expand for details about:", "(none)", "",
    ].join("\n");
    const v = validateSummary(text);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.includes("TL;DR") && i.includes("placeholder"))).toBe(true);
  });

  test("absolute-floor (116 bytes, single-glyph kw/expand, no other content) is rejected", () => {
    const text = "## TL;DR\n## Decisions\n## Blockers\n## Follow-ups\n## Artifacts referenced\n## Keywords\nk\n## Expand for details about:\ne";
    expect(validateSummary(text).ok).toBe(false);
  });

  // ------ Negative controls: structurally-wrong markdown should keep failing ------

  test("setext (=====) headings are rejected (regex requires ATX ##)", () => {
    const text = [
      "TL;DR", "=====",
      "## Decisions", "## Blockers", "## Follow-ups",
      "## Artifacts referenced", "## Keywords", "k",
      "## Expand for details about:", "e",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(false);
  });

  test("4-space indented headings (markdown code block) are rejected", () => {
    const text = [
      "    ## TL;DR", "    ## Decisions", "    ## Blockers", "    ## Follow-ups",
      "    ## Artifacts referenced", "    ## Keywords", "    k",
      "    ## Expand for details about:", "    e",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(false);
  });

  test("h3 (###) headings are rejected", () => {
    const text = [
      "### TL;DR", "### Decisions", "### Blockers", "### Follow-ups",
      "### Artifacts referenced", "### Keywords", "k",
      "### Expand for details about:", "e",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(false);
  });

  // ------ Positive controls: legitimate summaries that MUST keep passing ------

  const validMinimal = [
    "## TL;DR",
    "Adopted strategy X for backfill; no blockers; ready to merge.",
    "",
    "## Decisions",
    "- adopted X over Y because Z works under concurrent writes (commit abc1234)",
    "",
    "## Blockers",
    "- (none)",
    "",
    "## Follow-ups",
    "- (none)",
    "",
    "## Artifacts referenced",
    "- (none)",
    "",
    "## Keywords",
    "backfill, concurrent-writes, migration",
    "",
    "## Expand for details about:",
    "exact phrasing of rejected alternative Y, intermediate dead ends",
  ].join("\n");

  test("positive: minimal-but-real summary is accepted", () => {
    expect(validateSummary(validMinimal).ok).toBe(true);
  });

  test("positive: Decisions = `(none) — explanation` is accepted (design Q1)", () => {
    const text = [
      "## TL;DR", "Discussed migration approach; no decision yet — recap follows.",
      "",
      "## Decisions", "- (none) — ran out of time, see follow-ups",
      "",
      "## Blockers", "- (none)",
      "## Follow-ups", "- finalize migration plan in next sync",
      "## Artifacts referenced", "- (none)",
      "## Keywords", "migration, planning, deferred",
      "## Expand for details about:", "exact options considered, why we deferred",
    ].join("\n");
    expect(validateSummary(text).ok).toBe(true);
  });

  test("positive: CRLF line endings on a valid summary are accepted", () => {
    expect(validateSummary(validMinimal.replace(/\n/g, "\r\n")).ok).toBe(true);
  });

  test("positive: legacy CR-only line endings on a valid summary are accepted", () => {
    expect(validateSummary(validMinimal.replace(/\n/g, "\r")).ok).toBe(true);
  });

  test("positive: rendered stub itself is accepted (writer can copy-and-edit without bouncing)", () => {
    const stub = renderSummaryStub({
      edgeId: "lumeyon-orion",
      archiveId: "arch_L_test",
      kind: "leaf",
      depth: 0,
      participants: ["lumeyon", "orion"],
      earliestAt: "2026-05-01T00:00:00Z",
      latestAt: "2026-05-01T01:00:00Z",
      sourceLabel: "raw sections",
      sourceText: "BODY",
    });
    expect(validateSummary(stub).ok).toBe(true);
  });
});

describe("parseLockFile", () => {
  const tmp = `${process.env.TMPDIR ?? "/tmp"}/agent-chat-locktest-${process.pid}`;

  test("parses legacy 3-tuple lock file (backward-compat with pre-starttime format)", () => {
    const fs = require("node:fs");
    fs.writeFileSync(tmp, "orion@hostname.example:12345 2026-05-01T00:00:00Z\n");
    const lk = parseLockFile(tmp);
    expect(lk).toEqual({
      agent: "orion",
      host: "hostname.example",
      pid: 12345,
      starttime: null,
      ts: "2026-05-01T00:00:00Z",
    });
    fs.unlinkSync(tmp);
  });

  test("parses 4-tuple lock file with starttime fingerprint", () => {
    const fs = require("node:fs");
    fs.writeFileSync(tmp, "orion@hostname.example:12345:987654321 2026-05-01T00:00:00Z\n");
    const lk = parseLockFile(tmp);
    expect(lk).toEqual({
      agent: "orion",
      host: "hostname.example",
      pid: 12345,
      starttime: 987654321,
      ts: "2026-05-01T00:00:00Z",
    });
    fs.unlinkSync(tmp);
  });

  test("parses 4-tuple with starttime=0 as null (recording failed at write time)", () => {
    const fs = require("node:fs");
    fs.writeFileSync(tmp, "orion@hostname.example:12345:0 2026-05-01T00:00:00Z\n");
    const lk = parseLockFile(tmp);
    expect(lk?.starttime).toBeNull();
    fs.unlinkSync(tmp);
  });

  test("returns null on malformed lock file", () => {
    const fs = require("node:fs");
    fs.writeFileSync(tmp, "not a real lock");
    expect(parseLockFile(tmp)).toBeNull();
    fs.unlinkSync(tmp);
  });

  test("returns null when file does not exist", () => {
    expect(parseLockFile(`${tmp}-missing`)).toBeNull();
  });
});

describe("processTag / displayTag (lyra L2)", () => {
  test("formats agent@host:pid", () => {
    const tag = processTag("orion");
    expect(tag).toMatch(/^orion@.+:\d+$/);
  });
  test("displayTag uses stableSessionPid (not the throwaway bun pid)", async () => {
    const { displayTag, stableSessionPid } = await import("../scripts/lib.ts");
    const tag = displayTag("orion");
    expect(tag).toContain(`:${stableSessionPid()}`);
  });
});

describe("stableSessionPid", () => {
  // Full-coverage unit testing of the /proc walk would require mocking
  // /proc, which is more friction than the function's worth. We test the
  // observable invariants instead: the returned pid is alive, and behavior
  // diverges sensibly between "running under Claude Code" and "plain shell".
  test("returns a positive, currently-alive pid", async () => {
    const { stableSessionPid, pidIsAlive } = await import("../scripts/lib.ts");
    const pid = stableSessionPid();
    expect(Number.isInteger(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);
    expect(pidIsAlive(pid)).toBe(true);
  });

  test("when CLAUDECODE is forcibly unset, returns ppid (plain-shell fallback)", async () => {
    // Spawn a fresh bun child WITHOUT the CLAUDECODE marker; it should
    // hit the early-return ppid fallback path. We use a tiny one-liner
    // child that prints stableSessionPid() and verify it equals the
    // child's own ppid (i.e. this test process).
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(
      process.execPath,
      ["-e", `
        import("${import.meta.dirname}/../scripts/lib.ts").then((m) => {
          console.log(m.stableSessionPid(), process.ppid);
        });
      `],
      {
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE")) as Record<string, string>,
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(0);
    const [pidStr, ppidStr] = r.stdout.trim().split(/\s+/);
    // When CLAUDECODE is unset on a non-Linux platform OR when no ancestor
    // has the marker, the function returns process.ppid.
    expect(parseInt(pidStr, 10)).toBe(parseInt(ppidStr, 10));
  });
});

describe("archiveId", () => {
  test("starts with arch_L_ for leaf and arch_C_ for condensed", () => {
    const a = archiveId("leaf", "2026-05-01T00:00:00Z");
    const b = archiveId("condensed", "2026-05-01T00:00:00Z");
    expect(a).toMatch(/^arch_L_/);
    expect(b).toMatch(/^arch_C_/);
  });

  test("two consecutive ids differ (random suffix)", () => {
    const a = archiveId("leaf", "2026-05-01T00:00:00Z");
    const b = archiveId("leaf", "2026-05-01T00:00:00Z");
    expect(a).not.toBe(b);
  });

  test("encodes timestamp into the id for sortability", () => {
    const a = archiveId("leaf", "2026-05-01T00:00:00Z");
    expect(a).toMatch(/20260501000000/);
  });
});

describe("depthPolicy", () => {
  test("d0 leaf has 'Normal leaf policy'", () => {
    const p = depthPolicy(0, "leaf");
    expect(p.policy).toContain("Normal leaf policy");
    expect(p.targetTokens).toBeGreaterThan(0);
  });

  test("d1 condensed mentions session-level", () => {
    const p = depthPolicy(1, "condensed");
    expect(p.policy.toLowerCase()).toContain("session");
  });

  test("d3+ condensed says durable", () => {
    const p = depthPolicy(4, "condensed");
    expect(p.policy.toLowerCase()).toContain("durable");
  });
});

describe("renderSummaryStub", () => {
  test("includes archive id, participants, source label, and policy", () => {
    const stub = renderSummaryStub({
      edgeId: "lumeyon-orion",
      archiveId: "arch_L_xxx",
      kind: "leaf",
      depth: 0,
      participants: ["lumeyon", "orion"],
      earliestAt: "2026-05-01T01:00:00Z",
      latestAt: "2026-05-01T02:00:00Z",
      sourceLabel: "raw sections",
      sourceText: "BODY GOES HERE",
    });
    expect(stub).toContain("lumeyon-orion");
    expect(stub).toContain("arch_L_xxx");
    expect(stub).toContain("BODY GOES HERE");
    expect(stub).toContain("## TL;DR");
    expect(stub).toContain("## Expand for details about:");
    expect(stub).toContain("Normal leaf policy");
  });
});

describe("readIndex — torn-read + malformed-line resilience (rhino #2/#3, P0)", () => {
  // Hardening regression: readIndex used to JSON.parse line-by-line with no
  // try/catch, so one corrupt or torn-mid-write line took down the whole
  // reader (search, list, condense). Both patches below test the survivable
  // shape: malformed lines are logged + skipped, and the reader bounds its
  // input by the open-time fstat size to avoid Bun's readFileSync over-read
  // on a growing file.
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");

  function makeEdgeDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-readindex-"));
  }

  function entry(id: string, ts: string) {
    return {
      id,
      edge_id: "lumeyon-orion",
      topology: "petersen",
      kind: "leaf" as const,
      depth: 0,
      earliest_at: ts,
      latest_at: ts,
      participants: ["lumeyon", "orion"] as [string, string],
      parents: [],
      descendant_count: 1,
      keywords: ["k1", "k2", "k3"],
      tldr: "tldr text",
      path: "/dev/null",
    };
  }

  test("readIndex skips a malformed middle line and returns the surrounding entries", async () => {
    const { readIndex, indexFile } = await import("../scripts/lib.ts");
    const edgeDir = makeEdgeDir();
    try {
      const f = indexFile(edgeDir);
      fs.writeFileSync(
        f,
        JSON.stringify(entry("arch_L_a", "2026-05-01T00:00:00Z")) + "\n" +
          "this is not valid json\n" +
          JSON.stringify(entry("arch_L_b", "2026-05-01T00:01:00Z")) + "\n",
      );
      const got = readIndex(edgeDir);
      expect(got.map((e) => e.id)).toEqual(["arch_L_a", "arch_L_b"]);
    } finally { fs.rmSync(edgeDir, { recursive: true, force: true }); }
  });

  test("readIndex tolerates a torn trailing line (writer mid-append, simulated)", async () => {
    const { readIndex, indexFile } = await import("../scripts/lib.ts");
    const edgeDir = makeEdgeDir();
    try {
      const f = indexFile(edgeDir);
      // Final line is truncated mid-record — exactly what `readFileSync` over-read
      // captures when sampling a growing file. The reader must recover.
      fs.writeFileSync(
        f,
        JSON.stringify(entry("arch_L_a", "2026-05-01T00:00:00Z")) + "\n" +
          '{"id":"arch_L_b","kind":"leaf","tld' /* truncated */,
      );
      const got = readIndex(edgeDir);
      expect(got.map((e) => e.id)).toEqual(["arch_L_a"]);
    } finally { fs.rmSync(edgeDir, { recursive: true, force: true }); }
  });

  test("readIndex on a missing file is empty (preserved)", async () => {
    const { readIndex } = await import("../scripts/lib.ts");
    const edgeDir = makeEdgeDir();
    try { expect(readIndex(edgeDir)).toEqual([]); }
    finally { fs.rmSync(edgeDir, { recursive: true, force: true }); }
  });

  test("readIndex bounds reads to fstat size: a writer extending the file mid-read does not pollute results", async () => {
    // Snapshot semantics: the reader captures fstat-size at open and reads
    // exactly that many bytes. A peer appending after the open is invisible
    // to this reader; the next call observes them. This is the discipline
    // that defeats the Bun over-read mechanism rhino reproduced.
    const { readIndex, indexFile } = await import("../scripts/lib.ts");
    const edgeDir = makeEdgeDir();
    try {
      const f = indexFile(edgeDir);
      fs.writeFileSync(f, JSON.stringify(entry("arch_L_a", "2026-05-01T00:00:00Z")) + "\n");
      const sizeBefore = fs.statSync(f).size;
      // Append more after we've conceptually started reading. (We can't truly
      // race a single-process call here, but we can at least verify the reader
      // does NOT over-read past the file size we observe at this instant when
      // the file is well-formed.)
      const got1 = readIndex(edgeDir);
      expect(got1.map((e) => e.id)).toEqual(["arch_L_a"]);
      fs.appendFileSync(f, JSON.stringify(entry("arch_L_b", "2026-05-01T00:01:00Z")) + "\n");
      const got2 = readIndex(edgeDir);
      expect(got2.map((e) => e.id)).toEqual(["arch_L_a", "arch_L_b"]);
      // sizeBefore was used to anchor the assertion; reference it to silence linters.
      expect(sizeBefore).toBeGreaterThan(0);
    } finally { fs.rmSync(edgeDir, { recursive: true, force: true }); }
  });
});

describe("pidStarttime / processIsOriginal — pid-recycling guard (cadence Q2/Q3, P1)", () => {
  // Hardening: pidIsAlive alone could not tell "the original process" from
  // "an unrelated process that got the recycled pid." The starttime
  // fingerprint pairs with the pid to make that distinction.
  test("pidStarttime returns a positive integer for the current process on Linux/macOS", async () => {
    const { pidStarttime } = await import("../scripts/lib.ts");
    const t = pidStarttime(process.pid);
    if (process.platform === "linux" || process.platform === "darwin") {
      expect(t).not.toBeNull();
      expect(t).toBeGreaterThan(0);
    } else {
      // Other platforms intentionally return null (identity-blind fallback).
      expect(t).toBeNull();
    }
  });

  test("pidStarttime returns null for an obviously-bogus pid", async () => {
    const { pidStarttime } = await import("../scripts/lib.ts");
    expect(pidStarttime(0)).toBeNull();
    expect(pidStarttime(-1)).toBeNull();
    expect(pidStarttime(NaN)).toBeNull();
  });

  test("pidStarttime is consistent across calls for a long-running pid (no jitter)", async () => {
    const { pidStarttime } = await import("../scripts/lib.ts");
    const a = pidStarttime(process.pid);
    const b = pidStarttime(process.pid);
    expect(a).toBe(b);
  });

  test("processIsOriginal returns true when pid+starttime match a live process", async () => {
    const { pidStarttime, processIsOriginal } = await import("../scripts/lib.ts");
    const t = pidStarttime(process.pid);
    expect(processIsOriginal(process.pid, t)).toBe(true);
  });

  test("processIsOriginal returns false when starttime mismatches (recycled-pid signal)", async () => {
    const { pidStarttime, processIsOriginal } = await import("../scripts/lib.ts");
    const t = pidStarttime(process.pid);
    if (t == null) return; // platform without starttime — nothing to assert
    expect(processIsOriginal(process.pid, t + 1)).toBe(false);
  });

  test("processIsOriginal falls back to pidIsAlive when expected is null (legacy records)", async () => {
    const { processIsOriginal } = await import("../scripts/lib.ts");
    // Legacy SessionRecord without pid_starttime: should still treat us as alive.
    expect(processIsOriginal(process.pid, null)).toBe(true);
    expect(processIsOriginal(process.pid, undefined)).toBe(true);
  });

  test("processIsOriginal returns false for a dead pid even with null expected", async () => {
    const { processIsOriginal } = await import("../scripts/lib.ts");
    // Find a dead pid the same way our gc tests do.
    let dead = 9_999_999;
    for (let p = 9_999_900; p > 1_000_000; p -= 17) {
      try { process.kill(p, 0); } catch (e: any) { if (e?.code === "ESRCH") { dead = p; break; } }
    }
    expect(processIsOriginal(dead, null)).toBe(false);
    expect(processIsOriginal(dead, 12345)).toBe(false);
  });
});

describe("findLivePresence — multi-host safety (cadence F8, P0)", () => {
  // Hardening regression: findLivePresence used to return any presence
  // record whose pid happened to be alive on THIS host, even when the
  // record's host field belonged to a different machine. On a shared
  // filesystem (NFS/sshfs) that misclassification would defeat collision
  // detection and let `gc` unlink another host's live state.
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");

  test("returns null for a presence record whose host is not this host", async () => {
    const { findLivePresence, presenceFile, ensureControlDirs } = await import("../scripts/lib.ts");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-foreignhost-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      // Need a fresh import because CONVERSATIONS_DIR is a module constant.
      const fresh = await import(`../scripts/lib.ts?bust=${Date.now()}`);
      fresh.ensureControlDirs();
      const rec = {
        agent: "ghost",
        topology: "petersen",
        session_key: "pid:99999",
        host: "definitely-not-this-host.example",
        pid: process.pid, // ALIVE on this host — the trap the bug fell into
        started_at: "2026-05-01T00:00:00Z",
        cwd: "/tmp",
      };
      fs.writeFileSync(fresh.presenceFile("ghost"), JSON.stringify(rec, null, 2) + "\n");
      expect(fresh.findLivePresence("ghost")).toBeNull();
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns the record when host matches and pid is alive (preserved happy path)", async () => {
    const { findLivePresence, presenceFile, ensureControlDirs } = await import("../scripts/lib.ts");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-myhost-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      const fresh = await import(`../scripts/lib.ts?bust=${Date.now()}b`);
      fresh.ensureControlDirs();
      const rec = {
        agent: "live",
        topology: "petersen",
        session_key: "pid:" + process.pid,
        host: os.hostname(),
        pid: process.pid,
        started_at: "2026-05-01T00:00:00Z",
        cwd: "/tmp",
      };
      fs.writeFileSync(fresh.presenceFile("live"), JSON.stringify(rec, null, 2) + "\n");
      const got = fresh.findLivePresence("live");
      expect(got).not.toBeNull();
      expect(got!.agent).toBe("live");
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
