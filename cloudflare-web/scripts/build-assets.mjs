import { mkdir, readdir, copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.resolve(root, '../focus-dopa-preview');
const output = path.join(root, 'public');
const webExtensions = new Set(['.html', '.js', '.css']);
const mediaExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif', '.mp4', '.webm', '.wav', '.mp3', '.woff2']);
const excluded = new Set(['desktop-overlay.html', 'desktop-overlay-renderer.js']);
const copied = [];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

async function copyDirectory(directory, relative = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const local = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (relative || entry.name === 'assets') await copyDirectory(path.join(directory, entry.name), local);
      continue;
    }
    const allowed = relative ? mediaExtensions : webExtensions;
    if (!entry.isFile() || !allowed.has(path.extname(entry.name).toLowerCase()) || excluded.has(local)) continue;
    const destination = path.join(output, local);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(directory, entry.name), destination);
    copied.push(local);
  }
}

await copyDirectory(source);
if (!copied.includes('index.html') || !copied.includes('app.js')) throw new Error('Frontend entry files are missing.');
await writeFile(path.join(root, '.build-manifest.json'), JSON.stringify({ files: copied }, null, 2) + '\n');
console.log(`Prepared ${copied.length} browser assets for Cloudflare. Server files, settings and tests are excluded.`);
