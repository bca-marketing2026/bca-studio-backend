require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'bca-secret-2026';

// ── Database ──────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// ── Auth middleware ───────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── DB Init ───────────────────────────────────────────────────
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(200) NOT NULL,
      role VARCHAR(20) DEFAULT 'filmmaker',
      brand_id VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS brands (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      handle VARCHAR(100),
      color VARCHAR(20) DEFAULT '#5B7FA6',
      industry VARCHAR(100),
      logo_url VARCHAR(500),
      client_email VARCHAR(100),
      client_name VARCHAR(100),
      phone VARCHAR(50),
      notes TEXT,
      metricool_api_key VARCHAR(200),
      metricool_user_id VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS posts (
      id VARCHAR(50) PRIMARY KEY,
      num INTEGER,
      title VARCHAR(200),
      copy TEXT,
      date VARCHAR(20),
      time VARCHAR(10),
      status VARCHAR(30) DEFAULT 'draft',
      platform TEXT[],
      format VARCHAR(50),
      cover TEXT,
      thumbnail TEXT,
      brand_id VARCHAR(50) REFERENCES brands(id),
      comments JSONB DEFAULT '[]',
      preprod JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS library (
      id VARCHAR(50) PRIMARY KEY,
      title VARCHAR(200),
      cover TEXT,
      type VARCHAR(20),
      format VARCHAR(50),
      platform TEXT[],
      brand_id VARCHAR(50) REFERENCES brands(id),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Seed default admin if no users exist
  const { rows } = await db.query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count) === 0) {
    const hash = await bcrypt.hash('bca2026', 10);
    await db.query(
      `INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4)`,
      ['Sofia Serrano', 'sserrano@mktbca.com', hash, 'admin']
    );
    const filmHash = await bcrypt.hash('film2026', 10);
    await db.query(
      `INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4)`,
      ['Filmmaker BCA', 'film@mktbca.com', filmHash, 'filmmaker']
    );

    // Seed brands
    await db.query(
      `INSERT INTO brands (id, name, handle, color, industry) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      ['leku', 'Leku Restaurant', 'lekurestaurant', '#7B6F64', 'Restaurante']
    );
    await db.query(
      `INSERT INTO brands (id, name, handle, color, industry) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      ['bca', 'BCA Agency', 'bcamarketing', '#5B7FA6', 'Agencia']
    );

    console.log('✓ Default users and brands seeded');
  }

  console.log('✓ Database initialized');
}

// ── Auth Routes ───────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, brand_id: user.brand_id, name: user.name },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, brand: user.brand_id } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Users Routes ──────────────────────────────────────────────
app.get('/api/users', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { rows } = await db.query('SELECT id, name, email, role, brand_id FROM users ORDER BY id');
  res.json(rows);
});

app.post('/api/users', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { name, email, password, role, brand_id } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await db.query(
    'INSERT INTO users (name, email, password, role, brand_id) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,email,role,brand_id',
    [name, email, hash, role, brand_id || null]
  );
  res.json(rows[0]);
});

app.delete('/api/users/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ── Brands Routes ─────────────────────────────────────────────
app.get('/api/brands', auth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM brands ORDER BY name');
  res.json(rows);
});

app.post('/api/brands', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { id, name, handle, color, industry, logo_url, client_email, client_name, phone, notes } = req.body;
  const brandId = id || name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const { rows } = await db.query(
    `INSERT INTO brands (id,name,handle,color,industry,logo_url,client_email,client_name,phone,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET name=$2,handle=$3,color=$4,industry=$5,logo_url=$6,client_email=$7,client_name=$8,phone=$9,notes=$10
     RETURNING *`,
    [brandId, name, handle, color, industry, logo_url, client_email, client_name, phone, notes]
  );
  res.json(rows[0]);
});

app.put('/api/brands/:id/metricool', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { api_key, user_id } = req.body;
  const { rows } = await db.query(
    'UPDATE brands SET metricool_api_key=$1, metricool_user_id=$2 WHERE id=$3 RETURNING *',
    [api_key, user_id, req.params.id]
  );
  res.json(rows[0]);
});

// ── Posts Routes ──────────────────────────────────────────────
app.get('/api/posts', auth, async (req, res) => {
  const { brand_id } = req.query;
  let query = 'SELECT * FROM posts WHERE 1=1';
  const params = [];
  if (brand_id) { params.push(brand_id); query += ` AND brand_id = $${params.length}`; }
  if (req.user.role === 'client') {
    params.push(req.user.brand_id);
    query += ` AND brand_id = $${params.length} AND status IN ('review','ajustes','aprobado','scheduled','published')`;
  }
  query += ' ORDER BY created_at DESC';
  const { rows } = await db.query(query, params);
  res.json(rows);
});

app.post('/api/posts', auth, async (req, res) => {
  const p = req.body;
  const { rows } = await db.query(
    `INSERT INTO posts (id,num,title,copy,date,time,status,platform,format,cover,thumbnail,brand_id,comments,preprod)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [p.id, p.num, p.title, p.copy, p.date, p.time, p.status, p.platform, p.format,
     p.cover, p.thumbnail, p.brand, JSON.stringify(p.comments||[]), JSON.stringify(p.preprod||{})]
  );
  res.json(rows[0]);
});

app.put('/api/posts/:id', auth, async (req, res) => {
  const p = req.body;
  const { rows } = await db.query(
    `UPDATE posts SET title=$1,copy=$2,date=$3,time=$4,status=$5,platform=$6,format=$7,
     cover=$8,thumbnail=$9,comments=$10,preprod=$11,updated_at=NOW()
     WHERE id=$12 RETURNING *`,
    [p.title, p.copy, p.date, p.time, p.status, p.platform, p.format,
     p.cover, p.thumbnail, JSON.stringify(p.comments||[]), JSON.stringify(p.preprod||{}), req.params.id]
  );
  res.json(rows[0]);
});

app.delete('/api/posts/:id', auth, async (req, res) => {
  await db.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ── Library Routes ────────────────────────────────────────────
app.get('/api/library', auth, async (req, res) => {
  const { brand_id } = req.query;
  const params = brand_id ? [brand_id] : [];
  const query = brand_id
    ? 'SELECT * FROM library WHERE brand_id = $1 ORDER BY created_at DESC'
    : 'SELECT * FROM library ORDER BY created_at DESC';
  const { rows } = await db.query(query, params);
  res.json(rows);
});

app.post('/api/library', auth, async (req, res) => {
  const a = req.body;
  const { rows } = await db.query(
    'INSERT INTO library (id,title,cover,type,format,platform,brand_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [a.id, a.title, a.cover, a.type, a.format, a.platform, a.brand]
  );
  res.json(rows[0]);
});

app.delete('/api/library/:id', auth, async (req, res) => {
  await db.query('DELETE FROM library WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ── Metricool Routes ──────────────────────────────────────────
async function getMetricoolKeys(brandId) {
  const { rows } = await db.query(
    'SELECT metricool_api_key, metricool_user_id FROM brands WHERE id = $1',
    [brandId]
  );
  return rows[0] || {};
}

// Test Metricool connection
app.post('/api/metricool/test', auth, async (req, res) => {
  const { brand_id } = req.body;
  const keys = await getMetricoolKeys(brand_id);
  if (!keys.metricool_api_key || !keys.metricool_user_id) {
    return res.status(400).json({ ok: false, msg: 'API Key o User ID no configurados' });
  }
  try {
    const r = await fetch(
      `https://app.metricool.com/api/admin/simpleProfiles?userId=${keys.metricool_user_id}&blogId=${keys.metricool_user_id}`,
      { headers: { 'X-Mc-Auth': keys.metricool_api_key } }
    );
    if (r.ok) {
      res.json({ ok: true, msg: 'Conexion exitosa con Metricool' });
    } else {
      res.json({ ok: false, msg: `Error ${r.status}: verifica tu API Key y User ID` });
    }
  } catch (err) {
    res.json({ ok: false, msg: 'No se pudo conectar con Metricool: ' + err.message });
  }
});

// Sync stats from Metricool
app.post('/api/metricool/stats', auth, async (req, res) => {
  const { brand_id } = req.body;
  const keys = await getMetricoolKeys(brand_id);
  if (!keys.metricool_api_key || !keys.metricool_user_id) {
    return res.status(400).json({ ok: false, msg: 'API Key o User ID no configurados' });
  }
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const end = now.toISOString().slice(0, 10);
  try {
    const r = await fetch(
      `https://app.metricool.com/api/v2/analytics/bestTime?userId=${keys.metricool_user_id}&blogId=${keys.metricool_user_id}&startDate=${start}&endDate=${end}`,
      { headers: { 'X-Mc-Auth': keys.metricool_api_key } }
    );
    const data = await r.json();
    res.json({ ok: true, data, msg: 'Estadisticas sincronizadas' });
  } catch (err) {
    res.json({ ok: false, msg: 'Error al sincronizar: ' + err.message });
  }
});

// Schedule post in Metricool — called automatically when post is approved
app.post('/api/metricool/schedule', auth, async (req, res) => {
  const { brand_id, post_id } = req.body;
  const keys = await getMetricoolKeys(brand_id);
  if (!keys.metricool_api_key || !keys.metricool_user_id) {
    return res.status(400).json({ ok: false, msg: 'API Key o User ID no configurados para esta marca' });
  }

  // Get post
  const { rows } = await db.query('SELECT * FROM posts WHERE id = $1', [post_id]);
  if (!rows.length) return res.status(404).json({ error: 'Post not found' });
  const post = rows[0];

  const netMap = { IG: 'INSTAGRAM', FB: 'FACEBOOK', TK: 'TIKTOK', LI: 'LINKEDIN', YT: 'YOUTUBE' };
  const networks = (post.platform || []).map(pl => ({
    network: netMap[pl],
    text: post.copy || '',
    publicationDate: {
      dateTime: `${post.date}T${post.time || '12:00'}:00`,
      timezone: 'America/Guayaquil'
    }
  })).filter(n => n.network);

  try {
    const r = await fetch(
      `https://app.metricool.com/api/v2/scheduler/posts?userId=${keys.metricool_user_id}&blogId=${keys.metricool_user_id}`,
      {
        method: 'POST',
        headers: { 'X-Mc-Auth': keys.metricool_api_key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ networks })
      }
    );
    const data = await r.json();
    if (data.id || data.success) {
      // Update post status to scheduled
      await db.query("UPDATE posts SET status='scheduled' WHERE id=$1", [post_id]);
      res.json({ ok: true, msg: 'Publicacion programada en Metricool', data });
    } else {
      res.json({ ok: false, msg: data.message || 'Error al programar en Metricool', data });
    }
  } catch (err) {
    res.json({ ok: false, msg: 'Error: ' + err.message });
  }
});

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ── Start ─────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`BCA Studio API running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
