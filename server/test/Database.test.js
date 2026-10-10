import test from "node:test";
import assert from "node:assert/strict";
import { connectToDatabase, getDatabaseStatus } from "../src/config/database.js";

test("database status distinguishes demo, connecting, connected, and disconnected states", () => {
  assert.equal(getDatabaseStatus({ configured: false, readyState: 0 }), "demo-mode");
  assert.equal(getDatabaseStatus({ configured: true, readyState: 2 }), "connecting");
  assert.equal(getDatabaseStatus({ configured: true, readyState: 1 }), "connected");
  assert.equal(getDatabaseStatus({ configured: true, readyState: 0 }), "disconnected");
});

test("database connection retries transient startup failures and starts services after recovery", async () => {
  let attempts = 0;
  let serviceStarted = false;
  const delays = [];
  const connected = await connectToDatabase({
    uri: "mongodb://example.test",
    connect: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary outage");
    },
    sleep: async milliseconds => delays.push(milliseconds),
    onConnected: () => { serviceStarted = true; }
  });

  assert.equal(connected, true);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [5000]);
  assert.equal(serviceStarted, true);
});

test("database connection cleanly stays in demo mode without a URI", async () => {
  let attempted = false;
  const connected = await connectToDatabase({
    uri: "",
    connect: async () => { attempted = true; }
  });
  assert.equal(connected, false);
  assert.equal(attempted, false);
});
