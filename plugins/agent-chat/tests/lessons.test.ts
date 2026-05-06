// tests/lessons.test.ts — Round-15o cross-edge crystallized lessons
//
// Closes the last open learning loop in agent-chat: cross-edge wisdom
// crystallizes via <lesson topic="..."> directives in cmdRun output AND
// surfaces in future cmdRun prompts via composeLessonsPromptBlock. The
// pattern that tree-of-knowledge tried but didn't close (writes accumulated
// without ever changing reads).

import { test, expect, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("Round-15o lessons primitives", () => {
  test("appendLesson + readLesson round-trips a single entry", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-lesson-rt-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      const fresh = await import(`../scripts/lib.ts?bust=${Date.now()}rt`);
      fresh.appendLesson("orion", "bwrap-survival", "When bwrap fails, file-based protocol still works.");
      const body = fresh.readLesson("orion", "bwrap-survival");
      expect(body).not.toBeNull();
      expect(body).toMatch(/^## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
      expect(body).toContain("file-based protocol still works");
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("appendLesson is append-only — second call on same topic preserves first", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-lesson-app-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      const fresh = await import(`../scripts/lib.ts?bust=${Date.now()}app`);
      fresh.appendLesson("orion", "bwrap-survival", "first lesson body");
      // Insert a small delay so the second utcStamp differs from the
      // first if the resolution is per-second (it is, in lib.ts utcStamp).
      // Two entries with the same timestamp would still be appended (no
      // dedup logic), but distinct timestamps prove the dated-trail shape.
      const start = Date.now(); while (Date.now() - start < 1100) {}
      fresh.appendLesson("orion", "bwrap-survival", "second lesson body");
      const body = fresh.readLesson("orion", "bwrap-survival");
      expect(body).toContain("first lesson body");
      expect(body).toContain("second lesson body");
      const dateHeaders = (body!.match(/^## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/gm) ?? []);
      expect(dateHeaders.length).toBe(2);
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("appendLesson refuses empty body, oversized body, invalid topic", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-lesson-bad-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      const fresh = await import(`../scripts/lib.ts?bust=${Date.now()}bad`);
      expect(() => fresh.appendLesson("orion", "valid-topic", "")).toThrow(/empty/);
      expect(() => fresh.appendLesson("orion", "valid-topic", "   \n  ")).toThrow(/empty/);
      const oversized = "x".repeat(fresh.LESSON_BODY_MAX_BYTES + 1);
      expect(() => fresh.appendLesson("orion", "valid-topic", oversized)).toThrow(/too long/);
      expect(() => fresh.appendLesson("orion", "Invalid Topic With Spaces", "body")).toThrow(/invalid lesson topic/);
      expect(() => fresh.appendLesson("orion", "topic/with/slash", "body")).toThrow(/invalid lesson topic/);
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("listLessonTopics returns only this agent's topics, sorted", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-lesson-list-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      const fresh = await import(`../scripts/lib.ts?bust=${Date.now()}list`);
      fresh.appendLesson("orion", "zebra-topic", "z");
      fresh.appendLesson("orion", "apple-topic", "a");
      fresh.appendLesson("orion", "midstream", "m");
      fresh.appendLesson("lumeyon", "different-agent", "shouldnt-leak");
      const orionTopics = fresh.listLessonTopics("orion");
      expect(orionTopics).toEqual(["apple-topic", "midstream", "zebra-topic"]);
      const lumeyonTopics = fresh.listLessonTopics("lumeyon");
      expect(lumeyonTopics).toEqual(["different-agent"]);
      // Per-agent isolation: orion's lessons never appear in lumeyon's listing.
      expect(lumeyonTopics).not.toContain("apple-topic");
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("clearLesson: returns true on existing, false otherwise", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-lesson-clear-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      const fresh = await import(`../scripts/lib.ts?bust=${Date.now()}clr`);
      fresh.appendLesson("orion", "transient", "body");
      expect(fresh.clearLesson("orion", "transient")).toBe(true);
      expect(fresh.clearLesson("orion", "transient")).toBe(false);
      expect(fresh.readLesson("orion", "transient")).toBeNull();
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("composeLessonsPromptBlock surfaces headlines for each topic", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-lesson-compose-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      const fresh = await import(`../scripts/lib.ts?bust=${Date.now()}compose`);
      fresh.appendLesson("orion", "topic-one", "First headline.\n\nMore detail in body.");
      fresh.appendLesson("orion", "topic-two", "Second headline.\nMore body.");
      const block = fresh.composeLessonsPromptBlock("orion");
      expect(block).toContain("Lessons you've crystallized");
      expect(block).toContain("topic-one: First headline");
      expect(block).toContain("topic-two: Second headline");
      expect(block).toContain("agent-chat lessons get <topic>");
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("composeLessonsPromptBlock returns empty string when no lessons", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-lesson-empty-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      const fresh = await import(`../scripts/lib.ts?bust=${Date.now()}empty`);
      expect(fresh.composeLessonsPromptBlock("nobody")).toBe("");
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("composeLessonsPromptBlock surfaces the MOST RECENT dated entry's headline", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ac-lesson-recent-"));
    const prevEnv = process.env.AGENT_CHAT_CONVERSATIONS_DIR;
    process.env.AGENT_CHAT_CONVERSATIONS_DIR = tmp;
    try {
      const fresh = await import(`../scripts/lib.ts?bust=${Date.now()}recent`);
      fresh.appendLesson("orion", "evolving", "Old headline (first version).");
      const start = Date.now(); while (Date.now() - start < 1100) {}
      fresh.appendLesson("orion", "evolving", "New headline (refined version).");
      const block = fresh.composeLessonsPromptBlock("orion");
      expect(block).toContain("evolving: New headline");
      expect(block).not.toContain("evolving: Old headline");
    } finally {
      if (prevEnv == null) delete process.env.AGENT_CHAT_CONVERSATIONS_DIR;
      else process.env.AGENT_CHAT_CONVERSATIONS_DIR = prevEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
