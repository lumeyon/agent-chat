// tests/topology-roles.test.ts — Round 15f: per-agent role definitions.
//
// Pins the YAML parser's ability to read multi-line block-scalar roles
// from agents.<topology>.yaml and the petersen.yaml pre-populated set.

import { test, expect, describe } from "bun:test";
import { parseTopologyYaml, loadTopology } from "../scripts/lib.ts";

describe("topology roles — Round-15f parser", () => {
  test("petersen.yaml ships with roles for all 10 agents", () => {
    const topo = loadTopology("petersen");
    // Note: loadTopology overlays users.yaml, so .agents includes humans.
    // Roles are AI-side only; check that all 10 declared AI agents have roles.
    const aiAgents = ["orion", "lumeyon", "lyra", "keystone", "sentinel",
                      "vanguard", "carina", "pulsar", "cadence", "rhino"];
    expect(topo.roles).toBeDefined();
    for (const a of aiAgents) {
      expect(topo.roles?.[a]).toBeDefined();
      expect(topo.roles?.[a]?.length).toBeGreaterThan(20);
    }
  });

  test("orion's role mentions 'orchestrator'", () => {
    const topo = loadTopology("petersen");
    expect(topo.roles?.orion?.toLowerCase()).toContain("orchestrator");
  });

  test("parses inline single-line role values", () => {
    const yaml = `
topology: pair
agents:
  - alpha
  - beta
edges:
  - [alpha, beta]
roles:
  alpha: First agent.
  beta: Second agent.
`;
    const t = parseTopologyYaml(yaml);
    expect(t.roles?.alpha).toBe("First agent.");
    expect(t.roles?.beta).toBe("Second agent.");
  });

  test("parses block-scalar (|) multi-line role values", () => {
    const yaml = `
topology: pair
agents:
  - alpha
  - beta
edges:
  - [alpha, beta]
roles:
  alpha: |
    First line.
    Second line.
    Third line.
  beta: |
    Beta one.
`;
    const t = parseTopologyYaml(yaml);
    expect(t.roles?.alpha).toContain("First line.");
    expect(t.roles?.alpha).toContain("Second line.");
    expect(t.roles?.alpha).toContain("Third line.");
    expect(t.roles?.beta).toBe("Beta one.");
  });

  test("topology with no roles section parses cleanly (roles undefined or empty)", () => {
    const yaml = `
topology: pair
agents:
  - alpha
  - beta
edges:
  - [alpha, beta]
`;
    const t = parseTopologyYaml(yaml);
    // Either undefined or an empty object — both signal "no roles declared."
    expect(!t.roles || Object.keys(t.roles).length === 0).toBe(true);
  });

  test("invalid agent name in roles section is silently ignored (parser lenience)", () => {
    // The role-name regex `[a-z0-9_-]+` rejects path-traversal characters
    // at the regex level (quoted keys, slashes, etc don't match the role-
    // head pattern), so the line is simply not recognized as a role
    // declaration. The valid roles are parsed normally.
    const yaml = `
topology: pair
agents:
  - alpha
  - beta
edges:
  - [alpha, beta]
roles:
  alpha: Real role.
  "../etc/passwd": Bad name should be ignored.
  beta: Another real role.
`;
    const t = parseTopologyYaml(yaml);
    expect(t.roles?.alpha).toBe("Real role.");
    expect(t.roles?.beta).toBe("Another real role.");
    expect(Object.keys(t.roles ?? {})).not.toContain("../etc/passwd");
  });
});
