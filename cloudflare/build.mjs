// Split large assets before upload: Cloudflare allows 25 MiB per static file.
import { cp, mkdir, readdir, rm, stat, open, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LIMIT = 24 * 1024 * 1024
export const CHUNK = 20 * 1024 * 1024

export async function buildAssets(src, out) {
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  const manifest = {}
  let files = 1
  async function copy(path) {
    const info = await stat(path)
    const name = relative(src, path).split('\\').join('/')
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) if (entry !== '.DS_Store') await copy(join(path, entry))
      return
    }
    const target = join(out, name)
    await mkdir(dirname(target), { recursive: true })
    if (info.size <= LIMIT) { await cp(path, target); files++; return }
    const parts = Math.ceil(info.size / CHUNK)
    // Allow routing and manifest requests within the free Worker's 50 subrequests.
    if (parts > 45) throw new Error(`Asset needs external storage: ${name}`)
    const source = await open(path, 'r')
    const hash = createHash('sha256')
    try {
      const buffer = Buffer.alloc(CHUNK)
      for (let i = 0, offset = 0; offset < info.size; i++) {
        const size = Math.min(CHUNK, info.size - offset)
        let read = 0
        while (read < size) {
          const { bytesRead } = await source.read(buffer, read, size - read, offset + read)
          if (!bytesRead) throw new Error(`Asset changed during build: ${name}`)
          read += bytesRead
        }
        const bytes = buffer.subarray(0, size)
        hash.update(bytes)
        await writeFile(`${target}.part${i}`, bytes)
        offset += size; files++
      }
    } finally { await source.close() }
    manifest['/' + name] = { size: info.size, parts, chunkSize: CHUNK, etag: `"${hash.digest('hex')}"` }
    console.log(`split ${name} → ${parts} parts`)
  }
  for (const name of ['index.html', 'app.js', 'dj.js', 'local-library.js', 'vk-library.js', 'vk-browser.js', 'vk-app-login.js', 'engine.js', 'lights.js', 'analysis.js', 'bpm.js', 'style.css', 'stems']) await copy(join(src, name))
  if (files > 20000) throw new Error('Too many static files for Cloudflare Free')
  await writeFile(join(out, 'flow-chunks.json'), JSON.stringify(manifest))
  await writeFile(join(out, '.assetsignore'), '.DS_Store\n')
  console.log(`public/ ready: ${files} files, each at most 24 MiB`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url))
  await buildAssets(join(here, '..', 'flow'), join(here, 'public'))
}
