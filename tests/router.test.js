import { test } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../src/router.js";

test("matches a static route with no params", () => {
  const router = new Router();
  router.add("GET", "/healthz", () => "ok");
  const match = router.match("GET", "/healthz");
  assert.ok(match);
  assert.deepEqual(match.params, {});
});

test("extracts multiple path params in order", () => {
  const router = new Router();
  router.add("POST", "/admin/venues/:venueId/tables/:tableId/pair", () => "ok");
  const match = router.match("POST", "/admin/venues/v1/tables/t1/pair");
  assert.ok(match);
  assert.deepEqual(match.params, { venueId: "v1", tableId: "t1" });
});

test("decodes URL-encoded param segments", () => {
  const router = new Router();
  router.add("GET", "/t/:token/state", () => "ok");
  const match = router.match("GET", "/t/abc%2Fdef/state");
  assert.equal(match.params.token, "abc/def");
});

test("does not match on wrong method", () => {
  const router = new Router();
  router.add("GET", "/t/:token/state", () => "ok");
  assert.equal(router.match("POST", "/t/abc/state"), null);
});

test("does not match on different segment count", () => {
  const router = new Router();
  router.add("GET", "/t/:token/state", () => "ok");
  assert.equal(router.match("GET", "/t/abc/state/extra"), null);
});

test("ignores query strings when matching", () => {
  const router = new Router();
  router.add("GET", "/t/:token/state", () => "ok");
  const match = router.match("GET", "/t/abc/state?foo=bar");
  assert.ok(match);
  assert.equal(match.params.token, "abc");
});

test("returns null when nothing matches", () => {
  const router = new Router();
  router.add("GET", "/healthz", () => "ok");
  assert.equal(router.match("GET", "/nope"), null);
});
