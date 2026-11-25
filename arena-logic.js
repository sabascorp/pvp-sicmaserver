'use strict';
// SpeedMathSprint · ARENA (equipos) — lógica en tiempo real. Archivo NUEVO: no toca pvp-logic.js.
//
// Igual que el PVP 1 contra 1, este servidor NO resuelve operaciones, NO decide quién gana y NO guarda nada.
// Solo: verifica quién es cada jugador (el mismo token firmado), junta a los jugadores en una sala con código,
// los reparte en dos equipos, manda la semilla y la hora de inicio, y pasa los números en vivo a los demás.
// Los equipos son de 'tam' jugadores (2 = Duo, 3 = Trio, 4 = Squad): la sala se llena con 2 × tam jugadores.
// Vive en su propio espacio de Socket.IO ("/arena"), así que no se mezcla con el PVP de siempre.

const crypto = require('crypto');
const { verificarToken, limpiarNumeros } = require('./pvp-logic');

const OP_VALIDA = /^[a-z][a-z0-9_]{0,39}$/;
const LETRAS_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para que no se confundan

function crearArena(io, opciones) {
  const cfg = Object.assign({
    secreto: '',
    maxSalas: 100,            // salas con código al mismo tiempo
    cuentaMs: 5000,           // tiempo entre "todos listos" y el inicio real
    inactivoMs: 5 * 60 * 1000,
    barridoMs: 30000,
    eventosPorSegundo: 40,
    ahora: Date.now,
    log: () => {},
  }, opciones || {});

  const nsp = io.of('/arena');
  const salas = new Map();      // código -> sala
  const jugadores = new Map();  // socket.id -> jugador
  const porUsuario = new Map(); // usuario -> jugador (si abre otra pestaña, gana la última)

  function emitir(j, evento, datos) {
    try { j.socket.emit(evento, datos); } catch (e) { cfg.log('emitir falló', evento, e && e.message); }
  }

  const capacidad = (sala) => sala.tam * 2;
  const delEquipo = (sala, eq) => sala.jugadores.filter((x) => x.eq === eq);
  const llena = (sala) => sala.jugadores.length === capacidad(sala) && delEquipo(sala, 0).length === sala.tam && delEquipo(sala, 1).length === sala.tam;
  const otros = (sala, j) => sala.jugadores.filter((x) => x !== j);

  function enviarSala(sala) {
    for (const j of sala.jugadores) {
      emitir(j, 'sala', {
        codigo: sala.codigo,
        estado: sala.estado,
        tam: sala.tam,
        jugadores: sala.jugadores.map((x) => ({
          nombre: x.n, escuela: x.e, nv: x.nv, eq: x.eq, listo: x.listo, yo: x === j, anfitrion: x === sala.anfitrion,
        })),
      });
    }
  }

  function codigoNuevo() {
    for (let intento = 0; intento < 50; intento++) {
      let c = '';
      for (let i = 0; i < 4; i++) c += LETRAS_CODIGO[crypto.randomInt(LETRAS_CODIGO.length)];
      if (!salas.has(c)) return c;
    }
    return null;
  }

  function reiniciarSala(sala) {
    sala.estado = 'espera';
    sala.jugadores.forEach((x) => { x.listo = false; x.termino = false; x.yaEnvioFinal = false; });
  }

  // ---------- entrar y salir ----------
  function salir(j) {
    const sala = j.sala;
    if (!sala) return;
    j.sala = null;
    sala.jugadores = sala.jugadores.filter((x) => x !== j);
    const habiaPartida = sala.estado === 'jugando';
    const enCuenta = habiaPartida && cfg.ahora() < sala.inicioMs;   // se fue antes de que empezara el juego

    for (const resto of sala.jugadores) {
      emitir(resto, 'jug:salio', { i: j.idx, eq: j.eq, nombre: j.n, enPartida: habiaPartida, enCuenta, yaTermino: !!j.termino });
    }
    const eraAnfitrion = sala.anfitrion === j;
    j.listo = false;
    j.termino = false;

    if (sala.jugadores.length === 0) { salas.delete(sala.codigo); return; }
    if (eraAnfitrion) sala.anfitrion = sala.jugadores[0];

    if (enCuenta) {
      reiniciarSala(sala);   // todavía no empezaba: se cancela y se vuelve a la sala
    } else if (habiaPartida) {
      // La partida sigue para los que quedan; se cierra cuando todos ellos terminan
      if (sala.jugadores.every((x) => x.termino)) reiniciarSala(sala);
    } else {
      sala.jugadores.forEach((x) => { x.listo = false; });
    }
    enviarSala(sala);
  }

  function unirse(j, datos, ack) {
    const responder = (r) => { if (typeof ack === 'function') ack(r); };
    datos = datos && typeof datos === 'object' ? datos : {};
    const op = String(datos.op || '');
    const modo = String(datos.modo || '');
    if (!OP_VALIDA.test(op)) return responder({ ok: false, error: 'operacion' });

    salir(j); // un jugador está en una sola sala a la vez
    j.listo = false; j.termino = false; j.yaEnvioFinal = false;

    let sala = null;
    if (modo === 'crear') {
      const tam = entero(datos.tam, 2, 4);
      if (salas.size >= cfg.maxSalas) return responder({ ok: false, error: 'llenas' });
      const codigo = codigoNuevo();
      if (!codigo) return responder({ ok: false, error: 'llenas' });
      sala = { codigo, op, tam, estado: 'espera', jugadores: [], anfitrion: j };
      salas.set(codigo, sala);
    } else if (modo === 'codigo') {
      const codigo = String(datos.codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      const s = codigo ? salas.get(codigo) : null;
      if (!s || s.op !== op) return responder({ ok: false, error: 'no_existe' });
      if (datos.tam !== undefined && entero(datos.tam, 2, 4) !== s.tam) return responder({ ok: false, error: 'otro_modo' }); // código de Duo en Trio, etc.
      if (s.jugadores.length >= capacidad(s)) return responder({ ok: false, error: 'sala_llena' });
      if (s.estado !== 'espera') return responder({ ok: false, error: 'en_juego' });
      sala = s;
    } else {
      return responder({ ok: false, error: 'modo' });
    }

    // Se sienta en el equipo con menos jugadores (si hay empate, en el A)
    const a = delEquipo(sala, 0).length;
    const b = delEquipo(sala, 1).length;
    j.eq = a <= b ? 0 : 1;
    sala.jugadores.push(j);
    sala.jugadores.forEach((x) => { x.listo = false; });
    j.sala = sala;
    j.ultimo = cfg.ahora();
    responder({ ok: true, codigo: sala.codigo, tam: sala.tam });
    enviarSala(sala);
  }

  function cambiarEquipo(j, datos) {
    const sala = j.sala;
    if (!sala || sala.estado !== 'espera') return;
    const eq = entero(datos && datos.eq, 0, 1);
    if (eq === j.eq || delEquipo(sala, eq).length >= sala.tam) return;
    j.eq = eq;
    sala.jugadores.forEach((x) => { x.listo = false; }); // si cambian los equipos, hay que volver a confirmar
    enviarSala(sala);
  }

  // ---------- partida ----------
  function iniciar(sala) {
    const partida = crypto.randomBytes(6).toString('hex');
    const semilla = (crypto.randomBytes(4).readUInt32LE(0) % 2147483646) + 1;
    const inicioMs = cfg.ahora() + cfg.cuentaMs;
    sala.estado = 'jugando';
    sala.inicioMs = inicioMs;
    sala.jugadores.forEach((x, i) => { x.idx = i; x.listo = false; x.termino = false; x.yaEnvioFinal = false; x.ultimoStats = 0; });
    const lista = sala.jugadores.map((x) => ({ i: x.idx, nombre: x.n, escuela: x.e, nv: x.nv, eq: x.eq }));
    for (const j of sala.jugadores) {
      emitir(j, 'inicio', { partida, semilla, inicio: inicioMs, yo: j.idx, jugadores: lista, tam: sala.tam });
    }
    enviarSala(sala);
  }

  function listo(j) {
    const sala = j.sala;
    if (!sala || sala.estado !== 'espera' || !llena(sala)) return;
    j.listo = true;
    if (sala.jugadores.every((x) => x.listo)) iniciar(sala);
    else enviarSala(sala);
  }

  function stats(j, datos) {
    const sala = j.sala;
    if (!sala || sala.estado !== 'jugando' || j.termino) return;
    const t = cfg.ahora();
    if (t - j.ultimoStats < 100) return;
    j.ultimoStats = t;
    const n = Object.assign({ i: j.idx }, limpiarNumeros(datos));
    for (const r of otros(sala, j)) emitir(r, 'jug:stats', n);
  }

  function final(j, datos) {
    const sala = j.sala;
    if (!sala || sala.estado !== 'jugando' || j.termino) return;
    j.termino = true;
    j.yaEnvioFinal = true;
    const n = Object.assign({ i: j.idx }, limpiarNumeros(datos));
    for (const r of otros(sala, j)) emitir(r, 'jug:final', n);
    if (sala.jugadores.every((x) => x.termino)) {
      reiniciarSala(sala);
      enviarSala(sala);
    }
  }

  // ---------- conexión ----------
  nsp.use((socket, next) => {
    const auth = (socket.handshake && socket.handshake.auth) || {};
    const u = verificarToken(auth.token, cfg.secreto, cfg.ahora());
    if (!u) return next(new Error('token'));
    socket.data = socket.data || {};
    socket.data.usuario = u;
    next();
  });

  nsp.on('connection', (socket) => {
    const u = socket.data.usuario;
    const j = {
      socket, u: u.u, n: u.n, e: u.e || '', nv: u.nv || 0, sala: null, eq: 0, idx: -1,
      listo: false, termino: false, yaEnvioFinal: false,
      ultimo: cfg.ahora(), ultimoStats: 0, ventana: cfg.ahora(), eventos: 0,
    };

    const previo = porUsuario.get(j.u);
    if (previo && previo !== j) {
      emitir(previo, 'expulsado', { motivo: 'otra_sesion' });
      salir(previo);
      jugadores.delete(previo.socket.id);
      try { previo.socket.disconnect(true); } catch (e) { /* ya estaba cerrada */ }
    }
    porUsuario.set(j.u, j);
    jugadores.set(socket.id, j);

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
    on('equipo', (d) => cambiarEquipo(j, d));
    on('listo', () => listo(j));
    on('stats', (d) => stats(j, d));
    on('final', (d) => final(j, d));
    on('salir', () => salir(j));
    on('actividad', () => { /* solo marca que sigue ahí */ });

    socket.on('disconnect', () => {
      salir(j);
      jugadores.delete(socket.id);
      if (porUsuario.get(j.u) === j) porUsuario.delete(j.u);
    });
  });

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
      let jugando = 0;
      for (const s of salas.values()) if (s.estado === 'jugando') jugando++;
      return { arenaSalas: salas.size, arenaConectados: jugadores.size, arenaPartidas: jugando };
    },
    cerrar() { clearInterval(barrido); },
    _salas: salas, _jugadores: jugadores, // solo para pruebas
  };
}

function entero(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

module.exports = { crearArena };
