// submitTask appends immutable versions. A label identifies a deliverable within one task.
export function artifactVersions(artifacts) {
  const groups = new Map();
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const artifact = artifacts[i];
    const versions = groups.get(artifact.label);
    if (versions) versions.push(artifact);
    else groups.set(artifact.label, [artifact]);
  }
  return [...groups.values()];
}
