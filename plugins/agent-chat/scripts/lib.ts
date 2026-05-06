// Shared helpers for agent-chat scripts. No external deps — uses Node std only.
// Compatible with `bun`, `tsx`, and `node --experimental-strip-types` (Node 23+).

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";

export type Topology = {
  topology: string;
  description?: string;
  agents: string[];
  edges: [string, string][];
  // Round-15d: graph diameter computed at load time (BFS from every node).
  // Used as the max-depth ceiling for ephemeral sub-relay chains. Petersen=2,
  // ring=5, star=2, pair=1. Computed lazily; cached.
  _diameter?: number;
  // Round-15f: per-agent role definitions. When the agent dispatches an
  // ephemeral peer via `claude -p`, cmdRun prepends the role text to the
  // spawned subprocess's prompt so each peer has a coherent specialty
  // instead of a generic "you are <name>" persona. Optional — agents
  // without roles default to a generic prompt.
  //
  // YAML shape:
  //   roles:
  //     orion: |
  //       Orchestrator. Decomposes user questions into slices and
  //       dispatches to peer specialists.
  //     lumeyon: |
  //       Architecture and systems analyst. Deep code reading.
  roles?: Record<string, string>;
  // Round-15l: per-agent runtime selection. Some agents may run under
  // Claude Code (the original target), others under Codex. cmdRun reads
  // this field via resolveRuntime() to pick the right dispatch adapter
  // (scripts/runtimes/<name>.ts). Optional — agents without an explicit
  // runtime fall back to env var → auto-detect via PATH.
  //
  // YAML shape:
  //   runtimes:
  //     orion: claude
  //     lumeyon: claude
  //     cadence: codex
  runtimes?: Record<string, string>;
};

// Round-15d: compute the graph diameter (longest shortest-path between any
// two nodes). Sub-relay chains are bounded to this depth: a peer dispatched
// from orion may dispatch to its neighbor, who may dispatch to its neighbor,
// and so on — but the recursion stops when the chain length equals the
// graph's diameter. Beyond that, every node is reachable in fewer hops via
// a different path, so deeper recursion would be a cycle or a less-direct
// route. User directive at Round-15d: "max-depth is 2 for petersen but it
// may be more for other graphs."
export function computeDiameter(topo: Topology): number {
  if (topo._diameter != null) return topo._diameter;
  // Build adjacency list.
  const adj = new Map<string, Set<string>>();
  for (const a of topo.agents) adj.set(a, new Set());
  for (const [a, b] of topo.edges) {
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  let diameter = 0;
  // BFS from every node; track max distance.
  for (const start of topo.agents) {
    const dist = new Map<string, number>();
    dist.set(start, 0);
    const queue: string[] = [start];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const d = dist.get(cur)!;
      for (const nbr of adj.get(cur) ?? []) {
        if (!dist.has(nbr)) {
          dist.set(nbr, d + 1);
          queue.push(nbr);
        }
      }
    }
    for (const d of dist.values()) {
      if (d > diameter) diameter = d;
    }
  }
  topo._diameter = diameter;
  return diameter;
}

// agents.users.yaml — orthogonal user registry overlaid onto any topology
// at loadTopology time. Slice 1 of the multi-user transparency refactor:
// users.yaml membership IS the human marker (no `kind: ai|human` schema
// field needed). record-turn checks `users.includes(speaker) && !users.includes(agent)`
// to gate human→AI flow; AI-to-AI flow uses turn.ts directly.
export type User = {
  name: string;
  default?: boolean;
};

export type Identity = {
  name: string;
  topology: string;
  source: string; // "env" | ".agent-name" | "cli"
};

// SKILL_ROOT is the directory containing this scripts/ folder's parent.
// Resolved relative to this file so the skill can live anywhere.
export const SKILL_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

// Plugin config: ~/.claude/data/agent-chat/config.json. Read once at module
// load. Used to let the Claude-Code plugin and the (future) Codex plugin point
// at the SAME conversations dir without each user fiddling with env vars in
// every shell. The file is optional; if absent, defaults apply.
//
// Schema (fields are all optional):
//   {
//     "conversations_dir": "/absolute/path/for/shared/state",
//     "dot_axes": ["clarity", "depth", "reliability", "speed"]
//   }
//
// dot_axes (Round-15k Item-8): override the four-axis Dot Collector default
// with a user-chosen set. Useful when an organization wants different
// believability dimensions (e.g. ["creativity", "rigor", "specificity",
// "openness"] for an R&D mesh, or ["correctness", "completeness", "speed"]
// for a code-review mesh). Constraints:
//   - 1-8 axes (anything more bloats the cmdRun prompt)
//   - each axis name 1-32 chars, [a-z0-9_-]+ (filesystem + regex safe)
//   - all 10 agents must agree (read from the same config.json — that's why
//     it lives at user-global ~/.claude/data/agent-chat/config.json)
// If invalid, falls through to the default 4-axis set with a warning.
export type AgentChatConfig = {
  conversations_dir?: string;
  dot_axes?: string[];
};
export const CONFIG_PATH = path.join(
  os.homedir(),
  ".claude",
  "data",
  "agent-chat",
  "config.json",
);

function loadConfig(): AgentChatConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[agent-chat] config at ${CONFIG_PATH}: expected object, ignoring`);
      return {};
    }
    const cfg: AgentChatConfig = {};
    if (parsed.conversations_dir != null) {
      if (typeof parsed.conversations_dir !== "string" || !path.isAbsolute(parsed.conversations_dir)) {
        console.warn(`[agent-chat] config.conversations_dir must be an absolute path string, ignoring`);
      } else {
        cfg.conversations_dir = parsed.conversations_dir;
      }
    }
    if (parsed.dot_axes != null) {
      const arr = parsed.dot_axes;
      const AXIS_NAME_RE = /^[a-z0-9_-]{1,32}$/i;
      if (!Array.isArray(arr)) {
        console.warn(`[agent-chat] config.dot_axes must be an array, ignoring`);
      } else if (arr.length < 1 || arr.length > 8) {
        console.warn(`[agent-chat] config.dot_axes must have 1-8 entries (got ${arr.length}), ignoring`);
      } else if (!arr.every((a) => typeof a === "string" && AXIS_NAME_RE.test(a))) {
        console.warn(`[agent-chat] config.dot_axes entries must each be a 1-32 char [a-z0-9_-] string, ignoring`);
      } else if (new Set(arr).size !== arr.length) {
        console.warn(`[agent-chat] config.dot_axes contains duplicates, ignoring`);
      } else {
        cfg.dot_axes = arr.map((a: string) => a.toLowerCase());
      }
    }
    return cfg;
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    console.warn(`[agent-chat] failed to read config at ${CONFIG_PATH}: ${e?.message ?? e}`);
    return {};
  }
}

export const CONFIG: AgentChatConfig = loadConfig();

// Conversations directory: user-global by default so state is shared across
// projects, plugin-cache version dirs, AND across runtimes (Claude + Codex
// plugins read the same config.json). Resolution order:
//   1. $AGENT_CHAT_CONVERSATIONS_DIR env var (highest — tests & per-shell)
//   2. config.json `conversations_dir` field (cross-runtime sharing)
//   3. ~/.claude/data/agent-chat/conversations/ (default)
//
// Topology yaml files always live under SKILL_ROOT — only runtime state
// (CONVO.md, .turn, archives, .sessions, .presence) follows this override.
//
// Why user-global rather than <skill>/conversations: a plugin install resolves
// SKILL_ROOT to ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/, so
// every version bump would orphan all prior wire-state. And two installs (cache
// vs. legacy ~/.claude/skills) would talk past each other on different files.
export const CONVERSATIONS_DIR = process.env.AGENT_CHAT_CONVERSATIONS_DIR
  ? path.resolve(process.env.AGENT_CHAT_CONVERSATIONS_DIR)
  : CONFIG.conversations_dir
    ? path.resolve(CONFIG.conversations_dir)
    : path.join(os.homedir(), ".claude", "data", "agent-chat", "conversations");

// Tiny YAML parser for our limited schema:
//   topology: <name>
//   description: <text>
//   agents: [list of strings, one per dash line]
//   edges:  [list of two-element arrays, e.g. - [a, b]]
// Anything richer is rejected — keeps the skill auditable. The top-level
// key allowlist (lumeyon P2) refuses unrecognized keys including the
// prototype-pollution vectors `__proto__`/`constructor`/`prototype`. Agent
// names are restricted to a safe character class so they can be used in
// filesystem paths (lock body, presence file, log file) without escaping.
const ALLOWED_TOP_KEYS = new Set(["topology", "description", "agents", "edges", "roles", "runtimes"]);
const ALLOWED_RUNTIMES = new Set(["claude", "codex"]);
const AGENT_NAME_RE = /^[a-z0-9_-]{1,40}$/i;

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

export function parseTopologyYaml(text: string): Topology {
  const lines = text.split(/\r?\n/);
  const out: any = Object.create(null);
  out.agents = [];
  out.edges = [];
  out.roles = Object.create(null);
  out.runtimes = Object.create(null);
  let section: "agents" | "edges" | "roles" | "runtimes" | null = null;
  // Round-15f: roles section uses block-scalar bodies (`|`) so role text
  // can span multiple lines. Track the current role being accumulated.
  let currentRoleAgent: string | null = null;
  let currentRoleLines: string[] = [];
  let currentRoleIndent = -1;
  const flushCurrentRole = () => {
    if (currentRoleAgent != null) {
      out.roles[currentRoleAgent] = currentRoleLines.join("\n").trim();
      currentRoleAgent = null;
      currentRoleLines = [];
      currentRoleIndent = -1;
    }
  };
  for (let raw of lines) {
    // Inside a roles block-scalar body, preserve content verbatim
    // (don't strip inline `#` — role text may legitimately contain #).
    const inRoleBody = section === "roles" && currentRoleAgent != null;
    const line = inRoleBody ? raw : raw.replace(/#.*$/, "");
    if (!inRoleBody && !line.trim()) continue;
    if (inRoleBody) {
      const indent = raw.match(/^(\s*)/)?.[1].length ?? 0;
      // Empty line inside body: keep, preserves paragraph breaks.
      if (!raw.trim()) { currentRoleLines.push(""); continue; }
      // Lines indented at-least-as-much as the opening line stay in the role.
      if (currentRoleIndent < 0) currentRoleIndent = indent;
      if (indent >= currentRoleIndent) {
        currentRoleLines.push(raw.slice(currentRoleIndent));
        continue;
      }
      // Less indent → role body ended; flush + fall through to outer parse.
      flushCurrentRole();
    }
    const top = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (top && !line.startsWith(" ") && !line.startsWith("\t")) {
      flushCurrentRole();
      const [, key, val] = top;
      if (!ALLOWED_TOP_KEYS.has(key)) {
        throw new Error(`unknown top-level yaml key "${key}" — allowed: ${[...ALLOWED_TOP_KEYS].join(", ")}`);
      }
      if (key === "agents") { section = "agents"; continue; }
      if (key === "edges") { section = "edges"; continue; }
      if (key === "roles") { section = "roles"; continue; }
      if (key === "runtimes") { section = "runtimes"; continue; }
      section = null;
      out[key] = val.trim();
      continue;
    }
    if (section === "runtimes") {
      // Round-15l: runtimes section is simple `agent: runtime` pairs
      // (no block-scalar — each value is a single token like "claude" or
      // "codex"). Parser is intentionally narrower than roles.
      const rt = line.match(/^\s+([a-z0-9_-]+):\s*([a-z]+)\s*$/i);
      if (rt) {
        const [, agent, runtime] = rt;
        if (!isValidAgentName(agent)) {
          throw new Error(`runtime declared for invalid agent name "${agent}"`);
        }
        if (!ALLOWED_RUNTIMES.has(runtime.toLowerCase())) {
          throw new Error(
            `unknown runtime "${runtime}" for agent "${agent}" — allowed: ${[...ALLOWED_RUNTIMES].join(", ")}`,
          );
        }
        out.runtimes[agent] = runtime.toLowerCase();
      }
      continue;
    }
    if (section === "roles") {
      // Match `<agent>: |` (block-scalar opener) or `<agent>: <inline-text>`.
      const roleHead = line.match(/^\s+([a-z0-9_-]+):\s*(\|?)\s*(.*)$/i);
      if (roleHead) {
        flushCurrentRole();
        const agent = roleHead[1];
        if (!isValidAgentName(agent)) {
          throw new Error(`role declared for invalid agent name "${agent}"`);
        }
        if (roleHead[2] === "|") {
          // Block-scalar — accumulate following indented lines.
          currentRoleAgent = agent;
          currentRoleLines = [];
          currentRoleIndent = -1;
        } else if (roleHead[3]) {
          // Inline value — single line role.
          out.roles[agent] = roleHead[3].trim();
        }
      }
      continue;
    }
    const dash = line.match(/^\s*-\s*(.*)$/);
    if (!dash) continue;
    const item = dash[1].trim();
    if (section === "agents") {
      if (!isValidAgentName(item)) {
        throw new Error(`invalid agent name "${item}" — must match ${AGENT_NAME_RE} (used in filesystem paths)`);
      }
      out.agents.push(item);
    } else if (section === "edges") {
      const m = item.match(/^\[\s*([^,\s]+)\s*,\s*([^,\s\]]+)\s*\]$/);
      if (!m) throw new Error(`bad edge syntax: ${item}`);
      if (!isValidAgentName(m[1]) || !isValidAgentName(m[2])) {
        throw new Error(`edge [${m[1]}, ${m[2]}] contains invalid agent name`);
      }
      out.edges.push([m[1], m[2]]);
    }
  }
  flushCurrentRole();
  if (typeof out.topology !== "string") throw new Error("topology field missing");
  if (!Array.isArray(out.agents) || out.agents.length === 0) throw new Error("agents list empty");
  if (!Array.isArray(out.edges) || out.edges.length === 0) throw new Error("edges list empty");
  // Drop empty roles map for cleanliness.
  if (Object.keys(out.roles).length === 0) delete out.roles;
  return out as Topology;
}

// Tiny parser for agents.users.yaml. Mirrors parseTopologyYaml's strictness:
// allowlist top-level keys (kills prototype-pollution shapes), validate the
// name regex, Object.create(null) for the output. Schema is a list of
// `- name: <id>` entries with an optional `default: true` flag (at most one
// per file; load-time validation in loadUsers enforces).
const ALLOWED_USERS_TOP_KEYS = new Set(["description", "users"]);

export function parseUsersYaml(text: string): User[] {
  const lines = text.split(/\r?\n/);
  const out: any = Object.create(null);
  out.users = [];
  let section: "users" | null = null;
  let pending: User | null = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "");
    if (!line.trim()) continue;
    const top = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (top && !line.startsWith(" ") && !line.startsWith("\t")) {
      if (pending) { out.users.push(pending); pending = null; }
      const [, key, val] = top;
      if (!ALLOWED_USERS_TOP_KEYS.has(key)) {
        throw new Error(`unknown top-level yaml key "${key}" in users.yaml — allowed: ${[...ALLOWED_USERS_TOP_KEYS].join(", ")}`);
      }
      if (key === "users") { section = "users"; continue; }
      section = null;
      out[key] = val.trim();
      continue;
    }
    if (section !== "users") continue;
    // List entries open with `- name: <id>`; subsequent indented `default: ...`
    // lines belong to the most recent entry. Greedy `.+` capture matches the
    // full post-colon value (including any quoted/spaced content), then we
    // validate via isValidAgentName so the rejection error mirrors topology
    // yaml's strictness — `"boss;rm -rf /"` throws rather than silently failing.
    const dashName = line.match(/^\s*-\s*name:\s*(.+)$/);
    if (dashName) {
      if (pending) { out.users.push(pending); }
      const name = dashName[1].trim();
      if (!isValidAgentName(name)) {
        throw new Error(`invalid user name "${name}" — must match ${AGENT_NAME_RE} (used in filesystem paths)`);
      }
      pending = { name };
      continue;
    }
    const indentedKv = line.match(/^\s+([a-z_]+):\s*(\S+)\s*$/i);
    if (indentedKv && pending) {
      const [, key, val] = indentedKv;
      if (key === "default") {
        pending.default = val.trim() === "true";
      } else {
        throw new Error(`unknown user attribute "${key}" — allowed: default`);
      }
      continue;
    }
    // Allow the dash-only-no-fields shorthand `- name` (without indented attrs).
    const dashOnly = line.match(/^\s*-\s*(.+)$/);
    if (dashOnly) {
      if (pending) { out.users.push(pending); }
      const name = dashOnly[1].trim();
      if (!isValidAgentName(name)) {
        throw new Error(`invalid user name "${name}" — must match ${AGENT_NAME_RE}`);
      }
      pending = { name };
      continue;
    }
  }
  if (pending) out.users.push(pending);
  if (!Array.isArray(out.users)) out.users = [];
  return out.users as User[];
}

// Read the orthogonal user registry. Returns [] if the file is missing
// (graceful degrade — pre-overlay sessions on petersen/ring/star/pair stay
// identical bit-for-bit). Re-reads on every call (matches loadTopology's
// no-cache pattern; the file is tiny). Validates at most one `default: true`
// and rejects duplicate names — both are load-time correctness invariants.
export function loadUsers(): User[] {
  const file = path.join(SKILL_ROOT, "agents.users.yaml");
  if (!fs.existsSync(file)) return [];
  const users = parseUsersYaml(fs.readFileSync(file, "utf8"));
  // No duplicate user names within the file.
  const seen = new Set<string>();
  for (const u of users) {
    if (seen.has(u.name)) {
      throw new Error(`duplicate user "${u.name}" in agents.users.yaml`);
    }
    seen.add(u.name);
  }
  // At most one default user. Multiple defaults would make
  // resolveDefaultSpeaker non-deterministic — refuse loudly.
  const defaults = users.filter((u) => u.default === true);
  if (defaults.length > 1) {
    throw new Error(`multiple default users in agents.users.yaml: ${defaults.map((u) => u.name).join(", ")}; expected at most one`);
  }
  return users;
}

export function loadTopology(topologyName: string): Topology {
  const file = path.join(SKILL_ROOT, `agents.${topologyName}.yaml`);
  if (!fs.existsSync(file)) {
    const choices = fs.readdirSync(SKILL_ROOT)
      .filter((f) => f.startsWith("agents.") && f.endsWith(".yaml") && f !== "agents.users.yaml")
      .map((f) => f.replace(/^agents\.|\.yaml$/g, ""))
      .join(", ");
    throw new Error(`no topology "${topologyName}" — available: ${choices}`);
  }
  const t = parseTopologyYaml(fs.readFileSync(file, "utf8"));
  // Validate every edge endpoint is a known agent (pre-merge, so AI-only edges
  // resolve against the AI agent set declared in the topology yaml).
  const aiKnown = new Set(t.agents);
  for (const [a, b] of t.edges) {
    if (!aiKnown.has(a) || !aiKnown.has(b)) {
      throw new Error(`edge [${a}, ${b}] references unknown agent`);
    }
    if (a === b) throw new Error(`self-loop edge [${a}, ${b}] not allowed`);
  }
  // Overlay agents.users.yaml. Lyra's design lever: merge users into t.agents
  // and derive user-AI + user-user edges into t.edges so every existing call
  // site (`topo.agents.includes(name)`, edge canonicalization, edgesOf,
  // neighborsOf) keeps working with zero per-site edits. Set-based dedup
  // makes the merge idempotent against topologies that already declare users
  // (e.g. agents.org.yaml).
  const users = loadUsers();
  if (users.length > 0) {
    // The AI-only set is t.agents minus anyone users.yaml claims as a human.
    // User-AI edges derive against this set so a topology that pre-declares
    // humans alongside AI in its own agents list (e.g. agents.org.yaml) gets
    // idempotent overlay: dedup-merging users back in is a no-op for both
    // agents and edges. record-turn's misroute defense uses
    // `users.includes(name)` as the human marker, so a name that appears in
    // both lists IS treated as a human (users.yaml wins).
    const userSet = new Set(users.map((u) => u.name));
    const aiNames = t.agents.filter((a) => !userSet.has(a));
    const userNames = users.map((u) => u.name);
    // Merge user names into the agent list (Set dedup; org's pre-declared
    // boss/john don't duplicate).
    const agentSet = new Set(t.agents);
    for (const u of userNames) {
      if (!agentSet.has(u)) {
        t.agents.push(u);
        agentSet.add(u);
      }
    }
    // Derive edges. Canonical-id Set dedup against pre-existing edges so org's
    // already-declared boss-orion / boss-john pairs don't duplicate.
    const edgeIdSet = new Set(t.edges.map(([a, b]) => edgeId(a, b)));
    for (const u of userNames) {
      for (const a of aiNames) {
        const id = edgeId(u, a);
        if (!edgeIdSet.has(id)) {
          t.edges.push([u, a]);
          edgeIdSet.add(id);
        }
      }
    }
    for (let i = 0; i < userNames.length; i++) {
      for (let j = i + 1; j < userNames.length; j++) {
        const id = edgeId(userNames[i], userNames[j]);
        if (!edgeIdSet.has(id)) {
          t.edges.push([userNames[i], userNames[j]]);
          edgeIdSet.add(id);
        }
      }
    }
  }
  // Round-15h Concern-2: agent-managed role overrides. After parsing the
  // YAML defaults, overlay any per-agent override file from
  // <conv>/.roles/<agent>.md. Override wins. This lets an agent evolve
  // their own role at runtime without editing the topology yaml — peers
  // re-read the topology on every cmdRun tick, so changes propagate
  // naturally. Missing override file is silent (use yaml default).
  const overlay = readRoleOverrides();
  if (Object.keys(overlay).length > 0) {
    t.roles = { ...(t.roles ?? {}), ...overlay };
  }
  return t;
}

// Identity resolution order:
//   1. $AGENT_NAME + $AGENT_TOPOLOGY env vars
//   2. ./.agent-name file (YAML: name + topology)
//   3. throw — never silently guess
//
// When env vars are set AND .agent-name also exists with different values,
// emit a stderr warning so the conflict is visible. This matters when two
// Claude/Codex sessions share a cwd: the file is shared, the env is per-shell,
// so a mismatch usually means the user forgot to override the env in one of
// the shells.
function readAgentNameFile(cwd: string): { name: string; topology: string } | null {
  const file = path.join(cwd, ".agent-name");
  if (!fs.existsSync(file)) return null;
  // Strip `# comment` per line to mirror parseTopologyYaml's tolerance —
  // pre-fix, `name: orion # main project` failed with a misleading "must
  // declare 'name:'" error (lyra L3).
  const text = fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, ""))
    .join("\n");
  const nameM = text.match(/^\s*name:\s*(\S+)\s*$/m);
  const topoM = text.match(/^\s*topology:\s*(\S+)\s*$/m);
  if (!nameM || !topoM) {
    throw new Error(`.agent-name at ${file} must declare 'name:' and 'topology:'`);
  }
  return { name: nameM[1], topology: topoM[1] };
}

// Per-session identity. Written by `agent-chat init`, read by every other
// script. Higher priority than env vars / .agent-name so that ten sessions
// sharing one cwd each get their own identity without the user having to
// touch shell variables. Keyed by Claude's session id when available, or
// the parent shell's pid otherwise — both are stable for the lifetime of
// the session and unique per terminal on a single host.
export type SessionRecord = {
  agent: string;
  topology: string;
  session_key: string;        // claude session id, or "ppid:<n>"
  claude_session_id?: string;
  host: string;
  pid: number;                // pid of the launcher / Claude session
  // Kernel start_time of `pid`, captured at init. Pairing pid+start_time
  // defeats pid-recycling: a pid that was reaped and reassigned to an
  // unrelated process will have a different start_time, so
  // `processIsOriginal` returns false even though `kill(pid, 0)` succeeds.
  // Linux: `/proc/<pid>/stat` field 22 (clock ticks since boot). macOS:
  // `ps -p <pid> -o lstart=` parsed to ms-since-epoch. Other platforms:
  // omitted; legacy records also omit; both fall back to identity-blind
  // pidIsAlive (current behavior). See cadence Q2/Q3.
  pid_starttime?: number;
  started_at: string;
  cwd: string;
  tty?: string;
  // Last speaker recorded by `agent-chat record-turn` in this session. Used
  // by record-turn to detect speaker switches and emit a handoff section on
  // the OLD edge before routing the next turn to the NEW edge. Optional so
  // legacy session records keep working unchanged.
  last_recorded_speaker?: string;
  // Round-15c (Contract A): synthetic SessionRecord pre-written by a
  // dispatcher (cmdRun --speaker, future human-AI ephemeral flows) before
  // spawning a `claude -p` ephemeral child. Distinguishes a synthetic
  // dispatcher-owned record from a normal interactive session. Optional;
  // legacy records omit; default false.
  ephemeral?: boolean;
};

export const SESSIONS_DIR = path.join(CONVERSATIONS_DIR, ".sessions");
export const PRESENCE_DIR = path.join(CONVERSATIONS_DIR, ".presence");

// Round-15a: ScheduleWakeup delay tuned to keep Anthropic's prompt cache
// warm. Cache TTL is 5 minutes; sleeping past 300s pays a full cache-miss
// (the next wake re-reads the full conversation context uncached, slow +
// expensive). 270s leaves 30s of margin for the wakeup latency itself.
// Empirical source: Ruflo plugins/ruflo-autopilot/skills/autopilot-loop/SKILL.md:18
// ("Always use delay 270s (under 300s cache TTL) to keep the prompt cache
// warm between iterations"). Single home for the constant so any future
// skill adopting the wakeup pattern reads the same value — same drift-
// insurance pattern as Round-13's STUCK_REASONS.
export const CACHE_WARM_DELAY_SEC = 270;

// Round-15d: per-agent scratchpad directory. The scratchpad is the agent's
// autobiographical narrative — their summary of their relationship with
// each peer, written in their own voice, persisted across ephemeral ticks.
// Read at the START of every cmdRun tick alongside the CONVO.md tail;
// written at the END of every tick the agent updates it. The file is
// the structural answer to "the same agent must know context from the
// distant past" under ephemeral-only execution.
//
// One file per agent (NOT per edge): the scratchpad is the agent's holistic
// memory across all their relationships. Per-edge memory lives in the
// CONVO.md archive layer. Scratchpad is small (default cap 8KB raw; older
// content gets archived into scratch.archives/ via scratch-condense).
export const SCRATCH_DIR = path.join(CONVERSATIONS_DIR, ".scratch");

// Default scratchpad size cap. Larger scratchpads get archived (see
// scratch-condense.ts). The cap balances "enough context for an agent
// to recall their relationship history" vs "doesn't bloat every prompt".
// 8KB ≈ 2000 tokens — modest fraction of even a small Claude context.
export const SCRATCHPAD_MAX_BYTES = 8 * 1024;

export function scratchPath(agent: string): string {
  // Sanitize agent name same way other per-agent paths do (lyra L1
  // pattern; defense against agent names that could escape the dir).
  const safe = agent.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(SCRATCH_DIR, `${safe}.md`);
}

function safeAgent(agent: string): string {
  return agent.replace(/[^A-Za-z0-9_-]/g, "_");
}

// Read the agent's scratchpad. Returns "" if no scratchpad exists yet
// (first tick for this agent). Caller composes prompt by prepending
// the scratchpad content; an empty scratchpad means the agent has no
// autobiographical context to draw on — which is correct for a
// freshly-introduced agent.
export function readScratch(agent: string): string {
  try {
    return fs.readFileSync(scratchPath(agent), "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

// Write the agent's scratchpad. Atomic write so concurrent reads (e.g.
// a sub-relay tick from a different process) don't see torn state.
// Caps content at SCRATCHPAD_MAX_BYTES — caller should have already
// triggered scratch-condense if approaching the cap.
export function writeScratch(agent: string, contents: string): void {
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  if (contents.length > SCRATCHPAD_MAX_BYTES) {
    // Hard cap: truncate with a marker. Caller should have condensed
    // before reaching this point; this is a safety net.
    contents = contents.slice(0, SCRATCHPAD_MAX_BYTES - 80) +
      "\n\n<!-- TRUNCATED at SCRATCHPAD_MAX_BYTES — run scratch-condense.ts -->\n";
  }
  writeFileAtomic(scratchPath(agent), contents, { mode: 0o600 });
}

// ── Round-15h Concern-2: agent-managed role overrides ───────────────────
//
// The topology YAML provides default roles; agents can write their own
// override at <conv>/.roles/<agent>.md and overlay-merge wins. Roles are
// re-read on every cmdRun tick (loadTopology calls readRoleOverrides), so
// an agent who updates their role on tick N has it visible to peers on
// tick N+1.
export const ROLES_DIR = path.join(CONVERSATIONS_DIR, ".roles");
export const ROLE_MAX_BYTES = 4 * 1024;

export function rolePath(agent: string): string {
  return path.join(ROLES_DIR, `${safeAgent(agent)}.md`);
}

export function readRoleOverride(agent: string): string | null {
  try {
    return fs.readFileSync(rolePath(agent), "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

export function readRoleOverrides(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(ROLES_DIR)) return out;
  for (const f of fs.readdirSync(ROLES_DIR)) {
    if (!f.endsWith(".md")) continue;
    const agent = f.slice(0, -3);
    try { out[agent] = fs.readFileSync(path.join(ROLES_DIR, f), "utf8"); } catch {}
  }
  return out;
}

export function writeRoleOverride(agent: string, body: string): void {
  fs.mkdirSync(ROLES_DIR, { recursive: true });
  if (body.length > ROLE_MAX_BYTES) {
    throw new Error(`role body too long (${body.length} bytes > cap ${ROLE_MAX_BYTES}); split into a scratchpad entry instead`);
  }
  writeFileAtomic(rolePath(agent), body, { mode: 0o600 });
}

export function clearRoleOverride(agent: string): boolean {
  try { fs.unlinkSync(rolePath(agent)); return true; }
  catch (e: any) { if (e?.code === "ENOENT") return false; throw e; }
}

// ── Round-15o: cross-edge crystallized lessons ──────────────────────────
//
// Closes the last open learning loop in agent-chat. Per-edge archives,
// per-agent scratchpads, Dot Collector, role overrides, and relay paths
// each close their own loop (today's writes change tomorrow's reads).
// Missing: cross-edge crystallized lessons — wisdom an agent extracts
// from many conversations, surfaced in future cmdRun prompts.
//
// Pattern that the tree-of-knowledge experiment got wrong (negative result
// on /data/lumeyon/tree-of-knowledge): EVIDENCE accumulated as append-only
// diary, but no read path consulted it during reasoning. Storage without
// surfacing is just a Wiki, not a learning system.
//
// Round-15o makes the loop close at the same surface that already closes
// the loops for scratchpad + roster + dots + roles: the cmdRun prompt.
// Agents emit `<lesson topic="...">body</lesson>` deliberately when they
// recognize something worth keeping. Lessons are surfaced (first line of
// each topic) at the start of every cmdRun tick. Same closing pattern,
// already-validated five times.
//
// Storage: <conv>/.lessons/<agent>/<topic>.md, append-only, with a
// `## YYYY-MM-DDTHH:MM:SSZ` header per addition so multiple lessons on
// the same topic accumulate as a dated trail.
//
// Topic name constraints: 1-64 chars matching [a-z0-9_-] (filesystem +
// regex safe; same character class as agent names but slightly wider
// length cap so topics can be specific without being awkward).
export const LESSONS_DIR = path.join(CONVERSATIONS_DIR, ".lessons");
export const LESSON_TOPIC_RE = /^[a-z0-9_-]{1,64}$/i;
export const LESSON_BODY_MAX_BYTES = 8 * 1024;
export const LESSON_PROMPT_BUDGET_BYTES = 2 * 1024;

export function isValidLessonTopic(topic: string): boolean {
  return LESSON_TOPIC_RE.test(topic);
}

export function lessonsAgentDir(agent: string): string {
  return path.join(LESSONS_DIR, safeAgent(agent));
}

export function lessonPath(agent: string, topic: string): string {
  if (!isValidLessonTopic(topic)) {
    throw new Error(`invalid lesson topic "${topic}"; must match ${LESSON_TOPIC_RE}`);
  }
  return path.join(lessonsAgentDir(agent), `${topic}.md`);
}

export function appendLesson(agent: string, topic: string, body: string): void {
  if (!isValidLessonTopic(topic)) {
    throw new Error(`invalid lesson topic "${topic}"; must match ${LESSON_TOPIC_RE}`);
  }
  const trimmed = body.trim();
  if (!trimmed) throw new Error(`lesson body refused: empty (use \`lessons clear <topic>\` to remove)`);
  if (trimmed.length > LESSON_BODY_MAX_BYTES) {
    throw new Error(`lesson body too long (${trimmed.length} bytes > cap ${LESSON_BODY_MAX_BYTES})`);
  }
  const dir = lessonsAgentDir(agent);
  fs.mkdirSync(dir, { recursive: true });
  const target = lessonPath(agent, topic);
  const ts = utcStamp();
  // Append-only: each addition gets a dated header so repeated lessons
  // on the same topic accumulate as a trail rather than overwriting.
  const block = (fs.existsSync(target) ? "\n\n" : "") + `## ${ts}\n\n${trimmed}\n`;
  fs.appendFileSync(target, block, { mode: 0o600 });
}

export function readLesson(agent: string, topic: string): string | null {
  try { return fs.readFileSync(lessonPath(agent, topic), "utf8"); }
  catch (e: any) { if (e?.code === "ENOENT") return null; throw e; }
}

export function listLessonTopics(agent: string): string[] {
  const dir = lessonsAgentDir(agent);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

export function clearLesson(agent: string, topic: string): boolean {
  try { fs.unlinkSync(lessonPath(agent, topic)); return true; }
  catch (e: any) { if (e?.code === "ENOENT") return false; throw e; }
}

/**
 * Compose the lessons block surfaced in cmdRun prompts. Returns the
 * first line of each lesson topic (the most-recent dated entry's first
 * non-empty line after its header), space-budgeted to LESSON_PROMPT_BUDGET_BYTES
 * so a long lessons history doesn't crowd out the rest of the prompt.
 *
 * Returns "" if no lessons exist for this agent.
 */
export function composeLessonsPromptBlock(agent: string): string {
  const topics = listLessonTopics(agent);
  if (topics.length === 0) return "";
  const lines: string[] = [];
  let bytesUsed = 0;
  for (const topic of topics) {
    const body = readLesson(agent, topic);
    if (!body) continue;
    // Find the LAST dated section (most recent), then its first non-empty
    // body line. This is the headline of the lesson.
    const sections = body.split(/^## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    const latest = sections[sections.length - 1] ?? "";
    const headline = latest.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    if (!headline) continue;
    const line = `  - ${topic}: ${headline}`;
    if (bytesUsed + line.length > LESSON_PROMPT_BUDGET_BYTES) {
      lines.push(`  - (${topics.length - lines.length} more lesson topic(s) — see \`agent-chat lessons list\`)`);
      break;
    }
    lines.push(line);
    bytesUsed += line.length + 1; // +1 for newline
  }
  return `Lessons you've crystallized from past exchanges (use \`agent-chat lessons get <topic>\` to expand):\n\n${lines.join("\n")}\n\n---\n\n`;
}

// ── Round-15h Concern-3: Dot Collector (Dalio-inspired peer rating) ─────
//
// Multidimensional grading. Each dot is one peer's rating of another peer's
// recent contribution along several axes (1-10). Stored as JSONL ledger
// per peer (the GRADEE) at <conv>/.dots/<peer>.jsonl. Append-only so the
// historical record is preserved; aggregation is computed on read.
//
// Believability (Dalio's concept): not all graders are equally credible.
// An agent who themselves has high dots-received counts more when grading
// others. We compute believability as the mean of an agent's received-axes
// scores (across all axes, all dots received, weighted equally), divided
// by 10. New agents start at 0.5 (neutral prior) until they accumulate dots.
//
// Aggregation: weighted mean of per-axis scores, where each dot's weight
// is the grader's believability. Returned alongside the unweighted mean
// for comparison.
export const DOTS_DIR = path.join(CONVERSATIONS_DIR, ".dots");

// Round-15k Item-8: DOT_AXES is config-driven. Defaults to the original
// Dalio-inspired 4-axis set ("clarity", "depth", "reliability", "speed"),
// overridden by config.json `dot_axes` (validated at module load — see
// loadConfig). The type widened from a discriminated union to plain string
// so the runtime list is the source of truth; invalid axes are still caught
// at appendDot/CLI/directive parse time against the runtime DOT_AXES list.
export const DEFAULT_DOT_AXES = ["clarity", "depth", "reliability", "speed"] as const;
export const DOT_AXES: readonly string[] = CONFIG.dot_axes ?? DEFAULT_DOT_AXES;
export type DotAxis = string;

export type Dot = {
  ts: string;
  grader: string;
  axes: Record<string, number>;
  note?: string;
};

export function dotsPath(peer: string): string {
  return path.join(DOTS_DIR, `${safeAgent(peer)}.jsonl`);
}

export function appendDot(peer: string, dot: Dot): void {
  fs.mkdirSync(DOTS_DIR, { recursive: true });
  fs.appendFileSync(dotsPath(peer), JSON.stringify(dot) + "\n", { mode: 0o600 });
}

export function readDots(peer: string): Dot[] {
  try {
    const raw = fs.readFileSync(dotsPath(peer), "utf8");
    const out: Dot[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d && typeof d.grader === "string" && d.axes && typeof d.axes === "object") {
          out.push(d as Dot);
        }
      } catch { /* skip malformed line */ }
    }
    return out;
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
}

export function readAllDots(): Record<string, Dot[]> {
  const out: Record<string, Dot[]> = {};
  if (!fs.existsSync(DOTS_DIR)) return out;
  for (const f of fs.readdirSync(DOTS_DIR)) {
    if (!f.endsWith(".jsonl")) continue;
    const peer = f.slice(0, -6);
    out[peer] = readDots(peer);
  }
  return out;
}

// Believability: per-agent score in [0, 1]. Computed from the agent's
// received dots — high scores received → high believability. Used as
// a weight when aggregating their grades of others.
//
// Round-15k Item-6: fixed-point iteration. Pre-fix, computeBelievability
// was a one-pass unweighted-mean computation: every grader contributed
// equally regardless of their own believability. That meant a low-quality
// grader (cadence's harshness, or worse: a misaligned agent's high noise)
// pulled receivers down by the same amount as a high-quality grader's
// signal. Worse: the function returned via early-continue with the 0.5
// prior, so an agent who had received zero dots had no way to "catch up"
// once grading started — their first grader weighted at 1.0 in the
// unweighted mean, distorting the network.
//
// Now: iterate. Initialize all agents at the 0.5 prior. On each pass,
// recompute every agent's believability as the believability-WEIGHTED
// mean of their received-axes scores (using the previous pass's weights).
// Iterate until convergence (max delta < 0.001) or MAX_ITERS hit. This
// is structurally what Dalio's DC does — the "believable" people's
// votes count more, recursively. Bounded: 5-10 iterations on a 10-agent
// petersen, sub-millisecond cost.
//
// Edge cases: agents with zero received dots stay at 0.5 (neutral prior)
// and never appear in another agent's weighting denominator. New agents
// joining mid-conversation start at 0.5 and converge as their first dots
// land. Cycles in the grade graph are fine — fixed-point iteration handles
// them by converging to the eigenvector of the (normalized) weighting matrix.
const BELIEVABILITY_MAX_ITERS = 20;
const BELIEVABILITY_CONVERGE_THRESHOLD = 0.001;

export function computeBelievability(allDots: Record<string, Dot[]> = readAllDots()): Record<string, number> {
  const peers = Object.keys(allDots);
  if (peers.length === 0) return {};

  // Initialize: every agent at 0.5 neutral prior.
  let belv: Record<string, number> = {};
  for (const p of peers) belv[p] = 0.5;

  for (let iter = 0; iter < BELIEVABILITY_MAX_ITERS; iter++) {
    const next: Record<string, number> = {};
    let maxDelta = 0;

    for (const [peer, dots] of Object.entries(allDots)) {
      if (dots.length === 0) {
        next[peer] = 0.5;
        continue;
      }
      // Believability-weighted mean of received axes.
      let weightedSum = 0, weightSum = 0;
      for (const d of dots) {
        const graderBelv = belv[d.grader] ?? 0.5;
        for (const a of DOT_AXES) {
          const v = d.axes[a];
          if (typeof v === "number" && Number.isFinite(v)) {
            weightedSum += v * graderBelv;
            weightSum += graderBelv;
          }
        }
      }
      const score = weightSum > 0
        ? Math.max(0, Math.min(1, (weightedSum / weightSum) / 10))
        : 0.5;
      next[peer] = score;
      const delta = Math.abs(score - (belv[peer] ?? 0.5));
      if (delta > maxDelta) maxDelta = delta;
    }

    belv = next;
    if (maxDelta < BELIEVABILITY_CONVERGE_THRESHOLD) break;
  }
  return belv;
}

export type DotAggregate = {
  count: number;
  unweighted: Record<string, number>; // mean per axis (key = axis name from DOT_AXES)
  weighted: Record<string, number>;   // believability-weighted mean per axis
  composite: number;                  // mean across axes of `weighted`, in [0, 10]
};

export function aggregateDots(peer: string, allDots?: Record<string, Dot[]>): DotAggregate {
  const all = allDots ?? readAllDots();
  const dots = all[peer] ?? [];
  const believability = computeBelievability(all);
  const empty: Record<string, number> = {};
  for (const a of DOT_AXES) empty[a] = 0;
  if (dots.length === 0) {
    return { count: 0, unweighted: { ...empty }, weighted: { ...empty }, composite: 0 };
  }
  const uw: Record<string, { sum: number; n: number }> = {};
  const wt: Record<string, { sum: number; w: number }> = {};
  for (const a of DOT_AXES) { uw[a] = { sum: 0, n: 0 }; wt[a] = { sum: 0, w: 0 }; }
  for (const d of dots) {
    const w = believability[d.grader] ?? 0.5;
    for (const a of DOT_AXES) {
      const v = d.axes[a];
      if (typeof v === "number" && Number.isFinite(v)) {
        uw[a].sum += v; uw[a].n++;
        wt[a].sum += v * w; wt[a].w += w;
      }
    }
  }
  const unweighted: Record<string, number> = { ...empty };
  const weighted: Record<string, number> = { ...empty };
  let compositeSum = 0;
  for (const a of DOT_AXES) {
    unweighted[a] = uw[a].n > 0 ? uw[a].sum / uw[a].n : 0;
    weighted[a] = wt[a].w > 0 ? wt[a].sum / wt[a].w : 0;
    compositeSum += weighted[a];
  }
  const composite = DOT_AXES.length > 0 ? compositeSum / DOT_AXES.length : 0;
  return { count: dots.length, unweighted, weighted, composite };
}

// ── Round-15h Concern-4: relay path BFS ─────────────────────────────────
//
// Returns the shortest path of agent names from `from` to `to` in the
// topology graph. Empty array if from === to. null if no path (disconnected
// graph, which the topology validators already refuse). For petersen the
// max path length is 3 nodes (2 hops, diameter=2). Used by cmdRun to tell
// agents how to reach non-neighbors via relay.
export function relayPathTo(topo: Topology, from: string, to: string): string[] | null {
  if (from === to) return [];
  const adj: Record<string, string[]> = Object.create(null);
  for (const a of topo.agents) adj[a] = [];
  for (const [a, b] of topo.edges) {
    if (a in adj) adj[a].push(b);
    if (b in adj) adj[b].push(a);
  }
  if (!(from in adj) || !(to in adj)) return null;
  const prev: Record<string, string | null> = { [from]: null };
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === to) {
      const path: string[] = [];
      let n: string | null = cur;
      while (n != null) { path.unshift(n); n = prev[n]; }
      return path;
    }
    for (const nb of adj[cur]) {
      if (!(nb in prev)) { prev[nb] = cur; queue.push(nb); }
    }
  }
  return null;
}

// ── Round-15l: per-agent runtime selection ───────────────────────────────
//
// resolveRuntime returns the runtime adapter name for a given agent.
// Resolution order (highest precedence first):
//   1. $AGENT_CHAT_RUNTIME env var (per-shell test override)
//   2. topology yaml `runtimes: { <agent>: <name> }`
//   3. Auto-detect via PATH probe: prefer "claude" if on PATH, else "codex"
//      if on PATH, else "claude" (the call into runClaude will then return
//      a graceful "not-found" reason — same shape as if the binary were
//      missing for any other reason).
//
// The wire protocol (CONVO.md, .turn, archives, .dots, .roles, .scratch)
// is identical across runtimes — so a Claude agent on edge A and a Codex
// agent on edge B can collaborate on the same petersen graph because the
// state is filesystem-mediated, not adapter-mediated.
export type RuntimeName = "claude" | "codex";
export const ALL_RUNTIMES: readonly RuntimeName[] = ["claude", "codex"];

let _pathProbeCache: { claude?: boolean; codex?: boolean } | null = null;
function probeBinaryOnPath(name: string): boolean {
  if (!_pathProbeCache) _pathProbeCache = {};
  if (_pathProbeCache[name as RuntimeName] != null) return _pathProbeCache[name as RuntimeName]!;
  try {
    const r = require("node:child_process").spawnSync("which", [name], { encoding: "utf8" });
    const found = r.status === 0 && !!(r.stdout ?? "").trim();
    _pathProbeCache[name as RuntimeName] = found;
    return found;
  } catch {
    _pathProbeCache[name as RuntimeName] = false;
    return false;
  }
}

export function resolveRuntime(topo: Topology, agent: string): RuntimeName {
  const envOverride = process.env.AGENT_CHAT_RUNTIME?.toLowerCase();
  if (envOverride && (ALL_RUNTIMES as readonly string[]).includes(envOverride)) {
    return envOverride as RuntimeName;
  }
  const yamlValue = topo.runtimes?.[agent]?.toLowerCase();
  if (yamlValue && (ALL_RUNTIMES as readonly string[]).includes(yamlValue)) {
    return yamlValue as RuntimeName;
  }
  // Auto-detect: prefer claude (the original target), fall back to codex.
  if (probeBinaryOnPath("claude")) return "claude";
  if (probeBinaryOnPath("codex")) return "codex";
  return "claude";
}

export function ensureControlDirs(): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(PRESENCE_DIR, { recursive: true });
  fs.mkdirSync(ROLES_DIR, { recursive: true });
  fs.mkdirSync(DOTS_DIR, { recursive: true });
  fs.mkdirSync(LESSONS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// current_speaker.json — slice 2 (multi-user transparency).
//
// One file per session, keyed by session_key. Live-state only — declares
// which human is currently typing in this Claude Code session. Schema is
// {name, set_at}. No `prev` field: pulsar slice-2 round flagged that as a
// read-modify-write race surface; cadence flagged it as scope-creep
// (durable speaker history belongs in keystone's CONVO.md handoff sections,
// not in a live-state file). Mode 0600 to avoid leaking human identity to
// other local users on shared hosts (pulsar's mode recommendation).
//
// Lifecycle: written by `agent-chat speaker <name>`, read by `record-turn`
// and `cmdRun --speaker`, unlinked by `agent-chat exit` and reclaimed by
// `agent-chat gc` for orphan session_keys.
// ---------------------------------------------------------------------------

export const CURRENT_SPEAKER_FILE_SUFFIX = ".current_speaker.json";

export type CurrentSpeaker = {
  name: string;
  set_at: string;
};

export function currentSpeakerPath(key: string): string {
  // Mirror sessionFile's sanitization so the writer and reaper resolve
  // identical paths regardless of session_key shape (cadence flagged
  // path-helper drift between writer and reaper as a slice-2 risk).
  const safe = key.replace(/[^A-Za-z0-9_:.-]/g, "_");
  return path.join(SESSIONS_DIR, `${safe}${CURRENT_SPEAKER_FILE_SUFFIX}`);
}

export function readCurrentSpeaker(key: string): CurrentSpeaker | null {
  const f = currentSpeakerPath(key);
  if (!fs.existsSync(f)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!obj || typeof obj.name !== "string" || typeof obj.set_at !== "string") return null;
    return { name: obj.name, set_at: obj.set_at };
  } catch (err) {
    // Surface to stderr so a corrupt file is observable; return null so
    // callers see "speaker not set" rather than crashing (the documented
    // ENOENT-equivalent semantic). Same shape as readSessionRecord's
    // corrupt-file handling.
    console.error(`[agent-chat] speaker file ${f} is unreadable: ${(err as Error).message}`);
    return null;
  }
}

export function writeCurrentSpeaker(key: string, name: string): void {
  ensureControlDirs();
  const rec: CurrentSpeaker = { name, set_at: utcStamp() };
  const json = JSON.stringify(rec, null, 2) + "\n";
  // Mode 0600: file embeds human identity, default umask would yield 0644
  // and leak the identifier to other local users on shared hosts.
  writeFileAtomic(currentSpeakerPath(key), json, { mode: 0o600 });
}

// ENOENT-tolerant unlink. Shared by CLIs and tests that need cleanup
// without importing from agent-chat.ts. Returns true if the file was removed,
// false if it was already gone (peer race or already-cleaned). Throws on
// any other error so a real EACCES / EBUSY surfaces.
export function safeUnlink(p: string): boolean {
  try { fs.unlinkSync(p); return true; }
  catch (e: any) { if (e?.code === "ENOENT") return false; throw e; }
}

// ---------------------------------------------------------------------------
// resolveDefaultSpeaker — slice 2 refactor (orthogonal user overlay).
//
// Pure function; testable in isolation. Returns the human user that init
// should auto-write to current_speaker.json on a fresh session, OR an
// error if explicit env asserts a name not in users.yaml.
//
// Resolution order (cadence/pulsar/orion Phase-2 resolved):
//   1. $AGENT_CHAT_USER — explicit per-session user assertion. SET +
//      registered → return name. SET + NOT registered → return error
//      (cadence: never silently fall through; explicit env masks config
//      typos otherwise).
//   2. $USER — system-level login. Set + registered → return name. Set +
//      NOT registered → silent fall-through (system $USER is not an
//      agent-chat-specific assertion the way $AGENT_CHAT_USER is).
//   3. users.yaml `default: true` entry → return that name. loadUsers'
//      load-time validation guarantees at most one default.
//   4. None of the above → {name: null, source: null, error: null}: no
//      auto-resolve fires; init proceeds without writing current_speaker.
//
// `source` is purely diagnostic (for stderr logging); never load-bearing.
// ---------------------------------------------------------------------------

export type DefaultSpeakerResolution = {
  name: string | null;
  source: "$AGENT_CHAT_USER" | "$USER" | "users.yaml default" | null;
  error: string | null;
};

export function resolveDefaultSpeaker(): DefaultSpeakerResolution {
  // Tolerate malformed yaml as "no users known" rather than crashing init.
  // loadUsers() ships in this same file (multi-user refactor); the prior
  // self-require dance was dead code and removed at lumeyon's Phase-4
  // review nit.
  let users: User[] = [];
  try { users = loadUsers(); } catch { users = []; }

  const userNames = new Set(users.map((u) => u.name));

  // 1. $AGENT_CHAT_USER — strict.
  const explicit = process.env.AGENT_CHAT_USER;
  if (explicit && explicit.trim()) {
    const name = explicit.trim();
    if (userNames.has(name)) {
      return { name, source: "$AGENT_CHAT_USER", error: null };
    }
    return {
      name: null,
      source: null,
      error: `$AGENT_CHAT_USER='${name}' but no user named '${name}' in agents.users.yaml; add an entry or run 'agent-chat speaker <name>' explicitly`,
    };
  }

  // 2. $USER — silent fall-through if unregistered.
  const sys = process.env.USER;
  if (sys && sys.trim() && userNames.has(sys.trim())) {
    return { name: sys.trim(), source: "$USER", error: null };
  }

  // 3. users.yaml default: true.
  const defaultUser = users.find((u) => u.default === true);
  if (defaultUser) {
    return { name: defaultUser.name, source: "users.yaml default", error: null };
  }

  // 4. None resolved — let init proceed without an auto-write.
  return { name: null, source: null, error: null };
}

// Returns the session key for the *current* process. Must be:
//   - stable across every bun invocation within ONE agent session
//   - different between two agent sessions on the same host (no collisions)
//   - cheap to compute (no syscalls beyond /proc reads)
//
// Resolution order:
//   1. $CLAUDE_SESSION_ID / $CLAUDE_CODE_SESSION_ID — explicit session id,
//      if the runtime sets one.
//   2. `pid:<stableSessionPid>` — derived from the long-lived agent runtime
//      ancestor (Claude Code / Codex main process via marker walk, or
//      process.ppid on plain shell). Each runtime instance has a different
//      main pid, so two instances on the same host get different keys.
//      Stable across every bun invocation within a session because the
//      ancestor pid doesn't change.
//
// We deliberately do NOT key by $CLAUDE_CODE_SSE_PORT: empirically, two
// Claude Code instances under the same VS Code remote dev parent can share
// a single SSE port, and a shared key silently clobbers the prior session's
// record. The pid-based key is collision-free.
export function currentSessionKey(): string {
  const cs = process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID;
  if (cs && cs.trim()) return cs.trim();
  return `pid:${stableSessionPid()}`;
}

export function sessionFile(key: string): string {
  // Sanitize: keys are typically uuids or "ppid:NNNN"; replace anything
  // funky with "_" to keep them safe filenames on Windows too.
  const safe = key.replace(/[^A-Za-z0-9_:.-]/g, "_");
  return path.join(SESSIONS_DIR, `${safe}.json`);
}

export function presenceFile(agent: string): string {
  // Mirror sessionFile's defensive sanitization. Today every caller validates
  // agent name via topology membership first, so input is safe — but the
  // asymmetry (sessionFile sanitized, presenceFile didn't) is exactly the
  // shape a future caller could trip over. Lyra L1.
  const safe = agent.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(PRESENCE_DIR, `${safe}.json`);
}

export function readSessionRecord(key: string): SessionRecord | null {
  const f = sessionFile(key);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")) as SessionRecord; }
  catch (err) {
    // Surface to stderr so the user notices a corrupt session file (carina
    // bonus 1). Still return null so callers get the same "not found" shape
    // they expect — corrupt and missing are observationally identical from
    // the resolver's POV.
    console.error(`[agent-chat] session file ${f} is unreadable: ${(err as Error).message}`);
    return null;
  }
}

export function writeSessionRecord(rec: SessionRecord): void {
  ensureControlDirs();
  // Atomic write so concurrent readers (cmdWho, cmdGc, findResumableSession,
  // --whoami) never see an empty/partial JSON window during a truncate-then-
  // write race (lyra round-2 Q3). writeFileAtomic uses tmp + rename within
  // the same directory.
  // Mode 0o600 (owner-only): session and presence records contain
  // identity-tagged data (`agent: <name>@<host>:<pid>`); on a shared host,
  // 0o644 default would leak the identifier to other local users. Same
  // rationale as current_speaker.json in the multi-user rollout. Caught
  // at Phase-4 cross-review by lumeyon as mode-asymmetry concern; uniform
  // 0o600 across all per-session writes is the defense-in-depth answer.
  const json = JSON.stringify(rec, null, 2) + "\n";
  writeFileAtomic(sessionFile(rec.session_key), json, { mode: 0o600 });
  writeFileAtomic(presenceFile(rec.agent), json, { mode: 0o600 });
}

export function deleteSessionRecord(rec: SessionRecord): void {
  try { fs.unlinkSync(sessionFile(rec.session_key)); } catch {}
  // Only remove the presence file if it still points at THIS session — don't
  // clobber a presence record written by a different session that happens to
  // share the agent name (which would be a misconfig but we don't want to
  // make it worse).
  try {
    const p = presenceFile(rec.agent);
    if (fs.existsSync(p)) {
      const cur = JSON.parse(fs.readFileSync(p, "utf8")) as SessionRecord;
      if (cur.session_key === rec.session_key) fs.unlinkSync(p);
    }
  } catch {}
}

// Round-15c (Contract A): Pre-write synthetic identity state for a
// dispatched ephemeral child so its in-process `agent-chat record-turn`
// invocation can resolve speaker. Returns the synthetic session key
// (export as CLAUDE_SESSION_ID into the child's env) plus a cleanup()
// function that unlinks the pre-written files.
//
// Carina's Phase-1 break-point analysis: under ephemeral mode,
// `cmdRecordTurn` calls `fetchSpeaker(id.name, key)` which fails when no
// speaker file exists. This helper is the file-side primitive that closes
// the gap for ephemeral children.
//
// Usage:
//   const { sessionKey, cleanup } = prepareEphemeralIdentity({
//     agent: "keystone", speaker: "boss", parent: orionRecord,
//   });
//   process.env.CLAUDE_SESSION_ID = sessionKey;
//   try { await runClaude({ ... }); } finally { cleanup(); }
//
// The synthetic record carries `ephemeral: true` so cmdGc + doctor can
// distinguish it from a normal session. `parent` is the dispatcher's
// SessionRecord — its pid + starttime are inherited (the parent is alive
// while the child runs; pid-recycle defense via processIsOriginal works
// against the parent's identity).
export function prepareEphemeralIdentity(input: {
  agent: string;
  speaker: string;
  parent: SessionRecord;
}): { sessionKey: string; cleanup: () => void } {
  ensureControlDirs();
  // Generate a fresh session key. Use crypto.randomUUID() so the key is
  // distinct from any live session and from any ppid-derived key.
  const sessionKey = `eph:${crypto.randomUUID()}`;
  const synthetic: SessionRecord = {
    agent: input.agent,
    topology: input.parent.topology,
    session_key: sessionKey,
    claude_session_id: sessionKey,
    host: input.parent.host,
    pid: input.parent.pid,
    pid_starttime: input.parent.pid_starttime,
    started_at: utcStamp(),
    cwd: input.parent.cwd,
    ephemeral: true,
  };
  writeSessionRecord(synthetic);
  writeCurrentSpeaker(sessionKey, input.speaker);
  const cleanup = (): void => {
    try { fs.unlinkSync(sessionFile(sessionKey)); } catch {}
    try { fs.unlinkSync(currentSpeakerPath(sessionKey)); } catch {}
    // NOTE: presenceFile is keyed by agent name, not session key — and
    // the parent dispatcher may have its own presence record for the
    // same agent. Don't unlink presence here; let cmdGc's dead-pid
    // sweep handle any orphan presence file for synthetic records.
  };
  return { sessionKey, cleanup };
}

export function listSessions(): SessionRecord[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const out: SessionRecord[] = [];
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
      // Defensive shape validation: SESSIONS_DIR also holds per-session
      // live-state files like `<key>.current_speaker.json` that share the
      // `.json` suffix but are NOT SessionRecords. Pre-fix, those files
      // contaminated the return — `cmdWho`'s `r.agent.padEnd(...)` then
      // crashed on `undefined`. Caught at Phase-4 cross-review by lumeyon
      // (multi-user rollout); the fix is general defense against any future
      // foreign `.json` file in SESSIONS_DIR (test fixtures, manual
      // breadcrumbs, future live-state files).
      if (!parsed || typeof parsed.agent !== "string" || typeof parsed.session_key !== "string") continue;
      out.push(parsed as SessionRecord);
    } catch {}
  }
  return out;
}

// "Resume key" identifies a recurring login from the same terminal: same
// cwd, same tty. Lets `init` offer "you were orion last time, resume?"
// instead of forcing the user to redeclare each restart.
export function resumeKey(cwd: string, tty: string | undefined): string {
  return `${cwd}|${tty ?? ""}`;
}

export function findResumableSession(rk: string): SessionRecord | null {
  // Sort by started_at descending so the MOST-RECENT stale record wins when
  // multiple match the same cwd|tty resume key. Pre-fix, this returned the
  // first readdir-order match — filesystem-dependent and non-deterministic
  // across restarts (lyra round-2 Q2, P2).
  const candidates = listSessions()
    .filter((rec) => resumeKey(rec.cwd, rec.tty) === rk)
    .filter((rec) => !processIsOriginal(rec.pid, rec.pid_starttime))
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
  return candidates[0] ?? null;
}

export function findLivePresence(agent: string): SessionRecord | null {
  const f = presenceFile(agent);
  if (!fs.existsSync(f)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(f, "utf8")) as SessionRecord;
    // Foreign-host records belong to a different machine sharing this
    // filesystem (NFS/sshfs). Their pid is meaningless on us — checking
    // pidIsAlive against our pid namespace would either falsely match
    // (recycled local pid) or falsely reject (live remote pid we can't see).
    // The only safe answer is "not mine, ignore." See cadence F8.
    if (rec.host !== os.hostname()) return null;
    return processIsOriginal(rec.pid, rec.pid_starttime) ? rec : null;
  } catch { return null; }
}

// Atomic exclusive-create write: open with O_CREAT|O_EXCL so the call fails
// with EEXIST if the file already exists, never silently truncating.
//
// Used for filesystem-as-mutex primitives: the lock file (one writer at a
// time) and the presence file (one session per agent name). The previous
// `fs.writeFileSync(p, …)` was create-or-truncate, which lets two
// concurrent callers both "succeed" with the second silently overwriting
// the first.
//
// NFS caveat: O_EXCL semantics on NFSv2/v3 are historically lossy (the
// server may report success when another client already holds the file).
// All current users of this skill are on local filesystems, so the simple
// implementation suffices. If multi-host filesystem use ever ships,
// switch to a link()-based fallback for NFSv2/v3.
export function exclusiveWriteOrFail(p: string, content: string, opts: { mode?: number } = {}): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Apply mode at openSync time (third arg) rather than chmod-after-create:
  // openSync sets the file's permissions atomically with the create, closing
  // a race where a concurrent reader could see the file at default-umask
  // 0o644 between the open and a chmod follow-up. Same identity-leak threat
  // model that justified 0o600 on per-session files in the first place; this
  // is the defense-in-depth answer (lumeyon Phase-4 review of the multi-user
  // refactor).
  const fd = opts.mode != null ? fs.openSync(p, "wx", opts.mode) : fs.openSync(p, "wx");
  let wrote = false;
  try {
    fs.writeFileSync(fd, content);
    wrote = true;
  } finally {
    fs.closeSync(fd);
    // If the writeFileSync threw (e.g. ENOSPC mid-write), the file exists
    // but is empty. Future wx calls would EEXIST forever. Unlink so the
    // caller's retry handler sees the slot as available again. Carina bonus 2.
    if (!wrote) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
}

export function resolveIdentity(cwd: string = process.cwd()): Identity {
  // 1. Per-session file (Claude session id or parent shell pid). This is the
  //    high-N path: ten sessions in the same cwd each have their own session
  //    record and never need env vars.
  const key = currentSessionKey();
  const rec = readSessionRecord(key);
  if (rec) {
    // Opportunistic conflict detection: env or .agent-name disagrees with
    // the live session record. Pre-fix, init recorded the user's intent
    // and resolveIdentity short-circuited — so a later edit to .agent-name
    // (or a divergent env override in a freshly-spawned shell) was
    // silently ignored (lyra L4).
    const envName = process.env.AGENT_NAME;
    const envTopo = process.env.AGENT_TOPOLOGY;
    if (envName && envTopo && (envName !== rec.agent || envTopo !== rec.topology)) {
      console.error(
        `[agent-chat] WARNING: env says "${envName}@${envTopo}" but live session record ` +
        `says "${rec.agent}@${rec.topology}" — using session record. ` +
        `Run \`bun scripts/agent-chat.ts exit\` then re-init to switch.`,
      );
    }
    try {
      const fileId = readAgentNameFile(cwd);
      if (fileId && (fileId.name !== rec.agent || fileId.topology !== rec.topology)) {
        console.error(
          `[agent-chat] WARNING: .agent-name in ${cwd} says "${fileId.name}@${fileId.topology}" ` +
          `but live session record says "${rec.agent}@${rec.topology}" — using session record.`,
        );
      }
    } catch { /* malformed .agent-name — readAgentNameFile already warns */ }
    return { name: rec.agent, topology: rec.topology, source: `session:${key}` };
  }
  // 2. $AGENT_NAME + $AGENT_TOPOLOGY env vars
  const envName = process.env.AGENT_NAME;
  const envTopo = process.env.AGENT_TOPOLOGY;
  // Half-set env is almost always a typo. Refuse instead of silently
  // falling through to .agent-name and returning a different identity than
  // the user typed (lyra round-2 Q1, P1).
  if (envName && !envTopo) {
    throw new Error(`AGENT_NAME=${envName} is set without AGENT_TOPOLOGY (partial env). Set both or neither.`);
  }
  if (envTopo && !envName) {
    throw new Error(`AGENT_TOPOLOGY=${envTopo} is set without AGENT_NAME (partial env). Set both or neither.`);
  }
  if (envName && envTopo) {
    try {
      const fileId = readAgentNameFile(cwd);
      if (fileId && (fileId.name !== envName || fileId.topology !== envTopo)) {
        console.error(
          `[agent-chat] WARNING: .agent-name in ${cwd} says "${fileId.name}@${fileId.topology}" ` +
          `but env says "${envName}@${envTopo}" — using env. If you have two sessions sharing ` +
          `this directory, that's expected. If not, remove or update .agent-name.`,
        );
      }
    } catch (err) {
      console.error(`[agent-chat] WARNING: ${(err as Error).message}`);
    }
    return { name: envName, topology: envTopo, source: "env" };
  }
  // 3. ./.agent-name file
  const fileId = readAgentNameFile(cwd);
  if (fileId) {
    return { name: fileId.name, topology: fileId.topology, source: ".agent-name" };
  }
  throw new Error(
    `cannot resolve identity — run \`bun scripts/agent-chat.ts init <name> [<topology>]\`, ` +
    `or set $AGENT_NAME + $AGENT_TOPOLOGY, or write .agent-name in ${cwd}.`,
  );
}

// Display fingerprint: agent@host:<stable-session-pid>. Used by --whoami
// and the init banner so two terminals advertised as the SAME session show
// the SAME pid (and two genuinely-distinct sessions show DIFFERENT pids).
// Pre-fix, this returned process.pid (the throwaway bun pid), defeating
// the dup-name detection workflow bootstrap.md advertises (lyra L2).
export function displayTag(name: string): string {
  return `${name}@${os.hostname()}:${stableSessionPid()}`;
}

// Backward-compat alias. New code should call displayTag.
export const processTag = displayTag;

// Lock-file fingerprint: agent@host:<stable-session-pid>. The lock body
// records the long-lived agent runtime ancestor pid (Claude Code/Codex main
// process, or the user's terminal pid for plain shell), NOT the
// short-lived bun pid. With process.pid, every bun spawn looks like a
// "stale lock" the moment it returns; with stableSessionPid, the lock
// looks fresh as long as the agent session is alive, and goes stale only
// when that session genuinely exits.
// Lock body wire format:
//   `<agent>@<host>:<pid>:<starttime>:<session_key> <ts>` (5-tuple).
// Older formats were `<agent>@<host>:<pid>:<starttime> <ts>` (4-tuple)
// and `<agent>@<host>:<pid> <ts>` (3-tuple); parseLockFile accepts both
// so an in-flight upgrade doesn't strand already-held locks. Embedding
// starttime rejects recycled-pid claimants; embedding session_key lets
// same-agent lock checks distinguish two live sessions even when process
// ancestry is ambiguous under test runners or nested shells.
export function lockTag(name: string): string {
  const sp = stableSessionPid();
  const st = pidStarttime(sp);
  return `${name}@${os.hostname()}:${sp}:${st ?? 0}:${encodeURIComponent(currentSessionKey())}`;
}

export type LockRecord = {
  agent: string;
  host: string;
  pid: number;
  starttime: number | null;
  session_key?: string;
  ts: string;
};

// Parse a lock file body in the current 5-tuple form, or the older 4-tuple
// / 3-tuple forms. When an old form is observed, missing fields remain
// absent/null and callers fall back to conservative pid/starttime checks.
export function parseLockFile(
  p: string,
): LockRecord | null {
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, "utf8").trim();
  // Current 5-tuple.
  let m = text.match(/^(\S+)@([^:\s]+):(\d+):(\d+):([^:\s]+)\s+(\S+)$/);
  if (m) {
    const st = parseInt(m[4], 10);
    let sessionKey: string | undefined;
    try { sessionKey = decodeURIComponent(m[5]); } catch { sessionKey = m[5]; }
    return {
      agent: m[1],
      host: m[2],
      pid: parseInt(m[3], 10),
      starttime: st > 0 ? st : null,
      session_key: sessionKey,
      ts: m[6],
    };
  }
  // 4-tuple without session_key.
  m = text.match(/^(\S+)@([^:\s]+):(\d+):(\d+)\s+(\S+)$/);
  if (m) {
    const st = parseInt(m[4], 10);
    return { agent: m[1], host: m[2], pid: parseInt(m[3], 10), starttime: st > 0 ? st : null, ts: m[5] };
  }
  // Legacy 3-tuple.
  m = text.match(/^(\S+)@([^:\s]+):(\d+)\s+(\S+)$/);
  if (!m) return null;
  return { agent: m[1], host: m[2], pid: parseInt(m[3], 10), starttime: null, ts: m[4] };
}

export function lockBelongsToCurrentSession(lk: LockRecord): boolean {
  if (lk.session_key != null) return lk.session_key === currentSessionKey();
  const myStablePid = stableSessionPid();
  const myStarttime = pidStarttime(myStablePid);
  return lk.pid === myStablePid && lk.starttime != null && myStarttime != null && lk.starttime === myStarttime;
}

export function pidIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence test, doesn't actually signal
    return true;
  } catch (err: any) {
    // EPERM means the process exists but we can't signal it — still alive.
    return err?.code === "EPERM";
  }
}

// Return the kernel start_time of `pid` as an opaque comparable number, or
// null if we can't read it. Linux: `/proc/<pid>/stat` field 22 (clock ticks
// since boot, monotonic for the lifetime of the kernel). macOS: parse
// `ps -p <pid> -o lstart=` to ms-since-epoch. Other platforms: null.
//
// The returned number is a fingerprint, not a timestamp — only equality
// matters. Treat it as opaque.
//
// macOS `ps` shells out (~10ms); call sparingly (init, gc, exit).
export function pidStarttime(pid: number): number | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22 (1-indexed) is starttime in clock ticks. The comm field
      // (field 2) is parenthesized and may contain spaces, so split by the
      // last `)` rather than naïve whitespace.
      const rparen = stat.lastIndexOf(")");
      if (rparen < 0) return null;
      const fields = stat.slice(rparen + 2).split(/\s+/);
      // After ")", field 3 (state) is fields[0], so starttime is fields[19].
      const t = parseInt(fields[19] ?? "", 10);
      return Number.isFinite(t) ? t : null;
    } catch { return null; }
  }
  if (process.platform === "darwin") {
    try {
      const r = require("node:child_process").spawnSync(
        "ps", ["-p", String(pid), "-o", "lstart="],
        { encoding: "utf8", timeout: 2000 },
      );
      if (r.status !== 0) return null;
      const t = Date.parse(r.stdout.trim());
      return Number.isFinite(t) ? t : null;
    } catch { return null; }
  }
  return null;
}

// "Is this pid still the same process whose start_time we recorded?"
// `expected == null/undefined` means we don't have a fingerprint for it
// (legacy SessionRecord, non-Linux/non-macOS, or initial recording failed).
// In that case fall back to identity-blind pidIsAlive — same behavior as
// before, no regression.
//
// When we DO have a fingerprint, this rejects (a) dead pids and (b) pids
// recycled to a different process. That closes the gc-deletes-foreign-state
// loophole and the exit-kills-wrong-pid race.
export function processIsOriginal(pid: number, expected: number | null | undefined): boolean {
  if (!pidIsAlive(pid)) return false;
  if (expected == null) return true;
  const actual = pidStarttime(pid);
  if (actual == null) return true; // can't verify on this platform; trust pidIsAlive
  return actual === expected;
}

// Find the pid of the long-lived agent runtime that ultimately spawned the
// current bun process. Under Claude Code and Codex, each tool invocation may
// get a freshly-spawned shell as its parent, so process.ppid is often too
// short-lived for lock ownership. We need an ancestor pid that survives the
// whole user session.
//
// Strategy: descendants carry a runtime marker (CLAUDECODE=1 for Claude
// Code, CODEX_THREAD_ID for Codex) that the runtime parent itself does not.
// Walk ancestors and return the first marker-present → marker-absent
// transition. Falls back to process.ppid for plain shells, non-Linux/macOS
// platforms, or unreadable process metadata.
export function stableSessionPid(): number {
  if (process.env.CLAUDECODE === "1") {
    if (process.platform === "linux") return stableSessionPidLinux("CLAUDECODE", "1", "Claude Code");
    if (process.platform === "darwin") return stableSessionPidDarwin("CLAUDECODE", "1");
  }
  if (process.env.CODEX_THREAD_ID) {
    // Codex descendants carry CODEX_THREAD_ID, but the long-lived Codex CLI
    // parent does not. Use the same marker-transition walk as Claude so
    // lock identity is stable across short-lived Bun subprocesses.
    if (process.platform === "linux") return stableSessionPidLinux("CODEX_THREAD_ID", process.env.CODEX_THREAD_ID, "Codex");
    if (process.platform === "darwin") return stableSessionPidDarwin("CODEX_THREAD_ID", process.env.CODEX_THREAD_ID);
  }
  // Plain shell: ppid is the user's terminal, which is itself long-lived
  // enough for this protocol's lock ownership checks.
  return process.ppid || process.pid;
}

function stableSessionPidLinux(markerName: string, markerValue: string, runtimeName: string): number {
  let pid = process.ppid;
  let prevHadMarker = true; // we (the bun process) have the runtime marker set
  const seen = new Set<number>();
  for (let depth = 0; depth < 30 && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    let hasMarker = false;
    try {
      const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
      hasMarker = environ.split("\0").includes(`${markerName}=${markerValue}`);
    } catch { break; }
    if (prevHadMarker && !hasMarker) return pid;
    prevHadMarker = hasMarker;
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const m = status.match(/^PPid:\s*(\d+)/m);
      if (!m) break;
      const ppid = parseInt(m[1], 10);
      if (ppid <= 1) break;
      pid = ppid;
    } catch { break; }
  }
  // Walked the depth ceiling without finding the marker transition — likely
  // an unusual process tree (daemonized parent, container init, etc.). Warn
  // so the user can investigate; lock identity is unstable in this state.
  if (seen.size >= 30) {
    console.error(`[agent-chat] stableSessionPid: walked 30 ancestors without finding the ${runtimeName} main process; falling back to ppid=${process.ppid}.`);
  }
  return process.ppid || process.pid;
}

// macOS marker-walk. /proc isn't available; we shell out to `ps -E -o
// command=` (env disclosure for our own user's processes only) to read each
// ancestor's environment block, looking for the same marker-present →
// marker-absent transition that the Linux walk uses. ~10ms per step, walk
// usually 1-3 deep — acceptable for `init`/`lock`/`unlock` cadence.
function stableSessionPidDarwin(markerName: string, markerValue: string): number {
  const cp = require("node:child_process") as typeof import("node:child_process");
  function envHasMarker(pid: number): boolean | null {
    try {
      const r = cp.spawnSync("ps", ["-E", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000 });
      if (r.status !== 0) return null;
      // `ps -E` prepends the process's environment to the command.
      return (` ${r.stdout.trim()} `).includes(` ${markerName}=${markerValue} `);
    } catch { return null; }
  }
  function ppidOf(pid: number): number | null {
    try {
      const r = cp.spawnSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8", timeout: 2000 });
      if (r.status !== 0) return null;
      const p = parseInt(r.stdout.trim(), 10);
      return Number.isFinite(p) && p > 0 ? p : null;
    } catch { return null; }
  }
  let pid = process.ppid;
  let prevHadMarker = true;
  const seen = new Set<number>();
  for (let depth = 0; depth < 30 && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    const marker = envHasMarker(pid);
    if (marker == null) break;
    if (prevHadMarker && !marker) return pid;
    prevHadMarker = marker;
    const next = ppidOf(pid);
    if (next == null || next <= 1) break;
    pid = next;
  }
  return process.ppid || process.pid;
}

// Canonical edge id is "<lo>-<hi>" (alphabetical) so each edge maps to one path
// regardless of which side is talking.
export function edgeId(a: string, b: string): string {
  return [a, b].sort().join("-");
}

export function neighborsOf(t: Topology, name: string): string[] {
  const out = new Set<string>();
  for (const [a, b] of t.edges) {
    if (a === name) out.add(b);
    else if (b === name) out.add(a);
  }
  return [...out].sort();
}

export function edgesOf(t: Topology, name: string): { peer: string; id: string; dir: string; convo: string; turn: string; lock: string }[] {
  return neighborsOf(t, name).map((peer) => {
    const id = edgeId(name, peer);
    const dir = path.join(CONVERSATIONS_DIR, t.topology, id);
    const convo = path.join(dir, "CONVO.md");
    const turn = path.join(dir, "CONVO.md.turn");
    const lock = path.join(dir, "CONVO.md.turn.lock");
    return { peer, id, dir, convo, turn, lock };
  });
}

export function ensureEdgeFiles(edge: ReturnType<typeof edgesOf>[number], participants: [string, string]) {
  fs.mkdirSync(edge.dir, { recursive: true });
  if (!fs.existsSync(edge.convo)) {
    const header = `# CONVO — ${participants[0]} ↔ ${participants[1]}\n\nProtocol: agent-chat\nParticipants: ${participants[0]}, ${participants[1]}\n\nOnly the agent named in CONVO.md.turn may append.\nIf CONVO.md.turn is parked, do not write unless explicitly resumed.\n`;
    fs.writeFileSync(edge.convo, header);
  }
  // Note: .turn is intentionally NOT created here. Whoever initializes the edge picks first writer.
}

export function readTurn(turnFile: string): string | null {
  if (!fs.existsSync(turnFile)) return null;
  return fs.readFileSync(turnFile, "utf8").trim();
}

export function writeTurnAtomic(turnFile: string, value: string) {
  const tmp = `${turnFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, value);
  fs.renameSync(tmp, turnFile);
}

export function utcStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Archive layer (LCM-inspired). Per-edge DAG of summary nodes.
//
//   archives/leaf/<archive-id>/        depth=0, source=raw CONVO.md sections
//     BODY.md       — verbatim transcript chunk (sealed, never edited)
//     SUMMARY.md    — human/agent-written summary; MUST end with the
//                     "Expand for details about: ..." footer
//     META.yaml     — id, depth, kind, time_range, body_sha256, parents,
//                     children, descendant_count, keywords, file_refs
//
//   archives/condensed/d1/<archive-id>/   depth=1, parents= leaf summaries
//   archives/condensed/d2/<archive-id>/   depth=2, parents= d1 summaries
//   archives/condensed/d3/<archive-id>/   depth>=3, durable
//
// Plus per-edge `index.jsonl` (one line per archive at any depth) so search.ts
// doesn't need to walk the tree to filter by keyword/time/peer.
// ---------------------------------------------------------------------------

export type ArchiveKind = "leaf" | "condensed";
export type ArchiveDepth = 0 | 1 | 2 | 3; // 3 collapses to "d3+"; META can carry exact depth

export type IndexEntry = {
  id: string;
  edge_id: string;
  topology: string;
  kind: ArchiveKind;
  depth: number;
  earliest_at: string;
  latest_at: string;
  participants: [string, string];
  parents: string[];           // child summary ids this one folds (condensed only)
  descendant_count: number;    // total number of leaf sources under this node
  keywords: string[];
  tldr: string;                // first 240 chars of TL;DR for cheap grep
  body_sha256?: string;        // present only for leaves
  path: string;                // absolute path to the archive directory
  // Round 12 slice 2: estimated token cost of all descendant content.
  // Leaves: text.length / 4 of BODY.md content. Condensed: sum of parents'
  // descendant_token_count. Populated by keystone's auto-compaction trigger
  // and verified by lumeyon's doctor descendant_count_consistency check.
  // Optional on read so legacy index entries (no field) treat as 0.
  descendant_token_count?: number;
};

export function archiveId(kind: ArchiveKind, latestAt: string, body?: string): string {
  // arch_<kind-prefix>_<UTC compact>_<8-hex content-addressed sha prefix>
  //
  // Round 12 slice 2: content-addressed IDs (lossless-claw backport).
  // - body present → sha256(body) prefix 8 hex. Re-sealing identical body
  //   yields identical id, which the seal/commit path treats as idempotent
  //   no-op (lyra round-12 nuance: without the guard at the seal site, a
  //   re-seal would EEXIST on dir create or duplicate the index entry).
  // - body absent (legacy path) → 8 random hex bytes. Old archives sealed
  //   before this round keep their random tails forever; the new format
  //   coexists with them. `findById` / `readIndex` are string-equal
  //   lookups so backward compat is free (lyra confirmed at Phase 1).
  // For condensed archives the convention is: body = UTF-8 concatenation
  // of parent SUMMARY.md content in parent-id-sorted order (orion Phase-2
  // resolution; semantic stability — same parents, same content, same id).
  const stamp = latestAt.replace(/[-:T]/g, "").replace(/Z$/, "");
  const tail = body !== undefined
    ? crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 8)
    : crypto.randomBytes(8).toString("hex");
  const prefix = kind === "leaf" ? "L" : "C";
  return `arch_${prefix}_${stamp}_${tail}`;
}

export function archivesRoot(edgeDir: string): string {
  return path.join(edgeDir, "archives");
}

export function leafArchiveDir(edgeDir: string, id: string): string {
  return path.join(archivesRoot(edgeDir), "leaf", id);
}

export function condensedArchiveDir(edgeDir: string, depth: number, id: string): string {
  const bucket = depth >= 3 ? "d3" : `d${depth}`;
  return path.join(archivesRoot(edgeDir), "condensed", bucket, id);
}

export function indexFile(edgeDir: string): string {
  return path.join(edgeDir, "index.jsonl");
}

// Atomic write: tmpfile + rename in the same directory. The destination is
// either fully present (post-rename) or absent — never half-written. With
// `fsync: true`, also flush the data to disk before the rename, so a power
// loss between write and the page cache flush can't strand a 0-byte file.
// Used by archive seal (which destroys the source) and by appendIndexEntry
// when called from a commit path (durability matters once we've validated).
export function writeFileAtomic(p: string, content: string, opts: { fsync?: boolean; mode?: number } = {}): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  // openSync's mode arg is masked by umask at create time. fchmodSync after
  // open forces the exact mode the caller requested (e.g. 0o600 for
  // current_speaker.json which embeds human identity — pulsar's slice-2
  // recommendation; mode 0644 default would leak it to other local users).
  const fd = opts.mode != null
    ? fs.openSync(tmp, "w", opts.mode)
    : fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content);
    if (opts.mode != null) fs.fchmodSync(fd, opts.mode);
    if (opts.fsync) fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p);
}

export function appendIndexEntry(
  edgeDir: string,
  entry: IndexEntry,
  opts: { fsync?: boolean } = {},
): void {
  fs.mkdirSync(edgeDir, { recursive: true });
  const f = indexFile(edgeDir);
  // O_APPEND on local FS is whole-record atomic for any single write up to
  // the underlying inode rwsem boundary — rhino's race testing confirmed
  // 1KB-1MB at 4 concurrent writers produces zero interleaving. The fsync
  // is opt-in for commit paths only (durability matters once we've passed
  // the validator) so non-commit callers don't pay the cost.
  if (opts.fsync) {
    const fd = fs.openSync(f, "a");
    try {
      fs.writeSync(fd, JSON.stringify(entry) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  } else {
    fs.appendFileSync(f, JSON.stringify(entry) + "\n");
  }
}

// Snapshot read of a growing append-only file. Open, fstat once, then
// readSync exactly that many bytes. Bun's readFileSync may return more
// bytes than the open-time fstat-size on a file that's being appended,
// which captures the leading bytes of an in-flight entry as a torn line.
// Bounding the read to the fstat-size makes the trailing line either
// complete (if the writer finished before our open) or absent (if the
// writer is mid-append) — never half-present. See rhino #3.
function readIndexSnapshot(f: string): string {
  const fd = fs.openSync(f, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return "";
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = fs.readSync(fd, buf, off, size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally { fs.closeSync(fd); }
}

export function readIndex(edgeDir: string): IndexEntry[] {
  const f = indexFile(edgeDir);
  if (!fs.existsSync(f)) return [];
  // Pair patch with readIndexSnapshot: bounded read defeats the over-read,
  // per-line try/catch defeats both a corrupt line that snuck in and the
  // residual torn-trailer case that snapshot can still observe under ext4's
  // per-page i_size update window. Either patch alone leaves a hole.
  const out: IndexEntry[] = [];
  for (const line of readIndexSnapshot(f).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as IndexEntry); }
    catch (err) {
      console.error(`[agent-chat] readIndex: skipping malformed line in ${f}: ${(err as Error).message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CONVO.md section parser + fresh-tail splitter.
//
// A "section" is a markdown block that begins with `## ` or `---` (separator)
// and ends just before the next one. The header preamble (everything before
// the first section) is preserved across archive cycles. Fresh-tail = the last
// K sections, never archived; that's how LCM keeps recent raw context cheap.
// ---------------------------------------------------------------------------

export type ConvoSplit = {
  header: string;             // preamble before any section, kept verbatim
  archivable: string;         // sections that should go into the leaf archive
  freshTail: string;          // last K sections, kept in CONVO.md
  sectionCount: number;       // total sections (excluding the header)
  archivableSectionCount: number;
};

export function parseSections(convoText: string): { header: string; sections: string[] } {
  // Section starts at a line beginning with `## ` (markdown h2) preceded by
  // a `---` separator or BOF. We treat the preamble as everything up to the
  // first `## ` line (LCM-style), and slice on `## ` headers from there.
  //
  // Fenced-code awareness: a literal `## not a real heading` line inside a
  // ```/~~~ fence used to be treated as a section break, splitting bodies
  // and polluting timeRangeOf. Track the fence-open state and skip header
  // matches inside (keystone #2).
  const lines = convoText.split(/\r?\n/);
  const isFenceLine = (s: string) => /^(```|~~~)/.test(s);
  let inFence = false;
  let firstSection = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isFenceLine(lines[i])) { inFence = !inFence; continue; }
    if (!inFence && /^## \S/.test(lines[i])) { firstSection = i; break; }
  }
  if (firstSection === -1) {
    return { header: convoText, sections: [] };
  }
  // Strip a trailing `---` separator from the header (it belongs to the first section).
  let headerEnd = firstSection;
  while (headerEnd > 0 && /^(\s*|---\s*)$/.test(lines[headerEnd - 1])) headerEnd--;
  const header = lines.slice(0, headerEnd).join("\n").replace(/\n+$/, "") + "\n";

  // Re-scan from the first section, again tracking fences so a `## fake`
  // line inside a fenced code block does NOT start a new section.
  inFence = false;
  const sections: string[] = [];
  let cur: string[] = [];
  for (let i = firstSection; i < lines.length; i++) {
    if (isFenceLine(lines[i])) { inFence = !inFence; cur.push(lines[i]); continue; }
    if (!inFence && /^## \S/.test(lines[i]) && cur.length) {
      sections.push(cur.join("\n").replace(/\n+$/, ""));
      cur = [];
    }
    cur.push(lines[i]);
  }
  if (cur.length) sections.push(cur.join("\n").replace(/\n+$/, ""));
  return { header, sections };
}

export function splitForArchive(convoText: string, freshTailCount: number): ConvoSplit {
  const { header, sections } = parseSections(convoText);
  const tailStart = Math.max(0, sections.length - freshTailCount);
  const archivableSections = sections.slice(0, tailStart);
  const tailSections = sections.slice(tailStart);
  const sep = "\n\n---\n\n";
  return {
    header,
    archivable: archivableSections.length ? archivableSections.join(sep) + "\n" : "",
    freshTail: tailSections.length ? tailSections.join(sep) + "\n" : "",
    sectionCount: sections.length,
    archivableSectionCount: archivableSections.length,
  };
}

// Best-effort timestamp + author extraction from a section header:
//   ## <author> — <topic> (UTC YYYY-MM-DDTHH:MM:SS[.fff]Z)
// Falls back to (file mtime, "unknown") if a section doesn't match.
// Fractional-seconds suffix is optional — covers `.SSS` (ms), `.SSSSSS` (µs),
// and `.SSSSSSSSS` (ns). Pre-fix the regex hard-coded second-precision and
// silently dropped any agent's section header using millisecond precision
// (e.g. round-2 latency-poll spec instructed `date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"`
// for send_time and several agents echoed that into the section header).
export function sectionMeta(section: string): { author: string; ts: string | null } {
  const m = section.match(/^##\s+([A-Za-z0-9_-]+)\s+—.*?\(UTC\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)\)/m);
  if (!m) return { author: "unknown", ts: null };
  return { author: m[1].toLowerCase(), ts: m[2] };
}

export function timeRangeOf(sections: string[]): { earliest: string; latest: string } {
  const stamps = sections.map((s) => sectionMeta(s).ts).filter((t): t is string => !!t).sort();
  const fallback = utcStamp();
  return { earliest: stamps[0] ?? fallback, latest: stamps[stamps.length - 1] ?? fallback };
}

// ---------------------------------------------------------------------------
// Summary template + validator. Inspired by lossless-claw's depth-aware
// prompts: depth 0 (leaf/segment), 1 (session), 2 (phase), 3+ (durable).
// Each depth specifies what to PRESERVE and what to DROP, and every summary
// must end with the exact `Expand for details about:` line so the model can
// decide whether the `expand` step is worth running.
// ---------------------------------------------------------------------------

export type SummaryRenderInput = {
  edgeId: string;
  archiveId: string;
  kind: ArchiveKind;
  depth: number;
  participants: [string, string];
  earliestAt: string;
  latestAt: string;
  sourceLabel: string;        // "raw sections" for leaf, "child summaries" for condensed
  sourceText: string;         // body to summarize, embedded in HTML comment
};

// Round 12 update: depth-aware prompts adapted from lossless-claw's
// depth-aware-prompts-and-rewrite.md spec. General-purpose (NOT
// software-development-specific) per the spec's own discipline note.
// `buildSummaryPrompt` (below) wraps the policy text with our SUMMARY.md
// schema requirements + the source text and feeds it to runClaude.
export function depthPolicy(depth: number, kind: ArchiveKind): { policy: string; targetTokens: number } {
  if (kind === "leaf") {
    return {
      policy: [
        "You are summarizing a chunk of raw conversation between two participants.",
        "A future model instance will read this summary to understand what happened",
        "and decide whether to expand to the full transcript. Preserve enough detail",
        "that an expand step is unnecessary for downstream work.",
        "",
        "Preserve:",
        "- Key decisions made and their rationale (when rationale matters going forward)",
        "- Direct quotes for the most consequential exchanges (1-2 quotes max)",
        "- Specific references (paths, ids, commit shas, archive ids, URLs) future turns will need",
        "- Active constraints, blockers, and unresolved questions",
        "- Tasks completed (with outcomes, not just \"done\") and tasks still in flight",
        "",
        "Drop:",
        "- Conversational filler (greetings, acknowledgements, hedging)",
        "- Intermediate dead ends when the conclusion is known (keep the conclusion)",
        "- Process scaffolding (lock/flip/turn-protocol mechanics — not relevant to content)",
        "- Verbose references when shorter forms suffice",
      ].join("\n"),
      targetTokens: 1000,
    };
  }
  if (depth <= 1) {
    return {
      policy: [
        "You are condensing several leaf summaries into a session-level memory node.",
        "A future model instance will read this to understand what was decided and",
        "what state the work is in — without re-reading the per-section detail.",
        "",
        "Focus on what matters for continuation:",
        "- Decisions made and their rationale (when rationale matters going forward)",
        "- Decisions altered or superseded, and what replaced them",
        "- Topics completed, with outcomes (not just \"done\" — what was the result?)",
        "- Things still in progress: current state, what remains",
        "- Blockers, open questions, and unresolved tensions",
        "- Specific references (names, paths, URLs, identifiers) future turns will need",
        "",
        "Drop:",
        "- Intermediate exploration or dead ends (keep the conclusion)",
        "- Transient states already resolved",
        "- Tool-internal mechanics and process scaffolding",
        "- Verbose references when shorter forms would suffice",
        "",
        "Include a brief timeline with timestamps (to the hour or half-hour) for",
        "significant events. Present in chronological order. Mark decisions that",
        "supersede earlier ones.",
      ].join("\n"),
      targetTokens: 1500,
    };
  }
  if (depth === 2) {
    return {
      policy: [
        "You are condensing multiple session-level summaries into a higher-level",
        "memory node. Each input summary covers a significant block of conversation.",
        "Your job is to extract the arc: what was the goal, what happened, what",
        "carries forward.",
        "",
        "A future model will read this to understand the trajectory — not the",
        "details of each session, but the overall shape of what occurred and where",
        "things stand.",
        "",
        "Preserve:",
        "- Decisions still in effect and their rationale",
        "- Decisions that evolved: what changed and why",
        "- Completed work with outcomes (not process)",
        "- Active constraints, limitations, and known issues",
        "- Current state of anything still in progress",
        "- Key references only if they're still relevant",
        "",
        "Drop:",
        "- Per-session operational minutiae (internal IDs, tool mechanics, process)",
        "- Specific identifiers and references only relevant within a session",
        "- Anything \"planned\" earlier and \"completed\" later — record only the completion",
        "- Intermediate states a later summary supersedes",
        "- How things were done (unless the method itself was the decision)",
        "",
        "Include a timeline with timestamps (date and approximate time of day) for",
        "key milestones — decisions, completions, phase transitions.",
      ].join("\n"),
      targetTokens: 1800,
    };
  }
  return {
    policy: [
      "You are creating a high-level memory node from multiple phase-level summaries.",
      "This node may persist for the entire remaining conversation. Only include",
      "what a fresh model instance would need to pick up this conversation cold —",
      "possibly days or weeks from now.",
      "",
      "Think: \"what would I need to know?\" not \"what happened?\"",
      "",
      "Preserve:",
      "- Key decisions and their rationale",
      "- What was accomplished and its current state",
      "- Active constraints and hard limitations",
      "- Important relationships between people, systems, or concepts",
      "- Lessons learned (\"don't do X because Y\")",
      "",
      "Drop:",
      "- All operational and process detail",
      "- How things were done (only what was decided and the outcome)",
      "- Specific references unless essential for continuation",
      "- Progress narratives (everything is either done or captured as current state)",
      "",
      "Be ruthlessly concise. Include a brief timeline with dates (or date ranges)",
      "for major milestones and decisions.",
    ].join("\n"),
    targetTokens: 2000,
  };
}

// Round 12: full LLM prompt body for runClaude. Wraps depth-aware policy +
// the SUMMARY.md schema the validator requires + the source text. The LLM's
// stdout is the SUMMARY.md content directly (no preamble, no fences).
export function buildSummaryPrompt(inp: SummaryRenderInput): string {
  const { policy, targetTokens } = depthPolicy(inp.depth, inp.kind);
  return [
    policy,
    "",
    "Output format — Markdown with EXACTLY these section headers, in this order.",
    "The validator will reject your output if any header is missing, renamed,",
    "or appears twice.",
    "",
    "  # SUMMARY — <edge id> · <kind> · depth <n> · <earliest> → <latest>",
    "",
    "  <archive-id: ...>",
    "  <participants: a, b>",
    "  <source: ...>",
    "",
    "  ## TL;DR",
    "  3 lines max. Lead with: what was decided, what is blocked, what is next.",
    "  Do NOT write \"(none)\" here.",
    "",
    "  ## Decisions",
    "  One bullet per decision. \"(none) — explanation\" is acceptable.",
    "",
    "  ## Blockers",
    "  Bulleted; \"(none)\" acceptable.",
    "",
    "  ## Follow-ups",
    "  Bulleted; \"(none)\" acceptable.",
    "",
    "  ## Artifacts referenced",
    "  Bulleted list of paths, commits, archive ids; \"(none)\" acceptable.",
    "",
    "  ## Keywords",
    "  ≥3 distinct alphanumeric tokens of length ≥3, comma-separated.",
    "",
    "  ## Expand for details about:",
    "  Comma-separated list of what was DROPPED or COMPRESSED. Required —",
    "  this is the signal that lets a future agent decide whether to read",
    "  BODY.md. Do NOT write \"(none)\" here.",
    "",
    `Target length: about ${targetTokens} tokens or less.`,
    "Output the SUMMARY.md content directly (no preamble, no markdown fences).",
    "",
    `Edge id: ${inp.edgeId}`,
    `Archive id: ${inp.archiveId}`,
    `Participants: ${inp.participants.join(", ")}`,
    `Time range: ${inp.earliestAt} → ${inp.latestAt}`,
    `Source label: ${inp.sourceLabel}`,
    "",
    "==== source begins ====",
    inp.sourceText,
    "==== source ends ====",
    "",
  ].join("\n");
}

// Round 12 post-process: backfill the `## Keywords` section if the LLM omitted
// it OR emitted fewer than 3 tokens. Preserves the LLM's structure and content;
// only adds/replaces the missing/short Keywords section so validateSummary
// passes without bouncing back to the synthesizer fallback.
export function injectKeywordsIfMissing(summary: string): string {
  const kwRe = /^## Keywords\s*\n([\s\S]*?)(?=\n## |\n*$)/m;
  const m = summary.match(kwRe);
  if (m) {
    // Keywords section exists. Count valid tokens.
    const body = m[1];
    const tokens = body.split(/[,\s\n]+/).filter((t) => /^[a-z0-9-]{3,24}$/i.test(t));
    if (tokens.length >= 3) return summary;
    // Too few — replace the body with backfilled keywords.
    const replacement = backfillKeywordsFromBody(summary);
    return summary.replace(kwRe, `## Keywords\n${replacement}\n`);
  }
  // No Keywords section — inject before "## Expand for details about:".
  const replacement = backfillKeywordsFromBody(summary);
  const expandIdx = summary.search(/^## Expand for details about:/m);
  if (expandIdx < 0) {
    return summary.replace(/\n+$/, "") + `\n\n## Keywords\n${replacement}\n`;
  }
  return summary.slice(0, expandIdx) + `## Keywords\n${replacement}\n\n` + summary.slice(expandIdx);
}

function backfillKeywordsFromBody(body: string): string {
  // Cheap stop-word + length filter. Standalone (not importing from
  // synthesizeAutoSummary) to avoid an import cycle.
  const STOP = new Set([
    "the", "and", "for", "with", "that", "this", "from", "into", "have", "been",
    "will", "could", "should", "would", "about", "their", "there", "which",
    "what", "when", "were", "are", "any", "all", "but", "not", "you", "your",
    "section", "summary", "decision", "decisions", "blocker", "blockers",
    "followup", "followups", "artifact", "artifacts",
    "keyword", "keywords", "expand", "details", "depth", "leaf",
    "condensed", "tldr",
  ]);
  const counts = new Map<string, number>();
  for (const tok of body.toLowerCase().split(/[^a-z0-9-]+/)) {
    if (tok.length < 4 || tok.length > 24) continue;
    if (STOP.has(tok)) continue;
    if (/^\d+$/.test(tok)) continue;
    counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
  if (top.length < 3) return "summary, archive, conversation";
  return top.join(", ");
}

export function renderSummaryStub(inp: SummaryRenderInput): string {
  const { policy, targetTokens } = depthPolicy(inp.depth, inp.kind);
  // The stub embeds the source text inside an HTML comment so the agent can
  // read it while filling in the summary, but the resulting SUMMARY.md is
  // self-contained when stripped of the comment block (`<!-- ... -->`).
  return [
    `# SUMMARY — ${inp.edgeId} · ${inp.kind} · depth ${inp.depth} · ${inp.earliestAt} → ${inp.latestAt}`,
    "",
    `<archive-id: ${inp.archiveId}>`,
    `<participants: ${inp.participants.join(", ")}>`,
    `<source: ${inp.sourceLabel}>`,
    "",
    "## TL;DR",
    "<!-- 3 lines max. Lead with: what was decided, what is blocked, what is next.",
    "     Replace the example below with your real summary — `(none)` is NOT accepted here. -->",
    "Adopted strategy X over alternative Y after evaluating Z; one blocker remains in module M; next step is to land PR #123.",
    "",
    "## Decisions",
    "<!-- One bullet per decision. `(none) — explanation` is acceptable when no",
    "     decision was reached, e.g. `(none) — ran out of time, see follow-ups`. -->",
    "- adopted X over Y because Z (see commit abc1234)",
    "",
    "## Blockers",
    "- (none)  <!-- or: describe the blocker with owner and evidence ref -->",
    "",
    "## Follow-ups",
    "- (none)  <!-- or: describe each follow-up and why it is non-blocking -->",
    "",
    "## Artifacts referenced",
    "- (none)  <!-- or: list paths, commits, archive ids -->",
    "",
    "## Keywords",
    "<!-- ≥3 distinct alphanumeric tokens of length ≥3, comma-separated. Replace these. -->",
    "scan-orchestration, edge-flip, lock-presence",
    "",
    "## Expand for details about:",
    "<!-- Comma-separated list of what was DROPPED or COMPRESSED. Required —",
    "     `(none)` is NOT accepted here; this is the signal that lets a future",
    "     agent decide whether to read BODY.md. -->",
    "exact phrasing of the rejected alternative, intermediate dead ends, why we ruled out method M",
    "",
    "<!-- ====================================================================",
    `${policy}`,
    `Target length: about ${targetTokens} tokens or less.`,
    "Keep the section headings above; the validator checks for them by name.",
    "Once you've filled in every TODO, remove this comment block and any other",
    "<!-- ... --> blocks before saving.",
    "==================================================================== -->",
    "",
    "<!-- ====== source begins below — strip before committing the summary ======",
    inp.sourceText,
    "====== source ends ====== -->",
    "",
  ].join("\n");
}

// Auto-summary synthesizer: produces a deterministic, validator-passing
// SUMMARY.md from raw section bodies + edge metadata. Used by
// `archive.ts auto` so seal+commit can run in a single non-interactive
// CLI call. Quality is shallow (extracts from section headers and bodies
// via heuristics, not LLM synthesis) but the chain is exercised
// end-to-end: every required section gets non-placeholder content and
// the validator passes.
//
// Anti-placeholder discipline: the validator rejects any occurrence of
// `\b(?:todo|fixme|xxx|tbd|wip|placeholder)\b` anywhere in the summary,
// so synthesized text must avoid those tokens even in stable phrasing.
export type AutoSummaryInput = {
  edgeId: string;
  archiveId: string;
  participants: [string, string];
  earliestAt: string;
  latestAt: string;
  sections: string[];        // raw section bodies (pre-archive)
};

const AUTO_SUMMARY_STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "been", "were", "they", "what",
  "when", "where", "their", "would", "could", "should", "about", "which",
  "into", "than", "then", "them", "there", "these", "those", "your",
  "yours", "you", "are", "was", "but", "for", "and", "the", "any",
  "section", "sections", "agent", "user", "turn", "turns",
]);

export function synthesizeAutoSummary(inp: AutoSummaryInput): string {
  const metas = inp.sections.map((s) => sectionMeta(s));
  const authors = [...new Set(metas.map((m) => m.author).filter((a) => a !== "unknown"))];

  // Topic strings from section headers: `## <author> — <topic> (UTC ...)`.
  // Strip the trailing parenthesis and surrounding whitespace.
  const topicOf = (s: string): string => {
    const m = s.match(/^##\s+\S+\s+—\s+(.*?)(?:\s*\(UTC\s+\S+\))?\s*$/m);
    return m ? m[1].trim() : "";
  };
  const topics = inp.sections.map(topicOf).filter(Boolean);
  const distinctTopics = [...new Set(topics)];

  // Decisions: extract `→ <next>` arrows AND lines containing protocol-
  // formal decision verbs (decided, agreed, adopted, accepted, approved).
  // Both are reasonable signals for "what changed in this thread."
  const arrowDecisions = inp.sections
    .map((s) => {
      const m = s.match(/→\s+(\S+)\s*$/m);
      const tm = topicOf(s);
      if (!m) return null;
      return tm ? `${tm} → ${m[1]}` : `flip → ${m[1]}`;
    })
    .filter((d): d is string => d !== null);

  // Artifacts: path-shaped tokens in bodies (extension allowlist).
  const allText = inp.sections.join("\n");
  const pathRegex = /\b[\w./-]+\.(?:md|ts|js|tsx|yaml|yml|json|sh|py|go|rs|lock)\b/g;
  const artifacts = [...new Set(allText.match(pathRegex) ?? [])].slice(0, 12);

  // Keywords: frequency-counted alphanumeric tokens, length ≥4. Stopword
  // filter removes English filler and meta-protocol nouns. Take the
  // top-20 most-frequent and pick 8-12 distinct surviving the filter.
  const tokens = (allText.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])
    .filter((t) => !AUTO_SUMMARY_STOPWORDS.has(t));
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  const topKeywords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([w]) => w);

  // Validator floor: ≥3 distinct alphanumeric tokens of length ≥3 in
  // Keywords. Top-12 from a real conversation virtually always meets
  // this; for short edge cases backfill with author names + topic words.
  let keywords = topKeywords;
  if (keywords.length < 3) {
    const backfill = [
      ...authors,
      ...distinctTopics.flatMap((t) => t.split(/\s+/)).filter((w) => w.length >= 4),
    ].filter((w) => /^[\p{L}\p{N}_-]{3,}$/u.test(w));
    keywords = [...new Set([...keywords, ...backfill])].slice(0, 8);
  }

  const tldrAuthors = authors.length === 0 ? "various" : authors.join(", ");
  const tldrTopics = distinctTopics.slice(0, 3).join("; ");
  const tldr = [
    `Auto-archive of ${inp.sections.length} section(s) from ${tldrAuthors}.`,
    `Time range: ${inp.earliestAt} through ${inp.latestAt}.`,
    tldrTopics ? `Subjects include: ${tldrTopics}.` : "",
  ].filter(Boolean).join(" ");

  const decisionsList = arrowDecisions.length > 0
    ? arrowDecisions.slice(0, 8).map((d) => `- ${d}`).join("\n")
    : `- Recorded ${inp.sections.length} sections by ${tldrAuthors} into one leaf archive`;

  const artifactsList = artifacts.length > 0
    ? artifacts.map((a) => `- ${a}`).join("\n")
    : "(none) — auto-archive detected no path-shaped tokens in the source";

  const expandTopics = distinctTopics.length > 0
    ? distinctTopics.slice(0, 8).map((t) => `- ${t}`).join("\n")
    : `- Section transcript spanning ${inp.sections.length} entries by ${tldrAuthors}`;

  return [
    `# SUMMARY — ${inp.edgeId} · leaf · depth 0 · ${inp.earliestAt} → ${inp.latestAt}`,
    "",
    `<archive-id: ${inp.archiveId}>`,
    `<participants: ${inp.participants.join(", ")}>`,
    `<source: auto-archive (deterministic synthesis from section metadata)>`,
    "",
    "## TL;DR",
    tldr,
    "",
    "## Decisions",
    decisionsList,
    "",
    "## Blockers",
    "(none) — auto-archive does not detect blockers heuristically; consult the body for any unhandled issues",
    "",
    "## Follow-ups",
    "(none) — auto-archive does not detect follow-ups heuristically; consult the body",
    "",
    "## Artifacts referenced",
    artifactsList,
    "",
    "## Keywords",
    keywords.join(", "),
    "",
    "## Expand for details about:",
    expandTopics,
    "",
  ].join("\n");
}

export type SummaryValidation = {
  ok: boolean;
  issues: string[];
};

const REQUIRED_SECTIONS = [
  "TL;DR",
  "Decisions",
  "Blockers",
  "Follow-ups",
  "Artifacts referenced",
  "Keywords",
  "Expand for details about:",
];

// Sections that must contain substantive content. The other three
// (Blockers / Follow-ups / Artifacts referenced) may legitimately be `(none)`.
const REQUIRES_REAL_BODY: ReadonlySet<string> = new Set([
  "TL;DR",
  "Decisions",
  "Keywords",
  "Expand for details about:",
]);

// A "placeholder line" is a whole-line value that conveys no information:
// `(none)`, `n/a`, `tbd`, `todo`, `xxx`, `wip`, `placeholder`, single em/en
// dash, single dot, single underscore. Surrounding list-bullet decoration
// (`-`, `*`) and parenthesis are tolerated; anything else on the line means
// the writer added real content alongside the placeholder.
const PLACEHOLDER_LINE = /^[\s\-*]*\(?\s*(?:none|n\/a|tbd|todo|fixme|xxx|wip|placeholder|—|–|\.|_)\s*\)?[\s\-*]*$/i;

// Generic regex escape — covers every metacharacter, not the partial set
// the previous validator escaped. Future-proofs new entries in
// REQUIRED_SECTIONS that may contain `(`, `)`, `*`, etc.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateSummary(text: string): SummaryValidation {
  // Normalize CR / CRLF to LF so the line-anchored regex below has a
  // consistent terminator to scan against. Then strip HTML comments
  // (lifting their trailing newline so the comment-removal does not
  // leave a blank line inside what should be a body) and fenced code
  // blocks (without this, a SUMMARY.md entirely wrapped in triple
  // backticks renders as a single empty code block but satisfies the
  // heading regex on the raw markdown).
  const stripped = text
    .replace(/\r\n?/g, "\n")
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\n?/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
  const issues: string[] = [];

  // 1. Heading presence + uniqueness. `[^\S\n]+` requires non-newline
  // whitespace between `##` and the heading name (closing the
  // line-split bypass), and the trailing `[^\S\n]*$` likewise refuses
  // to span a newline.
  for (const heading of REQUIRED_SECTIONS) {
    const re = new RegExp(`^##[^\\S\\n]+${escapeRegex(heading)}[^\\S\\n]*$`, "gm");
    const matches = stripped.match(re) ?? [];
    if (matches.length === 0) issues.push(`missing section: "## ${heading}"`);
    else if (matches.length > 1) issues.push(`duplicate section: "## ${heading}"`);
  }

  // 2. Broadened placeholder-marker check. The original validator only
  // caught uppercase `TODO`; this catches the common alternatives
  // (TBD/FIXME/XXX/WIP/PLACEHOLDER) case-insensitively.
  if (/\b(?:todo|fixme|xxx|tbd|wip|placeholder)\b/i.test(stripped)) {
    issues.push("unfilled placeholder marker remains (TODO/FIXME/XXX/TBD/WIP/PLACEHOLDER)");
  }

  // Body capture: stop at the next `## ` heading or absolute end of
  // string. Crucially do NOT stop at a blank line — paragraph breaks
  // inside a body are normal markdown and a comment-strip can also
  // leave a residual blank line ahead of the real content.
  const bodyRegex = (heading: string) =>
    new RegExp(
      `^##[^\\S\\n]+${escapeRegex(heading)}[^\\S\\n]*\\n([\\s\\S]*?)(?=^##[^\\S\\n]|$(?![\\s\\S]))`,
      "m",
    );

  // 3. Real-body check for the four sections that must have substantive
  // content. A body is "real" when at least one line is not a
  // placeholder and the body contains at least one ≥2-char alphanumeric
  // token.
  for (const heading of REQUIRES_REAL_BODY) {
    const m = stripped.match(bodyRegex(heading));
    const body = (m?.[1] ?? "").trim();
    if (!body) {
      issues.push(`section "${heading}" has empty body`);
      continue;
    }
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    const allPlaceholder = lines.length > 0 && lines.every((l) => PLACEHOLDER_LINE.test(l));
    if (allPlaceholder) issues.push(`section "${heading}" is all placeholder tokens`);
    if (!/[\p{L}\p{N}]{2,}/u.test(body)) {
      issues.push(`section "${heading}" has no real-word tokens`);
    }
  }

  // 4. Keywords: at least 3 distinct alphanumeric tokens of length ≥3,
  // case-insensitive. Defeats single-glyph and zero-width-space bypasses.
  const kwM = stripped.match(bodyRegex("Keywords"));
  if (kwM) {
    const toks = new Set(
      kwM[1]
        .split(/[,\n]/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[\p{L}\p{N}_-]{3,}$/u.test(s)),
    );
    if (toks.size < 3) {
      issues.push("Keywords requires ≥3 distinct alphanumeric tokens of length ≥3");
    }
  }

  // 5. Expand-for-details: at least one item that is not a placeholder.
  const exM = stripped.match(bodyRegex("Expand for details about:"));
  if (exM) {
    const items = exM[1]
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !PLACEHOLDER_LINE.test(s));
    if (items.length === 0) {
      issues.push("Expand-for-details has no real items (all placeholder)");
    }
  }

  return { ok: issues.length === 0, issues };
}

export function extractTldr(text: string): string {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, "");
  const m = stripped.match(/^##\s+TL;DR\s*\n([\s\S]*?)(?=^##\s|\s*$)/m);
  if (!m) return "";
  return m[1].trim().split(/\n/).slice(0, 3).join(" ").trim().slice(0, 240);
}

export function extractKeywords(text: string): string[] {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, "");
  const m = stripped.match(/^##\s+Keywords\s*\n([\s\S]*?)(?=^##\s|\s*$)/m);
  if (!m) return [];
  return m[1].split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

// Round 12 slice 2: extract the body of "Expand for details about:" line(s)
// for FTS5 indexing. The Expand-for-details footer is the strongest
// expansion signal — a query that hits there means search.ts expand on
// this archive is highly likely to surface relevant content. Indexed in
// fts.db with bm25 weight 2.5 (highest of the 4 indexed columns).
//
// The codebase consistently writes the header as `## Expand for details about:`
// WITH the trailing colon (validator, stub, LLM prompt all agree). The
// optional `:?` makes the matcher tolerant of either form — a regression
// here means LLM-produced summaries get empty expand_topics indexed,
// silently defeating the bm25-weight-2.5 cross-slice contract.
export function extractExpandTopics(text: string): string {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, "");
  const m = stripped.match(/^##\s+Expand for details about:?\s*\n([\s\S]*?)(?=^##\s|\s*$)/im);
  if (!m) return "";
  return m[1].trim();
}

// Round 12 slice 2: extract the body of all sections OTHER than TL;DR /
// Keywords / Expand-for-details, joined with single newlines. This is
// the "summary_body" indexed column in fts.db — the bulk of the curated
// summary. Used by FTS5 for the broadest term match across the SUMMARY.
export function extractSummaryBody(text: string): string {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, "");
  const headers = stripped.match(/^##\s+[^\n]+/gm) ?? [];
  const skipHeaders = new Set([
    "TL;DR", "Keywords", "Expand for details about",
  ]);
  const parts: string[] = [];
  for (const header of headers) {
    const headerName = header.replace(/^##\s+/, "").trim();
    if (skipHeaders.has(headerName)) continue;
    const re = new RegExp(
      `^##\\s+${headerName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=^##\\s|\\s*$)`,
      "m",
    );
    const m = stripped.match(re);
    if (m) parts.push(m[1].trim());
  }
  return parts.join("\n").trim();
}

// Minimal YAML emitter for our limited META schema. Strings are quoted.
export function writeYaml(p: string, obj: Record<string, unknown>): void {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      if (v.length === 0) { out.push(`${k}: []`); continue; }
      // Inline arrays of scalars; block-style for arrays of arrays.
      if (v.every((x) => typeof x === "string" || typeof x === "number")) {
        out.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`);
      } else {
        out.push(`${k}:`);
        for (const x of v) out.push(`  - ${JSON.stringify(x)}`);
      }
    } else if (v && typeof v === "object") {
      out.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        out.push(`  ${k2}: ${JSON.stringify(v2)}`);
      }
    } else {
      out.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  fs.writeFileSync(p, out.join("\n") + "\n");
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}
