import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStartupBanner } from "../src/start.js";

test("formatStartupBanner only includes non-internal IPv4 addresses", () => {
  const fakeInterfaces = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    wlan0: [
      { address: "192.168.1.42", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
  };

  const lines = formatStartupBanner(8080, fakeInterfaces);

  assert.equal(lines.length, 1);
  assert.match(lines[0], /192\.168\.1\.42/);
  assert.match(lines[0], /:8080/);
  assert.doesNotMatch(lines.join("\n"), /127\.0\.0\.1/);
});

test("formatStartupBanner returns an empty array when there are no real interfaces", () => {
  const fakeInterfaces = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  };
  assert.deepEqual(formatStartupBanner(8080, fakeInterfaces), []);
});

test("formatStartupBanner handles multiple real interfaces", () => {
  const fakeInterfaces = {
    eth0: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
    wlan0: [{ address: "192.168.1.42", family: "IPv4", internal: false }],
  };
  const lines = formatStartupBanner(3000, fakeInterfaces);
  assert.equal(lines.length, 2);
  assert.ok(lines.some((l) => l.includes("10.0.0.5")));
  assert.ok(lines.some((l) => l.includes("192.168.1.42")));
});
