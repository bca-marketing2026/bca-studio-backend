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

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ── Security headers ──────────────────────────────────────────
app.use(function(req,res,next){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('X-XSS-Protection','1; mode=block');
  res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  next();
});

// ── Rate limiting ─────────────────────────────────────────────
var loginAttempts={};
app.use(function(req,res,next){
  if(req.path==='/api/auth/login'&&req.method==='POST'){
    var ip=req.ip||'unknown';
    var now=Date.now();
    if(!loginAttempts[ip])loginAttempts[ip]={count:0,reset:now+60000};
    if(now>loginAttempts[ip].reset)loginAttempts[ip]={count:0,reset:now+60000};
    loginAttempts[ip].count++;
    if(loginAttempts[ip].count>10)return res.status(429).json({error:'Demasiados intentos. Espera 1 minuto.'});
  }
  next();
});

// ── Auth middleware ───────────────────────────────────────────
function auth(req,res,next){
  var token=(req.headers.authorization||'').split(' ')[1];
  if(!token)return res.status(401).json({error:'No token'});
  try{req.user=jwt.verify(token,JWT_SECRET);next();}
  catch{res.status(401).json({error:'Invalid token'});}
}

// ── DB Init ───────────────────────────────────────────────────
async function initDB(){
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(200) NOT NULL,
      role VARCHAR(20) DEFAULT 'filmmaker',
      brand_id VARCHAR(50),
      allowed_brands TEXT[] DEFAULT '{}',
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
      metricool_blog_id VARCHAR(50),
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
    CREATE TABLE IF NOT EXISTS analytics_cache (
      id SERIAL PRIMARY KEY,
      brand_id VARCHAR(50),
      data JSONB,
      fetched_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_brands TEXT[] DEFAULT '{}'`);
  await db.query(`ALTER TABLE brands ADD COLUMN IF NOT EXISTS metricool_blog_id VARCHAR(50)`);

  const{rows}=await db.query('SELECT COUNT(*) FROM users');
  if(parseInt(rows[0].count)===0){
    const h=await bcrypt.hash('bca2026',10);
    await db.query('INSERT INTO users (name,email,password,role) VALUES ($1,$2,$3,$4)',['Sofia Serrano','sserrano@mktbca.com',h,'admin']);
    const fh=await bcrypt.hash('film2026',10);
    await db.query('INSERT INTO users (name,email,password,role) VALUES ($1,$2,$3,$4)',['Filmmaker BCA','film@mktbca.com',fh,'filmmaker']);
    await db.query('INSERT INTO brands (id,name,handle,color,industry) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',['leku','Leku Restaurant','lekurestaurant','#7B6F64','Restaurante']);
    await db.query('INSERT INTO brands (id,name,handle,color,industry) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',['bca','BCA Agency','bcamarketing','#5B7FA6','Agencia']);
  }
  console.log('DB ready');
}

// ── Metricool helpers ─────────────────────────────────────────
async function getKeys(brandId){
  const{rows}=await db.query('SELECT metricool_api_key,metricool_user_id,metricool_blog_id FROM brands WHERE id=$1',[brandId]);
  return rows[0]||{};
}

// Import brands from Metricool - called on schedule and on demand
async function syncBrandsFromMetricool(){
  try{
    // Get all brands that have Metricool configured
    const{rows:brandsWithKeys}=await db.query("SELECT * FROM brands WHERE metricool_api_key IS NOT NULL AND metricool_api_key != ''");
    if(!brandsWithKeys.length)return{synced:0};

    // Use the first configured brand's credentials to fetch all blogs
    const masterBrand=brandsWithKeys[0];
    const apiKey=masterBrand.metricool_api_key;
    const userId=masterBrand.metricool_user_id;

    const r=await fetch(`https://app.metricool.com/api/admin/simpleProfiles?userId=${userId}&blogId=${masterBrand.metricool_blog_id||userId}`,{headers:{'X-Mc-Auth':apiKey}});
    if(!r.ok)return{synced:0,error:`Metricool error ${r.status}`};

    const data=await r.json();
    console.log('Metricool sync RAW:', JSON.stringify(data).slice(0,500));

    let profiles=[];
    // Try every known structure
    if(Array.isArray(data)) profiles=data;
    else if(data.data&&Array.isArray(data.data)) profiles=data.data;
    else if(data.blogs&&Array.isArray(data.blogs)) profiles=data.blogs;
    else if(data.profiles&&Array.isArray(data.profiles)) profiles=data.profiles;
    else if(data.result&&Array.isArray(data.result)) profiles=data.result;
    else if(data.items&&Array.isArray(data.items)) profiles=data.items;
    else{
      // Try to find any array in the response
      for(const key of Object.keys(data)){
        if(Array.isArray(data[key])&&data[key].length>0){ profiles=data[key]; break; }
      }
      if(!profiles.length){
        console.log('Unknown Metricool structure, keys:', Object.keys(data));
        // If data itself looks like a single profile, wrap it
        if(data.id||data.blogId||data.name) profiles=[data];
        else return{synced:0,raw:data,msg:'Ver logs de Railway para debug'};
      }
    }

    let synced=0;
    for(const p of profiles){
      const blogId=(p.id||p.blogId||p.blog_id||'').toString();
      // Metricool uses "label" as the brand name
      const name=p.label||p.name||p.blogName||p.blog_name||p.title||'Marca '+blogId;
      // Build a clean handle from the name
      const rawHandle=p.handle||p.username||p.screen_name||name;
      const handle=rawHandle.toLowerCase().replace(/[^a-z0-9_-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,50);
      // Use blogId as the brand ID so it matches Metricool
      const brandId='mc-'+blogId;
      if(!blogId||!name)continue;
      const colors=['#7B6F64','#5B7FA6','#6B8E73','#8E6B7F','#7F8E6B','#6B7F8E'];
      const color=colors[synced%colors.length];
      try{
        await db.query(
          `INSERT INTO brands (id,name,handle,color,metricool_api_key,metricool_user_id,metricool_blog_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO UPDATE SET name=$2,handle=$3,metricool_api_key=$5,metricool_user_id=$6,metricool_blog_id=$7`,
          [brandId,name,handle,color,apiKey,userId,blogId]
        );
        synced++;
      }catch(e){console.error('Brand sync error:',e.message);}
    }
    console.log(`Synced ${synced} brands from Metricool`);
    return{synced,total:profiles.length};
  }catch(e){console.error('Metricool sync error:',e.message);return{synced:0,error:e.message};}
}

// ── Auto-sync every hour ──────────────────────────────────────
setInterval(function(){
  console.log('Auto-syncing brands from Metricool...');
  syncBrandsFromMetricool();
},60*60*1000);

// ── Auth ──────────────────────────────────────────────────────
app.post('/api/auth/login',async(req,res)=>{
  const{email,password}=req.body;
  if(!email||!password)return res.status(400).json({error:'Email y contrasena requeridos'});
  try{
    const{rows}=await db.query('SELECT * FROM users WHERE email=$1',[email.toLowerCase().trim()]);
    if(!rows.length)return res.status(401).json({error:'Credenciales incorrectas'});
    const u=rows[0];
    if(!await bcrypt.compare(password,u.password))return res.status(401).json({error:'Credenciales incorrectas'});
    const token=jwt.sign({id:u.id,email:u.email,role:u.role,brand_id:u.brand_id,name:u.name,allowed_brands:u.allowed_brands||[]},JWT_SECRET,{expiresIn:'7d'});
    res.json({token,user:{id:u.id,name:u.name,email:u.email,role:u.role,brand:u.brand_id,allowed_brands:u.allowed_brands||[]}});
  }catch(e){res.status(500).json({error:'Error del servidor'});}
});

// ── Users ─────────────────────────────────────────────────────
app.get('/api/users',auth,async(req,res)=>{
  if(req.user.role!=='admin')return res.status(403).json({error:'Sin permiso'});
  const{rows}=await db.query('SELECT id,name,email,role,brand_id,allowed_brands FROM users ORDER BY id');
  res.json(rows);
});
app.post('/api/users',auth,async(req,res)=>{
  if(req.user.role!=='admin')return res.status(403).json({error:'Sin permiso'});
  const{name,email,password,role,brand_id,allowed_brands}=req.body;
  if(!name||!email||!password)return res.status(400).json({error:'Campos requeridos'});
  const hash=await bcrypt.hash(password,10);
  const brands=allowed_brands||(brand_id?[brand_id]:[]);
  const{rows}=await db.query('INSERT INTO users (name,email,password,role,brand_id,allowed_brands) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,brand_id,allowed_brands',[name,email.toLowerCase().trim(),hash,role,brand_id||null,brands]);
  res.json(rows[0]);
});
app.put('/api/users/:id',auth,async(req,res)=>{
  if(req.user.role!=='admin')return res.status(403).json({error:'Sin permiso'});
  const{name,email,role,brand_id,allowed_brands,password}=req.body;
  const brands=allowed_brands||(brand_id?[brand_id]:[]);
  if(password&&password.trim()){
    const hash=await bcrypt.hash(password,10);
    const{rows}=await db.query('UPDATE users SET name=$1,email=$2,role=$3,brand_id=$4,allowed_brands=$5,password=$6 WHERE id=$7 RETURNING id,name,email,role,brand_id,allowed_brands',[name,email,role,brand_id||null,brands,hash,req.params.id]);
    return res.json(rows[0]);
  }
  const{rows}=await db.query('UPDATE users SET name=$1,email=$2,role=$3,brand_id=$4,allowed_brands=$5 WHERE id=$6 RETURNING id,name,email,role,brand_id,allowed_brands',[name,email,role,brand_id||null,brands,req.params.id]);
  res.json(rows[0]);
});
app.delete('/api/users/:id',auth,async(req,res)=>{
  if(req.user.role!=='admin')return res.status(403).json({error:'Sin permiso'});
  if(parseInt(req.params.id)===req.user.id)return res.status(400).json({error:'No puedes eliminarte'});
  await db.query('DELETE FROM users WHERE id=$1',[req.params.id]);
  res.json({ok:true});
});

// ── Brands ────────────────────────────────────────────────────
app.get('/api/brands',auth,async(req,res)=>{
  let rows;
  if(req.user.role==='admin'){({rows}=await db.query('SELECT * FROM brands ORDER BY name'));}
  else if(req.user.role==='client'){({rows}=await db.query('SELECT * FROM brands WHERE id=$1',[req.user.brand_id]));}
  else{
    const allowed=req.user.allowed_brands||[];
    if(!allowed.length){({rows}=await db.query('SELECT * FROM brands ORDER BY name'));}
    else{({rows}=await db.query('SELECT * FROM brands WHERE id=ANY($1) ORDER BY name',[allowed]));}
  }
  res.json(rows);
});
app.post('/api/brands',auth,async(req,res)=>{
  if(req.user.role!=='admin')return res.status(403).json({error:'Sin permiso'});
  const{id,name,handle,color,industry,logo_url,client_email,client_name,phone,notes}=req.body;
  const brandId=id||name.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
  const{rows}=await db.query(`INSERT INTO brands (id,name,handle,color,industry,logo_url,client_email,client_name,phone,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET name=$2,handle=$3,color=$4,industry=$5,logo_url=$6,client_email=$7,client_name=$8,phone=$9,notes=$10 RETURNING *`,[brandId,name,handle,color,industry,logo_url,client_email,client_name,phone,notes]);
  res.json(rows[0]);
});
app.put('/api/brands/:id/metricool',auth,async(req,res)=>{
  if(req.user.role!=='admin')return res.status(403).json({error:'Sin permiso'});
  const{api_key,user_id}=req.body;
  const{rows}=await db.query('UPDATE brands SET metricool_api_key=$1,metricool_user_id=$2 WHERE id=$3 RETURNING *',[api_key,user_id,req.params.id]);
  res.json(rows[0]);
});

// ── Posts ─────────────────────────────────────────────────────
app.get('/api/posts',auth,async(req,res)=>{
  const{brand_id}=req.query;
  let query='SELECT * FROM posts WHERE 1=1';
  const params=[];
  if(brand_id){params.push(brand_id);query+=` AND brand_id=$${params.length}`;}
  if(req.user.role==='client'){params.push(req.user.brand_id);query+=` AND brand_id=$${params.length} AND status IN ('review','ajustes','aprobado','scheduled','published')`;}
  query+=' ORDER BY created_at DESC';
  const{rows}=await db.query(query,params);
  res.json(rows);
});
app.post('/api/posts',auth,async(req,res)=>{
  const p=req.body;
  const id=p.id||Math.random().toString(36).slice(2,10);
  const{rows}=await db.query('INSERT INTO posts (id,num,title,copy,date,time,status,platform,format,cover,thumbnail,brand_id,comments,preprod) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',[id,p.num,p.title,p.copy,p.date,p.time,p.status||'draft',p.platform,p.format,p.cover,p.thumbnail,p.brand_id||p.brand,JSON.stringify(p.comments||[]),JSON.stringify(p.preprod||{})]);
  res.json(rows[0]);
});
app.put('/api/posts/:id',auth,async(req,res)=>{
  const p=req.body;
  const{rows}=await db.query('UPDATE posts SET title=$1,copy=$2,date=$3,time=$4,status=$5,platform=$6,format=$7,cover=$8,thumbnail=$9,comments=$10,preprod=$11,updated_at=NOW() WHERE id=$12 RETURNING *',[p.title,p.copy,p.date,p.time,p.status,p.platform,p.format,p.cover,p.thumbnail,JSON.stringify(p.comments||[]),JSON.stringify(p.preprod||{}),req.params.id]);
  res.json(rows[0]);
});
app.delete('/api/posts/:id',auth,async(req,res)=>{
  await db.query('DELETE FROM posts WHERE id=$1',[req.params.id]);
  res.json({ok:true});
});

// ── Library ───────────────────────────────────────────────────
app.get('/api/library',auth,async(req,res)=>{
  const{brand_id}=req.query;
  const q=brand_id?'SELECT * FROM library WHERE brand_id=$1 ORDER BY created_at DESC':'SELECT * FROM library ORDER BY created_at DESC';
  const{rows}=await db.query(q,brand_id?[brand_id]:[]);
  res.json(rows);
});
app.post('/api/library',auth,async(req,res)=>{
  const a=req.body;
  const{rows}=await db.query('INSERT INTO library (id,title,cover,type,format,platform,brand_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',[a.id,a.title,a.cover,a.type,a.format,a.platform,a.brand_id||a.brand]);
  res.json(rows[0]);
});
app.delete('/api/library/:id',auth,async(req,res)=>{
  await db.query('DELETE FROM library WHERE id=$1',[req.params.id]);
  res.json({ok:true});
});

// ── Metricool ─────────────────────────────────────────────────
app.post('/api/metricool/test',auth,async(req,res)=>{
  const k=await getKeys(req.body.brand_id);
  if(!k.metricool_api_key||!k.metricool_user_id)return res.json({ok:false,msg:'API Key o User ID no configurados'});
  try{
    const r=await fetch(`https://app.metricool.com/api/admin/simpleProfiles?userId=${k.metricool_user_id}&blogId=${k.metricool_user_id}`,{headers:{'X-Mc-Auth':k.metricool_api_key}});
    res.json(r.ok?{ok:true,msg:'Conexion exitosa con Metricool'}:{ok:false,msg:`Error ${r.status}`});
  }catch(e){res.json({ok:false,msg:e.message});}
});

app.post('/api/metricool/sync-brands',auth,async(req,res)=>{
  if(req.user.role!=='admin')return res.status(403).json({error:'Sin permiso'});
  // If api_key passed directly, save it first then sync
  const{brand_id,api_key,user_id}=req.body;
  if(api_key&&user_id&&brand_id){
    await db.query('UPDATE brands SET metricool_api_key=$1,metricool_user_id=$2 WHERE id=$3',[api_key,user_id,brand_id]);
  }
  const result=await syncBrandsFromMetricool();
  res.json({ok:true,...result});
});

app.post('/api/metricool/schedule',auth,async(req,res)=>{
  const{brand_id,post_id}=req.body;
  const k=await getKeys(brand_id);
  if(!k.metricool_api_key)return res.json({ok:false,msg:'API Key no configurada'});
  const{rows}=await db.query('SELECT * FROM posts WHERE id=$1',[post_id]);
  if(!rows.length)return res.status(404).json({error:'Post no encontrado'});
  const post=rows[0];
  const netMap={IG:'INSTAGRAM',FB:'FACEBOOK',TK:'TIKTOK',LI:'LINKEDIN',YT:'YOUTUBE'};
  const networks=(post.platform||[]).map(pl=>({network:netMap[pl],text:post.copy||'',publicationDate:{dateTime:`${post.date}T${post.time||'12:00'}:00`,timezone:'America/Guayaquil'}})).filter(n=>n.network);
  try{
    const r=await fetch(`https://app.metricool.com/api/v2/scheduler/posts?userId=${k.metricool_user_id}&blogId=${k.metricool_blog_id||k.metricool_user_id}`,{method:'POST',headers:{'X-Mc-Auth':k.metricool_api_key,'Content-Type':'application/json'},body:JSON.stringify({networks})});
    const data=await r.json();
    if(data.id||data.success){
      await db.query("UPDATE posts SET status='scheduled' WHERE id=$1",[post_id]);
      res.json({ok:true,msg:'Programado en Metricool'});
    }else{res.json({ok:false,msg:data.message||'Error',data});}
  }catch(e){res.json({ok:false,msg:e.message});}
});

// ── Analytics ─────────────────────────────────────────────────
app.get('/api/analytics/:brand_id',auth,async(req,res)=>{
  const{brand_id}=req.params;
  const k=await getKeys(brand_id);

  // Internal analytics from DB
  const{rows:posts}=await db.query('SELECT * FROM posts WHERE brand_id=$1',[brand_id]);

  // Posts by status
  const byStatus={};
  posts.forEach(p=>{byStatus[p.status]=(byStatus[p.status]||0)+1;});

  // Posts by format
  const byFormat={};
  posts.forEach(p=>{byFormat[p.format||'Sin formato']=(byFormat[p.format||'Sin formato']||0)+1;});

  // Posts by platform
  const byPlatform={};
  posts.forEach(p=>{(p.platform||[]).forEach(pl=>{byPlatform[pl]=(byPlatform[pl]||0)+1;});});

  // Posts by month (last 6 months)
  const byMonth={};
  posts.forEach(p=>{
    if(p.date){
      const ym=p.date.slice(0,7);
      byMonth[ym]=(byMonth[ym]||0)+1;
    }
  });

  // Approval time avg (draft -> published)
  const published=posts.filter(p=>p.status==='published'||p.status==='scheduled');
  const avgDays=published.length>0?Math.round(published.reduce((acc,p)=>{
    const diff=(new Date(p.updated_at)-new Date(p.created_at))/(1000*60*60*24);
    return acc+diff;
  },0)/published.length):0;

  var metricoolData=null;

  // Try to get Metricool analytics if configured
  if(k.metricool_api_key&&k.metricool_user_id){
    try{
      const now=new Date();
      const start=new Date(now.getFullYear(),now.getMonth()-2,1).toISOString().slice(0,10);
      const end=now.toISOString().slice(0,10);
      const blogId=k.metricool_blog_id||k.metricool_user_id;

      // Fetch multiple Metricool endpoints in parallel
      const [postsRes, bestTimeRes] = await Promise.all([
        fetch(`https://app.metricool.com/api/v2/analytics/posts?userId=${k.metricool_user_id}&blogId=${blogId}&startDate=${start}&endDate=${end}&limit=50`,{headers:{'X-Mc-Auth':k.metricool_api_key}}).then(r=>r.json()).catch(()=>null),
        fetch(`https://app.metricool.com/api/v2/analytics/bestTime?userId=${k.metricool_user_id}&blogId=${blogId}&startDate=${start}&endDate=${end}`,{headers:{'X-Mc-Auth':k.metricool_api_key}}).then(r=>r.json()).catch(()=>null),
      ]);

      metricoolData={posts:postsRes,bestTime:bestTimeRes};

      // Cache analytics
      await db.query('INSERT INTO analytics_cache (brand_id,data) VALUES ($1,$2)',[brand_id,JSON.stringify(metricoolData)]);
    }catch(e){
      console.error('Analytics fetch error:',e.message);
      // Try to use cached data
      const{rows:cached}=await db.query('SELECT data FROM analytics_cache WHERE brand_id=$1 ORDER BY fetched_at DESC LIMIT 1',[brand_id]);
      if(cached.length)metricoolData=cached[0].data;
    }
  }

  res.json({
    internal:{
      total:posts.length,
      byStatus,
      byFormat,
      byPlatform,
      byMonth,
      avgApprovalDays:avgDays,
      published:published.length,
    },
    metricool:metricoolData,
  });
});

app.get('/api/health',(req,res)=>res.json({status:'ok',version:'1.3.0'}));

initDB().then(()=>{
  // Sync brands on startup
  setTimeout(syncBrandsFromMetricool, 5000);
  app.listen(PORT,()=>console.log(`BCA Social API v1.3 on port ${PORT}`));
}).catch(e=>{console.error(e);process.exit(1);});
