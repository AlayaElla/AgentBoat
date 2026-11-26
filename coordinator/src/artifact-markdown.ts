import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Marked } from 'marked'
import { pluginDataPath } from '../scripts/orca-cli.mjs'
import { fileType, maxLinkFileBytes, maxLinkFiles, readContainedArtifact } from './link-files'
import { fail, fingerprint } from './store'

export const isMarkdownArtifact = (file: string) => /^\.(?:md|markdown)$/i.test(path.extname(file))
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export async function artifactMarkdownPage(root: string, file: string, directory = pluginDataPath()) {
  const source = await readContainedArtifact(root, file, 1024 ** 2)
  const images = new Map<string, { id: number; source: string }>()
  const hrefs = new Set<string>()
  const linked = new Set<number>()
  let byteBudget = maxLinkFileBytes - source.length
  const parser = new Marked({ gfm: true, renderer: {
    html: ({ text }) => escape(text),
    link({ href, tokens }) {
      return images.has(href) ? imageLink(href, escape(this.parser.parseInline(tokens, this.parser.textRenderer))) : this.parser.parseInline(tokens)
    },
    image: ({ href, text }) => imageLink(href, escape(text))
  } })
  function imageLink(href: string, label: string) {
    const image = images.get(href)
    if (!image) return label
    const { id } = image
    const back = linked.has(id) ? '' : ` id="link-${id}"`
    linked.add(id)
    return `<a${back} href="#image-${id}">${label}</a>`
  }
  const tokens = parser.lexer(source.toString('utf8').replace(/^\uFEFF/, ''))
  parser.walkTokens(tokens, token => {
    if (token.type === 'link' || token.type === 'image') hrefs.add(token.href)
  })
  for (const href of hrefs) {
    if (images.size >= maxLinkFiles || !byteBudget) break
    // Only explicitly referenced relative raster images can leave the Markdown parser as URLs.
    let name: string
    try { name = decodeURIComponent(href) } catch { continue }
    if (!name || name.startsWith('/') || /[\\:?#\u0000-\u001f\u007f]/.test(name)) continue
    const type = fileType(name)
    if (!/^image\/(?:png|jpeg|webp|gif)$/.test(type)) continue
    const data = await readContainedArtifact(root, path.resolve(path.dirname(file), name), byteBudget).catch(() => undefined)
    if (!data?.length) continue
    byteBudget -= data.length
    images.set(href, { id: images.size + 1, source: `data:${type};base64,${data.toString('base64')}` })
  }
  const body = parser.parser(tokens)
  const figures = [...images.values()].map(({ id, source }) => `<figure id="image-${id}">
    <a href="#link-${id}">返回正文</a><img src="${source}" alt="对照图"></figure>`).join('\n')
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(path.basename(file))}</title>
<style>
:root { color-scheme: light dark }
body { font: 16px/1.65 system-ui, sans-serif; margin: 2rem auto; max-width: 76rem; padding: 0 1.25rem; overflow-wrap: anywhere }
table { border-collapse: collapse } th, td { border: 1px solid GrayText; padding: .35rem .65rem; text-align: start }
pre { overflow: auto } figure { display: none; margin: 1rem 0 } figure:target { display: block } img { display: block; max-width: 100%; margin-top: 1rem }
</style><body>${body}${figures}</body></html>`

  const folder = path.join(directory, 'markdown-previews')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  if (!(await lstat(folder)).isDirectory()) fail('成果预览目录不安全')
  const output = path.join(folder, `${fingerprint([root, file])}.html`)
  const temp = path.join(folder, `${randomUUID()}.tmp`)
  const outputFile = await open(temp, 'wx', 0o600)
  try {
    try { await outputFile.writeFile(html) } finally { await outputFile.close() }
    await rename(temp, output)
  } finally { await rm(temp, { force: true }) }
  return output
}
