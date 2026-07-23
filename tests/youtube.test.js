import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVideoId, fetchOembedTitle } from "../src/youtube.js";

const ID = "dQw4w9WgXcQ"; // 11 chars, real-shaped example ID
const REAL_VIDEO_ID = "jNQXAC9IVRw"; // "Me at the zoo" — real, distinct from ID above

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

// Real network calls to YouTube's real oEmbed endpoint — deliberately not
// mocked, matching this project's established precedent (KR4) of
// verifying real YouTube-dependent behavior against the real service
// rather than a fabricated mock that would only prove the code handles
// a shape it was told to expect.
test("fetchOembedTitle returns the real title for a known, real video ID", async () => {
  const title = await fetchOembedTitle(REAL_VIDEO_ID);
  assert.equal(title, "Me at the zoo");
});

test("fetchOembedTitle returns null for a syntactically-valid but nonexistent video ID", async () => {
  const title = await fetchOembedTitle("00000000000");
  assert.equal(title, null);
});

test("fetchOembedTitle returns null instead of throwing for garbage input", async () => {
  const title = await fetchOembedTitle("not a real id at all!!");
  assert.equal(title, null);
});
