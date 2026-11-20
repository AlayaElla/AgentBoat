import type {} from 'orca/frame'

type FileInfo = { name: string; type: string; size: number; key: string }

async function showPdf(bytes: Uint8Array, body: HTMLElement, dialog: HTMLDialogElement) {
  const base = new URL('./assets/pdf/', document.baseURI)
  const pdfjs: typeof import('pdfjs-dist') = await import(new URL('pdf.min.mjs', base).href)
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', base).href
  const task = pdfjs.getDocument({ data: bytes, cMapUrl: new URL('cmaps/', base).href, cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', base).href, wasmUrl: new URL('wasm/', base).href,
    useWasm: false, maxImageSize: 16_000_000 })
  const dispose = () => { void task.destroy().catch(() => {}) }
  if (!dialog.open) { dispose(); return }
  dialog.addEventListener('close', dispose, { once: true })
  const pdf = await task.promise
  const canvas = document.createElement('canvas'), count = document.createElement('span')
  const previous = document.createElement('button'), next = document.createElement('button')
  previous.textContent = '上一页'; next.textContent = '下一页'
  let current = 1
  async function draw() {
    previous.disabled = next.disabled = true
    const page = await pdf.getPage(current)
    const unit = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(unit.width, unit.height)) })
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, viewport }).promise
    count.textContent = current + ' / ' + pdf.numPages
    previous.disabled = current === 1; next.disabled = current === pdf.numPages
    page.cleanup()
  }
  const turn = (by: number) => {
    current += by
    void draw().catch(() => { body.textContent = '此页无法预览' })
  }
  previous.onclick = () => turn(-1); next.onclick = () => turn(1)
  body.replaceChildren(canvas)
  if (pdf.numPages > 1) body.append(previous, count, next)
  await draw()
}

export async function previewArtifact(label: string, getFile: () => Promise<FileInfo | { pending: true }>, read: (key: string, offset: number) => Promise<string>) {
  const dialog = document.createElement('dialog'), body = document.createElement('div')
  dialog.className = 'artifact-preview'
  dialog.setAttribute('aria-label', label)
  const title = document.createElement('h2'), close = document.createElement('button')
  title.textContent = label; close.textContent = '关闭'; close.onclick = () => dialog.close()
  const status = document.createElement('p')
  status.setAttribute('role', 'status'); status.textContent = '正在获取成果…'
  dialog.append(title, close, body, status)
  dialog.addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation() })
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  document.body.append(dialog); dialog.showModal()
  try {
    let file = await getFile()
    while ('pending' in file) { if (!dialog.open) return; file = await getFile() }
    if (!dialog.open) return
    const bytes = new Uint8Array(file.size)
    for (let offset = 0; offset < bytes.length;) {
      const raw = atob(await read(file.key, offset))
      if (!dialog.open) return
      if (!raw.length || offset + raw.length > bytes.length) throw Error('成果读取不完整，请重新获取')
      for (let i = 0; i < raw.length; i++) bytes[offset++] = raw.charCodeAt(i)
    }
    status.textContent = ''
    const save = document.createElement('button')
    save.textContent = '保存到本机'
    save.onclick = async () => {
      try {
        if (!orca.files) throw Error('请在 Orca 桌面面板中保存')
        save.disabled = true
        if ((await orca.files.saveAs({ suggestedName: file.name, data: bytes })).status === 'saved') status.textContent = '已保存'
      } catch { status.textContent = '暂时无法保存，请在 Orca 桌面面板中重试' }
      finally { save.disabled = false }
    }
    dialog.append(save)
    if (['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(file.type)) {
      const img = document.createElement('img')
      const url = URL.createObjectURL(new Blob([bytes], { type: file.type }))
      dialog.addEventListener('close', () => URL.revokeObjectURL(url), { once: true })
      img.alt = label; img.onerror = () => { status.textContent = '此图片无法预览' }; img.src = url
      body.append(img)
    } else if (file.type === 'application/pdf') {
      try { await showPdf(bytes.slice(), body, dialog) }
      catch { status.textContent = '此 PDF 无法预览，可以保存到本机查看' }
    }
    else if (file.type === 'text/plain' || file.type === 'text/markdown') {
      const pre = document.createElement('pre')
      pre.textContent = new TextDecoder().decode(bytes); body.append(pre)
    }
  } catch (e) { status.textContent = e instanceof Error ? e.message : '暂时无法查看此成果' }
}
