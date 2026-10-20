const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MARKER,
  parseDependencies,
  updateType,
  renderSummary,
  run,
} = require("./dependabot-summary.cjs");

const groupedBody = [
  "Bumps the cargo-deps group with 2 updates in the /src-tauri directory:",
  "",
  "| Package | From | To |",
  "| --- | --- | --- |",
  "| [serde_json](https://github.com/serde-rs/json) | `1.0.149` | `1.0.154` |",
  "| dirs | `5.0.1` | `7.0.0` |",
  "",
  "<details><summary>Release notes</summary>",
  "| Package | From | To |",
  "| --- | --- | --- |",
  "| unrelated | 1 | 2 |",
  "</details>",
].join("\n");

const pull = {
  number: 12,
  user: { login: "dependabot[bot]", type: "Bot" },
  state: "open",
  body: groupedBody,
  html_url: "https://github.com/owner/repo/pull/12",
};

function mockGithub({ pr = pull, comments = [], pulls = [pull] } = {}) {
  const writes = [];
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: pr }),
        list: async () => pulls,
        listFiles: async () => [{ filename: "src-tauri/Cargo.lock" }],
      },
      issues: {
        listComments: async () => comments,
        createComment: async (args) => {
          writes.push({ action: "create", ...args });
          return {
            data: {
              html_url: "https://github.com/owner/repo/pull/12#issuecomment-1",
            },
          };
        },
        updateComment: async (args) => {
          writes.push({ action: "update", ...args });
          return {
            data: {
              html_url: "https://github.com/owner/repo/pull/12#issuecomment-1",
            },
          };
        },
      },
    },
    paginate: async (method, args) => method(args),
  };
  return {
    writes,
    args: {
      github,
      context: { repo: { owner: "owner", repo: "repo" }, payload: {} },
      core: { info() {} },
    },
  };
}

test("解析批量更新，忽略发行说明中的表格", () => {
  const dependencies = parseDependencies(groupedBody.replace(/\n/g, "\r\n"));
  assert.equal(dependencies.length, 2);
  assert.deepEqual(dependencies[0], {
    name: "serde_json",
    url: "https://github.com/serde-rs/json",
    previousVersion: "1.0.149",
    newVersion: "1.0.154",
  });
});

test("解析单项 GitHub Actions 更新和纯文本依赖", () => {
  assert.deepEqual(
    parseDependencies(
      "Bumps [actions/checkout](https://github.com/actions/checkout) from 6 to 7.\n<details>",
    ),
    [
      {
        name: "actions/checkout",
        url: "https://github.com/actions/checkout",
        previousVersion: "6",
        newVersion: "7",
      },
    ],
  );
  assert.equal(
    parseDependencies("Bumps lodash from 4.17.20 to 4.17.21.")[0].newVersion,
    "4.17.21",
  );
});

test("中文标注版本变化，不把 Git SHA 当成语义化版本", () => {
  assert.equal(updateType("v6", "v7"), "主版本变化");
  assert.equal(updateType("1.0.0", "1.1.0"), "次版本变化");
  assert.equal(updateType("1.0.0", "1.0.1"), "补丁版本变化");
  assert.equal(updateType("1.0.0-beta.1", "1.0.0"), "预发布版本或构建信息变化");
  assert.equal(updateType("aabbccdd", "ffeeddcc"), "版本或引用变更");
});

test("生成中文摘要、主版本提示和原始说明链接", () => {
  const body = renderSummary(pull, [{ filename: "src-tauri/Cargo.lock" }]);
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /2 项依赖/);
  assert.match(body, /Rust 依赖（Cargo）/);
  assert.match(body, /1 项依赖存在主版本变化/);
  assert.match(body, /\| `dirs` \| `5.0.1` \| `7.0.0` \| 主版本变化 \|/);
  assert.match(body, /原始 PR 说明/);
});

test("格式未知时提供中文回退说明，不猜测依赖版本", () => {
  assert.deepEqual(parseDependencies(null ?? ""), []);
  assert.match(
    renderSummary({ ...pull, body: "unknown format" }, []),
    /未能.*完整提取版本信息/,
  );
});

test("丢弃不安全的依赖链接，版本内的 Markdown 不破坏表格", () => {
  const body = renderSummary(
    {
      ...pull,
      body: "Bumps [pkg](javascript:alert) from `1|2` to `3`.",
      html_url: "javascript:alert",
    },
    [],
  );
  assert.doesNotMatch(body, /javascript:/);
  assert.match(body, /1\\\|2/);
});

test("为已有 PR 补充摘要，并且只处理 Dependabot", async () => {
  const mock = mockGithub({
    pulls: [pull, { number: 13, user: { login: "human" } }],
  });
  await run(mock.args);
  assert.equal(mock.writes.length, 1);
  assert.equal(mock.writes[0].action, "create");
  assert.equal(mock.writes[0].issue_number, 12);
});

test("PR 内容更新时修改原评论，忽略其他作者伪造的标记", async () => {
  const mock = mockGithub({
    comments: [
      { id: 1, user: { login: "human" }, body: MARKER },
      {
        id: 2,
        user: { login: "github-actions[bot]" },
        body: `${MARKER}\n旧摘要`,
      },
    ],
  });
  mock.args.context.payload.pull_request = { number: 12 };
  await run(mock.args);
  assert.equal(mock.writes.length, 1);
  assert.equal(mock.writes[0].action, "update");
  assert.equal(mock.writes[0].comment_id, 2);
});

test("摘要未变化时不重复评论或更新", async () => {
  const mock = mockGithub({
    comments: [
      {
        id: 2,
        user: { login: "github-actions[bot]" },
        body: renderSummary(pull, [{ filename: "src-tauri/Cargo.lock" }]),
      },
    ],
  });
  await run({ ...mock.args, prNumber: "12" });
  assert.equal(mock.writes.length, 0);
});

test("手动指定非 Dependabot 或已关闭 PR 时不评论", async () => {
  for (const pr of [
    { ...pull, user: { login: "human", type: "User" } },
    { ...pull, state: "closed" },
  ]) {
    const mock = mockGithub({ pr });
    await run({ ...mock.args, prNumber: "12" });
    assert.equal(mock.writes.length, 0);
  }
});

test("拒绝无效的手动 PR 编号", async () => {
  for (const prNumber of ["-1", "1; exit", "9999999999999999999999"]) {
    await assert.rejects(
      run({ ...mockGithub().args, prNumber }),
      /PR 编号必须是正整数/,
    );
  }
});
