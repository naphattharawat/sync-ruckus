# Ruckus Wi-Fi location collector

เก็บข้อมูล AP และอุปกรณ์ที่เชื่อมต่อ SSID `ABH`, `ABH-Paperless`, `ABH-iot` จาก Ruckus Virtual SmartZone ลง MySQL เพื่อใช้แสดงตำแหน่งตามตึก/ชั้นในอนาคต

## ข้อมูลที่บันทึก

- `access_points`: AP MAC, ชื่อ, description, สถานะ และข้อมูลจาก API พร้อมตึก/ชั้นและพิกัดที่ admin กำหนดเอง การซิงก์ AP ไม่ทับค่าที่ admin กำหนด
- `client_current`: client MAC, username, SSID, AP MAC, ตึก/ชั้น, เวลาเห็นครั้งแรก, เวลาเห็นล่าสุด, สถานะออนไลน์ และเวลาเริ่ม session ตาม API
- `client_visits`: ช่วงเวลาที่อุปกรณ์อยู่ในตำแหน่งเดียวกัน โดยอัปเดต `last_seen_at` เมื่อยังอยู่ตึก/ชั้นเดิม; ปิดช่วงและสร้างช่วงใหม่เมื่อเปลี่ยนตำแหน่งหรือกลับมาออนไลน์อีกครั้ง
- `client_ap_visits`: ลำดับ AP ที่พบว่าอุปกรณ์เชื่อมต่อ แม้ AP ใหม่จะ map ไปตึก/ชั้น/วอร์ดเดิม การพบเพียงรอบเดียวก็ถูกเก็บเป็นหนึ่งช่วง พร้อมเวลา, SSID, AP MAC, จำนวนรอบที่พบ และ RSSI ครั้งแรก/ล่าสุด
- `ap_mapping_history`: ประวัติการเปลี่ยนตำแหน่ง AP
- `sync_runs`: ผลการดึงแต่ละรอบ เพื่อแยกกรณี API ขัดข้องจากอุปกรณ์ออฟไลน์จริง

เวลาทั้งหมดเก็บเป็น UTC ใน MySQL; ส่วนการแสดงผลควรแปลงเป็น `Asia/Bangkok`.

## ตั้งค่า

ต้องมี Node.js และ MySQL ที่เข้าถึงได้จากเครื่องรันงาน

1. `npm ci`
2. คัดลอก `.env.example` เป็น `.env` แล้วกรอก `DB_PASSWORD`, `RUCKUS_PASSWORD` และ fingerprint ของ TLS certificate ที่ตรวจสอบแล้ว เก็บไฟล์ `.env` เฉพาะเครื่องรันงานและอย่าเพิ่มเข้า Git
3. `npm run db:init` (รันซ้ำเพื่อสร้างตาราง `client_ap_visits` ในฐานข้อมูลเดิมได้)
4. `npm run sync:aps` และ `npm run sync:clients` เพื่อทดสอบรอบแรก
5. รันต่อเนื่องด้วย PM2 ตามหัวข้อถัดไป หรือใช้ `npm run worker` ชั่วคราว

## รันด้วย PM2

เปิด PowerShell ในโฟลเดอร์โปรเจ็กต์แล้วสั่ง:

```powershell
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs ruckus-wifi-location
```

PM2 จะดูแล worker ตัวเดียว ซึ่งดึง client ทุก 1 นาที, AP ทุก 1 ชั่วโมง และลบประวัติที่หมดอายุทุกวัน หากต้องการหยุดหรือเริ่มใหม่:

```powershell
pm2 stop ruckus-wifi-location
pm2 restart ruckus-wifi-location
pm2 delete ruckus-wifi-location
```

รัน `pm2 save` หลังเพิ่มหรือลบ process เพื่อบันทึกรายการที่ต้องกู้คืน บน Windows คำสั่ง `pm2 startup` ใช้ไม่ได้ เครื่องนี้ตั้ง Windows Task Scheduler ชื่อ `RuckusWifiLocationPM2` ให้เรียก `pm2 resurrect` เมื่อบัญชี `User` ล็อกอิน จึงยังต้องล็อกอินหลังรีบูต หากต้องทำงานตั้งแต่ก่อนล็อกอิน ต้องติดตั้งเป็น Windows service ด้วยบัญชีบริการต่างหาก

งาน Windows Task Scheduler ที่เคยสร้างสำหรับ collector ถูกลบแล้ว เพื่อไม่ให้ดึงข้อมูลซ้ำกับ PM2 ตรวจผลซิงก์จริงจาก `sync_runs` ตามตัวอย่างด้านล่าง

หาก Ruckus API ขัดข้อง ระบบลองอีก 5 ครั้งหลังรอ 10, 20, 30, 40, 50 วินาทีตามลำดับ หากยังไม่สำเร็จ รอบนั้นจะเป็น `failed` และจะไม่เปลี่ยน client เป็นออฟไลน์ การซิงก์ client ครั้งใหม่จะเกิดตามรอบถัดไป โดยไม่มีงานชนกันในชนิดเดียวกัน

Client จะถูกตั้งออฟไลน์เมื่อไม่พบอย่างน้อย 6 นาทีในการดึง snapshot ที่สำเร็จ ประวัติช่วงการเข้าใช้งานและข้อมูล current ที่ออฟไลน์เกิน 1 ปีจะถูกลบ

ประวัติราย AP เริ่มนับตั้งแต่เปิดใช้ตารางนี้; ไม่สร้างข้อมูล AP ย้อนหลังจากข้อมูลตำแหน่งที่รวมไว้ เพราะไม่สามารถทราบ AP ระหว่างทางได้จากตารางเดิม การดึงทุก 1 นาทีอาจพลาดการเชื่อม AP ที่เริ่มและจบระหว่างสองรอบ หากต้องเก็บทุกเหตุการณ์สั้นกว่านั้น ต้องรับ association/disassociation events จาก controller เพิ่มเติม

## หน้า admin สำหรับ map AP

เมื่อกำหนด `ADMIN_PASSWORD` ใน `.env` แล้ว ใช้ `npm run admin` และเปิด `http://127.0.0.1:8080` บนเครื่องที่รันโปรแกรม เข้าระบบด้วยชื่อผู้ใช้ `admin` และรหัสผ่านที่ตั้งไว้ จากนั้นสร้างตึก/ชั้น/วอร์ด และกำหนดให้ AP ตาม MAC แต่ละตัว (เลือกตึก → ชั้น → วอร์ด; วอร์ดเว้นได้หากชั้นนั้นไม่มีวอร์ด) พิกัด X/Y เป็นตัวเลือกสำหรับแผนภาพในอนาคต

ฐานข้อมูลที่สร้างก่อนมีวอร์ด ให้รัน `npm run db:migrate-wards` ครั้งเดียว (หยุด worker ก่อน) เพื่อแยกรายการเดิมในตาราง `floors` เป็นชั้นจริงและวอร์ด โดยสำรองตารางไว้เป็น `bak_<วันที่>_*`

หน้า admin ฟังเฉพาะ localhost โดยค่าเริ่มต้น หากต้องการให้ผู้ดูแลใช้จากเครื่องอื่น ควรตั้ง HTTPS reverse proxy ที่จำกัดผู้เข้าใช้ก่อนเปิดให้เข้าถึงผ่านเครือข่าย

## ตัวอย่างคำสั่งตรวจสอบ

```sql
SELECT ssid, COUNT(*) AS devices
FROM client_current
WHERE online = TRUE
GROUP BY ssid;

SELECT b.name AS building, f.name AS floor, COUNT(*) AS devices
FROM client_current c
JOIN buildings b ON b.id = c.building_id
JOIN floors f ON f.id = c.floor_id
WHERE c.online = TRUE
GROUP BY b.id, f.id;

SELECT kind, started_at, status, item_count, error_message
FROM sync_runs ORDER BY id DESC LIMIT 20;

SELECT v.first_seen_at, v.last_seen_at, v.sample_count, v.ssid,
       v.ap_mac, a.device_name, v.building_id, v.floor_id, v.ward_id
FROM client_ap_visits v
LEFT JOIN access_points a ON a.ap_mac = v.ap_mac
WHERE v.client_mac = ?
ORDER BY v.first_seen_at;
```
