// Builds the static L-LAN Web site into dist-web/ (no packages).
// Supabase settings come from LLAN_SUPABASE_URL / LLAN_SUPABASE_KEY (the publishable/anon key, never the secret key),
// or from web/config.js when the variables are not set.
import { mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.argv[2] || 'dist-web');
const copy = (from, to) => { mkdirSync(path.dirname(path.join(OUT, to)), { recursive: true }); copyFileSync(path.join(ROOT, from), path.join(OUT, to)); };

rmSync(OUT, { recursive: true, force: true });
copy('web/index.html', 'index.html');
copy('web/web.js', 'web.js');
for (const f of ['map.js', 'draw.js', 'styles.css', 'icon.svg']) copy(`public/${f}`, f);
for (const f of ['proj.mjs', 'geom.mjs', 'calc.mjs']) copy(`public/shared/${f}`, `shared/${f}`);

// The web site is public: only the publishable/anon key may go into it.
const isSecret = k => /secret|service_role/i.test(k + JSON.stringify(k.startsWith('eyJ') ? JSON.parse(Buffer.from(k.split('.')[1], 'base64url').toString()) : {}));
const url = process.env.LLAN_SUPABASE_URL, key = process.env.LLAN_SUPABASE_KEY;
if (key && isSecret(key)) throw new Error('LLAN_SUPABASE_KEY ต้องเป็น publishable/anon key ห้ามใช้ secret key บนเว็บ');
if (url && key) writeFileSync(path.join(OUT, 'config.js'), `export default ${JSON.stringify({ url, key })};\n`);
else if (existsSync(path.join(ROOT, 'web', 'config.js'))) {
  const text = readFileSync(path.join(ROOT, 'web', 'config.js'), 'utf8');
  if (/sb_secret_/.test(text) || (text.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) || []).some(isSecret)) throw new Error('web/config.js มี secret key ห้ามใช้บนเว็บ');
  copy('web/config.js', 'config.js');
} else throw new Error('ไม่มีค่า Supabase: ตั้ง LLAN_SUPABASE_URL และ LLAN_SUPABASE_KEY หรือสร้าง web/config.js จาก web/config.example.js');
// GitHub Pages: serve files as they are (no Jekyll processing).
writeFileSync(path.join(OUT, '.nojekyll'), '');
// Static hosts: no caching surprises for the module files.
writeFileSync(path.join(OUT, '_headers'), '/*\n  Cache-Control: no-cache\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n');
console.log(`สร้าง L-LAN Web แล้วที่ ${OUT} (${readFileSync(path.join(OUT, 'config.js'), 'utf8').includes('supabase') ? 'ตั้งค่า Supabase แล้ว' : 'ตรวจ config.js'})`);
