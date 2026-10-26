#!/usr/bin/env node
// Přírůstkové zrcadlo souborů ze Supabase Storage (screenshoty, výplatní doklady…).
// Soubory nejsou v pg_dump — DB obsahuje jen řádky storage.objects.
//
// node storage-sync.mjs --objects <storage-objects.json> --mirror <dir> --out <manifest.tsv> --project-ref <ref>
//
// - stahuje jen objekty, které v zrcadle chybí, mají jinou velikost nebo jiné MD5 než eTag;
// - ověřuje velikost a MD5 proti eTagu (u multipart uploadu jen velikost);
// - objekt přepsaný po výpisu (worker průběžně přepisuje copier-snapshots/…/tv-live) uloží
//   v novější verzi, jen když obsah souhlasí s ETagem vlastní odpovědi; není to chyba;
// - ze zrcadla nikdy nemaže (smazaný objekt v Storage zůstane zálohovaný);
// - klíč service_role si bere z Supabase CLI do paměti, nikam ho nezapisuje.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, value, index, all) => {
  if (value.startsWith('--')) acc.push([value.slice(2), all[index + 1]]);
  return acc;
}, []));
for (const key of ['objects', 'mirror', 'out', 'project-ref']) {
  if (!args[key]) { console.error(`STOP: chybí --${key}`); process.exit(2); }
}
const mirror = resolve(args.mirror);
const baseUrl = `https://${args['project-ref']}.supabase.co/storage/v1/object/authenticated`;
const JOBS = 4;

const readKey = () => {
  const raw = execFileSync('npx', ['-y', 'supabase@2.122.0', 'projects', 'api-keys', '--project-ref', args['project-ref'], '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const keys = JSON.parse(raw);
  const legacy = keys.find(k => k.name === 'service_role' && k.api_key);
  if (legacy) return { apikey: legacy.api_key, authorization: `Bearer ${legacy.api_key}` };
  const secret = keys.find(k => k.type === 'secret' && k.api_key);
  if (secret) return { apikey: secret.api_key };
  throw new Error('Supabase CLI nevrátilo service_role ani secret klíč');
};

const fileHashes = path => new Promise((ok, fail) => {
  const md5 = createHash('md5'), sha256 = createHash('sha256');
  createReadStream(path).on('data', chunk => { md5.update(chunk); sha256.update(chunk); }).on('error', fail)
    .on('end', () => ok({ md5: md5.digest('hex'), sha256: sha256.digest('hex') }));
});
const md5Etag = object => {
  const etag = String(object.etag ?? '').replaceAll('"', '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(etag) ? etag : null;
};

const targetPath = (bucket, name) => {
  const target = resolve(mirror, bucket, name);
  if (!target.startsWith(mirror + sep + bucket + sep) || name.split('/').includes('..')) {
    throw new Error(`podezřelá cesta objektu ${bucket}/${name}`);
  }
  return target;
};

const sizeOf = async path => (await stat(path).catch(() => null))?.size ?? -1;

const download = async (headers, object, target) => {
  const url = `${baseUrl}/${encodeURIComponent(object.bucket)}/${object.name.split('/').map(encodeURIComponent).join('/')}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      const bodyMd5 = createHash('md5').update(body).digest('hex');
      const etag = md5Etag(object);
      const sizeOk = object.size == null || body.length === object.size;
      let changed = false;
      if (!sizeOk || (etag && bodyMd5 !== etag)) {
        // Výpis je z doby před pg_dump. Komprimovaná odpověď nese slabý ETag W/"<md5>".
        const responseEtag = md5Etag({ etag: String(response.headers.get('etag') ?? '').replace(/^W\//, '') });
        if (!responseEtag || responseEtag !== bodyMd5 || responseEtag === etag) {
          throw new Error(sizeOk ? 'MD5 nesouhlasí s eTagem' : `velikost ${body.length} ≠ ${object.size}`);
        }
        changed = true;
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(`${target}.partial`, body, { mode: 0o600 });
      await rename(`${target}.partial`, target);
      return { changed, size: body.length };
    } catch (error) {
      await rm(`${target}.partial`, { force: true });
      if (attempt >= 3) throw error;
      await new Promise(done => setTimeout(done, attempt * 2000));
    }
  }
};

const objects = JSON.parse(await readFile(args.objects, 'utf8'));
const headers = readKey();
const rows = [];
const failures = [];
const changedDuringBackup = [];
let downloaded = 0;
let queue = 0;
const worker = async () => {
  while (queue < objects.length) {
    const object = objects[queue++];
    try {
      const target = targetPath(object.bucket, object.name);
      const have = await sizeOf(target);
      let hashes = have >= 0 && (object.size == null || have === object.size) ? await fileHashes(target) : null;
      let size = object.size;
      if (!hashes || (md5Etag(object) && hashes.md5 !== md5Etag(object))) {
        const result = await download(headers, object, target);
        downloaded += 1;
        size = result.size;
        if (result.changed) changedDuringBackup.push(`${object.bucket}/${object.name}`);
        hashes = await fileHashes(target);
      }
      rows.push([object.bucket, object.name, size, hashes.sha256]);
    } catch (error) {
      failures.push(`${object.bucket}/${object.name}: ${error.message}`);
    }
  }
};
await Promise.all(Array.from({ length: JOBS }, worker));

rows.sort((a, b) => `${a[0]}/${a[1]}`.localeCompare(`${b[0]}/${b[1]}`));
const tsvField = value => String(value).replace(/[\t\n\\]/g, c => ({ '\t': '\\t', '\n': '\\n', '\\': '\\\\' })[c]);
await writeFile(args.out, ['bucket\tname\tsize\tsha256', ...rows.map(row => row.map(tsvField).join('\t'))].join('\n') + '\n', { mode: 0o600 });
const bytes = rows.reduce((sum, row) => sum + Number(row[2] ?? 0), 0);
// stdout je jediný řádek do manifestu zálohy, podrobnosti jdou na stderr (backup.log).
for (const name of changedDuringBackup.slice(0, 20)) console.error(`  změněno během zálohy, uložena novější verze: ${name}`);
console.log(`Storage: ${rows.length}/${objects.length} objektů v zrcadle (${(bytes / 1048576).toFixed(0)} MB), staženo nově ${downloaded}`
  + `${changedDuringBackup.length ? ` (z toho ${changedDuringBackup.length} změněno během zálohy)` : ''}, chyb ${failures.length}`);
if (failures.length) {
  for (const failure of failures.slice(0, 20)) console.error(`  ${failure}`);
  process.exit(1);
}
