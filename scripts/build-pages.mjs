/**
 * 生成 docs/：给 GitHub Pages 用的纯静态站点
 *
 * public/ 与 shared/ 会原样拷到 docs/，路径保持相对，
 * 所以既能部署在 https://<user>.github.io/<repo>/ 这种子路径下，也能挂在根路径。
 *
 * 一起做了两件保险：清空旧产物、扫描产物里有没有 API Key。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs');
const TEXT_EXT = new Set(['.html', '.css', '.js', '.mjs', '.json', '.md', '.txt', '.svg']);

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full));
  }
  return out;
}

const SECRET = /sk-[0-9a-f]{24,}/i;

async function assertNoSecrets(files) {
  const hits = [];
  for (const relative of files) {
    if (!TEXT_EXT.has(path.extname(relative).toLowerCase())) continue;
    const text = await fs.readFile(path.join(OUT, relative), 'utf8');
    if (SECRET.test(text)) hits.push(relative);
  }
  if (hits.length) {
    throw new Error(
      `产物里出现了疑似 API Key，已中止：${hits.join(', ')}\n` +
        '请确认没有把 Key 写进 public/ 或 shared/ 里的任何文件。'
    );
  }
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  await fs.cp(path.join(ROOT, 'public'), OUT, { recursive: true });
  await fs.cp(path.join(ROOT, 'shared'), path.join(OUT, 'shared'), { recursive: true });
  // 让 GitHub Pages 不要走 Jekyll 处理
  await fs.writeFile(path.join(OUT, '.nojekyll'), '');

  const files = await walk(OUT);
  await assertNoSecrets(files);

  let bytes = 0;
  for (const relative of files) {
    bytes += (await fs.stat(path.join(OUT, relative))).size;
  }

  console.log('');
  console.log('  docs/ 已生成');
  console.log(`  文件 ${files.length} 个，合计 ${(bytes / 1024).toFixed(0)} KB`);
  console.log('  未发现 API Key ✓');
  console.log('');
  console.log('  部署：把仓库 Settings → Pages 的 Source 设为 main 分支 /docs 目录');
  console.log('  访问：https://<你的用户名>.github.io/<仓库名>/');
  console.log('');
}

main().catch((err) => {
  console.error('\n  构建失败：', err.message, '\n');
  process.exitCode = 1;
});
