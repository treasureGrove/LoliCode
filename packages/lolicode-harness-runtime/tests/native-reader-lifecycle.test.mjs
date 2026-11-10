import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { notifyNativeSessionFrame, readNativeSession } from "../host-session-native.mjs";
import { prepareRuntime } from "../host-runtime-prepare.mjs";

test("native notifications stop adding frames when the shared SDK output is backed up", () => {
  let release;
  const output = new Writable({ write(_chunk, _encoding, callback) { release = callback; } });
  const sent = [];
  const transport = { notify: (...args) => sent.push(args) };
  const frame = { type: "event", event: { seq: 0 } };
  notifyNativeSessionFrame(transport, output, "fixture", frame);
  assert.deepEqual(sent, [["lolicode/session.native-follow", { subscriptionId: "fixture", frame }]]);
  output.write(Buffer.alloc(16 * 1024 * 1024 + 1));
  try {
    assert.throws(() => notifyNativeSessionFrame(transport, output, "fixture", frame), /NATIVE_FOLLOW_BACKLOG/);
    assert.equal(sent.length, 1);
  } finally {
    release();
    output.destroy();
  }
});

test("a failed native reader installation releases its scope and can be retried", async () => {
  // Fault injection is limited to the lifecycle boundary. The real SDK/Gateway
  // data contract is covered separately by the host-operations integration test.
  const failed = new Error("fixture connection initialization failed");
  const invoked = new Error("fixture reached the Gateway");
  let installations = 0;
  let disposed = 0;
  let peers = 0;
  const host = {
    get: () => true,
    typert: { getPackage: () => true },
    sessions: new Map([["fixture", { header: { origin: "root" } }]]),
    typertGateway: { invoke: async () => { throw invoked; } },
    plugin() {
      installations++;
      return {
        await: async () => {},
        dispose: async () => { disposed++; },
        ctx: {
          plugin: () => ({ await: async () => {} }),
          get: () => ({ createPeer(options) {
            assert.deepEqual(options, { principal: { kind: "owner" }, interactions: "none" });
            if (++peers === 1) throw failed;
            return {};
          } }),
        },
      };
    },
  };
  host.root = host;
  const initial = await Promise.allSettled([readNativeSession(host, "fixture"), readNativeSession(host, "fixture")]);
  for (const result of initial) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, failed);
  }
  assert.equal(installations, 1);
  assert.equal(disposed, 1);
  await assert.rejects(readNativeSession(host, "fixture"), (error) => error === invoked);
  await assert.rejects(readNativeSession(host, "fixture"), (error) => error === invoked);
  assert.equal(installations, 2);
  assert.equal(peers, 2);
  assert.equal(disposed, 1);
});

test("runtime preparation shares one context promise and retries after a failed reader installation", async () => {
  const failure = new Error("fixture runtime preparation failed");
  let installations = 0;
  let peers = 0;
  let disposed = 0;
  const host = {
    get: () => true,
    typert: { getPackage: () => true },
    plugin() {
      installations++;
      return {
        await: async () => {},
        dispose: async () => { disposed++; },
        ctx: {
          plugin: () => ({ await: async () => {} }),
          get: () => ({ createPeer() {
            if (++peers === 1) throw failure;
            return {};
          } }),
        },
      };
    },
  };
  host.root = host;
  const initial = await Promise.allSettled([prepareRuntime(host), prepareRuntime(host)]);
  for (const result of initial) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, failure);
  }
  assert.equal(installations, 1);
  assert.equal(disposed, 1);
  await Promise.all([prepareRuntime(host), prepareRuntime(host)]);
  await prepareRuntime(host);
  assert.equal(installations, 2);
  assert.equal(peers, 2);
  assert.equal(disposed, 1);
});
