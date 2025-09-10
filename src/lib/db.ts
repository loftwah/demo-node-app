import { Pool, PoolConfig } from 'pg';

export interface DbConfig extends PoolConfig {
  sslMode?: 'required' | 'disable';
}

function getSslConfig(): boolean | object | undefined {
  const mode = process.env.DB_SSL || 'disable';
  if (mode === 'required') {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

export const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ssl: getSslConfig(),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function checkDb(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1 as ok');
    client.release();
    return true;
  } catch (err) {
    return false;
  }
}

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
    await client.query(`
      CREATE TABLE IF NOT EXISTS items (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        value JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    if ((process.env.SEED_DB || '').toLowerCase() === 'true') {
      await client.query(
        `INSERT INTO items (id, name, value) VALUES
         (gen_random_uuid(), 'banana', '{"tasty": true}')
         ON CONFLICT DO NOTHING;`
      );
    }
  } finally {
    client.release();
  }
}

export interface Item {
  id: string;
  name: string;
  value: any;
  created_at: string;
}

export async function listItems(): Promise<Item[]> {
  const { rows } = await pool.query(
    'SELECT id, name, value, created_at FROM items ORDER BY created_at DESC'
  );
  return rows;
}

export async function getItem(id: string): Promise<Item | null> {
  const { rows } = await pool.query('SELECT id, name, value, created_at FROM items WHERE id = $1', [
    id,
  ]);
  return rows[0] || null;
}

export async function createItem(id: string, name: string, value: any): Promise<Item> {
  const { rows } = await pool.query(
    'INSERT INTO items (id, name, value) VALUES ($1, $2, $3) RETURNING id, name, value, created_at',
    [id, name, value]
  );
  return rows[0];
}

export async function updateItem(id: string, name: string, value: any): Promise<Item | null> {
  const { rows } = await pool.query(
    'UPDATE items SET name=$2, value=$3 WHERE id=$1 RETURNING id, name, value, created_at',
    [id, name, value]
  );
  return rows[0] || null;
}

export async function deleteItem(id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM items WHERE id=$1', [id]);
  return (rowCount ?? 0) > 0;
}
