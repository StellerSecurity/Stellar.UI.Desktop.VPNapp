import fs from 'node:fs';
import path from 'node:path';
const failures = [];
function walk(directory) {
  for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, file.name);
    if (file.isDirectory()) { walk(filename); continue; }
    if (!/\.tsx?$/.test(file.name)) continue;
    const source = fs.readFileSync(filename, 'utf8');
    const imports = [...source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)].map(match => match[1]);
    if (filename.includes('/domain/') && imports.some(value => /react|tauri|infrastructure|\/ui|application/.test(value))) failures.push(`${filename}: domain imports a framework or outer layer`);
    if (filename.includes('/application/') && imports.some(value => /infrastructure|\/ui/.test(value))) failures.push(`${filename}: application imports an adapter or UI`);
    if (filename.includes('/ui/') && imports.some(value => /infrastructure|@tauri-apps/.test(value))) failures.push(`${filename}: UI imports an infrastructure adapter`);
    if (!filename.includes('/infrastructure/') && filename !== 'src/app/container.ts' && /(?:localStorage\.|\bfetch\(|\binvoke\()/g.test(source)) failures.push(`${filename}: IO outside an adapter`);
  }
}
walk('src');
const catalogIds = JSON.parse(fs.readFileSync('assets/servers.json', 'utf8')).map(server => server.id).sort();
const nativeCatalog = fs.readFileSync('src-tauri/src/infrastructure/server_ids.rs', 'utf8');
const nativeIds = [...nativeCatalog.matchAll(/"([a-z0-9-]+)"/g)].map(match => match[1]).sort();
if (JSON.stringify(catalogIds) !== JSON.stringify(nativeIds)) failures.push('Native server allowlist differs from the bundled server catalog');
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log('Architecture boundaries passed: domain → ports ← adapters; UI has no direct IO.');
