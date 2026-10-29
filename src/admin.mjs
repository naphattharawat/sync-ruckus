import http from 'node:http';
import crypto from 'node:crypto';
import {config, requireConfig} from './config.mjs';
import {createPool, withTransaction} from './db.mjs';
import {normalizeMac} from './sync.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const csrfToken = crypto.randomBytes(32).toString('hex');

function authorized(request) {
  const header = request.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let credentials;
  try { credentials = Buffer.from(header.slice(6), 'base64').toString('utf8'); }
  catch { return false; }
  const colon = credentials.indexOf(':');
  if (colon < 0 || credentials.slice(0, colon) !== 'admin') return false;
  const given = crypto.createHash('sha256').update(credentials.slice(colon + 1)).digest();
  const expected = crypto.createHash('sha256').update(config.admin.password).digest();
  return crypto.timingSafeEqual(given, expected);
}

async function formBody(request) {
  const parts = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16_384) throw new Error('Form too large');
    parts.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(parts).toString('utf8'));
}

async function mapAp(pool, form) {
  const mac = normalizeMac(form.get('ap_mac'));
  const floorId = Number(form.get('floor_id'));
  const wardId = form.get('ward_id') ? Number(form.get('ward_id')) : null;
  const xText = form.get('map_x')?.trim() || '';
  const yText = form.get('map_y')?.trim() || '';
  const x = xText === '' ? null : Number(xText);
  const y = yText === '' ? null : Number(yText);
  if (!Number.isSafeInteger(floorId) || floorId < 1 || (wardId !== null && (!Number.isSafeInteger(wardId) || wardId < 1)) ||
      (x !== null && !Number.isFinite(x)) || (y !== null && !Number.isFinite(y))) {
    throw new Error('Invalid floor, ward or map coordinates');
  }
  await withTransaction(pool, async db => {
    const [[floor]] = await db.execute('SELECT id,building_id FROM floors WHERE id=?', [floorId]);
    if (!floor) throw new Error('Floor not found');
    if (form.has('building_id') && Number(form.get('building_id')) !== floor.building_id) throw new Error('Floor does not belong to the selected building');
    if (wardId !== null) {
      const [[ward]] = await db.execute('SELECT id FROM wards WHERE id=? AND floor_id=?', [wardId, floorId]);
      if (!ward) throw new Error('Ward does not belong to the selected floor');
    }
    const [[ap]] = await db.execute('SELECT * FROM access_points WHERE ap_mac=? FOR UPDATE', [mac]);
    if (!ap) throw new Error('AP not found');
    if (ap.building_id === floor.building_id && ap.floor_id === floorId && ap.ward_id === wardId && ap.map_x === x && ap.map_y === y) return;
    await db.execute('UPDATE ap_mapping_history SET valid_to=UTC_TIMESTAMP(3) WHERE ap_mac=? AND valid_to IS NULL', [mac]);
    await db.execute(`INSERT INTO ap_mapping_history (ap_mac,building_id,floor_id,ward_id,map_x,map_y,valid_from,mapped_by)
      VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3),'admin')`, [mac, floor.building_id, floorId, wardId, x, y]);
    await db.execute(`UPDATE access_points SET building_id=?,floor_id=?,ward_id=?,map_x=?,map_y=?,mapped_by='admin',mapped_at=UTC_TIMESTAMP(3)
      WHERE ap_mac=?`, [floor.building_id, floorId, wardId, x, y, mac]);
    // Apply the first mapping to observations that were waiting for this AP's location.
    if (ap.floor_id === null) {
      await db.execute('UPDATE client_current SET building_id=?,floor_id=?,ward_id=? WHERE ap_mac=? AND floor_id IS NULL', [floor.building_id, floorId, wardId, mac]);
      await db.execute(`UPDATE client_visits SET building_id=?,floor_id=?,ward_id=? WHERE first_ap_mac=? AND floor_id IS NULL`,
        [floor.building_id, floorId, wardId, mac]);
      await db.execute(`UPDATE client_ap_visits SET building_id=?,floor_id=?,ward_id=? WHERE ap_mac=? AND floor_id IS NULL`,
        [floor.building_id, floorId, wardId, mac]);
      await db.execute(`UPDATE client_ap_sessions SET building_id=?,floor_id=?,ward_id=? WHERE ap_mac=? AND floor_id IS NULL`,
        [floor.building_id, floorId, wardId, mac]);
    }
  });
}

const option = (value, label, selected) => `<option value="${value}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;

async function page(pool, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const show = ['unmapped', 'mapped'].includes(url.searchParams.get('show')) ? url.searchParams.get('show') : 'all';
  const [buildings] = await pool.query('SELECT * FROM buildings ORDER BY name');
  const [floors] = await pool.query('SELECT * FROM floors ORDER BY building_id,level_no,name');
  const [wards] = await pool.query('SELECT * FROM wards ORDER BY floor_id,name');
  const params = [];
  const where = [];
  if (show === 'unmapped') where.push('a.floor_id IS NULL');
  if (show === 'mapped') where.push('a.floor_id IS NOT NULL');
  if (q) { where.push('(a.ap_mac LIKE ? OR a.device_name LIKE ? OR a.description LIKE ?)'); params.push(...Array(3).fill(`%${q}%`)); }
  const [aps] = await pool.execute(`SELECT a.*,b.name AS building_name,f.name AS floor_name,w.name AS ward_name FROM access_points a
    LEFT JOIN buildings b ON b.id=a.building_id LEFT JOIN floors f ON f.id=a.floor_id LEFT JOIN wards w ON w.id=a.ward_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.device_name LIMIT 500`, params);
  const buildingOptions = selectedId => buildings.map(b => option(b.id, b.name, b.id === selectedId)).join('');
  const floorOptions = (buildingId, selectedId) => floors.filter(f => f.building_id === buildingId).map(f => option(f.id, f.name, f.id === selectedId)).join('');
  const wardOptions = (floorId, selectedId) => wards.filter(w => w.floor_id === floorId).map(w => option(w.id, w.name, w.id === selectedId)).join('');
  const hasWards = floorId => wards.some(w => w.floor_id === floorId);
  // Lists are rebuilt in the browser when a parent changes; `<` is escaped so names cannot close the script tag.
  const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
  const floorsJson = json(floors.map(f => ({id: f.id, parent: f.building_id, name: f.name})));
  const wardsJson = json(wards.map(w => ({id: w.id, parent: w.floor_id, name: w.name})));
  const location = ap => ap.floor_id === null ? '<span class="muted">ยังไม่ map</span>'
    : [ap.building_name, ap.floor_name, ap.ward_name].filter(Boolean).map(escapeHtml).join(' › ');
  const rows = aps.map(ap => `<tr id="ap-${escapeHtml(ap.ap_mac)}"${ap.floor_id === null ? '' : ' class="mapped"'}><td>${escapeHtml(ap.ap_mac)}</td><td>${escapeHtml(ap.device_name)}</td><td>${escapeHtml(ap.description)}</td>
    <td>${escapeHtml(ap.api_status)}</td><td>${location(ap)}</td>
    <td><form method="post" action="/map${escapeHtml(url.search)}"><input type="hidden" name="csrf" value="${csrfToken}"><input type="hidden" name="ap_mac" value="${escapeHtml(ap.ap_mac)}">
      <select name="building_id" class="building" required><option value="">เลือกตึก</option>${buildingOptions(ap.building_id)}</select>
      <select name="floor_id" class="floor" required${ap.building_id === null ? ' disabled' : ''}><option value="">เลือกชั้น</option>${ap.building_id === null ? '' : floorOptions(ap.building_id, ap.floor_id)}</select>
      <select name="ward_id" class="ward" required${hasWards(ap.floor_id) ? '' : ' disabled'}><option value="">เลือกวอร์ด</option>${ap.floor_id === null ? '' : wardOptions(ap.floor_id, ap.ward_id)}</select>
      <input name="map_x" type="number" step="any" placeholder="X" size="5" value="${escapeHtml(ap.map_x)}"><input name="map_y" type="number" step="any" placeholder="Y" size="5" value="${escapeHtml(ap.map_y)}">
      <button>บันทึก</button></form></td></tr>`).join('');
  return `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Ruckus AP Mapping</title><style>body{font:15px system-ui;margin:24px;color:#18212f}form{display:flex;gap:6px;flex-wrap:wrap}input,select,button{padding:7px}
    table{border-collapse:collapse;width:100%;margin-top:20px}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}th{background:#eef2f5}
    .toolbar{display:flex;gap:25px;flex-wrap:wrap}.toolbar section{padding:15px;background:#f5f7fa}td:nth-child(3){max-width:350px}
    tr.mapped td:nth-child(5){color:#0b6b3a;font-weight:600}.muted{color:#8a94a3}select:disabled{opacity:.5}:target{background:#fff8d6}
    th.sortable{cursor:pointer;user-select:none;white-space:nowrap}th.sortable:hover{background:#dde5ec}
    th.sortable::after{content:' ↕';color:#a0aab6}th[aria-sort=ascending]::after{content:' ▲';color:#18212f}th[aria-sort=descending]::after{content:' ▼';color:#18212f}</style>
    <h1>กำหนดตำแหน่ง AP</h1><p>ข้อมูลชื่อและ description มาจาก Ruckus API; ตึก/ชั้น/วอร์ดและพิกัดกำหนดโดย admin</p>
    <div class="toolbar"><section><h2>เพิ่มตึก</h2><form method="post" action="/building"><input type="hidden" name="csrf" value="${csrfToken}"><input name="code" placeholder="รหัสตึก" required><input name="name" placeholder="ชื่อตึก" required><button>เพิ่ม</button></form></section>
    <section><h2>เพิ่มชั้น</h2><form method="post" action="/floor"><input type="hidden" name="csrf" value="${csrfToken}"><select name="building_id" required><option value="">เลือกตึก</option>${buildingOptions(null)}</select>
      <input name="code" placeholder="รหัสชั้น" required><input name="name" placeholder="ชื่อชั้น เช่น ชั้น 2" required><input name="level_no" type="number" step="any" placeholder="ลำดับชั้น"><button>เพิ่ม</button></form></section>
    <section><h2>เพิ่มวอร์ด</h2><form method="post" action="/ward"><input type="hidden" name="csrf" value="${csrfToken}"><select name="building_id" class="building" required><option value="">เลือกตึก</option>${buildingOptions(null)}</select>
      <select name="floor_id" class="floor" required disabled><option value="">เลือกชั้น</option></select>
      <input name="code" placeholder="รหัสวอร์ด" required><input name="name" placeholder="ชื่อวอร์ด" required><button>เพิ่ม</button></form></section></div>
    <form method="get" action="/"><input name="q" value="${escapeHtml(q)}" placeholder="ค้นหา AP / MAC / description"><select name="show">${option('all', 'ทั้งหมด', show === 'all')}${option('unmapped', 'ยังไม่ map', show === 'unmapped')}${option('mapped', 'map แล้ว', show === 'mapped')}</select><button>ค้นหา</button></form>
    <p>แสดง ${aps.length} รายการ</p><table id="aps"><thead><tr><th class="sortable">AP MAC</th><th class="sortable">ชื่อ AP</th><th class="sortable">Description</th><th class="sortable">สถานะ</th><th class="sortable">ตำแหน่งปัจจุบัน</th><th>กำหนดตึก / ชั้น / วอร์ด</th></tr></thead><tbody>${rows}</tbody></table>
    <script>
    const floors = ${floorsJson};
    const wards = ${wardsJson};
    function fill(select, items, placeholder, parentValue) {
      if (!select) return;
      const children = parentValue === '' ? [] : items.filter(item => item.parent === Number(parentValue));
      select.replaceChildren(new Option(placeholder, ''), ...children.map(item => new Option(item.name, item.id)));
      select.disabled = !children.length;
    }
    document.addEventListener('change', event => {
      const form = event.target.form;
      if (!form) return;
      if (event.target.matches('select.building')) {
        fill(form.querySelector('select.floor'), floors, 'เลือกชั้น', event.target.value);
        fill(form.querySelector('select.ward'), wards, 'เลือกวอร์ด', '');
      } else if (event.target.matches('select.floor')) {
        fill(form.querySelector('select.ward'), wards, 'เลือกวอร์ด', event.target.value);
      }
    });
    // Sort the AP table by a clicked header; the choice is remembered so it survives the reload after saving.
    const table = document.getElementById('aps');
    const headers = [...table.tHead.rows[0].cells];
    const collator = new Intl.Collator('th', {numeric: true, sensitivity: 'base'});
    function sortBy(column, direction) {
      const body = table.tBodies[0];
      const text = row => row.cells[column].textContent.trim();
      const rows = [...body.rows].sort((a, b) => {
        const x = text(a), y = text(b);
        if (!x !== !y) return x ? -1 : 1;
        return direction * collator.compare(x, y);
      });
      body.append(...rows);
      headers.forEach((th, index) => th.toggleAttribute('aria-sort', false));
      headers[column].setAttribute('aria-sort', direction > 0 ? 'ascending' : 'descending');
      try { localStorage.setItem('apSort', JSON.stringify([column, direction])); } catch {}
    }
    headers.forEach((th, column) => {
      if (!th.classList.contains('sortable')) return;
      th.addEventListener('click', () => sortBy(column, th.getAttribute('aria-sort') === 'ascending' ? -1 : 1));
    });
    try {
      const [column, direction] = JSON.parse(localStorage.getItem('apSort') || 'null') || [];
      if (headers[column]?.classList.contains('sortable')) sortBy(column, direction);
    } catch {}
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({block: 'center'});
    </script></html>`;
}

export async function startAdmin() {
  requireConfig('admin.password');
  const pool = createPool();
  const server = http.createServer(async (request, response) => {
    if (!authorized(request)) {
      response.writeHead(401, {'WWW-Authenticate':'Basic realm="Ruckus AP Mapping"'});
      response.end('Authentication required');
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    try {
      let form;
      if (request.method === 'POST') {
        form = await formBody(request);
        const given = form.get('csrf');
        if (typeof given !== 'string' || given.length !== csrfToken.length ||
            !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(csrfToken))) {
          throw new Error('Invalid form token; reload the page');
        }
      }
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
        response.end(await page(pool, url));
      } else if (request.method === 'POST' && url.pathname === '/building') {
        if (!form.get('code')?.trim() || !form.get('name')?.trim()) throw new Error('Code and name required');
        await pool.execute('INSERT INTO buildings (code,name) VALUES (?,?)', [form.get('code').trim(), form.get('name').trim()]);
        response.writeHead(303, {Location:'/'}); response.end();
      } else if (request.method === 'POST' && url.pathname === '/floor') {
        const buildingId = Number(form.get('building_id'));
        if (!Number.isSafeInteger(buildingId) || !form.get('code')?.trim() || !form.get('name')?.trim()) throw new Error('Building, code and name required');
        const level = form.get('level_no')?.trim();
        await pool.execute('INSERT INTO floors (building_id,code,name,level_no) VALUES (?,?,?,?)',
          [buildingId, form.get('code').trim(), form.get('name').trim(), level ? Number(level) : null]);
        response.writeHead(303, {Location:'/'}); response.end();
      } else if (request.method === 'POST' && url.pathname === '/ward') {
        const floorId = Number(form.get('floor_id'));
        if (!Number.isSafeInteger(floorId) || !form.get('code')?.trim() || !form.get('name')?.trim()) throw new Error('Floor, code and name required');
        await pool.execute('INSERT INTO wards (floor_id,code,name) VALUES (?,?,?)', [floorId, form.get('code').trim(), form.get('name').trim()]);
        response.writeHead(303, {Location:'/'}); response.end();
      } else if (request.method === 'POST' && url.pathname === '/map') {
        await mapAp(pool, form);
        // Return to the same filtered list, scrolled to the AP that was just saved.
        response.writeHead(303, {Location:`/${url.search}#ap-${encodeURIComponent(form.get('ap_mac'))}`}); response.end();
      } else {
        response.writeHead(404); response.end('Not found');
      }
    } catch (error) {
      response.writeHead(400, {'Content-Type':'text/plain; charset=utf-8'});
      response.end(error.message);
    }
  });
  server.listen(config.admin.port, config.admin.host, () => console.log(`Admin UI: http://${config.admin.host}:${config.admin.port}`));
}

startAdmin();
