const MARKER = "<!-- lolicode-dependabot-summary-zh -->";

function plain(value) {
  return String(value ?? "")
    .trim()
    .replace(/^`+|`+$/g, "");
}

function code(value) {
  return `\`${plain(value)
    .replace(/[\r\n]/g, " ")
    .replace(/`/g, "'")
    .replace(/\|/g, "\\|")}\``;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      ? url.href.replace(/[()]/g, encodeURIComponent)
      : null;
  } catch {
    return null;
  }
}

function dependency(value, previousVersion, newVersion) {
  const link = value.trim().match(/^\[([^\]]+)\]\(([^\s]+)\)$/);
  return {
    name: plain(link ? link[1] : value),
    url: link ? safeUrl(link[2]) : null,
    previousVersion: plain(previousVersion),
    newVersion: plain(newVersion),
  };
}

function parseDependencies(body = "") {
  // 仅解析 Dependabot 的开头摘要；发行说明中可能还有无关表格和版本号。
  const introduction = body.split(/<details\b/i)[0];
  const lines = introduction.split(/\r?\n/);
  const header = lines.findIndex((line) =>
    /^\|\s*Package\s*\|\s*From\s*\|\s*To\s*\|\s*$/i.test(line),
  );
  if (header >= 0) {
    const dependencies = [];
    for (const line of lines.slice(header + 2)) {
      const cells = line.trim().split("|");
      if (cells.length !== 5) break;
      dependencies.push(dependency(cells[1], cells[2], cells[3]));
    }
    return dependencies;
  }

  const firstLine = lines
    .find((line) => line.trim())
    ?.trim()
    .replace(/\.$/, "");
  const single = firstLine?.match(
    /^Bumps\s+(.+?)\s+from\s+(.+?)\s+to\s+(.+)$/i,
  );
  return single ? [dependency(single[1], single[2], single[3])] : [];
}

function updateType(previousVersion, newVersion) {
  const pattern = /^v?(\d{1,6})(?:\.(\d+))?(?:\.(\d+))?([-+].*)?$/;
  const previous = previousVersion.match(pattern);
  const next = newVersion.match(pattern);
  if (!previous || !next) return "版本或引用变更";
  if (previous[1] !== next[1]) return "主版本变化";
  if (previous[2] !== next[2]) return "次版本变化";
  if (previous[3] !== next[3]) return "补丁版本变化";
  return "预发布版本或构建信息变化";
}

function renderSummary(pr, files) {
  const dependencies = parseDependencies(pr.body ?? "");
  const paths = files.map((file) => file.filename);
  const scopes = [];
  if (
    paths.some((path) =>
      /(^|\/)(package\.json|(?:pnpm|yarn|package)-lock\.(?:yaml|json)|yarn\.lock)$/.test(
        path,
      ),
    )
  ) {
    scopes.push("前端依赖（npm / pnpm）");
  }
  if (paths.some((path) => /(^|\/)Cargo\.(toml|lock)$/.test(path))) {
    scopes.push("Rust 依赖（Cargo）");
  }
  if (paths.some((path) => /^\.github\/(workflows|actions)\//.test(path))) {
    scopes.push("GitHub Actions");
  }

  const majorUpdates = dependencies.filter(
    (item) =>
      updateType(item.previousVersion, item.newVersion) === "主版本变化",
  ).length;
  const lines = [
    MARKER,
    "## Dependabot 中文更新摘要",
    "",
    dependencies.length
      ? `本 PR 更新 **${dependencies.length} 项依赖**。`
      : "本 PR 由 Dependabot 创建，用于更新项目依赖。未能从原始说明中完整提取版本信息，请查看原始 PR 说明。",
    "",
    `- **涉及范围**：${scopes.join("、") || "项目依赖"}`,
    `- **变更文件**：${paths.slice(0, 15).map(code).join("、") || "未获取到文件信息"}${paths.length > 15 ? ` 等 ${paths.length} 个文件` : ""}`,
  ];

  if (majorUpdates) {
    lines.push(
      `- **兼容性提示**：${majorUpdates} 项依赖存在主版本变化，建议检查上游迁移说明。`,
    );
  }
  if (dependencies.length) {
    lines.push(
      "",
      "| 依赖 | 原版本 | 新版本 | 更新类型 |",
      "| --- | --- | --- | --- |",
    );
    for (const item of dependencies.slice(0, 100)) {
      const name = item.url
        ? `[${code(item.name)}](${item.url})`
        : code(item.name);
      lines.push(
        `| ${name} | ${code(item.previousVersion)} | ${code(item.newVersion)} | ${updateType(item.previousVersion, item.newVersion)} |`,
      );
    }
    if (dependencies.length > 100) {
      lines.push(
        "",
        `另有 ${dependencies.length - 100} 项依赖，详见原始 PR 说明。`,
      );
    }
  }

  const url = safeUrl(pr.html_url);
  lines.push(
    "",
    url
      ? `更新日志、发行说明和提交记录见[原始 PR 说明](${url})及上表中的依赖链接。`
      : "更新日志、发行说明和提交记录见原始 PR 说明。",
    "",
    "此摘要根据 Dependabot 的版本信息生成，不包含上游发行说明的逐句翻译，也不代表 CI 已通过。由 GitHub Actions 自动维护，PR 更新后会更新同一条评论。",
  );
  return lines.join("\n");
}

async function summarizePullRequest({ github, context, core, number }) {
  const repo = context.repo;
  const { data: pr } = await github.rest.pulls.get({
    ...repo,
    pull_number: number,
  });
  if (
    pr.user?.login !== "dependabot[bot]" ||
    pr.user?.type !== "Bot" ||
    pr.state !== "open"
  ) {
    core.info(`跳过 PR #${number}：不是未关闭的 Dependabot PR。`);
    return;
  }
  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...repo,
    pull_number: number,
    per_page: 100,
  });
  const body = renderSummary(pr, files);
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: number,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) =>
      comment.user?.login === "github-actions[bot]" &&
      comment.body?.startsWith(MARKER),
  );
  if (existing?.body === body) {
    core.info(`PR #${number} 的中文摘要已是最新。`);
    return;
  }
  const { data: comment } = existing
    ? await github.rest.issues.updateComment({
        ...repo,
        comment_id: existing.id,
        body,
      })
    : await github.rest.issues.createComment({
        ...repo,
        issue_number: number,
        body,
      });
  core.info(
    `已${existing ? "更新" : "创建"} PR #${number} 的中文摘要：${comment.html_url}`,
  );
}

async function run({ github, context, core, prNumber = "" }) {
  const requested = prNumber.trim();
  let numbers;
  if (context.payload.pull_request) {
    numbers = [context.payload.pull_request.number];
  } else if (requested) {
    if (
      !/^[1-9]\d*$/.test(requested) ||
      !Number.isSafeInteger(Number(requested))
    ) {
      throw new Error("PR 编号必须是正整数。");
    }
    numbers = [Number(requested)];
  } else {
    const pulls = await github.paginate(github.rest.pulls.list, {
      ...context.repo,
      state: "open",
      per_page: 100,
    });
    numbers = pulls
      .filter((pr) => pr.user?.login === "dependabot[bot]")
      .map((pr) => pr.number);
  }
  for (const number of numbers) {
    await summarizePullRequest({ github, context, core, number });
  }
  core.info(`已检查 ${numbers.length} 个 PR。`);
}

module.exports = { MARKER, parseDependencies, updateType, renderSummary, run };
