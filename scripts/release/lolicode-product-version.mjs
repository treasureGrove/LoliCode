/** Resolve public names for historical 4.1 builds and unified releases. */
export function productVersion(build) {
  const m = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(build);
  if (!m || m[1] !== "4" || m[2] !== "1") return build;
  return `1.0.${m[3]}${m[4] ?? ""}`;
}
