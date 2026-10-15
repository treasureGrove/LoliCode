import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createCapabilityFacade } from "./capabilities.js";
import { NodeServices, Rpc, Services } from "./services.mjs";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lolicode-capabilities-"));
  const collection = new Services.ServiceCollection();
  const file = NodeServices.createFileService();
  collection.register(Services.IFileService, file);
  const facade = createCapabilityFacade({
    services: collection,
    privateRoot: root,
    configDirectory: root,
  });
  cleanups.push(async () => {
    await facade.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { root, collection, facade, file };
}

test("descriptor, channel and app-facing names call the same original native file service", async () => {
  const { root, facade, file } = await fixture();
  const path = join(root, "source.txt");
  await writeFile(path, "original native service\n", "utf8");
  const expected = await file.readTextFile({ path });
  for (const name of [
    "IFileService",
    Services.IFileService.channelName,
    "fileService",
  ]) {
    assert.deepEqual(
      await facade.dispatch(name, "readTextFile", [{ path }]),
      expected,
    );
  }
  assert.equal(await readFile(path, "utf8"), "original native service\n");
  assert.equal(facade.getServices(), facade.getServices());
});

test("capability dispatch rejects credential/prototype access and remote fallback", async () => {
  const { facade } = await fixture();
  await assert.rejects(
    facade.dispatch("ICredentialService", "get", ["key"]),
    /not an exposed capability/,
  );
  await assert.rejects(
    facade.dispatch("IFileService", "constructor", []),
    /Invalid capability method/,
  );
  await assert.rejects(
    facade.dispatch("IFileService", "__proto__", []),
    /Invalid capability method/,
  );
  await assert.rejects(
    facade.dispatch("IFileService", "readTextFile", [{ path: "unread" }], {
      remoteId: "missing",
    }),
    /Remote connections/,
  );
  await assert.rejects(
    facade.dispatch("remote", "connect", []),
    /not configured/,
  );
});

test("native subscriptions are disposed and late events never reach a closed caller", async () => {
  const { collection, facade } = await fixture();
  const emitter = new Rpc.Emitter<unknown>();
  collection.register(Services.IModelSelectionService, {
    onDidChange: emitter.event,
  } as never);
  const events: unknown[] = [];
  const subscription = facade.subscribe(
    "IModelSelectionService",
    "onDidChange",
    [],
    (value) => events.push(value),
  );
  emitter.fire({ revision: 1 });
  subscription.dispose();
  emitter.fire({ revision: 2 });
  assert.deepEqual(events, [{ revision: 1 }]);
  await facade.dispose();
  assert.throws(
    () =>
      facade.subscribe("IModelSelectionService", "onDidChange", [], () => {}),
    /closed/,
  );
  emitter.dispose();
});

test("dynamic event factories preserve the original session argument", async () => {
  const { collection, facade } = await fixture();
  const emitter = new Rpc.Emitter<unknown>();
  const args: string[] = [];
  collection.register(Services.IZCodeTaskService, {
    onDynamicTaskTerminalOutcome(id: string) {
      args.push(id);
      return emitter.event;
    },
  } as never);
  const events: unknown[] = [];
  facade.subscribe(
    "IZCodeTaskService",
    "onDynamicTaskTerminalOutcome",
    ["real-task-id"],
    (value) => events.push(value),
  );
  emitter.fire({ inputId: "real-input", outcome: "succeeded" });
  assert.deepEqual(args, ["real-task-id"]);
  assert.equal(events.length, 1);
  await facade.dispose();
  emitter.fire({ outcome: "late" });
  assert.equal(events.length, 1);
  emitter.dispose();
});

test("busy tracks a native operation until its actual result", async () => {
  const { collection, facade } = await fixture();
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  collection.register(Services.IFileService, {
    async stat() {
      await waiting;
      return { exists: true };
    },
  } as never);
  const call = facade.dispatch("IFileService", "stat", [{ path: "fixture" }]);
  assert.equal(facade.busy(), true);
  finish();
  assert.deepEqual(await call, { exists: true });
  assert.equal(facade.busy(), false);
});

test("the automation facade persists real CRUD in an isolated native repository", async () => {
  const { root, facade } = await fixture();
  const created = (await facade.dispatch("automation", "create", [
    {
      title: "Saved native schedule",
      cronExpr: "0 0 1 1 *",
      prompt: "No model call",
      workspacePath: root,
      recurring: true,
    },
  ])) as { automationId: string };
  const items = (await facade.dispatch("automation", "list")) as Array<{
    automationId: string;
  }>;
  assert.equal(items[0].automationId, created.automationId);
  await facade.dispatch("automation", "setEnabled", [
    created.automationId,
    false,
  ]);
  assert.equal(
    (await facade.automation.service.get(created.automationId))?.enabled,
    false,
  );
  await facade.dispatch("automation", "delete", [created.automationId]);
  assert.deepEqual(await facade.dispatch("automation", "list"), []);
});

test("a misleading directory prefix cannot place native data outside the private root", async () => {
  const { root, collection } = await fixture();
  assert.throws(
    () =>
      createCapabilityFacade({
        services: collection,
        privateRoot: root,
        configDirectory: `${root}-other`,
      }),
    /private runtime directory/,
  );
  assert.throws(
    () =>
      createCapabilityFacade({
        services: collection,
        privateRoot: "relative",
        configDirectory: root,
      }),
    /absolute runtime root/,
  );
});
