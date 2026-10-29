import fs from 'node:fs';

if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

export const config = {
  db: {
    host: process.env.DB_HOST || '172.18.22.3',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || 'wifi_location',
    user: process.env.DB_USER || 'wifi_location',
    password: process.env.DB_PASSWORD,
    timezone: 'Z',
    dateStrings: false,
    waitForConnections: true,
    connectionLimit: 5,
  },
  ruckus: {
    host: process.env.RUCKUS_HOST || '172.16.0.65',
    port: Number(process.env.RUCKUS_PORT || 8443),
    user: process.env.RUCKUS_USER || 'cpa',
    password: process.env.RUCKUS_PASSWORD,
    fingerprint: process.env.RUCKUS_CERT_SHA256,
  },
  trackedSsids: (process.env.TRACKED_SSIDS || '').split(',').map(x => x.trim()).filter(Boolean),
  admin: {
    host: process.env.ADMIN_HOST || '127.0.0.1',
    port: Number(process.env.ADMIN_PORT || 8080),
    password: process.env.ADMIN_PASSWORD,
  },
};

export function requireConfig(...keys) {
  for (const key of keys) {
    const value = key.split('.').reduce((obj, part) => obj?.[part], config);
    if (!value) throw new Error(`Missing configuration: ${key}`);
  }
}
