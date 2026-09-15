import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const release = process.argv.includes('--release');
const failures = [];
const pending = [];
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) { failures.push(`Symlink is not a website asset: ${relative(root, path)}`); continue; }
    if (entry.isDirectory()) await walk(path); else files.push(path);
  }
}
await walk(root);
for (const route of ['index.html', 'support/index.html', 'privacy/index.html', '404.html']) {
  if (!files.includes(resolve(root, route))) failures.push(`Missing required route: ${route}`);
}
for (const file of files) {
  if (!['.html', '.css', '.svg', '.png', '.txt'].includes(extname(file))) failures.push(`Unexpected public file: ${relative(root, file)}`);
  if (extname(file) !== '.html') continue;
  const html = await readFile(file, 'utf8');
  const name = relative(root, file);
  for (const expression of [/<html\s+lang="en"/, /<title>[^<]+<\/title>/, /name="viewport"/, /<main[\s>]/]) {
    if (!expression.test(html)) failures.push(`Missing document metadata or main landmark: ${name}`);
  }
  for (const match of html.matchAll(/data-release-pending="([^"]+)"/g)) pending.push(`${name}: ${match[1]}`);
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const ref = match[1];
    if (/^(https:|mailto:)/.test(ref)) continue;
    if (/^[a-z]+:/i.test(ref) || ref.startsWith('//')) { failures.push(`Unsupported asset/link scheme: ${name}`); continue; }
    const [path, hash] = ref.split('#');
    let target = path ? resolve(path.startsWith('/') ? root : dirname(file), `.${path.startsWith('/') ? path : '/' + path}`) : file;
    if (relative(root, target).startsWith('..')) { failures.push(`Link escapes public directory: ${name}`); continue; }
    try {
      const info = await stat(target);
      if (info.isDirectory()) target = resolve(target, 'index.html');
      await stat(target);
      if (hash && extname(target) === '.html') {
        const destination = await readFile(target, 'utf8');
        if (!destination.includes(`id="${hash}"`)) failures.push(`Missing anchor ${ref} in ${name}`);
      }
    } catch { failures.push(`Missing local asset/link ${ref} in ${name}`); }
  }
}
if (release && pending.length) failures.push(...pending.map(item => `Resolve owner input before public deployment: ${item}`));
console.log(JSON.stringify({ mode: release ? 'release' : 'preview', publicFiles: files.length, pendingOwnerInputs: pending, failures }, null, 2));
if (failures.length) process.exitCode = 1;
