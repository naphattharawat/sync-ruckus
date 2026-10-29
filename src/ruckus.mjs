import https from 'node:https';
import tls from 'node:tls';
import {config, requireConfig} from './config.mjs';

const delays = [10_000, 20_000, 30_000, 40_000, 50_000];
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function withRetries(fn, wait = sleep) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= delays.length || error.permanent) throw error;
      await wait(delays[attempt]);
    }
  }
}

class PinnedAgent extends https.Agent {
  constructor(fingerprint) {
    super({keepAlive: true, maxSockets: 5});
    this.fingerprint = fingerprint.replaceAll(':', '').toUpperCase();
  }

  createConnection(options, callback) {
    const socket = tls.connect({...options, rejectUnauthorized: false});
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      callback(error, value);
    };
    socket.once('secureConnect', () => {
      const actual = socket.getPeerCertificate()?.fingerprint256?.replaceAll(':', '').toUpperCase();
      if (!actual || actual !== this.fingerprint) {
        socket.destroy();
        finish(new Error('Ruckus TLS certificate fingerprint mismatch'));
      } else {
        finish(null, socket);
      }
    });
    socket.once('error', error => finish(error));
  }
}

export class RuckusClient {
  constructor(settings = config.ruckus) {
    if (!settings.fingerprint) throw new Error('Missing configuration: ruckus.fingerprint');
    this.settings = settings;
    this.agent = new PinnedAgent(settings.fingerprint);
    this.ticket = null;
  }

  async raw(method, path, body) {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = https.request({
        hostname: this.settings.host,
        port: this.settings.port,
        path: `/wsg/api/public${path}`,
        method,
        agent: this.agent,
        timeout: 15_000,
        headers: {'Content-Type': 'application/json;charset=UTF-8', ...(data ? {'Content-Length': data.length} : {})},
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let value;
          try { value = raw ? JSON.parse(raw) : null; }
          catch { reject(new Error('Ruckus returned invalid JSON')); return; }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const error = new Error(`Ruckus HTTP ${response.statusCode}: ${JSON.stringify(value)?.slice(0, 300)}`);
            error.status = response.statusCode;
            error.permanent = response.statusCode >= 400 && response.statusCode < 500 && ![401, 403, 429].includes(response.statusCode);
            reject(error);
          } else resolve(value);
        });
      });
      request.on('timeout', () => request.destroy(new Error('Ruckus request timeout')));
      request.on('error', reject);
      if (data) request.write(data);
      request.end();
    });
  }

  async login() {
    if (!this.settings.user || !this.settings.password) throw new Error('Missing Ruckus API credentials');
    const result = await this.raw('POST', '/v11_1/serviceTicket', {username: this.settings.user, password: this.settings.password});
    if (!result?.serviceTicket) throw new Error('Ruckus login did not return serviceTicket');
    this.ticket = result.serviceTicket;
  }

  async query(path, body) {
    if (!this.ticket) await this.login();
    const call = () => this.raw('POST', `${path}?serviceTicket=${encodeURIComponent(this.ticket)}`, body);
    try {
      return await call();
    } catch (error) {
      if (![401, 403].includes(error.status)) throw error;
      this.ticket = null;
      await this.login();
      return call();
    }
  }

  async allPages(path, pageSize = 500) {
    const rows = [];
    let expectedTotal = null;
    for (let page = 1; ; page++) {
      const response = await this.query(path, {page, limit: pageSize});
      if (!Array.isArray(response?.list)) throw new Error(`${path} did not return a list`);
      if (!Number.isSafeInteger(response.totalCount) || response.totalCount < 0 || typeof response.hasMore !== 'boolean') {
        throw new Error(`${path} returned invalid pagination metadata`);
      }
      if (expectedTotal === null) expectedTotal = response.totalCount;
      if (response.totalCount !== expectedTotal || response.firstIndex !== rows.length) {
        throw new Error(`${path} changed during pagination`);
      }
      rows.push(...response.list);
      if (!response.hasMore) {
        if (rows.length !== expectedTotal) throw new Error(`${path} returned an incomplete snapshot`);
        return rows;
      }
      if (!response.list.length || rows.length >= expectedTotal) throw new Error(`${path} returned inconsistent pagination`);
      if (page >= 10000) throw new Error(`${path} exceeded page safety limit`);
    }
  }
}
