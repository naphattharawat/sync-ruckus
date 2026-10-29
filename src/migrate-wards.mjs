// One-off migration: rows that used to be entered as "floors" are really wards on a floor.
// Each (building, level_no) becomes one real floor; a row named "ชั้น N" is kept as that floor, others move to `wards`.
import {createPool, withTransaction} from './db.mjs';

const pool = createPool();
try {
  const [[exists]] = await pool.query(`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='wards'`);
  if (exists.n) throw new Error('wards table already exists; migration has already run');

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  for (const table of ['floors', 'access_points', 'ap_mapping_history', 'client_current', 'client_visits']) {
    await pool.query(`CREATE TABLE bak_${stamp}_${table} AS SELECT * FROM ${table}`);
  }

  await pool.query(`CREATE TABLE wards (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    floor_id BIGINT UNSIGNED NOT NULL,
    code VARCHAR(40) NOT NULL,
    name VARCHAR(160) NOT NULL,
    UNIQUE KEY uq_ward_floor_code (floor_id, code),
    CONSTRAINT fk_ward_floor FOREIGN KEY (floor_id) REFERENCES floors(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`ALTER TABLE access_points ADD COLUMN ward_id BIGINT UNSIGNED NULL AFTER floor_id,
    ADD CONSTRAINT fk_ap_ward FOREIGN KEY (ward_id) REFERENCES wards(id)`);
  await pool.query(`ALTER TABLE ap_mapping_history ADD COLUMN ward_id BIGINT UNSIGNED NULL AFTER floor_id,
    ADD CONSTRAINT fk_mapping_history_ward FOREIGN KEY (ward_id) REFERENCES wards(id)`);
  await pool.query('ALTER TABLE client_visits ADD COLUMN ward_id BIGINT UNSIGNED NULL AFTER floor_id');
  await pool.query('ALTER TABLE client_current ADD COLUMN ward_id BIGINT UNSIGNED NULL AFTER floor_id');

  await withTransaction(pool, async db => {
    const [rows] = await db.query('SELECT * FROM floors WHERE level_no IS NOT NULL ORDER BY building_id,level_no,id');
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.building_id}|${row.level_no}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    let floorCount = 0, wardCount = 0;
    for (const group of groups.values()) {
      const {building_id: buildingId, level_no: level} = group[0];
      const label = String(Number(level));
      const plain = group.find(row => /^ชั้น\s*\S+$/.test(row.name.trim()));
      let floorId = plain?.id;
      if (!floorId) {
        const [result] = await db.execute('INSERT INTO floors (building_id,code,name,level_no) VALUES (?,?,?,?)',
          [buildingId, `L${label}`, `ชั้น ${label}`, level]);
        floorId = result.insertId;
        floorCount++;
      }
      for (const row of group) {
        if (row.id === floorId) continue;
        const [ward] = await db.execute('INSERT INTO wards (floor_id,code,name) VALUES (?,?,?)', [floorId, row.code, row.name]);
        for (const table of ['access_points', 'client_current', 'client_visits', 'ap_mapping_history']) {
          await db.execute(`UPDATE ${table} SET floor_id=?,ward_id=? WHERE floor_id=?`, [floorId, ward.insertId, row.id]);
        }
        await db.execute('DELETE FROM floors WHERE id=?', [row.id]);
        wardCount++;
      }
    }
    console.log(`Created ${floorCount} floors and moved ${wardCount} wards; backups in bak_${stamp}_*`);
  });
} finally {
  await pool.end();
}
