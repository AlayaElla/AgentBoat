export function artifactTitle({ label, version }) {
  return label === version || label.endsWith(' ' + version) ? label : label + ' · ' + version;
}

export function latestArtifacts(tasks, includeExpired = false) {
  // Older records have no registration time. Keep them behind dated versions, in append order on ties.
  const entries = tasks.flatMap(task => task.artifacts.map(artifact => ({
    task, artifact, registered: Date.parse(artifact.registeredAt) || 0,
    legacyTime: artifact.registeredAt ? 0 : Date.parse(task.updatedAt) || 0
  }))).reverse().sort((a, b) => b.registered - a.registered || b.legacyTime - a.legacyTime);
  const groups = new Map();
  const urls = new Map();
  for (const { task, artifact } of entries) {
    const sameUrl = artifact.url && urls.get(artifact.url);
    if (sameUrl) {
      sameUrl.tasks.add(task);
      continue;
    }
    const entry = { artifact, tasks: new Set([task]) };
    if (artifact.url) urls.set(artifact.url, entry);
    if (!groups.has(artifact.label)) groups.set(artifact.label, entry);
  }
  return [...groups.values()].filter(({ artifact }) => includeExpired || !artifact.expired);
}
