# Installing agent-chat on Codex CLI

This page documents the empirical install lifecycle for the Codex side
of agent-chat's dual-runtime support, including the schema-mismatch
workaround you currently need until Codex's plugin discovery converges
with Claude Code's marketplace.json shape.

## TL;DR

```bash
codex plugin marketplace add lumeyon/agent-chat
```

Then add this entry to `~/.codex/config.toml`:

```toml
[plugins."agent-chat@agent-chat-marketplace"]
enabled = true
```

Verify the runtime adapter works:

```bash
AGENT_CHAT_DIR="$(ls -d ~/.codex/.tmp/marketplaces/agent-chat-marketplace/plugins/agent-chat 2>/dev/null)"
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" doctor --paths
```

If `bun` is on PATH and the script prints SKILL_ROOT + CONVERSATIONS_DIR
without errors, the install is healthy and the Codex runtime adapter
(scripts/runtimes/codex.ts, Round-15i) is ready to dispatch through
`codex exec`.

## Why the manual config.toml step

Codex's `plugin marketplace add` and Claude Code's
`/plugin marketplace add` both git-clone the repo, but they diverge
on what happens next:

- **Claude Code**: `/plugin install agent-chat@agent-chat-marketplace`
  reads the cloned `.claude-plugin/marketplace.json`, registers the
  plugin under `~/.claude/plugins/cache/agent-chat-marketplace/agent-chat/<version>/`,
  and `/reload-plugins` makes the skill available immediately.
- **Codex**: there is no separate `codex plugin install` subcommand;
  per-plugin enable happens through `~/.codex/config.toml` entries.
  Pre-existing curated plugins (`openai-curated`) ship with a richer
  marketplace.json schema that Codex parses to populate the agent's
  available-plugins list automatically; our marketplace.json (in
  `.claude-plugin/`) uses Claude Code's flat-string `source` field
  which Codex tolerates at the marketplace level (the marketplace
  is registered) but doesn't fully expand into per-plugin metadata.
  The `[plugins."<name>@<marketplace>"] enabled = true` toml entry
  is the manual switch that bypasses the auto-discovery gap.

## The empirical schema diff

Codex's curated marketplace.json (verified against codex-cli 0.128.0):

```json
{
  "name": "openai-curated",
  "interface": {"displayName": "Codex official"},
  "plugins": [
    {
      "name": "linear",
      "source": {"source": "local", "path": "./plugins/linear"},
      "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
      "category": "Productivity"
    }
  ]
}
```

Ours (Claude Code shape):

```json
{
  "name": "agent-chat-marketplace",
  "owner": {"name": "tickcode", "url": "https://github.com/lumeyon"},
  "description": "...",
  "plugins": [
    {
      "name": "agent-chat",
      "source": "./plugins/agent-chat",
      "description": "..."
    }
  ]
}
```

Differences that matter:
- `interface.displayName` (Codex-specific) vs `description` (Claude-specific)
- `source: { source: "local", path: ... }` object vs `source: "..."` string
- `policy: { installation, authentication }` (Codex-only)
- `category` (Codex)

Because Claude Code rejected `repository: { type: "git", url: "..." }` as
"expected string" in earlier rounds, switching `source` to Codex's object
form would likely break the Claude Code install. We don't have a way to
verify Claude Code's tolerance without risking the install for all current
users, so the workaround above is the conservative path.

## Verifying the runtime adapter works after install

Once the toml entry is in place, the Codex runtime adapter wraps
`codex exec <prompt>` for ephemeral dispatch (symmetric with Claude's
adapter wrapping `claude -p`). The wire protocol is unchanged — Codex
agents read/write the same CONVO.md / .turn / .dots / .roles files
Claude agents do, so cross-runtime collaboration on the same petersen
graph works because every state is filesystem-mediated.

To smoke-test the adapter (after enabling the plugin):

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" self-test         # 62 hermetic checks
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" network-test      # 205 Dot Collector checks
```

For real LLM round-trips through Codex (analogous to llm-smoke for
Claude), see the test plan in `scripts/runtimes/codex.ts`'s leading
comment — empirical Codex smoke is a follow-up round.

## Filing the schema convergence

The right long-term fix is one of:
1. Codex's marketplace.json parser tolerates Claude Code's flat-string
   `source` field as shorthand for `{source: "local", path: <string>}`.
2. Claude Code's parser tolerates Codex's object `source` field.
3. The two CLIs agree on a polyglot schema.

Until one of those lands, the manual config.toml workaround above is
the install path for Codex users.
