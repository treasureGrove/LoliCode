import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  randomUUID,
} from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareRelease } from "./lolicode-release.mjs";
import {
  preparePublishPlan,
  publishRelease,
  quotePosix,
  remoteCommand,
  REMOTE_NAMESPACE,
  PUBLIC_NAMESPACE,
} from "./lolicode-publish.mjs";

const wrap = (value) => Buffer.from(value).toString("base64");
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "lolicode-publish-test-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8),
    data = Buffer.from(
      "MZ owned publication unit fixture, never a real installer",
    );
  const signature = sign(
      null,
      createHash("blake2b512").update(data).digest(),
      privateKey,
    ),
    comment = "timestamp:1700000000\tfile:fixture.exe";
  const encodedKey = wrap(
    `untrusted comment: owned test public key\n${Buffer.concat([Buffer.from("Ed"), keyId, publicKey.export({ type: "spki", format: "der" }).subarray(-32)]).toString("base64")}\n`,
  );
  const encodedSignature = wrap(
    `untrusted comment: owned test\n${Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64")}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey).toString("base64")}\n`,
  );
  const installer = path.join(root, "fixture.exe"),
    signatureFile = `${installer}.sig`,
    pub = path.join(root, "fixture.key.pub"),
    config = path.join(root, "tauri.json");
  writeFileSync(installer, data);
  writeFileSync(signatureFile, encodedSignature);
  writeFileSync(pub, encodedKey);
  writeFileSync(
    config,
    JSON.stringify({
      productName: "LoliCode",
      version: "4.0.13",
      bundle: { createUpdaterArtifacts: true },
      plugins: {
        updater: {
          pubkey: encodedKey,
          endpoints: [`${PUBLIC_NAMESPACE}/updates/latest.json`],
        },
      },
    }),
  );
  const prepared = await prepareRelease({
    installer,
    signature: signatureFile,
    "public-key-file": pub,
    "tauri-config": config,
    version: "4.0.13",
    "current-version": "4.0.12",
    "base-url": `${PUBLIC_NAMESPACE}/releases`,
    "latest-url": `${PUBLIC_NAMESPACE}/updates/latest.json`,
    "output-dir": path.join(root, "prepared"),
  });
  const options = {
    "release-dir": prepared.directory,
    "public-key-file": pub,
    "tauri-config": config,
  };
  return {
    root,
    options,
    clean() {
      const rel = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
      assert.ok(
        rel &&
          !rel.startsWith("..") &&
          !path.isAbsolute(rel) &&
          path.basename(root).startsWith("lolicode-publish-test-"),
      );
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function transport(f, failure) {
  const events = [];
  return {
    events,
    async remote(phase) {
      events.push(phase);
      if (failure === phase) throw Error(`owned ${phase} fixture rejection`);
      return { ok: true, artifactsReady: false };
    },
    async upload(_source, destination) {
      events.push("upload");
      assert.ok(destination.startsWith(`${REMOTE_NAMESPACE}/.publish-stage-`));
      assert.ok(!destination.includes("/../"));
    },
    async download(url, destination) {
      events.push("download");
      if (failure === "download") throw Error("owned HTTPS fixture failure");
      const name = decodeURIComponent(path.basename(new URL(url).pathname));
      copyFileSync(path.join(f.options["release-dir"], name), destination);
    },
  };
}

test("dry-run verifies local release without executing SSH/SCP or making a network request", async () => {
  const f = await fixture();
  try {
    const t = transport(f);
    const result = await publishRelease({ ...f.options, "dry-run": true }, t);
    assert.equal(result.uploaded, false);
    assert.equal(result.namespace, REMOTE_NAMESPACE);
    assert.deepEqual(t.events, []);
    assert.ok(result.files.every((file) => file.source === undefined));
  } finally {
    f.clean();
  }
});

test("publication orders remote validation and real local signature verification before latest, and retains failed stages", async () => {
  const f = await fixture();
  try {
    const t = transport(f);
    const result = await publishRelease(f.options, t);
    assert.equal(result.publicSignatureAndHashesVerified, true);
    assert.equal(t.events.at(-1), "finalize");
    assert.ok(
      t.events.indexOf("commit-artifacts") < t.events.indexOf("download"),
    );
    assert.equal(t.events.filter((e) => e === "download").length, 2);
    const denied = transport(f, "download");
    await assert.rejects(
      publishRelease(f.options, denied),
      /staging ID.*retained/,
    );
    assert.equal(denied.events.at(-1), "abort");
    assert.ok(!denied.events.includes("finalize"));
    const locked = transport(f, "begin");
    await assert.rejects(
      publishRelease(f.options, locked),
      /fixture rejection/,
    );
    assert.deepEqual(locked.events, ["begin", "abort"]);
  } finally {
    f.clean();
  }
});

test("remote paths and website allowlist cannot touch the tools root or unrelated dirty files", async () => {
  const f = await fixture();
  try {
    assert.equal(quotePosix("a'b;$(id)"), "'a'\\''b;$(id)'");
    assert.ok(
      remoteCommand("begin", {
        stageId: randomUUID(),
        note: "';rm -rf /",
      }).startsWith("python3 - 'begin' '"),
    );
    await assert.rejects(
      preparePublishPlan({ ...f.options, "resume-stage": "../../outside" }),
      /exact UUID/,
    );
    const site = path.join(f.root, "lolicode");
    mkdirSync(path.join(site, "assets"), { recursive: true });
    for (const name of [
      "index.html",
      "assets/site.css",
      "assets/downloads.js",
      "assets/logo.svg",
      "assets/maid.png",
    ])
      writeFileSync(path.join(site, name), "owned static fixture");
    writeFileSync(
      path.join(site, "README.md"),
      "Local-only release documentation, not uploaded.",
    );
    const plan = await preparePublishPlan({ ...f.options, "site-dir": site });
    assert.equal(plan.files.filter((file) => file.role === "site").length, 5);
    writeFileSync(path.join(site, ".env"), "DO NOT READ");
    await assert.rejects(
      preparePublishPlan({ ...f.options, "site-dir": site }),
      /five approved/,
    );
    await assert.rejects(
      preparePublishPlan({ ...f.options, "site-dir": f.root }),
      /never the tools website root/,
    );
  } finally {
    f.clean();
  }
});

test("actual remote Python lifecycle validates hashes, keeps version directories immutable, and blocks equal/newer latest", async () => {
  const f = await fixture();
  try {
    const plan = await preparePublishPlan(f.options),
      program = fileURLToPath(
        new URL("./lolicode-publish-remote.py", import.meta.url),
      );
    const wrapper = `import importlib.util,json,sys,shutil,uuid\nfrom pathlib import Path\nsys.dont_write_bytecode=True\nm=importlib.util.spec_from_file_location('owned_publish',sys.argv[1]);p=importlib.util.module_from_spec(m);m.loader.exec_module(p)\np.ROOT=Path(sys.argv[2])\nspec=json.loads(sys.stdin.read());spec['namespace']=str(p.ROOT)\nassert p.compare('4.0.13-rc.10','4.0.13-rc.2')==1\nassert p.main('begin',spec)['artifactsReady']==False\nstage=p.ROOT/('.publish-stage-'+spec['stageId'])\nfor item in spec['files']:\n source=Path(sys.argv[3])/item['name'];target=stage/item['role']/item['name'];target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)\nassert not (p.ROOT/'updates/latest.json').exists()\nassert p.main('commit-artifacts',spec)['remoteHashesAndBytesVerified']\nassert not (p.ROOT/'updates/latest.json').exists()\nassert p.main('finalize',spec)['latestPublishedLast']\nold=(p.ROOT/'updates/latest.json').read_bytes()\nnextspec=dict(spec);nextspec['stageId']=str(uuid.uuid4())\ntry: p.main('begin',nextspec);raise AssertionError('equal version was published')\nexcept ValueError as e: assert 'equal or newer' in str(e)\np.main('abort',nextspec)\nassert (p.ROOT/'updates/latest.json').read_bytes()==old\n(p.ROOT/'updates/latest.json').write_text(json.dumps({'version':'4.0.99'}))\nnextspec['stageId']=str(uuid.uuid4())\ntry: p.main('begin',nextspec);raise AssertionError('newer version was rolled back')\nexcept ValueError as e: assert 'equal or newer' in str(e)\np.main('abort',nextspec)\nassert stage.exists()\nprint('PASS actual offline remote lifecycle')\n`;
    const result = spawnSync(
      "python",
      [
        "-c",
        wrapper,
        program,
        path.join(f.root, "remote-lolicode"),
        f.options["release-dir"],
      ],
      { input: JSON.stringify(plan.spec), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS actual offline/);
  } finally {
    f.clean();
  }
});
