import fs from 'node:fs';
import mysql from 'mysql2/promise';
import {config, requireConfig} from './config.mjs';

export function createPool() {
  requireConfig('db.password');
  return mysql.createPool(config.db);
}

export async function initSchema() {
  requireConfig('db.password');
  const connection = await mysql.createConnection({...config.db, multipleStatements: true});
  try {
    await connection.query(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  } finally {
    await connection.end();
  }
}

export async function withTransaction(pool, fn) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
