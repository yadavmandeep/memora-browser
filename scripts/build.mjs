import { execSync } from 'child_process';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

console.log('🚀 [Build] Step 1: Compiling TypeScript with tsc (no sourcemaps)...');
// Clean previous dist
if (fs.existsSync('dist')) {
  fs.rmSync('dist', { recursive: true, force: true });
}

// 1. Run tsc (sourceMap is false in tsconfig.json)
execSync('npx tsc', { stdio: 'inherit' });

console.log('⚡ [Build] Step 2: Minifying & bundling entry points (esbuild)...');

// 2. Bundle dist/index.js (standalone minified library)
await esbuild.build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  legalComments: 'none',
  sourcemap: false,
  allowOverwrite: true,
});

// 3. Bundle dist/cli/index.js (standalone minified CLI)
await esbuild.build({
  entryPoints: ['src/cli/index.ts'],
  outfile: 'dist/cli/index.js',
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  legalComments: 'none',
  sourcemap: false,
  allowOverwrite: true,
});

// 4. Minify all other generated .js files across dist/ to protect all internal logic
console.log('🛡️  [Build] Step 3: Obfuscating and minifying all dist JS files...');
async function minifyAllJs(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await minifyAllJs(fullPath);
    } else if (entry.name.endsWith('.js') && fullPath !== path.join('dist', 'index.js') && fullPath !== path.join('dist', 'cli', 'index.js')) {
      const code = fs.readFileSync(fullPath, 'utf8');
      const minified = await esbuild.transform(code, {
        minify: true,
        legalComments: 'none',
        format: 'esm',
        target: 'node18',
      });
      fs.writeFileSync(fullPath, minified.code, 'utf8');
    } else if (entry.name.endsWith('.map') || entry.name.endsWith('.tsbuildinfo')) {
      fs.unlinkSync(fullPath);
    }
  }
}
await minifyAllJs('dist');

console.log('✅ [Build] Production build complete. All code compiled, bundled, and obfuscated.');
