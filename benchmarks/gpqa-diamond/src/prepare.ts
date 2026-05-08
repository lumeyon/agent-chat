#!/usr/bin/env bun
// prepare.ts — normalize raw GPQA Diamond CSV into a JSONL of clean
// problems with shuffled answer choices.
//
// The raw CSV has many metadata columns; we extract:
//   - Question (the polished question text)
//   - Correct Answer (the right answer text)
//   - Incorrect Answer 1/2/3 (the distractors)
//   - Subdomain (e.g., "Quantum Mechanics", "Organic Chemistry")
//   - High-level domain (Physics / Chemistry / Biology / etc.)
//   - Record ID (stable identifier)
//
// We then shuffle the 4 choices with a fixed seed so the position of
// the correct letter (A/B/C/D) is randomized but reproducible.
//
// Output: data/problems.jsonl with one JSON object per line:
//   { id, domain, subdomain, question, choices: {A,B,C,D}, answer: "C" }

import * as fs from "node:fs";
import * as path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RAW_CSV = path.join(HERE, "..", "data", "raw.csv");
const OUT_JSONL = path.join(HERE, "..", "data", "problems.jsonl");

// Tiny CSV parser tolerant of quoted multi-line cells. The dataset
// has questions with embedded newlines inside quoted fields.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(cell);
        cell = "";
      } else if (c === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else if (c === "\r") {
        // ignore — wait for \n
      } else {
        cell += c;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// Deterministic PRNG (mulberry32) seeded from the question's record ID
// so each problem's shuffle is reproducible.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stringSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

function shuffleWithSeed<T>(arr: T[], seed: number): T[] {
  const out = arr.slice();
  const r = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function main() {
  const raw = fs.readFileSync(RAW_CSV, "utf8");
  const rows = parseCsv(raw);
  if (rows.length === 0) throw new Error("empty CSV");
  const header = rows[0];
  const idx = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`column not found: ${name}`);
    return i;
  };
  const colQuestion = idx("Question");
  const colCorrect = idx("Correct Answer");
  const colInc1 = idx("Incorrect Answer 1");
  const colInc2 = idx("Incorrect Answer 2");
  const colInc3 = idx("Incorrect Answer 3");
  const colSubdomain = idx("Subdomain");
  const colDomain = idx("High-level domain");
  const colRecordId = idx("Record ID");

  const out = fs.createWriteStream(OUT_JSONL);
  let count = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < header.length) continue;  // tolerate trailing blank rows
    const question = row[colQuestion]?.trim();
    if (!question) continue;
    const correct = row[colCorrect].trim();
    const inc1 = row[colInc1].trim();
    const inc2 = row[colInc2].trim();
    const inc3 = row[colInc3].trim();
    const recordId = row[colRecordId].trim();

    // Shuffle the 4 choices deterministically per record.
    const choices = shuffleWithSeed(
      [
        { text: correct, isCorrect: true },
        { text: inc1, isCorrect: false },
        { text: inc2, isCorrect: false },
        { text: inc3, isCorrect: false },
      ],
      stringSeed(recordId),
    );
    const letters = ["A", "B", "C", "D"] as const;
    const choiceMap: Record<string, string> = {};
    let answerLetter = "";
    for (let i = 0; i < 4; i++) {
      const letter = letters[i];
      choiceMap[letter] = choices[i].text;
      if (choices[i].isCorrect) answerLetter = letter;
    }

    const problem = {
      id: recordId,
      domain: row[colDomain].trim(),
      subdomain: row[colSubdomain].trim(),
      question,
      choices: choiceMap,
      answer: answerLetter,
    };
    out.write(JSON.stringify(problem) + "\n");
    count++;
  }
  out.end();
  console.log(`# wrote ${count} problems → ${OUT_JSONL}`);
}

main();
