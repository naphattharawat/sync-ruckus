CREATE TABLE IF NOT EXISTS buildings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS floors (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  building_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  level_no DECIMAL(6,2) NULL,
  UNIQUE KEY uq_floor_building_code (building_id, code),
  CONSTRAINT fk_floor_building FOREIGN KEY (building_id) REFERENCES buildings(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wards (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  floor_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  UNIQUE KEY uq_ward_floor_code (floor_id, code),
  CONSTRAINT fk_ward_floor FOREIGN KEY (floor_id) REFERENCES floors(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS access_points (
  ap_mac CHAR(17) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL PRIMARY KEY,
  device_name VARCHAR(160) NULL,
  description TEXT NULL,
  api_status VARCHAR(40) NULL,
  model VARCHAR(80) NULL,
  zone_id VARCHAR(80) NULL,
  ap_group_id VARCHAR(80) NULL,
  indoor_map_id VARCHAR(80) NULL,
  indoor_map_x DOUBLE NULL,
  indoor_map_y DOUBLE NULL,
  source_present BOOLEAN NOT NULL DEFAULT TRUE,
  first_synced_at DATETIME(3) NOT NULL,
  last_synced_at DATETIME(3) NOT NULL,
  building_id BIGINT UNSIGNED NULL,
  floor_id BIGINT UNSIGNED NULL,
  ward_id BIGINT UNSIGNED NULL,
  map_x DOUBLE NULL,
  map_y DOUBLE NULL,
  mapped_by VARCHAR(160) NULL,
  mapped_at DATETIME(3) NULL,
  KEY ix_ap_mapping (building_id, floor_id),
  KEY ix_ap_sync (last_synced_at),
  CONSTRAINT fk_ap_building FOREIGN KEY (building_id) REFERENCES buildings(id),
  CONSTRAINT fk_ap_floor FOREIGN KEY (floor_id) REFERENCES floors(id),
  CONSTRAINT fk_ap_ward FOREIGN KEY (ward_id) REFERENCES wards(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ap_mapping_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ap_mac CHAR(17) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  building_id BIGINT UNSIGNED NOT NULL,
  floor_id BIGINT UNSIGNED NOT NULL,
  ward_id BIGINT UNSIGNED NULL,
  map_x DOUBLE NULL,
  map_y DOUBLE NULL,
  valid_from DATETIME(3) NOT NULL,
  valid_to DATETIME(3) NULL,
  mapped_by VARCHAR(160) NOT NULL,
  KEY ix_mapping_history_ap_time (ap_mac, valid_from, valid_to),
  CONSTRAINT fk_mapping_history_ap FOREIGN KEY (ap_mac) REFERENCES access_points(ap_mac),
  CONSTRAINT fk_mapping_history_building FOREIGN KEY (building_id) REFERENCES buildings(id),
  CONSTRAINT fk_mapping_history_floor FOREIGN KEY (floor_id) REFERENCES floors(id),
  CONSTRAINT fk_mapping_history_ward FOREIGN KEY (ward_id) REFERENCES wards(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS client_visits (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_mac CHAR(17) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  username VARCHAR(255) NULL,
  ssid VARCHAR(160) NOT NULL,
  building_id BIGINT UNSIGNED NULL,
  floor_id BIGINT UNSIGNED NULL,
  ward_id BIGINT UNSIGNED NULL,
  first_ap_mac CHAR(17) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  last_ap_mac CHAR(17) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  session_start_at DATETIME(3) NULL,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  KEY ix_visit_client_time (client_mac, first_seen_at),
  KEY ix_visit_retention (ended_at),
  KEY ix_visit_location_time (building_id, floor_id, last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS client_ap_visits (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_mac CHAR(17) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  open_client_mac CHAR(17) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  username VARCHAR(255) NULL,
  ssid VARCHAR(160) NOT NULL,
  ap_mac CHAR(17) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  bssid CHAR(17) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  building_id BIGINT UNSIGNED NULL,
  floor_id BIGINT UNSIGNED NULL,
  ward_id BIGINT UNSIGNED NULL,
  session_start_at DATETIME(3) NULL,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  first_rssi SMALLINT NULL,
  last_rssi SMALLINT NULL,
  sample_count INT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_ap_visit_open_client (open_client_mac),
  KEY ix_ap_visit_client_time (client_mac, first_seen_at),
  KEY ix_ap_visit_ap_time (ap_mac, first_seen_at),
  KEY ix_ap_visit_retention (ended_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Completed controller sessions preserve associations shorter than one polling interval.
CREATE TABLE IF NOT EXISTS client_ap_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_mac CHAR(17) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  ssid VARCHAR(160) NOT NULL,
  ap_mac CHAR(17) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  session_start_at DATETIME(3) NOT NULL,
  session_end_at DATETIME(3) NOT NULL,
  building_id BIGINT UNSIGNED NULL,
  floor_id BIGINT UNSIGNED NULL,
  ward_id BIGINT UNSIGNED NULL,
  first_synced_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_ap_session (client_mac, ap_mac, ssid, session_start_at, session_end_at),
  KEY ix_session_client_time (client_mac, session_start_at),
  KEY ix_session_end (session_end_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS client_current (
  client_mac CHAR(17) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL PRIMARY KEY,
  username VARCHAR(255) NULL,
  ssid VARCHAR(160) NOT NULL,
  ap_mac CHAR(17) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  bssid CHAR(17) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  building_id BIGINT UNSIGNED NULL,
  floor_id BIGINT UNSIGNED NULL,
  ward_id BIGINT UNSIGNED NULL,
  session_start_at DATETIME(3) NULL,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  online BOOLEAN NOT NULL DEFAULT TRUE,
  active_visit_id BIGINT UNSIGNED NULL,
  rssi SMALLINT NULL,
  KEY ix_current_online_location (online, building_id, floor_id),
  KEY ix_current_last_seen (last_seen_at),
  CONSTRAINT fk_current_visit FOREIGN KEY (active_visit_id) REFERENCES client_visits(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sync_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('aps','clients') NOT NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  status ENUM('running','success','failed') NOT NULL,
  item_count INT UNSIGNED NULL,
  error_message TEXT NULL,
  KEY ix_sync_kind_time (kind, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
