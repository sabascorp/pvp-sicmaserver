'use strict';
// SpeedMathSprint · PVP 2.1 — servidor de tiempo real (Render, plan gratuito).
// Variables de entorno en Render:
//   PVP_SECRET       (obligatoria) la MISMA clave que pusiste en includes/pvp_config.php de tu sitio
//   ALLOWED_ORIGINS  (recomendada) tu sitio, ej. https://tusitio.infinityfreeapp.com  (varios: separados por coma)
//   SALAS_RAPIDAS    (opcional) salas abiertas por operación para "Buscar rival" (por defecto 5)
//   PORT             lo pone Render solo
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { crearPVP } = require('./pvp-logic');

const PORT = Number(process.env.PORT) || 3000;
const SECRETO = process.env.PVP_SECRET || '';
const ORIGENES = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const SALAS_RAPIDAS = Math.max(1, Math.min(50, Number(process.env.SALAS_RAPIDAS) || 5));

if (SECRETO.length < 16) {
  console.error('Falta PVP_SECRET (mínimo 16 caracteres). Agrégala en Render → Environment.');
  process.exit(1);
}
if (!ORIGENES.length) {
  console.warn('Aviso: ALLOWED_ORIGINS vacío, se aceptan conexiones desde cualquier sitio. Conviene poner el tuyo.');
}

const app = express();
app.disable('x-powered-by');

const servidor = http.createServer(app);
const io = new Server(servidor, {
  cors: { origin: ORIGENES.length ? ORIGENES : '*', methods: ['GET', 'POST'] },
  serveClient: false,        // el navegador carga socket.io desde la CDN
  pingInterval: 8000,        // detecta rápido a quien se desconecta
  pingTimeout: 6000,
  maxHttpBufferSize: 10000,  // los mensajes son diminutos
});

const pvp = crearPVP(io, {
  secreto: SECRETO,
  salasRapidas: SALAS_RAPIDAS,
  log: (...a) => console.log('[pvp]', ...a),
});

// La página de PVP llama a /health al entrar para "despertar" el servicio gratuito
app.get('/', (_req, res) => res.type('text').send('SpeedMathSprint PVP 2.1 en línea'));
app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(Object.assign({ ok: true }, pvp.estado()));
});

servidor.listen(PORT, () => console.log('PVP escuchando en el puerto ' + PORT));

function apagar() {
  pvp.cerrar();
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', apagar);
process.on('SIGINT', apagar);
