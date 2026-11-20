import type { Artifact } from './model'

export function artifactTitle(artifact: Artifact): string
export function latestArtifacts<T extends { artifacts: Artifact[]; updatedAt?: string }>(tasks: readonly T[], includeExpired?: boolean): { artifact: Artifact; tasks: Set<T> }[]
