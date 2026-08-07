# BCA Studio Backend

## Deploy en Railway (paso a paso)

### 1. Subir a GitHub
1. Ve a github.com → New repository → nombre: `bca-studio-backend` → Create
2. Arrastra todos estos archivos al repositorio
3. Commit changes

### 2. Desplegar en Railway
1. Ve a railway.app → New Project → Deploy from GitHub repo
2. Selecciona `bca-studio-backend`
3. Railway detecta Node.js automáticamente → Deploy

### 3. Agregar base de datos
1. En Railway → tu proyecto → New → Database → PostgreSQL
2. Railway conecta la DB automáticamente (DATABASE_URL se agrega solo)

### 4. Variables de entorno
En Railway → tu proyecto → Variables → agrega:
```
JWT_SECRET=bca-studio-secreto-seguro-2026
NODE_ENV=production
```

### 5. Dominio
1. Railway → Settings → Domains → Generate Domain (URL temporal gratis)
2. O conecta tu dominio de GoDaddy en Settings → Custom Domain

### Credenciales por defecto
- Admin: sserrano@mktbca.com / bca2026
- Filmmaker: film@mktbca.com / film2026

### Endpoints principales
- POST /api/auth/login
- GET  /api/brands
- GET  /api/posts?brand_id=leku
- PUT  /api/posts/:id
- POST /api/metricool/test
- POST /api/metricool/schedule
- POST /api/metricool/stats
