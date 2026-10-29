/** Public SemVer is independent of the monotonically increasing native updater version. */
export function productVersion(build) {
  const m = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(build);
  if (!m || Number(m[1]) < 4 || Number(m[2]) < 1) return build;
  return `${Number(m[1]) - 3}.${Number(m[2]) - 1}.${m[3]}${m[4] ?? ""}`;
}
