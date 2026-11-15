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

// A plain, honest client name: what this is and where it lives.
const USER_AGENT = 'LokisVault/1.0 (+https://github.com/DPaess/LokisVault)';

const deDate = (d) => Number(d?.$date?.$numberLong ?? d?.$date ?? 0) || 0;
const tierOf = (code) => TIERS[Number(String(code ?? '').replace('VoidT', '')) - 1];

async function main() {
  const farm = JSON.parse(await readFile(FARM, 'utf8'));
  let ws = null;
  let failure = '';
  for (let attempt = 1; attempt <= 3 && !ws; attempt++) {
    try {
      const res = await fetch(WORLDSTATE, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${res.headers.get('server') ?? 'unknown server'}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
      ws = JSON.parse(text);
    } catch (err) {
      failure = `attempt ${attempt}: ${err.message}`;
      console.error(failure);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!ws) throw new Error(`could not read ${WORLDSTATE} (${failure})`);

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

main().catch(async (err) => {
  console.error(err);
  // Publish the failure with an empty list: the site then falls back to WFCD, and the reason can be
  // read from the deployed file without access to the run log.
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), error: err.message, fissures: [] })).catch(() => {});
  process.exit(1);
});
