import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVideoId } from "../src/youtube.js";

const ID = "dQw4w9WgXcQ"; // 11 chars, real-shaped example ID

test("accepts a bare video ID", () => {
  assert.equal(extractVideoId(ID), ID);
});

test("extracts from a watch URL", () => {
  assert.equal(extractVideoId(`https://www.youtube.com/watch?v=${ID}`), ID);
});

test("extracts from a watch URL with extra query params", () => {
  assert.equal(
    extractVideoId(`https://www.youtube.com/watch?list=PL123&v=${ID}&t=42s`),
    ID,
  );
});

test("extracts from a youtu.be short URL", () => {
  assert.equal(extractVideoId(`https://youtu.be/${ID}`), ID);
});

test("extracts from a shorts URL", () => {
  assert.equal(extractVideoId(`https://www.youtube.com/shorts/${ID}`), ID);
});

test("trims surrounding whitespace before matching", () => {
  assert.equal(extractVideoId(`  ${ID}  `), ID);
});

test("returns null for a non-YouTube URL", () => {
  assert.equal(extractVideoId("https://example.com/watch?v=" + ID), null);
});

test("returns null for garbage input", () => {
  assert.equal(extractVideoId("not a link at all"), null);
});

test("returns null for an empty string", () => {
  assert.equal(extractVideoId(""), null);
});

test("returns null for non-string input", () => {
  assert.equal(extractVideoId(null), null);
  assert.equal(extractVideoId(undefined), null);
  assert.equal(extractVideoId(42), null);
});

test("returns null for a too-short ID-like string", () => {
  assert.equal(extractVideoId("short"), null);
});

test("returns null for a too-long ID-like string", () => {
  assert.equal(extractVideoId("waytoolongtobeavalidid"), null);
});
