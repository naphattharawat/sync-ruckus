import {initSchema, createPool} from './db.mjs';
import {config} from './config.mjs';
import {RuckusClient} from './ruckus.mjs';
import {syncAps, syncClients, syncHistoricalSessions, pruneHistory} from './sync.mjs';

const mode = process.argv[2];
if (mode === 'init') {
  await initSchema();
  console.log('Database schema ready');
} else if (['aps', 'clients', 'sessions'].includes(mode)) {
  const pool = createPool();
  try {
    const count = mode === 'aps' ? await syncAps(pool) : mode === 'clients' ? await syncClients(pool) : await syncHistoricalSessions(pool);
    console.log(`${mode}: ${count} records synchronized`);
  } finally {
    await pool.end();
  }
} else if (mode === 'retention') {
  const pool = createPool();
  try {
    await pruneHistory(pool);
    console.log('History retention complete');
  } finally {
    await pool.end();
  }
} else if (mode === 'worker') {
  if (!config.trackedSsids.length) throw new Error('Set TRACKED_SSIDS before starting worker');
  const pool = createPool();
  // MySQL holds this lock for the lifetime of the connection, across all hosts using this DB.
  const lockName = 'ruckus_wifi_location_worker';
  const lockConnection = await pool.getConnection();
  const [[lock]] = await lockConnection.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
  if (lock.acquired !== 1) {
    lockConnection.release();
    await pool.end();
    throw new Error('Another Ruckus collector already holds the worker lock');
  }
  const apClient = new RuckusClient();
  const clientClient = new RuckusClient();
  const historyClient = new RuckusClient();
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  let checkingLock = false;
  const heartbeat = setInterval(async () => {
    if (checkingLock) return;
    checkingLock = true;
    try {
      const [[row]] = await lockConnection.execute('SELECT IS_USED_LOCK(?) AS owner, CONNECTION_ID() AS connection_id', [lockName]);
      if (row.owner !== row.connection_id) throw new Error('Worker lock was lost');
    } catch (error) {
      console.error(new Date().toISOString(), 'worker lock failed', error.message);
      process.exit(1);
    } finally {
      checkingLock = false;
    }
  }, 60_000);
  async function loop(label, interval, task) {
    while (!stopping) {
      const start = Date.now();
      try {
        const count = await task();
        console.log(new Date().toISOString(), label, 'success', count);
      } catch (error) {
        console.error(new Date().toISOString(), label, 'failed', error.message);
      }
      const remaining = Math.max(1000, interval - (Date.now() - start));
      await new Promise(resolve => setTimeout(resolve, remaining));
    }
  }
  await Promise.all([
    loop('aps', 60 * 60_000, () => syncAps(pool, apClient)),
    loop('clients', 60_000, () => syncClients(pool, clientClient)),
    loop('sessions', 60_000, () => syncHistoricalSessions(pool, historyClient)),
    loop('retention', 24 * 60 * 60_000, async () => { await pruneHistory(pool); return 0; }),
  ]);
  clearInterval(heartbeat);
  await lockConnection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
  lockConnection.release();
  await pool.end();
} else {
  console.error('Usage: node src/cli.mjs <init|aps|clients|sessions|retention|worker>');
  process.exitCode = 2;
}
