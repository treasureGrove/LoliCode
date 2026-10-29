// Scale explicit interface font sizes without scaling dimensions or document content.
const path = require("node:path");

const excludedFiles = new Set([
  "agent-document-viewer.css",
  "agent-spreadsheet-view.css",
  "agent-office-preview.css",
]);

module.exports = () => ({
  postcssPlugin: "interface-font-scale",
  OnceExit(root) {
    root.walkDecls(/^font-size$/i, (decl) => {
      const file = decl.source?.input?.file || root.source?.input?.file || "";
      const normalized = file.replace(/\\/g, "/");
      if (normalized.split("/").includes("node_modules")) return;
      if (excludedFiles.has(path.posix.basename(normalized))) return;
      const rule = decl.parent;
      if (rule.type !== "rule") return;
      // The root font size defines rem itself; scaling it would apply the factor twice.
      if (
        rule.selectors.some((selector) =>
          /^(?:html|:root)(?:\s|$|[.:#\[])/i.test(selector.trim()),
        )
      )
        return;
      const value = decl.value.trim();
      if (value.includes("--interface-font-scale")) return;
      // Leave inherited values and keywords alone. Expressions such as clamp() and
      // calc() are supported as long as they contain an explicit px/rem length.
      if (!/(?:\d|\.)\s*(?:px|rem)\b/i.test(value)) return;
      decl.value = `calc(${value} * var(--interface-font-scale, 1))`;
    });
  },
});
module.exports.postcss = true;
