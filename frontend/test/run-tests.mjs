// 用 esbuild 打包单测：src/utils 下对 './db' 的导入一律重定向到内存假 db
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const fakeDb = path.join(root, 'test/fake-db.js');

const fakeDbPlugin = {
  name: 'fake-db',
  setup(b) {
    b.onResolve({ filter: /^\.\/db$/ }, (args) => {
      if (args.importer.includes(path.join('src', 'utils'))) {
        return { path: fakeDb };
      }
      return null;
    });
  },
};

const outfile = path.join(root, 'test/.merge.test.bundle.mjs');
await build({
  entryPoints: [path.join(root, 'test/merge.test.js')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile,
  plugins: [fakeDbPlugin],
  logLevel: 'warning',
});

await import(pathToFileURL(outfile).href).finally(() => {
  fs.rmSync(outfile, { force: true });
});
