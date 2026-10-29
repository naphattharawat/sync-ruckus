// Import a flat CSV (id,building_id,code,name,level_no) into buildings › floors › wards.
// A row named exactly "ชั้น X" is a floor; any other row is a ward on the floor at level_no (a leading "ชั้น N " is dropped from its name).
// Existing wards are matched by code, then by name, within the same building, so AP mappings are kept.
// Usage: node src/import-locations.mjs <file.csv> [--dry-run]
import fs from 'node:fs';
import {createPool, withTransaction} from './db.mjs';

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(value => value.trim() !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some(value => value.trim() !== '')) rows.push(row);
  const [header, ...body] = rows;
  const names = header.map(name => name.trim().replace(/^﻿/, ''));
  return body.map(values => Object.fromEntries(names.map((name, index) => [name, (values[index] ?? '').trim()])));
}

const [file, flag] = process.argv.slice(2);
if (!file) throw new Error('Usage: node src/import-locations.mjs <file.csv> [--dry-run]');
const dryRun = flag === '--dry-run';
const records = parseCsv(fs.readFileSync(file, 'utf8'));

const pool = createPool();
try {
  if (!dryRun) {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
    for (const table of ['floors', 'wards', 'access_points', 'ap_mapping_history']) {
      await pool.query(`CREATE TABLE bak_${stamp}_${table} AS SELECT * FROM ${table}`);
    }
    console.log(`Backups in bak_${stamp}_*`);
  }
  const log = [];
  await withTransaction(pool, async db => {
    const [buildingRows] = await db.query('SELECT id FROM buildings');
    const buildingIds = new Set(buildingRows.map(row => row.id));
    const floorFor = async (buildingId, level, code, label) => {
      const [[floor]] = await db.execute('SELECT id FROM floors WHERE building_id=? AND level_no=?', [buildingId, level]);
      if (floor) return floor.id;
      const [result] = await db.execute('INSERT INTO floors (building_id,code,name,level_no) VALUES (?,?,?,?)', [buildingId, code, `ชั้น ${label}`, level]);
      log.push(`+ floor  building ${buildingId} ชั้น ${label} (${code})`);
      return result.insertId;
    };
    for (const record of records) {
      const buildingId = Number(record.building_id);
      const level = Number(record.level_no);
      if (!buildingIds.has(buildingId)) throw new Error(`Building ${record.building_id} not found (row id ${record.id})`);
      if (!record.code || !record.name || record.level_no === '' || !Number.isFinite(level)) throw new Error(`Incomplete row id ${record.id}`);
      const floorOnly = record.name.match(/^ชั้น\s*(\S+)$/);
      if (floorOnly) {
        await floorFor(buildingId, level, record.code, floorOnly[1]);
        continue;
      }
      const wardName = record.name.replace(/^ชั้น\s*\S+\s+/, '');
      const floorId = await floorFor(buildingId, level, `L${level}`, level);
      const find = column => db.execute(`SELECT w.* FROM wards w JOIN floors f ON f.id=w.floor_id WHERE f.building_id=? AND w.${column}=?`, [buildingId, column === 'code' ? record.code : wardName]);
      let [[ward]] = await find('code');
      if (!ward) [[ward]] = await find('name');
      if (!ward) {
        await db.execute('INSERT INTO wards (floor_id,code,name) VALUES (?,?,?)', [floorId, record.code, wardName]);
        log.push(`+ ward   building ${buildingId} ชั้น ${level} ${wardName} (${record.code})`);
        continue;
      }
      if (ward.floor_id === floorId && ward.code === record.code && ward.name === wardName) continue;
      await db.execute('UPDATE wards SET floor_id=?,code=?,name=? WHERE id=?', [floorId, record.code, wardName, ward.id]);
      log.push(`~ ward   ${ward.code} "${ward.name}" -> ${record.code} "${wardName}"${ward.floor_id === floorId ? '' : ` moved to ชั้น ${level}`}`);
      if (ward.floor_id !== floorId) {
        // APs on a moved ward follow it to the new floor; the change is recorded like an admin re-mapping.
        const [aps] = await db.execute('SELECT ap_mac,map_x,map_y FROM access_points WHERE ward_id=?', [ward.id]);
        for (const ap of aps) {
          await db.execute('UPDATE ap_mapping_history SET valid_to=UTC_TIMESTAMP(3) WHERE ap_mac=? AND valid_to IS NULL', [ap.ap_mac]);
          await db.execute(`INSERT INTO ap_mapping_history (ap_mac,building_id,floor_id,ward_id,map_x,map_y,valid_from,mapped_by)
            VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3),'import')`, [ap.ap_mac, buildingId, floorId, ward.id, ap.map_x, ap.map_y]);
        }
        await db.execute('UPDATE access_points SET building_id=?,floor_id=? WHERE ward_id=?', [buildingId, floorId, ward.id]);
        log.push(`         ${aps.length} AP(s) moved with it`);
      }
    }
    console.log(log.length ? log.join('\n') : 'No changes');
    if (dryRun) throw Object.assign(new Error('dry run'), {dryRun: true});
  }).catch(error => { if (!error.dryRun) throw error; console.log('(dry run: rolled back)'); });
} finally {
  await pool.end();
}
