// Offline feasibility probe. No Agent, model, user session, or UI is started.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import { Context } from "@deepseek-ai/cordis";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { z } from "zod";

const require = createRequire(import.meta.url);
const manifest = (name) => readFile(require.resolve(`${name}/package.json`), "utf8").then(JSON.parse);
const sdk = await manifest("@deepseek-ai/dsh");
const context = new Context();
const registry = new SessionProjectionRegistry(context);

try {
  // A probe-owned fold exercises the real public registry, not a replacement
  // implementation of any upstream domain projection or client controller.
  const stateSchema = z.object({ inherited: z.number(), events: z.array(z.json()) });
  const definition = {
    key: "lolicodeReuseProbe",
    stateVersion: 1,
    stateSchema,
    init: (_header, inherited) => ({ inherited, events: [] }),
    apply: (state, event) => ({ ...state, events: [...state.events, event] }),
    wire: { viewSchema: stateSchema, view: (state) => state },
  };
  const handle = await registry.register(definition);
  await registry.register({
    key: "lolicodePrivateProbe",
    stateVersion: 1,
    stateSchema: z.string(),
    init: () => "host-only-fixture",
    apply: (state) => state,
  });
  const session = Session.create(SessionId("lolicode-reuse-probe"));
  assert.deepEqual(registry.snapshot(session), {
    asOfSeq: -1,
    values: { lolicodeReuseProbe: { inherited: 0, events: [] } },
  });

  // Detached Sessions deliberately do not publish store events. Reads advance
  // the real registry over each committed suffix; this is not a live-follow test.
  const events = [
    session.append("turn/start", { turn: 1 }),
    session.append("step/start", { turn: 1, step: 1 }),
  ];
  events.push(session.append("step/end", { turn: 1, step: 1 }));
  const checkpoint = registry.checkpoint(session);
  assert.equal(checkpoint.lolicodePrivateProbe.val, "host-only-fixture");
  events.push(session.append("turn/end", { turn: 1, reason: { kind: "max-tokens" } }));
  const current = registry.snapshot(session);
  assert.equal(current.asOfSeq, 3);
  assert.deepEqual(current.values.lolicodeReuseProbe.events, events);
  assert.equal(Object.hasOwn(current.values, "lolicodePrivateProbe"), false);
  assert.equal(handle.stateOf(session).events[3].data.reason.kind, "max-tokens");

  // Cold suffix replay must agree at the same durable cut. A seeded Session
  // adds an official lifecycle marker: compare the prefix without hiding it.
  const floor = registry.restoreFloor(checkpoint);
  assert.ok(floor > 0, "exercise a real suffix rather than a full-log read");
  const restored = registry.restore(checkpoint, events.slice(floor), floor, session.header, 0);
  assert.deepEqual(restored.snapshot, current);
  const replayed = Session.create(session.id, events, session.header, 0);
  const replayedSnapshot = registry.snapshot(replayed);
  assert.deepEqual(replayedSnapshot.values.lolicodeReuseProbe.events.slice(0, events.length), events);
  assert.equal(replayedSnapshot.values.lolicodeReuseProbe.events.at(-1).type, "session/end-seed");
  assert.equal(replayedSnapshot.asOfSeq, events.length);
  const stale = structuredClone(checkpoint);
  stale.lolicodeReuseProbe.ver += 1;
  assert.equal(registry.restoreFloor(stale), 0);
  assert.deepEqual(registry.restore(stale, events, 0, session.header, 0).snapshot, current);

  // Capture published browser registrations only. Executing their factories
  // requires the actual upstream client loader and injected services.
  const browserModules = [];
  for (const name of [
    "@deepseek-ai/dsh-api-session-controller",
    "@deepseek-ai/dsh-client-ui-session",
    "@deepseek-ai/dsh-client-ui-chat",
  ]) {
    const metadata = await manifest(name);
    assert.equal(metadata.version, sdk.version);
    let registration;
    vm.runInNewContext(await readFile(require.resolve(`${name}/client`), "utf8"), {
      window: { __ModuleLoader__: { load: (value) => { registration = value; } } },
    }, { timeout: 1000 });
    assert.equal(registration?.id, name);
    assert.equal(typeof registration.factory, "function");
    browserModules.push({
      name,
      version: metadata.version,
      format: "upstream-window-module-loader",
      injectedServices: metadata.dsh?.client?.inject ?? [],
      externalModules: metadata.dsh?.client?.external ?? [],
      factoryExecuted: false,
    });
  }

  console.log(JSON.stringify({
    officialVersion: sdk.version,
    passed: [
      "public Session and SessionProjectionRegistry load without web Host",
      "event seq/time/type/data and turn/step/end reason survive probe-owned fold",
      "snapshot watermark matches committed log cut",
      "host-only projection excluded from client snapshot",
      "incremental read and cold checkpoint suffix agree at the same durable cut",
      "seed replay preserves prefix and exposes its additional session/end-seed marker",
      "projection version mismatch falls back to full replay",
      "three published client bundles register with upstream loader",
    ],
    browserModules,
    notVerified: [
      "production domain projection parity and live notification ordering",
      "SessionController Gateway transport and authenticated reconnect",
      "React render, stylesheet isolation, and Tauri WebView compatibility",
      "approval, tools, attachments, forks, and existing user history",
    ],
  }, null, 2));
} finally {
  await context.fiber.dispose();
}
