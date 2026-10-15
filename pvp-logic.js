'use strict';
// SpeedMathSprint · PVP 2.1 — lógica del relevo en tiempo real.
//
// Este servidor NO resuelve operaciones, NO calcula quién gana y NO guarda nada.
// Solo: verifica quién es cada jugador (token firmado por tu PHP), junta a dos en una sala,
// reparte la semilla y la hora de inicio, y pasa de un jugador al otro los números en vivo.
// Todo lo demás (operaciones, ganador, guardado en la base de datos) ocurre en el navegador y en PHP.
//
// Usa solo lo básico de Socket.IO (io.use, io.on('connection'), socket.on / emit / disconnect),
// y no usa las "rooms" de Socket.IO: las salas viven en memoria de este archivo.

const crypto = require('crypto');

// ------------------------------------------------------------
// Token firmado por PHP:  base64url(JSON).base64url(HMAC-SHA256(base64url(JSON), secreto))
// JSON = { u: usuario, n: nombre corto para mostrar, exp: segundos Unix }
// ------------------------------------------------------------
function verificarToken(token, secreto, ahoraMs) {
  if (typeof token !== 'string' || token.length < 10 || token.length > 600) return null;
  const partes = token.split('.');
  if (partes.length !== 2) return null;

  const esperado = crypto.createHmac('sha256', secreto).update(partes[0]).digest();
  let recibido;
  try { recibido = Buffer.from(partes[1], 'base64'); } catch (e) { return null; } // acepta base64url sin relleno
  if (recibido.length !== esperado.length || !crypto.timingSafeEqual(recibido, esperado)) return null;

  let p;
  try { p = JSON.parse(Buffer.from(partes[0], 'base64').toString('utf8')); } catch (e) { return null; }
  if (!p || typeof p.u !== 'string' || typeof p.n !== 'string' || typeof p.exp !== 'number') return null;
  if (!p.u || p.exp * 1000 < ahoraMs) return null;
  return { u: p.u.slice(0, 60), n: p.n.slice(0, 30) };
}

// ------------------------------------------------------------
// Limpieza de lo que manda un jugador (nunca se reenvía nada que no pase por aquí)
// ------------------------------------------------------------
function entero(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

const OP_ASCII = /^\d{1,6}(\.\d{1,6})?[+\-x/]\d{1,6}(\.\d{1,6})?$/;

function limpiarNumeros(d) {
  d = d && typeof d === 'object' ? d : {};
  const ms = Number(d.ms);
  const msValido = Number.isFinite(ms) && ms >= 1 && ms <= 600000;
  return {
    c: entero(d.c, 0, 999),   // aciertos
    w: entero(d.w, 0, 999),   // errores
    a: entero(d.a, 0, 1998),  // intentos
    k: entero(d.k, 0, 999),   // combo actual
    kb: entero(d.kb, 0, 999), // mejor combo
    ms: msValido ? Math.round(ms) : null,                                    // mejor tiempo (ms)
    mo: (typeof d.mo === 'string' && OP_ASCII.test(d.mo)) ? d.mo : '',      // operación de ese tiempo, "7+8"
  };
}

const OP_VALIDA = /^[a-z][a-z0-9_]{0,39}$/;
const LETRAS_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para que no se confundan

function crearPVP(io, opciones) {
  const cfg = Object.assign({
    secreto: '',
    salasRapidas: 15,          // salas abiertas por operación (partidas "Buscar rival")
    maxPrivadas: 200,         // tope de salas con código al mismo tiempo
    cuentaMs: 5000,           // tiempo entre "los dos listos" y el inicio real
    inactivoMs: 5 * 60 * 1000, // en la sala sin jugar: se libera el lugar
    barridoMs: 30000,         // cada cuánto se revisa la inactividad
    eventosPorSegundo: 40,    // protección: más que esto y se corta la conexión
    ahora: Date.now,
    log: () => {},
  }, opciones || {});

  const salas = new Map();      // id -> sala
  const jugadores = new Map();  // socket.id -> jugador
  const porUsuario = new Map(); // usuario -> jugador (si abre otra pestaña, gana la última)

  // ---------- utilidades ----------
  function emitir(j, evento, datos) {
    try { j.socket.emit(evento, datos); } catch (e) { cfg.log('emitir falló', evento, e && e.message); }
  }

  function enviarSala(sala) {
    for (const j of sala.jugadores) {
      emitir(j, 'sala', {
        id: sala.id,
        tipo: sala.tipo,
        codigo: sala.codigo || null,
        estado: sala.estado,
        jugadores: sala.jugadores.map((x) => ({ nombre: x.n, listo: x.listo, yo: x === j })),
      });
    }
  }

  function otros(sala, j) { return sala.jugadores.filter((x) => x !== j); }

  function codigoNuevo() {
    for (let intento = 0; intento < 50; intento++) {
      let c = '';
      for (let i = 0; i < 4; i++) c += LETRAS_CODIGO[crypto.randomInt(LETRAS_CODIGO.length)];
      if (!buscarPrivada(c)) return c;
    }
    return null;
  }

  function buscarPrivada(codigo) {
    for (const s of salas.values()) if (s.tipo === 'privada' && s.codigo === codigo) return s;
    return null;
  }

  function nuevaSala(id, op, tipo, codigo) {
    const s = { id, op, tipo, codigo: codigo || null, estado: 'espera', jugadores: [] };
    salas.set(id, s);
    return s;
  }

  function reiniciarSala(sala) {
    sala.estado = 'espera';
    sala.jugadores.forEach((x) => { x.listo = false; x.termino = false; });
  }

  // ---------- entrar y salir ----------
  function salir(j) {
    const sala = j.sala;
    if (!sala) return;
    j.sala = null;
    sala.jugadores = sala.jugadores.filter((x) => x !== j);
    const habiaPartida = sala.estado === 'jugando';

    for (const resto of sala.jugadores) {
      // "enPartida" + "yaTermino": el navegador del otro decide si fue un abandono
      emitir(resto, 'rival:salio', { enPartida: habiaPartida, yaTermino: !!j.termino });
    }
    j.listo = false;
    j.termino = false;

    if (sala.jugadores.length === 0) {
      if (sala.tipo === 'privada') salas.delete(sala.id);
      else reiniciarSala(sala);
      return;
    }
    // Si se fue en plena partida sin haber terminado, la partida se da por cerrada
    if (habiaPartida && !j.yaEnvioFinal) reiniciarSala(sala);
    else sala.jugadores.forEach((x) => { x.listo = false; });
    enviarSala(sala);
  }

  function unirse(j, datos, ack) {
    const responder = (r) => { if (typeof ack === 'function') ack(r); };
    datos = datos && typeof datos === 'object' ? datos : {};
    const op = String(datos.op || '');
    const modo = String(datos.modo || '');
    if (!OP_VALIDA.test(op)) return responder({ ok: false, error: 'operacion' });

    salir(j); // un jugador está en una sola sala a la vez
    j.listo = false;
    j.termino = false;
    j.yaEnvioFinal = false;

    let sala = null;

    if (modo === 'rapida') {
      // Primero se completa una sala con un jugador esperando; si no hay, la primera vacía
      let vacia = null;
      for (let i = 1; i <= cfg.salasRapidas; i++) {
        const id = 'rapida:' + op + ':' + i;
        const s = salas.get(id) || nuevaSala(id, op, 'rapida');
        if (s.estado !== 'espera') continue;
        if (s.jugadores.length === 1) { sala = s; break; }
        if (s.jugadores.length === 0 && !vacia) vacia = s;
      }
      sala = sala || vacia;
      if (!sala) return responder({ ok: false, error: 'llenas' });

    } else if (modo === 'crear') {
      const privadas = [...salas.values()].filter((s) => s.tipo === 'privada').length;
      const codigo = privadas >= cfg.maxPrivadas ? null : codigoNuevo();
      if (!codigo) return responder({ ok: false, error: 'llenas' });
      sala = nuevaSala('privada:' + op + ':' + codigo, op, 'privada', codigo);

    } else if (modo === 'codigo') {
      const codigo = String(datos.codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      const s = codigo ? buscarPrivada(codigo) : null;
      if (!s || s.op !== op) return responder({ ok: false, error: 'no_existe' });
      if (s.jugadores.length >= 2) return responder({ ok: false, error: 'sala_llena' });
      if (s.estado !== 'espera') return responder({ ok: false, error: 'en_juego' });
      sala = s;

    } else {
      return responder({ ok: false, error: 'modo' });
    }

    sala.jugadores.push(j);
    j.sala = sala;
    j.ultimo = cfg.ahora();
    responder({ ok: true, codigo: sala.codigo });
    enviarSala(sala);
  }

  // ---------- partida ----------
  function iniciar(sala) {
    const partida = crypto.randomBytes(6).toString('hex');
    const semilla = (crypto.randomBytes(4).readUInt32LE(0) % 2147483646) + 1; // 1 .. 2^31-2
    const inicioMs = cfg.ahora() + cfg.cuentaMs;
    sala.estado = 'jugando';
    sala.jugadores.forEach((x) => { x.listo = false; x.termino = false; x.yaEnvioFinal = false; x.ultimoStats = 0; });
    for (const j of sala.jugadores) {
      const rival = otros(sala, j)[0];
      emitir(j, 'inicio', { partida, semilla, inicio: inicioMs, rival: rival ? rival.n : '' });
    }
    enviarSala(sala);
  }

  function listo(j) {
    const sala = j.sala;
    if (!sala || sala.estado !== 'espera' || sala.jugadores.length !== 2) return;
    j.listo = true;
    if (sala.jugadores.every((x) => x.listo)) iniciar(sala);
    else enviarSala(sala);
  }

  function stats(j, datos) {
    const sala = j.sala;
    if (!sala || sala.estado !== 'jugando' || j.termino) return;
    const t = cfg.ahora();
    if (t - j.ultimoStats < 100) return; // máximo ~10 por segundo por jugador
    j.ultimoStats = t;
    const n = limpiarNumeros(datos);
    for (const r of otros(sala, j)) emitir(r, 'rival:stats', n);
  }

  function final(j, datos) {
    const sala = j.sala;
    if (!sala || sala.estado !== 'jugando' || j.termino) return;
    j.termino = true;
    j.yaEnvioFinal = true;
    const n = limpiarNumeros(datos);
    for (const r of otros(sala, j)) emitir(r, 'rival:final', n);
    if (sala.jugadores.every((x) => x.termino)) {
      reiniciarSala(sala);
      enviarSala(sala);
    }
  }

  // ---------- conexión ----------
  io.use((socket, next) => {
    const auth = (socket.handshake && socket.handshake.auth) || {};
    const u = verificarToken(auth.token, cfg.secreto, cfg.ahora());
    if (!u) return next(new Error('token'));
    socket.data = socket.data || {};
    socket.data.usuario = u;
    next();
  });

  io.on('connection', (socket) => {
    const u = socket.data.usuario;
    const j = {
      socket, u: u.u, n: u.n, sala: null, listo: false, termino: false, yaEnvioFinal: false,
      ultimo: cfg.ahora(), ultimoStats: 0, ventana: cfg.ahora(), eventos: 0,
    };

    // Una sola conexión por usuario: la anterior se cierra (evita dos pestañas jugando)
    const previo = porUsuario.get(j.u);
    if (previo && previo !== j) {
      emitir(previo, 'expulsado', { motivo: 'otra_sesion' });
      salir(previo);
      jugadores.delete(previo.socket.id);
      try { previo.socket.disconnect(true); } catch (e) { /* ya estaba cerrada */ }
    }
    porUsuario.set(j.u, j);
    jugadores.set(socket.id, j);

    // Protección contra ráfagas
    function permitido() {
      if (j.cortado) return false;
      const t = cfg.ahora();
      if (t - j.ventana >= 1000) { j.ventana = t; j.eventos = 0; }
      j.eventos++;
      if (j.eventos > cfg.eventosPorSegundo) {
        j.cortado = true;
        cfg.log('demasiados eventos, se corta', j.u);
        try { socket.disconnect(true); } catch (e) { /* nada */ }
        return false;
      }
      return true;
    }
    function on(evento, fn) {
      socket.on(evento, (datos, ack) => {
        if (!permitido()) return;
        j.ultimo = cfg.ahora();
        try { fn(datos, ack); } catch (e) { cfg.log('error en', evento, e && e.stack); }
      });
    }

    on('sync', (_d, ack) => { if (typeof ack === 'function') ack(cfg.ahora()); });
    on('unirse', (d, ack) => unirse(j, d, ack));
    on('listo', () => listo(j));
    on('stats', (d) => stats(j, d));
    on('final', (d) => final(j, d));
    on('salir', () => salir(j));
    on('actividad', () => { /* solo marca que sigue ahí (ya se actualizó j.ultimo) */ });

    socket.on('disconnect', () => {
      salir(j);
      jugadores.delete(socket.id);
      if (porUsuario.get(j.u) === j) porUsuario.delete(j.u);
    });
  });

  // Libera lugares: quien lleva mucho tiempo en una sala sin jugar ni tocar nada
  const barrido = setInterval(() => {
    const t = cfg.ahora();
    for (const j of [...jugadores.values()]) {
      if (j.sala && j.sala.estado === 'espera' && t - j.ultimo > cfg.inactivoMs) {
        emitir(j, 'expulsado', { motivo: 'inactividad' });
        salir(j);
      }
    }
  }, cfg.barridoMs);
  if (barrido.unref) barrido.unref();

  return {
    estado() {
      let enSala = 0; let jugando = 0;
      for (const s of salas.values()) {
        if (s.jugadores.length) enSala += s.jugadores.length;
        if (s.estado === 'jugando') jugando++;
      }
      return { conectados: jugadores.size, enSala, partidas: jugando };
    },
    cerrar() { clearInterval(barrido); },
    _salas: salas, _jugadores: jugadores, // solo para pruebas
  };
}

module.exports = { crearPVP, verificarToken, limpiarNumeros };
