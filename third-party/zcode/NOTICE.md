# ZCode content skills included in LoliCode

Source: https://github.com/zai-org/ZCode

Pinned source revision: `aac4755666d09fdcd70272fcf063c077a639015f` (ZCode 3.15.1).

The five unmodified skill directories in `skills/` come from the official
default-enabled content plugins: skill-creator, documents, pdf, presentations,
and spreadsheets. `manifest.json` records each original source path and every
file's SHA-256. The original plugin/package metadata is retained in
`original-manifests/`.

The four document skills contain their original Apache-2.0 `LICENSE.txt` and
copyright notices. Their SKILL.md frontmatter retains the upstream word
"Proprietary"; the referenced complete LICENSE.txt terms specify Apache-2.0.
The skill-creator package and plugin manifest declare MIT. The repository's
original Apache-2.0 LICENSE and complete NOTICE are retained as `LICENSE` and
`UPSTREAM_NOTICE.md`; these do not replace any file-specific notices.

LoliCode uses OpenCode's native skill discovery to load this content into its
private agent runtime. It does not include ZCode's agent engine, UI Apps host,
Browser/Computer Use services, or dynamic-workflow runtime. Document generation
and rendering still require the dependencies documented by each skill, such as
Python, Node.js, LibreOffice, and PDF utilities. Importing the instructions does
not install or execute those dependencies.

LoliCode's extension manager, configuration projection, and resource preparation
are separate local integration code. The copied skill content is unchanged.
