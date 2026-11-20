import type { Artifact } from './model'

export function artifactTitle(artifact: Artifact): string
export function artifactVersions<T extends { artifacts: Artifact[]; updatedAt?: string }>(tasks: readonly T[]): { artifact: Artifact; tasks: Set<T> }[][]
