// Collect the mini app into ./public for Cloudflare static assets.
// Files over 24 MB (the neural-net model and one WASM) are split into
// .part0, .part1… — the Worker stitches them back together on request.
import { cp, mkdir, readdir, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'flow')
const out = join(here, 'public')
const LIMIT = 24 * 1024 * 1024
const CHUNK = 20 * 1024 * 1024

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
for (const f of ['index.html', 'app.js', 'engine.js', 'lights.js', 'analysis.js', 'bpm.js', 'style.css']) {
  await cp(join(src, f), join(out, f))
}
await cp(join(src, 'stems'), join(out, 'stems'), { recursive: true })

async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { await walk(p); continue }
    if (e.name === '.DS_Store') { await rm(p); continue }
    const { size } = await stat(p)
    if (size <= LIMIT) continue
    const data = await readFile(p)
    let n = 0
    for (let o = 0; o < data.length; o += CHUNK, n++) await writeFile(`${p}.part${n}`, data.subarray(o, o + CHUNK))
    await rm(p)
    console.log(`split ${p.slice(out.length + 1)} → ${n} parts`)
  }
}
await walk(out)
await writeFile(join(out, '.assetsignore'), '.DS_Store\n')
console.log('public/ ready')
