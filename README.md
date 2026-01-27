# AutonomIA Suite Landing Demo

## Ejecutar local
1. Instalar dependencias:
   - `npm install`
2. Iniciar servidor:
   - `npm start`
3. Abrir en navegador:
   - `http://localhost:3000`

## Endpoints
- `POST /api/sessions`
- `POST /api/chat`
- `GET /api/sessions/:id`
- WebSocket: `/ws?session_id=...`

## Variables de entorno
Opcionales para persistencia en Supabase:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

## Modelo minimo en Supabase
Tabla: `sessions`

Columnas recomendadas:
- `session_id` (text, primary key)
- `step` (text)
- `captured` (jsonb)
- `triage` (jsonb)
- `timeline` (jsonb)
- `updated_at` (timestamptz)

## Deploy en Render (Web Service)
1. Crear Web Service desde el repo.
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Variables opcionales: `SUPABASE_URL`, `SUPABASE_ANON_KEY`
5. Habilitar WebSockets (Render lo soporta por defecto).

## Notas
- Demo con sesiones en memoria (expiran a los 30 minutos).
- Sin integraciones reales (WhatsApp/Calendario).
