// Writes public/data/fissures.json, the open Void Fissures, from DE's public world state.
// Browsers may not read DE's feed (it sends no CORS header), so a GitHub Action runs this every
// hour and on demand, and publishes the file with the site. It is never committed.
// Needs public/data/farm.json for node and mission type names. No dependencies.
// Run with: node scripts/fetch-fissures.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FARM = path.join(ROOT, 'public', 'data', 'farm.json');
const OUT = path.join(ROOT, 'public', 'data', 'fissures.json');
const WORLDSTATE = 'https://api.warframe.com/cdn/worldState.php';
const TIERS = ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem', 'Omnia'];

const deDate = (d) => Number(d?.$date?.$numberLong ?? d?.$date ?? 0) || 0;
const tierOf = (code) => TIERS[Number(String(code ?? '').replace('VoidT', '')) - 1];

async function main() {
  const farm = JSON.parse(await readFile(FARM, 'utf8'));
  const res = await fetch(WORLDSTATE);
  if (!res.ok) throw new Error(`${WORLDSTATE} -> HTTP ${res.status}`);
  const ws = await res.json();

  const fissures = [];
  const unknown = new Set();
  const add = (x, tier, storm) => {
    const known = farm.nodes?.[x.Node];
    if (!known) unknown.add(x.Node);
    if (!tier || !known) return;
    const [node, planet, enemy, nodeType] = known;
    const type = farm.missionTypes?.[x.MissionType] ?? nodeType;
    fissures.push({ id: x._id?.$oid ?? x.Node, node, planet, type, enemy, tier, hard: Boolean(x.Hard), storm, expiry: deDate(x.Expiry) });
  };
  for (const x of ws.ActiveMissions ?? []) add(x, tierOf(x.Modifier), false);
  for (const x of ws.VoidStorms ?? []) add(x, tierOf(x.ActiveMissionTier), true);
  if (!fissures.length) throw new Error('no fissures found in the world state');

  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), source: "DE's world state", fissures }));
  console.log(`fissures.json: ${fissures.length} fissures${unknown.size ? `, unknown nodes skipped: ${[...unknown].join(', ')}` : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
