export const artifactKindLabels = { web: '网页', image: '图片', pdf: 'PDF', document: '文档', video: '视频', file: '文件' } as const
export type ArtifactKind = keyof typeof artifactKindLabels

export function knownArtifactKind(value: unknown): ArtifactKind | undefined {
  if (typeof value === 'string' && Object.hasOwn(artifactKindLabels, value)) return value as ArtifactKind
}

const extensions: [ArtifactKind, RegExp][] = [
  ['web', /^html?$/],
  ['image', /^(?:jpe?g|png|gif|webp|svg|avif|bmp|heic|ico|tiff?)$/],
  ['pdf', /^pdf$/],
  ['document', /^(?:txt|md|markdown|rtf|docx?|odt|pptx?|odp|xlsx?|ods|csv|tsv)$/],
  ['video', /^(?:mp4|webm|mov|m4v|mkv|avi|mpeg|mpg)$/],
  ['file', /^(?:zip|7z|rar|tar|gz|apk|exe|json|mp3|wav)$/]
]

export function kindFromFilename(name: string): ArtifactKind | undefined {
  const extension = /[^/\\]\.(\w+)$/.exec(name.trim().toLowerCase())?.[1]
  if (extension) return extensions.find(([, pattern]) => pattern.test(extension))?.[0]
}

export function artifactKind({ kind, url, label }: { kind?: ArtifactKind; url: string; label: string }): ArtifactKind {
  const known = knownArtifactKind(kind)
  if (known) return known
  if (/^https?:\/\//i.test(url) && URL.canParse(url)) {
    const pathname = new URL(url).pathname
    const name = pathname.split('/').at(-1) ?? ''
    let decoded = name
    try { decoded = decodeURIComponent(name) } catch { /* Keep the literal name for malformed URL escapes. */ }
    return kindFromFilename(decoded) ?? kindFromFilename(label) ?? 'web'
  }
  return kindFromFilename(url) ?? kindFromFilename(label) ?? 'file'
}
