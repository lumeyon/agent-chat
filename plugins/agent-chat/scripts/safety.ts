// scripts/safety.ts — destructive-command + secret detection patterns.
//
// Round-15a slice 1 (lumeyon). Pattern set lifted from Ruflo's
// `v3/@claude-flow/guidance/wasm-kernel/src/gates.rs:29-43` with TS regex
// translations. Rationale for adapt-not-adopt: their wasm binary is 1.1MB
// for what's a 20-line regex set. Ours is JS-native; same patterns, no
// runtime dep. See Round-14 audit Finding 4 + audit-summary doc.
//
// Cross-repo greppability convention: pattern `name` field matches Ruflo's
// mental model so a future reviewer comparing both sources lands on the
// same identifier. e.g., `grep "rm-rf" v3/@claude-flow/guidance/wasm-kernel/src/gates.rs`
// AND `grep "rm-rf" scripts/safety.ts` resolve to the same pattern.
//
// Two integration call sites in Round-15a (others may follow):
//   - `agent-chat.ts cmdRun` pre-flight: refuse to invoke `claude -p` if
//     destructive pattern matched in the prompt (overridable via --unsafe).
//   - `archive.ts seal` (Round-15b candidate): scan BODY.md for secrets
//     before permanent archival.

export type SafetyHit = { pattern: string; match: string };

// 11 destructive-command patterns (Ruflo gates.rs:29-43 verbatim, in TS regex).
// Order matters slightly: bail-on-first-match for `detectDestructive`, so
// the most-common patterns lead.
//
// Round-15a Phase-4 carina-NIT-2: removed `drop-database-sql` because the
// case-insensitive `drop-table` pattern at line 27 already matches every
// input it would have matched. Verified by `safety.test.ts` — the test
// asserts `detectDestructive("drop database app_prod")?.pattern === "drop-table"`
// because that pattern fires first. The shadowed pattern was dead code +
// misleading the cross-repo greppability invariant (a reviewer comparing
// to gates.rs would assume both names are live).
export const DESTRUCTIVE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "rm-rf",            re: /(?:^|[\s;`"'(])\brm\s+-rf?\b/i },
  { name: "drop-table",       re: /\bdrop\s+(database|table|schema|index)\b/i },
  { name: "truncate-table",   re: /\btruncate\s+table\b/i },
  { name: "git-push-force",   re: /\bgit\s+push\s+.*--force\b/i },
  { name: "git-reset-hard",   re: /\bgit\s+reset\s+--hard\b/i },
  { name: "git-clean-fd",     re: /\bgit\s+clean\s+-fd?\b/i },
  { name: "format-volume",    re: /\bformat\s+[a-z]:/i },
  { name: "del-recursive",    re: /\bdel\s+\/[sf]\b/i },
  { name: "kubectl-delete",   re: /\b(?:kubectl|helm)\s+delete\s+(?:--all|namespace)\b/i },
  { name: "delete-from",      re: /\bDELETE\s+FROM\s+\w+\s*$/im },
  { name: "alter-drop",       re: /\bALTER\s+TABLE\s+\w+\s+DROP\b/i },
];

// 8 secret-detection patterns (Ruflo gates.rs SECRET_PATTERNS).
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "api-key-quoted",       re: /(?:api[_\-]?key|apikey)\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { name: "secret-quoted",        re: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/i },
  { name: "token-quoted",         re: /(?:token|bearer)\s*[:=]\s*['"][^'"]{10,}['"]/i },
  { name: "private-key-pem",      re: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },
  { name: "openai-key",           re: /sk-[a-zA-Z0-9]{20,}/ },
  { name: "github-personal-token",re: /ghp_[a-zA-Z0-9]{36}/ },
  { name: "npm-token",            re: /npm_[a-zA-Z0-9]{36}/ },
  { name: "aws-access-key",       re: /AKIA[0-9A-Z]{16}/ },
];

// detectDestructive — bail on first match. Returns the pattern name + the
// matched substring (for diagnostic logging) or null on clean input.
export function detectDestructive(text: string): SafetyHit | null {
  for (const { name, re } of DESTRUCTIVE_PATTERNS) {
    const m = text.match(re);
    if (m) return { pattern: name, match: m[0] };
  }
  return null;
}

// scanSecrets — full sweep, multiple hits possible. Returns one entry per
// distinct match. Caller decides how to redact / report.
export function scanSecrets(text: string): SafetyHit[] {
  const out: SafetyHit[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const matches = text.match(new RegExp(re.source, (re.flags || "") + (re.flags?.includes("g") ? "" : "g")));
    if (!matches) continue;
    for (const m of matches) out.push({ pattern: name, match: m });
  }
  return out;
}
