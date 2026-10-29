import {config} from './config.mjs';
import {withTransaction} from './db.mjs';
import {RuckusClient, withRetries} from './ruckus.mjs';

export function normalizeMac(value) {
  if (typeof value !== 'string') throw new Error('Missing MAC address in API response');
  const hex = value.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(hex)) throw new Error(`Invalid MAC address in API response: ${value}`);
  return hex.match(/.{2}/g).join(':');
}

function apiDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const result = new Date(number < 100_000_000_000 ? number * 1000 : number);
  return Number.isNaN(result.getTime()) ? null : result;
}

async function beginRun(pool, kind) {
  const [result] = await pool.execute('INSERT INTO sync_runs (kind,started_at,status) VALUES (?,UTC_TIMESTAMP(3),\'running\')', [kind]);
  return result.insertId;
}

async function failRun(pool, id, error) {
  await pool.execute('UPDATE sync_runs SET finished_at=UTC_TIMESTAMP(3),status=\'failed\',error_message=? WHERE id=?', [String(error.message || error).slice(0, 4000), id]);
}

export async function syncAps(pool, ruckus = new RuckusClient()) {
  const runId = await beginRun(pool, 'aps');
  try {
    const raw = await withRetries(() => ruckus.allPages('/v11_1/query/ap'));
    const aps = new Map(raw.map(ap => [normalizeMac(ap.apMac), ap]));
    const now = new Date();
    await withTransaction(pool, async db => {
      for (const [mac, ap] of aps) {
        await db.execute(`INSERT INTO access_points
          (ap_mac,device_name,description,api_status,model,zone_id,ap_group_id,indoor_map_id,indoor_map_x,indoor_map_y,source_present,first_synced_at,last_synced_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,TRUE,?,?)
          ON DUPLICATE KEY UPDATE device_name=VALUES(device_name),description=VALUES(description),api_status=VALUES(api_status),model=VALUES(model),
          zone_id=VALUES(zone_id),ap_group_id=VALUES(ap_group_id),indoor_map_id=VALUES(indoor_map_id),indoor_map_x=VALUES(indoor_map_x),
          indoor_map_y=VALUES(indoor_map_y),source_present=TRUE,last_synced_at=VALUES(last_synced_at)`,
          [mac, ap.deviceName ?? null, ap.description ?? null, ap.status ?? null, ap.model ?? null,
            ap.zoneId ?? null, ap.apGroupId ?? null, ap.indoorMapId ?? null, ap.indoorMapXy?.x ?? null,
            ap.indoorMapXy?.y ?? null, now, now]);
      }
      await db.execute('UPDATE access_points SET source_present=FALSE WHERE last_synced_at < ?', [now]);
      await db.execute('UPDATE sync_runs SET finished_at=UTC_TIMESTAMP(3),status=\'success\',item_count=? WHERE id=?', [aps.size, runId]);
    });
    return aps.size;
  } catch (error) {
    await failRun(pool, runId, error);
    throw error;
  }
}

function sameLocation(current, next) {
  if (current.building_id !== next.buildingId || current.floor_id !== next.floorId || current.ward_id !== next.wardId) return false;
  if (next.buildingId !== null) return true;
  return current.ap_mac === next.apMac;
}

export function sameApConnection(current, next) {
  const previousSession = current?.session_start_at ? new Date(current.session_start_at).getTime() : null;
  const nextSession = next.sessionStart ? next.sessionStart.getTime() : null;
  return Boolean(current?.online && current.ap_mac === next.apMac && current.ssid === next.ssid && previousSession === nextSession);
}

export async function syncClients(pool, ruckus = new RuckusClient()) {
  if (!config.trackedSsids.length) throw new Error('Set TRACKED_SSIDS before collecting client data');
  const runId = await beginRun(pool, 'clients');
  try {
    const raw = await withRetries(() => ruckus.allPages('/v11_1/query/client'));
    const accepted = new Set(config.trackedSsids);
    const clients = new Map();
    for (const row of raw) {
      if (!accepted.has(row.ssid)) continue;
      const mac = normalizeMac(row.clientMac);
      const previous = clients.get(mac);
      if (!previous || Number(row.sessionStartTime || 0) >= Number(previous.sessionStartTime || 0)) clients.set(mac, row);
    }
    const now = new Date();
    const cutoff = new Date(now.getTime() - 6 * 60_000);
    await withTransaction(pool, async db => {
      const [mappedRows] = await db.query('SELECT ap_mac,building_id,floor_id,ward_id FROM access_points');
      const mapping = new Map(mappedRows.map(row => [row.ap_mac, row]));
      for (const [mac, row] of clients) {
        const apMac = row.apMac ? normalizeMac(row.apMac) : null;
        const mapped = mapping.get(apMac);
        const next = {
          buildingId: mapped?.building_id ?? null,
          floorId: mapped?.floor_id ?? null,
          wardId: mapped?.ward_id ?? null,
          apMac,
          username: row.userName || null,
          ssid: row.ssid,
          bssid: row.bssid ? normalizeMac(row.bssid) : null,
          sessionStart: apiDate(row.sessionStartTime),
          rssi: row.rssi !== null && row.rssi !== undefined && Number.isFinite(Number(row.rssi)) ? Number(row.rssi) : null,
        };
        const [existing] = await db.execute('SELECT * FROM client_current WHERE client_mac=? FOR UPDATE', [mac]);
        const current = existing[0];
        let visitId;
        if (current?.online && current.active_visit_id && sameLocation(current, next)) {
          visitId = current.active_visit_id;
          await db.execute(`UPDATE client_visits SET username=?,ssid=?,last_ap_mac=?,last_seen_at=?,session_start_at=? WHERE id=?`,
            [next.username, next.ssid, apMac, now, next.sessionStart, visitId]);
        } else {
          if (current?.active_visit_id) {
            await db.execute('UPDATE client_visits SET ended_at=last_seen_at WHERE id=? AND ended_at IS NULL', [current.active_visit_id]);
          }
          const [visit] = await db.execute(`INSERT INTO client_visits
            (client_mac,username,ssid,building_id,floor_id,ward_id,first_ap_mac,last_ap_mac,session_start_at,first_seen_at,last_seen_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [mac, next.username, next.ssid, next.buildingId, next.floorId, next.wardId, apMac, apMac, next.sessionStart, now, now]);
          visitId = visit.insertId;
        }
        if (sameApConnection(current, next)) {
          const [updated] = await db.execute(`UPDATE client_ap_visits SET username=?,bssid=?,last_seen_at=?,last_rssi=?,sample_count=sample_count+1
            WHERE open_client_mac=?`, [next.username, next.bssid, now, next.rssi, mac]);
          if (!updated.affectedRows) {
            await db.execute(`INSERT INTO client_ap_visits
              (client_mac,open_client_mac,username,ssid,ap_mac,bssid,building_id,floor_id,ward_id,session_start_at,first_seen_at,last_seen_at,first_rssi,last_rssi)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [mac, mac, next.username, next.ssid, apMac, next.bssid, next.buildingId, next.floorId, next.wardId,
                next.sessionStart, now, now, next.rssi, next.rssi]);
          }
        } else {
          await db.execute('UPDATE client_ap_visits SET ended_at=last_seen_at,open_client_mac=NULL WHERE open_client_mac=?', [mac]);
          await db.execute(`INSERT INTO client_ap_visits
            (client_mac,open_client_mac,username,ssid,ap_mac,bssid,building_id,floor_id,ward_id,session_start_at,first_seen_at,last_seen_at,first_rssi,last_rssi)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [mac, mac, next.username, next.ssid, apMac, next.bssid, next.buildingId, next.floorId, next.wardId,
              next.sessionStart, now, now, next.rssi, next.rssi]);
        }
        await db.execute(`INSERT INTO client_current
          (client_mac,username,ssid,ap_mac,bssid,building_id,floor_id,ward_id,session_start_at,first_seen_at,last_seen_at,online,active_visit_id,rssi)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,TRUE,?,?)
          ON DUPLICATE KEY UPDATE username=VALUES(username),ssid=VALUES(ssid),ap_mac=VALUES(ap_mac),bssid=VALUES(bssid),
          building_id=VALUES(building_id),floor_id=VALUES(floor_id),ward_id=VALUES(ward_id),session_start_at=VALUES(session_start_at),
          last_seen_at=VALUES(last_seen_at),online=TRUE,active_visit_id=VALUES(active_visit_id),rssi=VALUES(rssi)`,
          [mac, next.username, next.ssid, apMac, next.bssid, next.buildingId, next.floorId, next.wardId,
            next.sessionStart, now, now, visitId, next.rssi]);
      }
      const [stale] = await db.execute('SELECT client_mac,active_visit_id FROM client_current WHERE online=TRUE AND last_seen_at<=?', [cutoff]);
      for (const row of stale) {
        if (row.active_visit_id) await db.execute('UPDATE client_visits SET ended_at=last_seen_at WHERE id=? AND ended_at IS NULL', [row.active_visit_id]);
        await db.execute('UPDATE client_ap_visits SET ended_at=last_seen_at,open_client_mac=NULL WHERE open_client_mac=?', [row.client_mac]);
      }
      await db.execute('UPDATE client_current SET online=FALSE,active_visit_id=NULL WHERE online=TRUE AND last_seen_at<=?', [cutoff]);
      await db.execute('UPDATE sync_runs SET finished_at=UTC_TIMESTAMP(3),status=\'success\',item_count=? WHERE id=?', [clients.size, runId]);
    });
    return clients.size;
  } catch (error) {
    await failRun(pool, runId, error);
    throw error;
  }
}

// A completed controller session can start and end between two client snapshots.
// Keep it separately from sampled visits so its exact times are never overwritten.
export async function syncHistoricalSessions(pool, ruckus = new RuckusClient()) {
  const [[latest]] = await pool.query('SELECT MAX(session_end_at) AS latest FROM client_ap_sessions');
  const end = Date.now();
  const start = latest.latest
    ? Math.max(end - 24 * 60 * 60_000, new Date(latest.latest).getTime() - 60 * 60_000)
    : end - 24 * 60 * 60_000;
  const rows = [];
  for (let page = 1; page <= 100; page++) {
    const response = await withRetries(() => ruckus.query('/v11_1/query/historicalclient', {
      page, limit: 500, extraTimeRange: {start, end},
    }));
    if (!Array.isArray(response?.list) || typeof response.hasMore !== 'boolean') {
      throw new Error('Historical client API returned invalid pagination');
    }
    rows.push(...response.list);
    if (!response.hasMore) break;
    if (page === 100) throw new Error('Historical client API exceeded page safety limit');
  }
  const accepted = new Set(config.trackedSsids);
  const valid = [];
  for (const row of rows) {
    if (!accepted.has(row.ssid) || !row.clientMac || !row.apMac) continue;
    const sessionStart = apiDate(row.sessionStartTime);
    const sessionEnd = apiDate(row.sessionEndTime);
    if (!sessionStart || !sessionEnd || sessionEnd < sessionStart) continue;
    valid.push({clientMac: normalizeMac(row.clientMac), apMac: normalizeMac(row.apMac),
      ssid: row.ssid, sessionStart, sessionEnd});
  }
  const [mappedRows] = await pool.query('SELECT ap_mac,building_id,floor_id,ward_id FROM access_points');
  const mapping = new Map(mappedRows.map(row => [row.ap_mac, row]));
  let inserted = 0;
  for (const row of valid) {
    const mapped = mapping.get(row.apMac);
    const [result] = await pool.execute(`INSERT IGNORE INTO client_ap_sessions
      (client_mac,ssid,ap_mac,session_start_at,session_end_at,building_id,floor_id,ward_id,first_synced_at)
      VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,
      [row.clientMac, row.ssid, row.apMac, row.sessionStart, row.sessionEnd,
        mapped?.building_id ?? null, mapped?.floor_id ?? null, mapped?.ward_id ?? null]);
    inserted += result.affectedRows;
  }
  return inserted;
}

export async function pruneHistory(pool) {
  await pool.query('DELETE FROM client_current WHERE online=FALSE AND last_seen_at < UTC_TIMESTAMP(3) - INTERVAL 1 YEAR');
  await pool.query('DELETE FROM client_visits WHERE ended_at IS NOT NULL AND ended_at < UTC_TIMESTAMP(3) - INTERVAL 1 YEAR');
  await pool.query('DELETE FROM client_ap_visits WHERE ended_at IS NOT NULL AND ended_at < UTC_TIMESTAMP(3) - INTERVAL 1 YEAR');
  await pool.query('DELETE FROM client_ap_sessions WHERE session_end_at < UTC_TIMESTAMP(3) - INTERVAL 1 YEAR');
}
