import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = ['src/core.js', 'src/form-engine.js', 'src/content.js'];

function convertModuleToClassicScript(source) {
  return source
    .replace(/^import\s+[^;]+;\s*$/gm, '')
    .replace(/\bexport\s+(?=(?:async\s+)?function|const|class)/g, '');
}

const modules = await Promise.all(
  sources.map(async (path) => convertModuleToClassicScript(await readFile(resolve(projectRoot, path), 'utf8'))),
);
const outputPath = resolve(projectRoot, 'dist/content.js');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `(() => {\n'use strict';\n${modules.join('\n')}\n})();\n`, 'utf8');
console.log(`Built dist/content.js from ${sources.length} modules.`);
