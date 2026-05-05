// tests/safety.test.ts — Round-15a slice 1 (lumeyon).
//
// Pattern coverage for safety.ts. 12 destructive + 8 secret patterns lifted
// from Ruflo's gates.rs:29-43. Each test is a positive-match + negative-
// clean pair so the regex precision is pinned. False-positives in mid-prose
// (e.g. "don't run rm -rf") are EXPECTED for v1; the cmdRun --unsafe override
// is the production-time workaround. Tests don't assert false-positive
// suppression.

import { test, expect, describe } from "bun:test";
import {
  detectDestructive, scanSecrets,
  DESTRUCTIVE_PATTERNS, SECRET_PATTERNS,
} from "../scripts/safety.ts";

describe("safety.ts — DESTRUCTIVE_PATTERNS coverage (Ruflo gates.rs:29-43 lift)", () => {
  test("rm-rf matches `rm -rf` and `rm -rf /tmp/foo`", () => {
    expect(detectDestructive("rm -rf /tmp/foo")?.pattern).toBe("rm-rf");
    expect(detectDestructive("rm -r /home/user")?.pattern).toBe("rm-rf");
  });

  test("drop-table matches `DROP TABLE` (case-insensitive)", () => {
    expect(detectDestructive("DROP TABLE users")?.pattern).toBe("drop-table");
    expect(detectDestructive("drop database app_prod")?.pattern).toBe("drop-table");
  });

  test("truncate-table matches `TRUNCATE TABLE foo`", () => {
    expect(detectDestructive("TRUNCATE TABLE sessions")?.pattern).toBe("truncate-table");
  });

  test("git-push-force matches `git push origin main --force`", () => {
    expect(detectDestructive("git push origin main --force")?.pattern).toBe("git-push-force");
  });

  test("git-reset-hard matches `git reset --hard HEAD~3`", () => {
    expect(detectDestructive("git reset --hard HEAD~3")?.pattern).toBe("git-reset-hard");
  });

  test("git-clean-fd matches `git clean -fd` and `git clean -f`", () => {
    expect(detectDestructive("git clean -fd")?.pattern).toBe("git-clean-fd");
    expect(detectDestructive("git clean -f")?.pattern).toBe("git-clean-fd");
  });

  test("kubectl-delete matches namespace/all destructive ops", () => {
    expect(detectDestructive("kubectl delete --all")?.pattern).toBe("kubectl-delete");
    expect(detectDestructive("helm delete namespace prod")?.pattern).toBe("kubectl-delete");
  });

  test("alter-drop matches `ALTER TABLE users DROP COLUMN`", () => {
    expect(detectDestructive("ALTER TABLE users DROP COLUMN email")?.pattern).toBe("alter-drop");
  });

  // Round-15a Phase-4 carina-NIT-3 fixes — positive tests for previously
  // untested patterns (format-volume, del-recursive, delete-from). The
  // shadowed `drop-database-sql` pattern was removed in Phase-5 (NIT-2)
  // so test count drops 12 → 11.
  test("format-volume matches `format C:` (Windows)", () => {
    expect(detectDestructive("format C:")?.pattern).toBe("format-volume");
    expect(detectDestructive("FORMAT D:")?.pattern).toBe("format-volume");
  });

  test("del-recursive matches `del /s` and `del /f` (Windows)", () => {
    expect(detectDestructive("del /s C:\\temp")?.pattern).toBe("del-recursive");
    expect(detectDestructive("DEL /f important.txt")?.pattern).toBe("del-recursive");
  });

  test("delete-from matches end-of-line SQL DELETE", () => {
    expect(detectDestructive("DELETE FROM users")?.pattern).toBe("delete-from");
  });

  test("clean prose returns null", () => {
    expect(detectDestructive("just normal text with no danger words")).toBeNull();
    expect(detectDestructive("explaining how rm works in general")).toBeNull();
  });

  test("all 11 destructive patterns are exported (drop-database-sql removed Phase-5)", () => {
    expect(DESTRUCTIVE_PATTERNS.length).toBe(11);
    const names = new Set(DESTRUCTIVE_PATTERNS.map((p) => p.name));
    expect(names.size).toBe(11); // no duplicate names
  });
});

describe("safety.ts — SECRET_PATTERNS coverage", () => {
  test("openai-key matches sk-... format", () => {
    const hits = scanSecrets("OPENAI_KEY=sk-abcdefghijklmnopqrstuv12345");
    expect(hits.find((h) => h.pattern === "openai-key")).toBeDefined();
  });

  test("github-personal-token matches ghp_... format", () => {
    const hits = scanSecrets("export GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(hits.find((h) => h.pattern === "github-personal-token")).toBeDefined();
  });

  test("npm-token matches npm_... format", () => {
    const hits = scanSecrets("//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(hits.find((h) => h.pattern === "npm-token")).toBeDefined();
  });

  test("aws-access-key matches AKIA... format", () => {
    const hits = scanSecrets("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
    expect(hits.find((h) => h.pattern === "aws-access-key")).toBeDefined();
  });

  test("private-key-pem matches BEGIN PRIVATE KEY block", () => {
    const hits = scanSecrets("-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----");
    expect(hits.find((h) => h.pattern === "private-key-pem")).toBeDefined();
  });

  test("api-key-quoted matches `apiKey: \"...\"`", () => {
    const hits = scanSecrets(`config = { apiKey: "supersecretvalue" };`);
    expect(hits.find((h) => h.pattern === "api-key-quoted")).toBeDefined();
  });

  test("secret-quoted matches `password = \"...\"`", () => {
    const hits = scanSecrets(`password = "letmein123"`);
    expect(hits.find((h) => h.pattern === "secret-quoted")).toBeDefined();
  });

  test("token-quoted matches `token: \"...\"`", () => {
    const hits = scanSecrets(`{ token: "abcdef1234567890" }`);
    expect(hits.find((h) => h.pattern === "token-quoted")).toBeDefined();
  });

  test("clean prose returns []", () => {
    expect(scanSecrets("just normal text")).toEqual([]);
    expect(scanSecrets("discussing apis and tokens in general")).toEqual([]);
  });

  test("all 8 secret patterns are exported", () => {
    expect(SECRET_PATTERNS.length).toBe(8);
    const names = new Set(SECRET_PATTERNS.map((p) => p.name));
    expect(names.size).toBe(8);
  });
});
