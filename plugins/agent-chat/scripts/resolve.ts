// resolve.ts — print this session's identity + edges + paths.
// Usage:
//   bun scripts/resolve.ts                                  identity from env or ./.agent-name
//   bun scripts/resolve.ts --json                           machine-readable
//   bun scripts/resolve.ts --as orion --topology petersen   override identity
//   bun scripts/resolve.ts --whoami                         compact one-line identity check
//                                                           (use this in each shell when two
//                                                           sessions share a cwd, to confirm
//                                                           you didn't forget to export
//                                                           $AGENT_NAME in one of them)

import { loadTopology, resolveIdentity, edgesOf, processTag } from "./lib.ts";

function parseArgs(argv: string[]) {
  const a = { json: false, name: "", topology: "", whoami: false } as
    { json: boolean; name: string; topology: string; whoami: boolean };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") a.json = true;
    else if (argv[i] === "--whoami") a.whoami = true;
    else if (argv[i] === "--as") a.name = argv[++i];
    else if (argv[i] === "--topology") a.topology = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const id = args.name && args.topology
  ? { name: args.name, topology: args.topology, source: "cli" }
  : resolveIdentity();

if (args.whoami) {
  // Compact identity line. Format: "<agent>@<host>:<pid> via <source> in topology <topo>"
  console.log(`${processTag(id.name)} via ${id.source} in topology ${id.topology}`);
  process.exit(0);
}

const topo = loadTopology(id.topology);
if (!topo.agents.includes(id.name)) {
  console.error(`agent "${id.name}" is not in topology "${id.topology}"`);
  process.exit(2);
}
const edges = edgesOf(topo, id.name);

if (args.json) {
  console.log(JSON.stringify({
    identity: id,
    process: processTag(id.name),
    topology: topo.topology,
    edges,
  }, null, 2));
} else {
  console.log(`identity: ${id.name}@${id.topology}  (source: ${id.source})`);
  console.log(`process:  ${processTag(id.name)}`);
  console.log(`edges (${edges.length}):`);
  for (const e of edges) {
    console.log(`  ${e.peer.padEnd(10)} → ${e.dir}`);
  }
}
