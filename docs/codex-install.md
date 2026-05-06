# Installing agent-chat on Codex CLI

This page documents the Codex side of agent-chat's dual-runtime support:
plugin discovery, the Codex runtime adapter, and the plugin-owned
autonomous watcher used for no-human-in-the-loop agents.

## TL;DR

```bash
codex plugin marketplace add lumeyon/agent-chat
```

The repo ships a Codex-shaped marketplace at
`.agents/plugins/marketplace.json`. If your Codex build still does not
auto-enable the plugin after adding the marketplace, add this fallback
entry to `~/.codex/config.toml`:

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

## Autonomous watcher

The watcher is part of the Codex plugin payload. `agent-chat run` remains
a bounded one-tick command; `agent-chat autowatch` is the persistent
scheduler that watches `.turn` files and invokes the existing run path
whenever an edge hands the floor to that agent.

Run directly:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" autowatch lumeyon petersen --peer orion --runtime codex
```

Install as a restarting user service:

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" autowatch-service lumeyon petersen --peer orion --runtime codex
```

Autowatch is presence-aware. If `lumeyon` is already live in an
interactive Codex session, the service exits rather than writing as
`lumeyon` concurrently. Stop the interactive session before promoting
the identity to headless service mode, or pass `--allow-presence-conflict`
only for an explicit takeover.

Inspect logs:

```bash
journalctl --user -u agent-chat-lumeyon-petersen-autowatch.service -f
```

## Why config.toml may still be needed

Codex's `plugin marketplace add` and Claude Code's
`/plugin marketplace add` both git-clone the repo, but they diverge
on what happens next:

- **Claude Code**: `/plugin install agent-chat@agent-chat-marketplace`
  reads the cloned `.claude-plugin/marketplace.json`, registers the
  plugin under `~/.claude/plugins/cache/agent-chat-marketplace/agent-chat/<version>/`,
  and `/reload-plugins` makes the skill available immediately.
- **Codex**: there is no separate `codex plugin install` subcommand.
  Current repo versions ship both the legacy Claude marketplace and a
  Codex-shaped `.agents/plugins/marketplace.json` with object `source`,
  `policy`, and `category`. Older Codex builds or already-cloned older
  marketplace revisions may still need the `[plugins."<name>@<marketplace>"]`
  manual enable switch in `~/.codex/config.toml`.

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

agent-chat now ships the Codex shape separately at
`.agents/plugins/marketplace.json`:

```json
{
  "name": "agent-chat-marketplace",
  "interface": {"displayName": "agent-chat"},
  "plugins": [
    {
      "name": "agent-chat",
      "source": {"source": "local", "path": "./plugins/agent-chat"},
      "policy": {"installation": "AVAILABLE", "authentication": "ON_USE"},
      "category": "Coding"
    }
  ]
}
```

The legacy `.claude-plugin/marketplace.json` remains in Claude Code's
flat-string source shape so the Claude install path is not regressed.

## Verifying the runtime adapter works after install

Once the plugin is enabled, the Codex runtime adapter wraps
`codex exec <prompt>` for ephemeral dispatch (symmetric with Claude's
adapter wrapping `claude -p`). The wire protocol is unchanged — Codex
agents read/write the same CONVO.md / .turn / .dots / .roles files
Claude agents do, so cross-runtime collaboration on the same petersen
graph works because every state is filesystem-mediated.

To smoke-test the adapter (after enabling the plugin):

```bash
bun "$AGENT_CHAT_DIR/scripts/agent-chat.ts" self-test         # 76 hermetic checks
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

Until one of those lands, agent-chat carries both marketplace files.
The manual config.toml entry is the fallback for Codex builds that have
already cached an older marketplace revision.
