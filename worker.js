// SuperPredict en Cloudflare Workers: página (carpeta public), /api (estado compartido), calendario, forma, resultados automáticos y avisos push.
// Un solo archivo. Los datos se guardan en un Durable Object (base de datos SQLite con consistencia fuerte: dos móviles a la vez no se pisan).
// Secretos necesarios (Workers & Pages → tu proyecto → Settings → Variables and Secrets): FOOTBALL_DATA_TOKEN, VAPID_PRIVATE, ADMIN_PIN.
// Variables (van en wrangler.jsonc): VAPID_PUBLIC, VAPID_SUBJECT.
import { DurableObject } from "cloudflare:workers";

const DIA = 864e5;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// ======================= Base de datos (Durable Object) =======================
const CH = 100000;   // los valores se parten en trozos para no pasar el límite de tamaño por fila
const emptyState = () => ({ players: [], matches: [], preds: {}, archivo: [] });   // archivo = jugadores archivados: no juegan esta temporada pero conservan sus datos

function applyOps(st, ops) {   // misma lógica que tenía api.mjs
  for (const o of ops) {
    if (o.c === "preds") {
      const m = (st.preds[o.m] = st.preds[o.m] || {});
      if (o.v === null) delete m[o.p];
      else m[o.p] = o.v;
      if (!Object.keys(m).length) delete st.preds[o.m];
    } else if (o.c === "players" || o.c === "matches" || o.c === "archivo") {
      const arr = (st[o.c] = st[o.c] || []);
      const i = arr.findIndex((x) => x.id === o.id);
      if (o.rm) {
        if (i >= 0) arr.splice(i, 1);
        continue;
      }
      const e = i >= 0 ? arr[i] : { id: o.id };
      Object.assign(e, o.set || {});
      (o.del || []).forEach((k) => delete e[k]);
      if (i < 0) arr.push(e);
    }
  }
}

export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT NOT NULL, i INTEGER NOT NULL, v TEXT NOT NULL, PRIMARY KEY (k, i))");
  }
  _get(k) {
    const rows = this.sql.exec("SELECT v FROM kv WHERE k = ? ORDER BY i", k).toArray();
    return rows.length ? JSON.parse(rows.map((r) => r.v).join("")) : null;
  }
  _set(k, val) {
    const s = JSON.stringify(val);
    this.sql.exec("DELETE FROM kv WHERE k = ?", k);
    let n = 0;
    do { this.sql.exec("INSERT INTO kv (k, i, v) VALUES (?, ?, ?)", k, n, s.slice(n * CH, (n + 1) * CH)); n++; } while (n * CH < s.length);
  }
  async get(k) { return this._get(k); }
  async borrarForma() { this.sql.exec("DELETE FROM kv WHERE k LIKE 'datos%' OR k = 'equipos'"); return true; }   // borra las estadísticas guardadas de los partidos y la lista de equipos
  async set(k, v) { this._set(k, v); return true; }
  _state() {
    const st = this._get("state") || emptyState();
    st.players ||= []; st.matches ||= []; st.preds ||= {}; st.archivo ||= [];
    return st;
  }
  async getState() { return this._state(); }
  // Todo es síncrono dentro del objeto: leer, aplicar y guardar ocurre de una vez, sin que otra petición se cuele en medio.
  async applyOps(ops) {
    const st = this._state();
    if (Array.isArray(ops) && ops.length) { applyOps(st, ops); this._set("state", st); }
    return st;
  }

  // ---- Copias de seguridad del estado (jugadores, partidos y predicciones) ----
  // Se guardan en la misma base de datos: una al día (se conservan las 14 últimas) y las permanentes
  // (manuales, fin de temporada, antes de empezar otra temporada o de restaurar), que no se borran solas.
  _snaps() { return this._get("snaps") || []; }
  _snapMake(label, tipo, ref) {
    const st = this._state(), now = Date.now();
    const id = tipo + "-" + now.toString(36) + Math.random().toString(36).slice(2, 5);
    const bytes = JSON.stringify(st).length;
    this._set("snap:" + id, st);
    let list = this._snaps();
    const meta = { id, t: now, tipo, label, ref: ref || "", bytes, jugadores: st.players.length, partidos: st.matches.length };
    list.push(meta);
    if (tipo === "auto") {   // de las diarias solo se guardan las 14 más recientes
      const viejas = list.filter((x) => x.tipo === "auto").sort((a, b) => b.t - a.t).slice(14), fuera = new Set(viejas.map((x) => x.id));
      for (const x of viejas) this.sql.exec("DELETE FROM kv WHERE k = ?", "snap:" + x.id);
      list = list.filter((x) => !fuera.has(x.id));
    }
    this._set("snaps", list);
    return meta;
  }
  async backupLista() { return this._snaps().sort((a, b) => b.t - a.t); }
  async backupCrear(label, tipo) { return this._snapMake(String(label || "").slice(0, 80) || "Copia manual", ["manual", "temporada", "pre"].includes(tipo) ? tipo : "manual"); }
  async backupExportar(id) {   // sin id: el estado actual
    if (!id) return { st: this._state(), meta: null };
    const meta = this._snaps().find((x) => x.id === id), st = meta ? this._get("snap:" + id) : null;
    return st ? { st, meta } : null;
  }
  async backupRestaurar(id) {   // antes de sustituir el estado se guarda una copia del actual, por si te arrepientes
    const meta = this._snaps().find((x) => x.id === id), st = meta ? this._get("snap:" + id) : null;
    if (!st || !Array.isArray(st.players) || !Array.isArray(st.matches) || !st.preds || typeof st.preds !== "object") return false;
    this._snapMake("Antes de restaurar «" + meta.label + "»", "pre");
    this._set("state", st);
    return true;
  }
  async backupBorrar(id) {
    const list = this._snaps();
    if (!list.some((x) => x.id === id)) return false;
    this.sql.exec("DELETE FROM kv WHERE k = ?", "snap:" + id);
    this._set("snaps", list.filter((x) => x.id !== id));
    return true;
  }
  async backupCron() {   // lo llama el cron: copia diaria y copia de fin de temporada
    const st = this._state(), now = Date.now();
    if (st.players.length && !this._snaps().some((x) => x.tipo === "auto" && day(x.t) === day(now))) this._snapMake("Copia diaria", "auto");   // nunca con la base vacía: no machacar copias buenas
    const fin = st.matches.find((m) => !m.comp && m.round === VOT_JORNADAS && m.result);   // la jornada final ya tiene resultado
    if (fin && !this._snaps().some((x) => x.tipo === "fin" && x.ref === fin.id)) this._snapMake("Fin de la temporada", "fin", fin.id);
  }

  // ---- Avisos push ----
  _logOnce() {   // registro de avisos ya enviados: "once(token)" es true solo la primera vez
    const log = this._get("pushlog") || {}, now = Date.now(); let dirty = false;
    return {
      once: (tok) => { if (log[tok]) return false; log[tok] = now; dirty = true; return true; },
      save: () => { if (!dirty) return; const lim = now - 60 * 864e5; for (const k in log) if (log[k] < lim) delete log[k]; this._set("pushlog", log); },
    };
  }
  _subs() { const d = this._get("push") || {}; d.subs ||= {}; return d; }
  // Presencia: la app avisa cada 25 s mientras está abierta y a la vista. Quien está dentro no recibe avisos (los verá en la propia app).
  // La presencia también se guarda en la base de datos: si el objeto se reinicia o se libera de memoria, no se pierde y se sigue sabiendo quién está dentro.
  _presMap() { return (this._pres ||= this._get("pres") || {}); }
  _dentro(pid) { const t = this._presMap()[pid]; return !!t && Date.now() - t < 55e3; }
  async presencia(pid, on) {
    const P = this._presMap(), now = Date.now();
    if (on) P[pid] = now; else delete P[pid];
    for (const k in P) if (now - P[k] > 3e5) delete P[k];   // se olvidan los que llevan más de 5 minutos sin latido
    this._set("pres", P); return true;
  }
  _jobs(msgs, st, forzar, autor) {   // cada aviso se convierte en un envío por cada móvil suscrito del jugador (salvo si está dentro de la app)
    if (!msgs.length) return [];
    const subs = this._subs().subs, jobs = [];
    const now = Date.now();
    for (const m of msgs) {
      if (!forzar && this._dentro(m.pid) && /^(duelo|reto|turno)-/.test(m.tag || "")) continue;   // dentro de la app solo se omiten los avisos de duelos de penaltis; el resto llegan siempre   // ya está en la app: no se le avisa, tampoco si el cambio lo ha hecho él (las pruebas desde el panel del admin siguen llegando: no pasan por aquí)
      const tab = TAB_AVISO[String(m.tag || "").split("-")[0]], n = pendientes(st, m.pid, now);
      for (const s of subs[m.pid] || []) jobs.push({ sub: s, payload: { t: m.title, b: m.body, tag: m.tag, url: tab ? "/#" + tab : "/", n } });
    }
    return jobs;
  }
  // Igual que applyOps, pero además devuelve los avisos que provocan los cambios (jornada nueva, resultado, penaltis).
  async applyOpsN(ops, autor) {
    const st = this._state(); let jobs = [];
    if (Array.isArray(ops) && ops.length) {
      const antes = { ids: new Set(st.matches.map((m) => m.id)), res: Object.fromEntries(st.matches.map((m) => [m.id, !!m.result])), mods: modsActuales(st), info: Object.fromEntries(st.matches.map((m) => [m.id, { round: m.round, home: m.home, away: m.away }])) };
      antes.pl = Object.fromEntries(st.matches.filter((m) => m.comp).map((m) => [m.id, Array.isArray(m.pl) ? m.pl.join(",") : ""]));   // trofeos y Balón de Oro: lo que había antes del cambio, para avisar solo de lo nuevo
      antes.prem = Object.fromEntries(st.players.map((q) => [q.id, (Array.isArray(q.premios) ? q.premios : []).filter((x) => /^s/.test(x))]));
      antes.bdo = Object.fromEntries(st.players.map((q) => [q.id, q.bdo && q.bdo.t ? q.bdo.s + "|" + q.bdo.t : ""]));
      applyOps(st, ops); this._set("state", st);
      try {   // si borras un partido (o le quitas el resultado), sus avisos "ya enviados" se olvidan: al volver a crearlo / ponerle resultado se mandan otra vez
        const quitar = [];
        for (const id of Object.keys(antes.info)) {
          const i = antes.info[id], vivo = st.matches.find((x) => x.id === id);
          if (!vivo) quitar.push(`j:${i.round}|${i.home}|${i.away}`, "r:" + id, `c:${id}:`, `p:${id}:`);
          else if (antes.res[id] && !vivo.result) quitar.push("r:" + id);
        }
        if (quitar.length) {
          const log = this._get("pushlog") || {}; let ch = false;
          for (const k of Object.keys(log)) if (quitar.some((q) => k === q || (q.endsWith(":") && k.startsWith(q)))) { delete log[k]; ch = true; }
          if (ch) this._set("pushlog", log);
        }
      } catch (e) { console.error("registro de avisos:", e && e.message); }
      const arch = ops.filter((o) => o && o.c === "archivo" && !o.rm && o.id).map((o) => o.id);   // jugador archivado: deja de recibir avisos
      if (arch.length) { const d = this._subs(); let ch = false; for (const id of arch) if (d.subs[id]) { delete d.subs[id]; ch = true; } if (ch) this._set("push", d); }
      try {   // un fallo en los avisos nunca debe impedir que se guarde
        const now = Date.now(), L = this._logOnce();
        const msgs = [...avisosNuevaJornada(st, antes, now, L.once), ...avisosResultado(st, antes, L.once), ...avisosPocion(st, antes, L.once), ...avisosPenaltis(st, now, L.once), ...avisosTrofeo(st, antes, L.once), ...avisosClasificado(st, antes, L.once), ...avisosBalon(st, antes, L.once)];
        if (typeof autor === "string" && autor) this._presMap()[autor] = now;   // quien manda el cambio está dentro de la app ahora mismo
        L.save(); jobs = this._jobs(msgs, st, false, typeof autor === "string" ? autor : "");
      } catch (e) { console.error("avisos:", e && e.message); }
    }
    return { st, jobs };
  }
  async pushReminders() {   // lo llama el cron: recordatorios de cierre
    try {
      const st = this._state(), L = this._logOnce(), msgs = [...avisosCierre(st, Date.now(), L.once), ...avisosVotacion(st, Date.now(), L.once), ...avisosVotoRecordatorio(st, Date.now(), L.once)];
      L.save(); return this._jobs(msgs, st);
    } catch (e) { console.error("recordatorios:", e && e.message); return []; }
  }
  async pushSubscribe(pid, sub) {
    if (!this._state().players.some((p) => p.id === pid)) return false;
    const d = this._subs();
    for (const k of Object.keys(d.subs)) { d.subs[k] = d.subs[k].filter((s) => s.e !== sub.e); if (!d.subs[k].length) delete d.subs[k]; }   // un móvil solo pertenece a un jugador
    const arr = (d.subs[pid] = d.subs[pid] || []);
    arr.push({ e: sub.e, p: sub.p, a: sub.a, t: Date.now() });
    while (arr.length > 5) arr.shift();
    this._set("push", d); return true;
  }
  async pushDemo(kind, pid) {   // aviso de prueba al móvil de un jugador: se puede repetir tantas veces como quieras
    const subs = this._subs().subs[pid] || [];
    if (!subs.length) return { jobs: [], sinAvisos: true };
    const st = this._state(), now = Date.now();
    const m = st.matches.filter((x) => !x.comp).sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff))[0] || { round: 1, home: "Equipo A", away: "Equipo B", kickoff: new Date(now + 864e5).toISOString() };
    const k = Date.parse(m.kickoff) || now + 864e5, f = votFase(st, now), rival = (st.players.find((p) => p.id !== pid && p.regAt) || { name: "Un rival" }).name;
    const D = {
      jornada: ["🆕 ¡Nueva jornada!", `J${m.round}: ${m.home} vs ${m.away}.\nCierre: ${fechaEs(k - CIERRE)}.`],
      cierre: ["⏰ ¡Queda 1 hora para el cierre!", `J${m.round}: ${m.home} vs ${m.away}\nCierra a las ${horaEs(k - CIERRE)} y aún no has puesto tu pronóstico…`],
      resultado: [`🏁 Final: ${m.home} 2-1 ${m.away}`, "+3 puntos ✅ +1 por racha 🔥"],
      pocion: ["🧪 ¡Te han lanzado una poción!", `${rival} ha usado Cambiaforma.\n+1 gol a ${m.home}.`],
      votacion: ["🗳️ ¡Votación abierta!", `Elige el partido de la próxima jornada.\nCierra el ${votCierreTxt(f)}.`],
      votacion_re: ["🗳️ Votación reabierta", `Se han borrado los votos: vuelve a votar.\nCierra el ${votCierreTxt(f)}.`],
      votorec: ["🗳️ ¡Queda 1 hora para votar!", `Aún no has votado el partido de la próxima jornada.\nCierra a las ${horaEs(f.close)}.`],
      reto: ["🤝🏼Reto Amistoso", `${rival} te reta a una tanda de penaltis. Acepta el reto desde la pestaña de inicio.`],
      turno: ["⚽️¡Es tu turno!", `${rival} ya ha jugado la ronda 2 de vuestra tanda. ¡Te toca!`],
      duelo: ["⚽Duelo de penaltis", `Tienes una tanda contra ${rival}. ¡Entra a jugarla!`],
      trofeo: ["🏆 ¡Trofeo ganado!", "¡Has ganado la liga! Ya está en tu vitrina."],
      clasif: ["🌍 ¡Te has clasificado!", `Te has clasificado a la Champions League. Juegas contra ${rival}. ¡Haz tu pronóstico!`],
      nominado: ["⭐️ ¡Estás nominado!", "Estás nominado al Balón de Oro. Los demás ya pueden votar."],
      votobdo: ["🗳️ ¡Vota al Balón de Oro!", `Elige al mejor jugador de la temporada. Cierra el ${fechaEs(now + 48 * HORA)}.`],
    }[kind];
    if (!D) return { jobs: [], desconocido: true };
    const tag = kind.split("_")[0] + "-prueba-" + now, tab = TAB_AVISO[kind.split("_")[0]], n = pendientes(st, pid, now);
    return { jobs: subs.map((s) => ({ sub: s, payload: { t: "🧪 PRUEBA · " + D[0], b: D[1], tag, url: tab ? "/#" + tab : "/", n } })) };
  }
  async pushResub(oldEndpoint, sub) {
    const d = this._subs();
    for (const k of Object.keys(d.subs)) {
      if (d.subs[k].some((s) => s.e === oldEndpoint)) {
        d.subs[k] = d.subs[k].filter((s) => s.e !== oldEndpoint && s.e !== sub.e);
        d.subs[k].push({ e: sub.e, p: sub.p, a: sub.a, t: Date.now() });
        this._set("push", d); return true;
      }
    }
    return false;
  }
  async pushUnsubscribe(endpoints) {   // quita suscripciones (el jugador las desactiva o el servicio de push dice que caducaron)
    const lista = Array.isArray(endpoints) ? endpoints : [endpoints], d = this._subs(); let ch = false;
    for (const k of Object.keys(d.subs)) {
      const n = d.subs[k].filter((s) => !lista.includes(s.e));
      if (n.length !== d.subs[k].length) { ch = true; if (n.length) d.subs[k] = n; else delete d.subs[k]; }
    }
    if (ch) this._set("push", d); return ch;
  }
  async pushJobsPara(pids, payload) {   // pids = null → todos
    const subs = this._subs().subs, jobs = [], vivos = new Set(this._state().players.map((p) => p.id)); let jugadores = 0, omitidos = 0;
    for (const pid of Object.keys(subs)) {
      if (pids && !pids.includes(pid)) continue;
      if (!vivos.has(pid)) continue;   // archivados o eliminados: sin avisos
      jugadores++; for (const s of subs[pid]) jobs.push({ sub: s, payload });
    }
    return { jobs, jugadores, omitidos };
  }
  async pushJobsEndpoint(endpoint, payload) {
    const subs = this._subs().subs, jobs = [];
    for (const pid of Object.keys(subs)) for (const s of subs[pid]) if (s.e === endpoint) jobs.push({ sub: s, payload });
    return jobs;
  }
  async pushStats() {
    const subs = this._subs().subs;
    return { pids: Object.keys(subs), moviles: Object.values(subs).reduce((n, a) => n + a.length, 0) };
  }
}

// ======================= Calendario =======================
// Devuelve los partidos de las 5 grandes ligas y la Champions de una semana (para que el admin elija partido con un toque).
// Necesita la variable de entorno FOOTBALL_DATA_TOKEN. Uso: /.netlify/functions/calendario?from=2026-10-30
const CAL_COMPS = "PD,PL,BL1,SA,FL1,CL";

async function calendario(req, env) {
  const token = env.FOOTBALL_DATA_TOKEN;
  if (!token) return Response.json({ error: "Falta FOOTBALL_DATA_TOKEN" }, { status: 500 });

  const q = new URL(req.url).searchParams.get("from");
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q || "") ? q : day(Date.now());
  const ini = Date.parse(from + "T00:00:00Z"), fin = ini + 7 * DIA;

  const r = await fetch(
    `https://api.football-data.org/v4/matches?competitions=${CAL_COMPS}&dateFrom=${from}&dateTo=${day(fin)}`,
    { headers: { "X-Auth-Token": token } }
  );
  if (!r.ok) return Response.json({ error: "football-data.org respondió " + r.status }, { status: 502 });
  const { matches = [] } = await r.json();

  const eq = (t) => ({ name: (t && t.name) || "", short: (t && t.shortName) || "", tla: (t && t.tla) || "" });
  const out = matches
    .filter((m) => !["CANCELLED", "POSTPONED", "SUSPENDED"].includes(m.status))
    .filter((m) => { const k = Date.parse(m.utcDate); return k >= ini && k < fin; })
    .map((m) => ({ id: m.id, comp: m.competition && m.competition.code, kickoff: m.utcDate, home: eq(m.homeTeam), away: eq(m.awayTeam) }))
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));

  return Response.json({ from, matches: out }, { headers: { "cache-control": "public, max-age=300" } });
}

// ======================= Forma del equipo =======================
// Forma (últimos 5 partidos), últimos enfrentamientos y estadísticas de toda la temporada de dos equipos, para el botón de historial de la tarjeta de jornada.
// Necesita la variable de entorno FOOTBALL_DATA_TOKEN. Uso: /.netlify/functions/forma?home=Real%20Madrid&away=Barcelona
// Los nombres son los de la app; aquí se convierten a equipos de football-data.org con la misma lógica que "resultados".
// El plan gratis solo cubre las 5 grandes ligas y la Champions: de otros equipos saldrán menos datos.
const FD_API = "https://api.football-data.org/v4";
const FORMA_COMPS = ["PD", "PL", "BL1", "SA", "FL1", "CL"];
const H = 36e5, DIA_F = 24 * H;
const TTL_DATOS = 1 * H, TTL_EQUIPOS = 7 * DIA_F;

const NF = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const TF = (s) => NF(s).split(" ").filter(Boolean);
// Mismos alias que en resultados.mjs y en el Calendario del index (nombre de la app normalizado → nombres de la API normalizados)
const ALIAS_F = {
  "racing de santander": ["santander", "racing santander", "real racing club de santander", "racing club de santander"],
  "bayer leverkusen": ["leverkusen", "bayer 04 leverkusen", "b04"],
  "rennes": ["stade rennais", "stade rennais fc", "stade rennais fc 1901", "rennais", "ren"],
  "sabah fk": ["sabah", "fk sabah"],
  "sl bratislava": ["slovan bratislava", "sk slovan bratislava", "slovan"],
  "pae aek": ["aek athens", "aek athens fc", "aek"],
  "shaktar": ["shakhtar donetsk", "fc shakhtar donetsk", "shakhtar"],
  "sporting cp": ["sporting clube de portugal", "sporting lisbon", "sporting"],
  "slavia praha": ["sk slavia praha", "slavia prague"],
};
// Nombres de la app → cómo los escribe football-data.org (normalizados). Evitan que "Barcelona" se confunda con "RCD Espanyol de Barcelona" o "Deportivo" con "Deportivo Alavés".
Object.assign(ALIAS_F, {
  "barcelona": ["fc barcelona", "barca", "fcb"],
  "espanyol": ["rcd espanyol de barcelona", "rcd espanyol", "espanyol"],
  "deportivo": ["rc deportivo la coruna", "deportivo la coruna", "rc deportivo", "deportivo"],
  "alaves": ["deportivo alaves", "cd alaves", "alaves"],
  "real madrid": ["real madrid cf"],
  "atletico de madrid": ["club atletico de madrid", "atletico madrid", "atleti"],
  "athletic club": ["athletic", "athletic bilbao"],
  "celta de vigo": ["rc celta de vigo", "celta vigo", "celta"],
  "real betis": ["real betis balompie", "betis"],
  "real sociedad": ["real sociedad de futbol"],
  "rayo vallecano": ["rayo vallecano de madrid", "rayo"],
  "osasuna": ["ca osasuna"], "malaga": ["malaga cf"], "elche": ["elche cf"], "getafe": ["getafe cf"],
  "levante": ["levante ud"], "valencia": ["valencia cf"], "villarreal": ["villarreal cf"], "sevilla fc": ["sevilla"],
  "tottenham": ["tottenham hotspur fc", "tottenham hotspur", "spurs"],
  "manchester city": ["manchester city fc", "man city"], "manchester united": ["manchester united fc", "man united"],
  "brighton": ["brighton hove albion fc", "brighton hove albion", "brighton hove"],
  "newcastle united": ["newcastle united fc", "newcastle"],
  "inter": ["fc internazionale milano", "internazionale"], "milan": ["ac milan"],
  "bayern munchen": ["fc bayern munchen", "bayern"], "koln": ["1 fc koln", "fc koln"], "mainz 05": ["1 fsv mainz 05", "mainz"],
  "borussia monchengladbach": ["borussia monchengladbach", "gladbach"],
  "paris saint germain": ["paris saint germain fc", "psg"], "marseille": ["olympique de marseille"], "lyon": ["olympique lyonnais"],
});
// 3 = exacto (o alias), 2 = lo contiene, 1 = tiene todas sus palabras, 0 = no coincide
const scoreF = (app, t) => {
  if (!t) return 0;
  const a = NF(app), names = [NF(t.name), NF(t.shortName), NF(t.tla)].filter(Boolean);
  if (names.includes(a) || (ALIAS_F[a] || []).some((x) => names.includes(x))) return 3;
  if (names.some((n) => (" " + n + " ").includes(" " + a + " "))) return 2;
  const ta = TF(a);
  return ta.length && names.some((n) => ta.every((w) => TF(n).includes(w))) ? 1 : 0;
};

class FalloF extends Error { constructor(msg, status) { super(msg); this.status = status; } }

async function forma(req, env, cache) {
  const token = env.FOOTBALL_DATA_TOKEN;
  if (!token) return Response.json({ error: "Falta FOOTBALL_DATA_TOKEN" }, { status: 500 });
  const q = new URL(req.url).searchParams;
  const nombres = { home: (q.get("home") || "").trim(), away: (q.get("away") || "").trim() };
  if (!nombres.home || !nombres.away) return Response.json({ error: "Faltan los equipos" }, { status: 400 });

  const call = async (path) => {
    const r = await fetch(FD_API + path, { headers: { "X-Auth-Token": token } });
    if (r.status === 429) throw new FalloF("Demasiadas consultas a la API de fútbol. Prueba de nuevo en un minuto.", 429);
    if (!r.ok) throw new FalloF("football-data.org respondió " + r.status, r.status);
    return r.json();
  };
  const leer = async (k) => { try { return await cache.get(k); } catch (e) { return null; } };
  const guardar = async (k, v) => { try { await cache.set(k, v); } catch (e) { /* ignorar */ } };

  try {
    // 1) ids de los equipos (se guardan 7 días: la primera vez puede costar hasta 6 llamadas)
    let tm = await leer("equipos");
    if (!tm || !Array.isArray(tm.list) || Date.now() - tm.t > TTL_EQUIPOS) tm = { t: Date.now(), list: [], done: [] };
    const buscar = (nombre) => {
      let best = null, bs = 0;
      for (const t of tm.list) { const s = scoreF(nombre, t); if (s > bs || (s === bs && s > 0 && TF(t.name).length < TF(best.name).length)) { bs = s; best = t; } }
      return bs >= 1 ? best : null;
    };
    let eh = buscar(nombres.home), ea = buscar(nombres.away);
    for (const c of FORMA_COMPS) {
      if (eh && ea) break;
      if (tm.done.includes(c)) continue;
      try {
        const j = await call(`/competitions/${c}/teams`);
        for (const t of j.teams || []) if (!tm.list.some((x) => x.id === t.id)) tm.list.push({ id: t.id, name: t.name, shortName: t.shortName, tla: t.tla });
        tm.done.push(c);
      } catch (e) { if (e.status === 429) throw e; /* competición no disponible en el plan */ }
      eh = buscar(nombres.home); ea = buscar(nombres.away);
    }
    await guardar("equipos", tm);

    const ko = Date.parse(q.get("kickoff") || "");   // hora del partido en la app: sirve para saber de qué competición es
    const clave = `datos8:${eh ? eh.id : "x" + NF(nombres.home)}-${ea ? ea.id : "x" + NF(nombres.away)}:${Number.isFinite(ko) ? new Date(ko).toISOString().slice(0, 10) : "s"}`;
    const debug = q.get("debug") === "1";
    const hit = debug || q.get("fresh") === "1" ? null : await leer(clave);
    if (hit && Date.now() - hit.t < TTL_DATOS) return Response.json({ ...hit.data, t: hit.t, cached: true }, { headers: { "cache-control": "no-store" } });

    // 2) partidos de la temporada de cada equipo (una llamada por equipo)
    const d = new Date(), season = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    const partidos = async (t) => {
      if (!t) return [];
      try { return (await call(`/teams/${t.id}/matches?season=${season}&limit=100`)).matches || []; }
      catch (e) { if (e.status === 429) throw e; try { return (await call(`/teams/${t.id}/matches?limit=100`)).matches || []; } catch (e2) { if (e2.status === 429) throw e2; return []; } }
    };
    const [mh, ma] = [await partidos(eh), await partidos(ea)];
    const entre = (m) => eh && ea && ((m.homeTeam.id === eh.id && m.awayTeam.id === ea.id) || (m.homeTeam.id === ea.id && m.awayTeam.id === eh.id));
    // El partido de la API que es este mismo (los dos equipos, hora más cercana a la de la app, máx. 36 h); da la competición.
    // Sin hora de la app, se usa el próximo partido pendiente entre ambos.
    const entreMs = mh.filter(entre);
    const proximo = Number.isFinite(ko)
      ? entreMs.map((m) => ({ m, dif: Math.abs(Date.parse(m.utcDate) - ko) })).filter((x) => x.dif <= 36 * H).sort((a, b) => a.dif - b.dif).map((x) => x.m)[0]
      : entreMs.filter((m) => m.status !== "FINISHED" && m.status !== "AWARDED").sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate))[0];
    const compCode = proximo && proximo.competition ? proximo.competition.code : null;

    const ahora = Date.now();
    const jugado = (m) => (m.status === "FINISHED" || m.status === "AWARDED") && Date.parse(m.utcDate) <= ahora && m.score && m.score.fullTime && Number.isInteger(m.score.fullTime.home) && Number.isInteger(m.score.fullTime.away);
    const resumen = (t, ms, lado, compCode) => {   // lado: "home" = sus datos como local, "away" = como visitante
      if (!t) return { id: null, n: 0, form: [], stats: null };
      const fin = ms.filter(jugado).sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate));   // toda la temporada actual
      const rec = fin.map((m) => {
        const loc = m.homeTeam.id === t.id, ft = m.score.fullTime, gf = loc ? ft.home : ft.away, ga = loc ? ft.away : ft.home;
        return { d: m.utcDate, r: gf > ga ? "G" : gf < ga ? "P" : "E", gf, ga, opp: (loc ? m.awayTeam : m.homeTeam).shortName || (loc ? m.awayTeam : m.homeTeam).name, loc, comp: m.competition && m.competition.code };
      });
      const recS = compCode ? rec.filter((r) => r.comp === compCode) : rec;   // forma y estadísticas solo de la competición del partido (si se conoce)
      const n = recS.length;
      let stats = null;
      if (n) {
        const gft = recS.reduce((a, r) => a + r.gf, 0), gat = recS.reduce((a, r) => a + r.ga, 0);
        stats = {
          gf: gft / n, ga: gat / n, gft, gat,   // medias por partido y totales de la temporada
          win: Math.round(recS.filter((r) => r.r === "G").length / n * 100),
          cs: recS.filter((r) => r.ga === 0).length,   // porterías a cero (número)
        };
      }
      return { id: t.id, n, form: recS.slice(-5), stats, all: rec };
    };
    const home = resumen(eh, mh, "home", compCode), away = resumen(ea, ma, "away", compCode);

    // 3) últimos enfrentamientos: primero el endpoint head2head del partido que enfrenta a ambos; si no, los de esta temporada
    let h2h = [];
    if (eh && ea) {
      const cand = mh.filter(entre).sort((a, b) => Date.parse(b.utcDate) - Date.parse(a.utcDate));
      const fut = proximo || cand.find((m) => m.status !== "FINISHED") || cand[0];
      let lista = [];
      if (fut) { try { lista = (await call(`/matches/${fut.id}/head2head?limit=40`)).matches || []; } catch (e) { if (e.status === 429) throw e; } }
      if (!lista.length) lista = cand;
      const vistos = new Set();
      h2h = lista.filter(jugado).filter((m) => entre(m) && (!compCode || (m.competition && m.competition.code === compCode)) && !vistos.has(m.id) && vistos.add(m.id))   // partido de liga: solo enfrentamientos de liga; de Champions: solo de Champions
        .sort((a, b) => Date.parse(b.utcDate) - Date.parse(a.utcDate)).slice(0, 5)
        .map((m) => ({ d: m.utcDate, h: m.homeTeam.id === eh.id ? "home" : "away", hs: m.score.fullTime.home, as: m.score.fullTime.away, comp: m.competition && m.competition.code }));
    }
    const gana = (x) => (x.hs === x.as ? "d" : (x.hs > x.as) === (x.h === "home") ? "h" : "a");
    const cuenta = { h: 0, d: 0, a: 0 };
    h2h.forEach((x) => cuenta[gana(x)]++);

    if (debug) return Response.json({ season, equipos: { home: eh, away: ea }, compCode, home, away, h2h });
    delete home.all; delete away.all;
    const data = { season, comp: compCode, home, away, h2h: { matches: h2h, hw: cuenta.h, d: cuenta.d, aw: cuenta.a }, falta: { home: !eh, away: !ea }, via: { home: eh ? eh.name : null, away: ea ? ea.name : null } };
    const t0 = Date.now();
    await guardar(clave, { t: t0, data });
    return Response.json({ ...data, t: t0, cached: false }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e.message || "Error inesperado" }, { status: e.status === 429 ? 429 : 502 });
  }
}

// ======================= Resultados automáticos =======================
// Cada 15 min: si hay un partido de liga ya terminado sin resultado, lo busca en football-data.org y lo guarda.
// Necesita la variable de entorno FOOTBALL_DATA_TOKEN (token gratis de football-data.org).
// El plan gratis cubre las 5 grandes ligas y la Champions; Europa/Conference se quedan manuales.
async function resultados(env, estado) {
  const st = (await estado.getState()) || {};
  const now = Date.now();
  // partidos de liga (no de copas internas) que ya deberían haber terminado y siguen sin resultado
  const pend = (st.matches || []).filter((m) => {
    const k = Date.parse(m.kickoff);
    return !m.comp && !m.result && k && now > k + 100 * 6e4 && now < k + 5 * 864e5;
  });
  if (!pend.length) return;

  const token = env.FOOTBALL_DATA_TOKEN;
  if (!token) return console.error("Falta FOOTBALL_DATA_TOKEN");

  // una sola llamada con todas las competiciones del plan (el rango máximo permitido son 10 días)
  const ks = pend.map((m) => Date.parse(m.kickoff));
  const to = Math.max(...ks) + 864e5, from = Math.max(Math.min(...ks) - 864e5, to - 9 * 864e5);
  const r = await fetch(`https://api.football-data.org/v4/matches?status=FINISHED&dateFrom=${day(from)}&dateTo=${day(to)}`, { headers: { "X-Auth-Token": token } });
  if (!r.ok) return console.error("football-data.org respondió", r.status);
  const { matches = [] } = await r.json();

  const ops = [];
  for (const m of pend) {
    let best = null, bs = 0;
    for (const x of matches) {
      const h = scoreF(m.home, x.homeTeam), a = scoreF(m.away, x.awayTeam);
      if (h < 1 || a < 1 || Math.abs(Date.parse(x.utcDate) - Date.parse(m.kickoff)) > 2 * 864e5) continue;
      if (h + a > bs) { bs = h + a; best = x; }
    }
    const s = best && best.score && best.score.fullTime;
    if (s && Number.isInteger(s.home) && Number.isInteger(s.away)) ops.push({ c: "matches", id: m.id, set: { result: { h: s.home, a: s.away } } });
    else console.log("Sin resultado aún o sin coincidencia en la API:", m.home, "-", m.away);
  }
  if (!ops.length) return;
  // se guarda directamente en la base de datos, igual que si lo hiciera el admin desde /api
  const r2 = await estado.applyOpsN(ops);   // además de guardar, devuelve los avisos de resultado
  console.log("Resultados guardados:", ops.length);
  await enviar(env, estado, r2.jobs);
}

// ==== WEBPUSH START ====
// Web Push (RFC 8291 aes128gcm + VAPID RFC 8292) con WebCrypto, sin librerías.
const te = new TextEncoder();
const b64uEnc = (buf) => { const a = new Uint8Array(buf); let s = ""; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const b64uDec = (s) => { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); s += "=".repeat((4 - (s.length % 4)) % 4); const b = atob(s), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };
const cat = (...xs) => { const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of xs) { o.set(x, p); p += x.length; } return o; };

async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

// Cifra el mensaje para una suscripción { p: p256dh, a: auth }. "fijo" solo se usa en las pruebas (clave efímera y sal conocidas).
async function pushCifrar(sub, texto, fijo) {
  const uaPub = b64uDec(sub.p), auth = b64uDec(sub.a);
  let asPriv, asPub;
  if (fijo) { asPriv = fijo.priv; asPub = fijo.pub; }
  else { const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]); asPriv = kp.privateKey; asPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)); }
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPriv, 256));
  const prk = await hkdf(auth, ecdh, cat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = fijo ? fijo.salt : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, prk, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const claro = cat(te.encode(texto), new Uint8Array([2]));   // 0x02 = último (y único) bloque
  const cif = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, claro));
  return cat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPub.length]), asPub, cif);   // cabecera: sal + tamaño de bloque (4096) + clave pública
}

let _vapidKey = null;
async function vapidFirma(env, audience) {
  if (!_vapidKey || _vapidKey.k !== env.VAPID_PRIVATE) {
    const pub = b64uDec(env.VAPID_PUBLIC);
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE, x: b64uEnc(pub.slice(1, 33)), y: b64uEnc(pub.slice(33, 65)), ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    _vapidKey = { k: env.VAPID_PRIVATE, key };
  }
  const h = b64uEnc(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const p = b64uEnc(te.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || "mailto:avisos@superpredict.app" })));
  const firma = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, _vapidKey.key, te.encode(h + "." + p)));
  return h + "." + p + "." + b64uEnc(firma);
}

// Envía un aviso a una suscripción { e: endpoint, p, a }. Devuelve el código HTTP del servicio de push (404/410 = suscripción caducada).
async function pushEnviar(env, sub, payload, ttl, signal) {
  const cuerpo = await pushCifrar(sub, JSON.stringify(payload));
  const jwt = await vapidFirma(env, new URL(sub.e).origin);
  const r = await fetch(sub.e, {
    method: "POST",
    headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(ttl || 6 * 3600), Urgency: "high", Authorization: "vapid t=" + jwt + ", k=" + env.VAPID_PUBLIC },
    body: cuerpo,
    signal,
  });
  return r.status;
}
// ==== WEBPUSH END ====

// ======================= Avisos (notificaciones push) =======================
// Qué se avisa y cuándo:
//  - Nueva jornada publicada (al guardarse el partido nuevo)         → todos los jugadores
//  - Cierre de pronósticos: 6 h, 3 h y 1 h antes (cron cada 5 min)     → solo quien aún no ha pronosticado
//  - Resultado del partido con los puntos ganados (al guardarse)      → quien pronosticó
//  - Penaltis: duelo nuevo, o el rival ya ha jugado y te toca a ti     → el jugador al que le toca
//  - Mensaje del admin (ruta /api/push/admin)                         → todos o un jugador
// Cada aviso se apunta en un registro ("pushlog") para no enviarse dos veces.
const HORA = 36e5, CIERRE = 36e5;   // las apuestas cierran 1 h antes del partido, igual que en la app
// Pestaña que se abre al tocar cada aviso (por el principio de la etiqueta del aviso): jugar = Inicio, tabla = Clasificación
const TAB_AVISO = { jornada: "jugar", cierre: "jugar", votacion: "jugar", votorec: "jugar", pocion: "jugar", reto: "jugar", turno: "jugar", duelo: "jugar", resultado: "tabla", trofeo: "historial", clasif: "jugar", nominado: "jugar", votobdo: "jugar" };
// Partidos de liga abiertos que el jugador aún no ha pronosticado: es el número rojo del icono de la app
const pendientes = (st, pid, now) => {
  let n = 0;
  for (const m of st.matches || []) {
    if (m.comp || m.result) continue;
    const k = Date.parse(m.kickoff); if (!k || k - CIERRE <= now) continue;
    const q = ((st.preds || {})[m.id] || {})[pid];
    if (!(q && typeof q.h === "number")) n++;
  }
  return n;
};
const RECORDATORIOS = [1];    // horas que quedan para el cierre (solo 1 hora antes, para no saturar)
const esp = (ms, o) => new Date(ms).toLocaleString("es-ES", Object.assign({ timeZone: "Europe/Madrid" }, o));
const fechaEs = (ms) => esp(ms, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const horaEs = (ms) => esp(ms, { hour: "2-digit", minute: "2-digit" });
const unidad = (n) => (Math.abs(n) === 1 ? "punto" : "puntos");

// ---- Puntos: misma lógica que la app ----
const pt1 = (q, r) => (q.h === r.h && q.a === r.a ? 3 : q.h === r.h || q.a === r.a ? 1 : 0);
function effPred(p) {
  if (!p || !p.mods || !p.mods.length) return p;
  const sm = (k, w) => p.mods.reduce((n, x) => n + (!x.w || x.w === w ? x[k] || 0 : 0), 0);
  const o = { ...p, h: Math.max(0, p.h + sm("dh", 1)), a: Math.max(0, p.a + sm("da", 1)) };
  if (p.h2 != null) { o.h2 = Math.max(0, p.h2 + sm("dh", 2)); o.a2 = Math.max(0, p.a2 + sm("da", 2)); }
  return o;
}
function ptsBase(p, r) {
  if (!p || !r || typeof p.h !== "number") return 0;
  const e = effPred(p); let x = pt1(e, r);
  if (e.h2 != null) x = Math.max(x, pt1({ h: e.h2, a: e.a2 }, r));
  return x;
}
function ptsPocion(p, r) {
  if (!p || !r || typeof p.h !== "number") return 0;
  const b = ptsBase(p, r);
  if (p.pot === "doble") return b > 0 ? b * 2 : -1;
  if (p.pot === "salva") return b === 0 ? 1 : b;
  return b;
}
function rondasCalculadas(st) {
  const by = {};
  st.matches.filter((m) => !m.comp).forEach((m) => { (by[m.round] = by[m.round] || []).push(m); });
  return Object.keys(by).map(Number).filter((r) => by[r].every((m) => m.result)).sort((a, b) => a - b);
}
function bonusRacha(st, pid, rs) {   // +1 desde la 3ª jornada seguida puntuando
  const out = {}; let racha = 0;
  rs.forEach((r) => {
    const base = st.matches.filter((m) => m.round === r).reduce((n, m) => n + ptsBase((st.preds[m.id] || {})[pid], m.result), 0);
    if (base > 0) { racha++; if (racha >= 3) out[r] = 1; } else racha = 0;
  });
  return out;
}

// ---- Penaltis: ronda en la que va el duelo vista desde un jugador (own = su ficha, riv = la del rival) ----
function penSiguiente(own, riv) {
  const os = own.s || [], ok = own.k || [], rs = riv.s || [], rk = riv.k || [];
  let gO = 0, gR = 0;
  for (let r = 0; r < 10; r++) {
    const oO = os[r] != null && ok[r] != null, oR = rs[r] != null && rk[r] != null;
    if (!(oO && oR)) return { over: false, r, ownOk: oO, rivOk: oR };
    gO += os[r] !== rk[r] ? 1 : 0; gR += rs[r] !== ok[r] ? 1 : 0;
    if (Math.abs(gO - gR) > Math.max(0, 3 - (r + 1))) return { over: true };
  }
  return { over: true };
}
const amTs = (k) => parseInt(String(k).slice(1), 36) || 0;   // hora de un reto amistoso (va en su clave)

// ---- Generadores de avisos: devuelven [{ pid, title, body, tag }] ----
const reales = (st) => st.players.filter((p) => p.regAt && !p.sim);

function avisosNuevaJornada(st, antes, now, once) {
  const out = [];
  for (const m of st.matches) {
    if (m.comp || antes.ids.has(m.id)) continue;
    const k = Date.parse(m.kickoff); if (!k || k - CIERRE <= now) continue;
    if (!once(`j:${m.round}|${m.home}|${m.away}`)) continue;
    for (const p of reales(st)) out.push({ pid: p.id, tag: "jornada-" + m.round, title: "🆕 ¡Nueva jornada!", body: `J${m.round}: ${m.home} vs ${m.away}.\nCierre: ${fechaEs(k - CIERRE)}.` });
  }
  return out;
}

function avisosResultado(st, antes, once) {
  const out = [];
  for (const m of st.matches) {
    if (m.comp || !m.result || antes.res[m.id] !== false) continue;   // solo partidos que acaban de recibir resultado
    if (!once("r:" + m.id)) continue;
    const rs = rondasCalculadas(st), conRonda = rs.includes(m.round), r = m.result;
    for (const p of reales(st)) {
      const q = (st.preds[m.id] || {})[p.id];
      if (!q || typeof q.h !== "number") continue;
      const bonus = conRonda ? bonusRacha(st, p.id, rs)[m.round] || 0 : 0;
      const total = ptsPocion(q, r) + bonus, base = ptsBase(q, r);
      const extra = [];
      if (q.pot === "doble") extra.push("Doble filo 🧪");
      if (q.pot === "salva" && base === 0) extra.push("Salvavidas 🧪");
      if (bonus) extra.push("+1 por racha 🔥");
      out.push({ pid: p.id, tag: "resultado-" + m.id, title: `🏁 Final: ${m.home} ${r.h}-${r.a} ${m.away}`, body: `${total > 0 ? "+" : ""}${total} ${unidad(total)} ${total > 0 ? "✅" : total < 0 ? "😢" : "❌"}` + (extra.length ? " " + extra.join(" ") : "") });
    }
  }
  return out;
}

// Cambiaforma: avisa al jugador al que le han retocado la predicción (Visión es secreta, no se avisa).
const modsActuales = (st) => {
  const s = new Set();
  for (const mid of Object.keys(st.preds)) for (const pid of Object.keys(st.preds[mid])) { const q = st.preds[mid][pid]; if (q && Array.isArray(q.mods) && q.mods.length) s.add(mid + ">" + pid); }
  return s;
};
const modTxt = (m, x) => (x.dh ? (x.dh > 0 ? "+1 gol a " : "-1 gol a ") + m.home : (x.da > 0 ? "+1 gol a " : "-1 gol a ") + m.away) + (x.w ? " (marcador " + x.w + ")" : "");

function avisosPocion(st, antes, once) {
  const out = [], by = new Map(st.players.map((p) => [p.id, p]));
  for (const m of st.matches) {
    for (const pid of Object.keys(st.preds[m.id] || {})) {
      const q = st.preds[m.id][pid];
      if (!q || !Array.isArray(q.mods) || !q.mods.length || antes.mods.has(m.id + ">" + pid)) continue;
      const v = by.get(pid); if (!v || v.sim || !v.regAt) continue;
      if (!once(`p:${m.id}:${pid}`)) continue;
      const x = q.mods[0], autor = (by.get(x.by) || {}).name || "Un rival";
      out.push({ pid, tag: `pocion-${m.id}`, title: "🧪 ¡Te han lanzado una poción!", body: `${autor} ha usado Cambiaforma.\n${modTxt(m, x)}.` });
    }
  }
  return out;
}

// ==== VOTACION START ====
// Votación del siguiente partido: se abre el viernes a las 14:00 y cierra el domingo a las 23:59 (hora de Madrid), igual que en la app.
// El administrador puede cancelarla o repetirla (queda en p.vctl de cada ficha). Cada jugador guarda su voto en p.vot.
const VOT_INI = "2026-11-06", VOT_JORNADAS = 20;   // primera votación y número total de jornadas (CONFIG.jornadas de la app)
function madridWall(ms) {   // hora de Madrid expresada como si fuera UTC, para sumar días sin líos de cambio de hora
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
}
function madridEpoch(wall) {   // al revés: de "hora de Madrid como UTC" al instante real
  let e = wall - 36e5;
  e = wall - Math.round((madridWall(e) - e) / 36e5) * 36e5;
  return wall - Math.round((madridWall(e) - e) / 36e5) * 36e5;
}
function votFase(st, now) {   // misma lógica que votFase() de la app
  const wall = madridWall(now), d = new Date(wall), back = (d.getUTCDay() - 5 + 7) % 7;
  let fri = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back, 14, 0);
  if (fri > wall) fri -= 7 * 864e5;   // viernes antes de las 14:00: aún cuenta la votación anterior
  const mid = fri - 14 * 36e5;
  let c = { r: 0, c: 0, x: 0, t: -1 };   // lo que haya fijado el admin (cancelar / repetir)
  const w = new Date(fri).toISOString().slice(0, 10);
  for (const q of st.players || []) { const v = q.vctl; if (v && v.w === w && ((v.r || 0) > c.r || ((v.r || 0) === c.r && (v.t || 0) > c.t))) c = { r: v.r || 0, c: v.c ? 1 : 0, x: v.x || 0, t: v.t || 0 }; }
  const close = c.x || madridEpoch(mid + 2 * 864e5 + 23 * 36e5 + 59 * 6e4 + 59e3);   // domingo 23:59:59 (o la nueva hora si se repitió tarde)
  return { w, r: c.r, x: c.x, can: !!c.c, close, ab: !c.c && now <= close, cerrada: !c.c && now > close, desde: new Date(mid + 3 * 864e5).toISOString().slice(0, 10) };
}
const votFinalCreada = (st) => (st.matches || []).some((m) => !m.comp && m.round === VOT_JORNADAS);   // jornada final ya creada: no hay más votaciones
const votSinVotar = (st, f) => reales(st).filter((p) => !(p.vot && p.vot.w === f.w && (p.vot.r || 0) === f.r));
const votCierreTxt = (f) => (f.x ? esp(f.x, { weekday: "long" }) + " a las " + horaEs(f.x) : "domingo a las 23:59");

// Aviso: votación abierta (o reabierta si el admin la repite). Quien ya votó no lo recibe.
function avisosVotacion(st, now, once) {
  const f = votFase(st, now);
  if (f.w < VOT_INI || !f.ab || votFinalCreada(st)) return [];
  const aviso = votSinVotar(st, f);
  if (!aviso.length || !once(`v:${f.w}:${f.r}`)) return [];
  const title = f.r ? "🗳️ Votación reabierta" : "🗳️ ¡Votación abierta!";
  const body = (f.r ? "Se han borrado los votos: vuelve a votar." : "Elige el partido de la próxima jornada.") + `\nCierra el ${votCierreTxt(f)}.`;
  return aviso.map((p) => ({ pid: p.id, tag: "votacion-" + f.w, title, body }));
}
// Aviso: queda 1 hora para votar (solo a quien aún no ha votado)
function avisosVotoRecordatorio(st, now, once) {
  const f = votFase(st, now);
  if (f.w < VOT_INI || !f.ab || votFinalCreada(st)) return [];
  const quedan = f.close - now, T = 1;
  if (!(quedan <= T * HORA && quedan > T * HORA - 25 * 6e4)) return [];   // ventana de 25 min por si algún cron se retrasa
  const aviso = votSinVotar(st, f);
  if (!aviso.length || !once(`vr:${f.w}:${f.r}`)) return [];
  const body = `Aún no has votado el partido de la próxima jornada.\nCierra a las ${horaEs(f.close)}.`;
  return aviso.map((p) => ({ pid: p.id, tag: "votorec-" + f.w, title: "🗳️ ¡Queda 1 hora para votar!", body }));
}

// ---- Cierre automático: al cerrarse la votación, el partido ganador pasa a ser el partido de la semana (antes lo creaba el primer móvil que abría la app) ----
const votN = NF;
// Nivel de cada equipo (0-10) para elegir los mejores partidos de la semana. Los que no estén aquí cuentan como 3.
const VOT_NV = Object.fromEntries(Object.entries({
  "Real Madrid": 10, "Barcelona": 10, "Atlético de Madrid": 9, "Villarreal": 7, "Athletic Club": 7, "Real Betis": 6.5, "Real Sociedad": 6, "Sevilla FC": 5.5, "Valencia": 5, "Celta de Vigo": 5, "Osasuna": 4.5, "Getafe": 4.5, "Rayo Vallecano": 4.5, "Alavés": 4, "Espanyol": 4, "Elche": 3.5, "Levante": 3.5, "Deportivo": 3, "Málaga": 3, "Racing de Santander": 3,
  "Manchester City": 10, "Arsenal": 10, "Liverpool": 9.5, "Chelsea": 8.5, "Manchester United": 8, "Tottenham": 8, "Newcastle United": 8, "Aston Villa": 7.5, "Brighton": 6, "Crystal Palace": 6, "Bournemouth": 6, "Nottingham Forest": 5.5, "Brentford": 5.5, "Fulham": 5.5, "Everton": 5.5, "Leeds United": 5, "Sunderland": 4.5, "Coventry City": 3.5, "Ipswich Town": 3.5, "Hull City": 3,
  "Bayern München": 10, "Bayer Leverkusen": 8.5, "Borussia Dortmund": 8.5, "RB Leipzig": 8, "Eintracht Frankfurt": 6.5, "Stuttgart": 6.5, "Freiburg": 5.5, "Hoffenheim": 5, "Borussia Mönchengladbach": 4.5, "Werder Bremen": 4.5, "Union Berlin": 4.5, "Mainz 05": 4.5, "Augsburg": 4, "Köln": 4, "Hamburger SV": 4, "Schalke 04": 3.5, "Paderborn": 3, "Elversberg": 3,
  "Inter": 9.5, "Napoli": 8.5, "Juventus": 8.5, "Milan": 8.5, "Atalanta": 8, "Roma": 7.5, "Lazio": 7, "Fiorentina": 6, "Bologna": 6, "Torino": 5, "Como": 5, "Genoa": 4.5, "Udinese": 4.5, "Sassuolo": 4, "Cagliari": 4, "Parma": 4, "Lecce": 3.5, "Monza": 3.5, "Venezia": 3.5, "Frosinone": 3,
  "Paris Saint-Germain": 9.5, "Marseille": 7, "Monaco": 7, "Lille": 6.5, "Lyon": 6.5, "Lens": 6, "Nice": 5.5, "Rennes": 5.5, "Strasbourg": 5, "Brest": 4.5, "Toulouse": 4, "Paris FC": 4, "Lorient": 3.5, "Auxerre": 3.5, "Angers": 3, "Le Havre": 3, "Le Mans": 2.5, "Troyes": 2.5,
  "Sporting CP": 7, "Porto": 6.5, "PSV": 6.5, "Club Brugge": 6, "Feyenoord": 6, "Galatasaray": 6, "Fenerbahçe": 5.5, "Bodø/Glimt": 4.5, "Shaktar": 4.5, "Slavia Praha": 4.5, "PAE AEK": 4, "LASK": 3, "Sl. Bratislava": 3, "Viking": 3, "Sabah FK": 2.5
}).map(([k, v]) => [votN(k), v]));
const votNv = n => { const v = VOT_NV[votN(n)]; return v == null ? 3 : v; };
// Nivel del partido: pesa más que los dos equipos sean fuertes (un grande contra un flojo puntúa menos); la Champions suma un extra. También desempata la votación.
const votScore = c => { const a = votNv(c.h), b = votNv(c.a); return a + b + Math.min(a, b) + (c.c === "CL" ? 1.5 : 0); };
// Derbis: entran siempre en la votación (dentro del máximo de 8)
const VOT_DERBIS = new Set([
  ["Real Madrid", "Atlético de Madrid"], ["Real Madrid", "Barcelona"], ["Barcelona", "Espanyol"], ["Sevilla FC", "Real Betis"], ["Athletic Club", "Real Sociedad"], ["Valencia", "Levante"], ["Deportivo", "Celta de Vigo"],
  ["Manchester United", "Manchester City"], ["Manchester United", "Liverpool"], ["Liverpool", "Everton"], ["Arsenal", "Tottenham"], ["Arsenal", "Chelsea"], ["Chelsea", "Tottenham"], ["Crystal Palace", "Brighton"], ["Newcastle United", "Sunderland"],
  ["Borussia Dortmund", "Schalke 04"], ["Bayern München", "Borussia Dortmund"], ["Hamburger SV", "Werder Bremen"], ["Köln", "Borussia Mönchengladbach"], ["Eintracht Frankfurt", "Mainz 05"],
  ["Inter", "Milan"], ["Roma", "Lazio"], ["Juventus", "Torino"], ["Juventus", "Inter"],
  ["Paris Saint-Germain", "Marseille"], ["Paris Saint-Germain", "Paris FC"], ["Lyon", "Marseille"], ["Monaco", "Nice"], ["Lille", "Lens"],
  ["Galatasaray", "Fenerbahçe"]
].map(([x, y]) => [votN(x), votN(y)].sort().join("|")));
const votDerbi = (h, a) => VOT_DERBIS.has([votN(h), votN(a)].sort().join("|"));
function votTop(list) {   // máximo 8: primero los derbis (siempre entran) y el resto de huecos, con los mejores por nivel; de mejor a peor
  const ord = list.slice().sort((x, y) => votScore(y) - votScore(x) || Date.parse(x.t) - Date.parse(y.t) || (x.k < y.k ? -1 : 1));
  const der = ord.filter(c => votDerbi(c.h, c.a)).slice(0, 8), usado = new Set(der.map(c => c.k));
  const res = der.concat(ord.filter(c => !usado.has(c.k)).slice(0, 8 - der.length)), ks = new Set(res.map(c => c.k));
  return ord.filter(c => ks.has(c.k));
}
const VOT_EQUIPOS = ["Alavés", "Athletic Club", "Atlético de Madrid", "Barcelona", "Celta de Vigo", "Deportivo", "Elche", "Espanyol", "Getafe", "Levante", "Málaga", "Osasuna", "Racing de Santander", "Rayo Vallecano", "Real Betis", "Real Madrid", "Real Sociedad", "Sevilla FC", "Valencia", "Villarreal", "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton", "Chelsea", "Coventry City", "Crystal Palace", "Everton", "Fulham", "Hull City", "Ipswich Town", "Leeds United", "Liverpool", "Manchester City", "Manchester United", "Newcastle United", "Nottingham Forest", "Sunderland", "Tottenham", "Augsburg", "Bayer Leverkusen", "Bayern München", "Borussia Dortmund", "Borussia Mönchengladbach", "Eintracht Frankfurt", "Elversberg", "Freiburg", "Hamburger SV", "Hoffenheim", "Köln", "Mainz 05", "Paderborn", "RB Leipzig", "Schalke 04", "Stuttgart", "Union Berlin", "Werder Bremen", "Atalanta", "Bologna", "Cagliari", "Como", "Fiorentina", "Frosinone", "Genoa", "Inter", "Juventus", "Lazio", "Lecce", "Milan", "Monza", "Napoli", "Parma", "Roma", "Sassuolo", "Torino", "Udinese", "Venezia", "Angers", "Auxerre", "Brest", "Le Havre", "Le Mans", "Lens", "Lille", "Lorient", "Lyon", "Marseille", "Monaco", "Nice", "Paris FC", "Paris Saint-Germain", "Rennes", "Strasbourg", "Toulouse", "Troyes", "Bodø/Glimt", "Club Brugge", "Fenerbahçe", "Feyenoord", "Galatasaray", "LASK", "PAE AEK", "Porto", "PSV", "Sabah FK", "Shaktar", "Sl. Bratislava", "Slavia Praha", "Sporting CP", "Viking"];
const votMapW = (t) => {   // equipo de la API → nombre de la app (misma lógica que votMap de la app)
  const ns = [NF(t && t.name), NF(t && t.shortName), NF(t && t.tla)].filter(Boolean);
  let best = null, bs = 0;
  for (const a of VOT_EQUIPOS) {
    const n = NF(a), ta = TF(n);
    const sc = ns.includes(n) || (ALIAS_F[n] || []).some((x) => ns.includes(x)) ? 3 : ns.some((x) => (" " + x + " ").includes(" " + n + " ")) ? 2 : ns.some((x) => ta.length && ta.every((q) => TF(x).includes(q))) ? 1 : 0;
    if (sc > bs) { bs = sc; best = a; }
  }
  return bs >= 1 ? best : null;
};
async function votCandidatos(env, f) {   // partidos de la semana siguiente (lunes a domingo): los 8 mejores + derbis. Solo si nadie ha votado
  const token = env.FOOTBALL_DATA_TOKEN; if (!token) { console.error("Falta FOOTBALL_DATA_TOKEN"); return []; }
  const ini = Date.parse(f.desde + "T00:00:00Z"), fin = ini + 7 * DIA, min = f.close + CIERRE;
  const r = await fetch(`https://api.football-data.org/v4/matches?competitions=${CAL_COMPS}&dateFrom=${f.desde}&dateTo=${day(fin)}`, { headers: { "X-Auth-Token": token } });
  if (!r.ok) { console.error("votación: football-data.org respondió", r.status); return []; }
  const { matches = [] } = await r.json(), seen = new Set();
  const list = matches
    .filter((m) => !["CANCELLED", "POSTPONED", "SUSPENDED"].includes(m.status))
    .filter((m) => { const k = Date.parse(m.utcDate); return k >= ini && k < fin; })
    .map((m) => { const h = votMapW(m.homeTeam), a = votMapW(m.awayTeam), ms = Date.parse(m.utcDate); return h && a && ms > min ? { k: h + "|" + a + "|" + ms, h, a, t: new Date(ms).toISOString(), c: (m.competition && m.competition.code) || "" } : null; })
    .filter((c) => c && !seen.has(c.k) && seen.add(c.k));
  return votTop(list);
}
async function votCierreServidor(env, estado) {   // lo llama el cron cada 5 min
  const st = (await estado.getState()) || {};
  st.players ||= []; st.matches ||= []; st.preds ||= {};
  const now = Date.now(), f = votFase(st, now);
  if (!st.players.length || !f.cerrada || f.w < VOT_INI || votFinalCreada(st)) return;
  const id = "vt" + f.w + (f.r ? "r" + f.r : "");
  if (st.matches.some((m) => m.id === id || m.vw === f.w)) return;   // ya creado (por aquí o por un móvil)
  const cuenta = {};
  for (const q of st.players) { const v = q.vot; if (v && v.w === f.w && (v.r || 0) === f.r && v.k) (cuenta[v.k] ||= { n: 0, c: v }).n++; }
  let L = Object.values(cuenta);
  if (L.length) { const mx = Math.max(...L.map((x) => x.n)); L = L.filter((x) => x.n === mx); }   // más votado; si hay empate, el mejor partido
  else L = (await votCandidatos(env, f)).map((c) => ({ n: 0, c }));   // nadie votó: el mejor de la semana
  if (!L.length) return;
  L.sort((x, y) => votScore(y.c) - votScore(x.c) || Date.parse(x.c.t) - Date.parse(y.c.t));
  const g = L[0].c, lg = st.matches.filter((m) => !m.comp);
  const round = lg.length ? Math.min(VOT_JORNADAS, Math.max(...lg.map((m) => m.round)) + 1) : 1;
  const m = { id, vw: f.w, round, home: g.h, away: g.a, kickoff: g.t, result: null };
  if (lg.some((x) => x.round === round) || Date.parse(m.kickoff) - CIERRE <= now) return;   // tope de jornadas, o el partido ya no se puede predecir
  const r2 = await estado.applyOpsN([{ c: "matches", id, set: m }]);   // además de guardar, devuelve el aviso de "Nueva jornada"
  console.log("Votación cerrada: partido elegido", g.h, "-", g.a);
  await enviar(env, estado, r2.jobs);
}
// ==== VOTACION END ====

function avisosCierre(st, now, once) {
  const out = [];
  for (const m of st.matches) {
    if (m.comp || m.result) continue;
    const k = Date.parse(m.kickoff); if (!k) continue;
    const quedan = k - CIERRE - now; if (quedan <= 0) continue;
    for (const T of RECORDATORIOS) {
      if (!(quedan <= T * HORA && quedan > T * HORA - 25 * 6e4)) continue;   // ventana de 25 min por si algún cron se retrasa
      if (!once(`c:${m.id}:${T}`)) continue;
      for (const p of reales(st)) {
        const q = (st.preds[m.id] || {})[p.id]; if (q && typeof q.h === "number") continue;   // ya pronosticó
        out.push({ pid: p.id, tag: `cierre-${m.id}`, title: T === 1 ? "⏰ ¡Queda 1 hora para el cierre!" : `⏰ Quedan ${T} horas para el cierre`, body: `J${m.round}: ${m.home} vs ${m.away}\nCierra a las ${horaEs(k - CIERRE)} y aún no has puesto tu pronóstico…` });
      }
    }
  }
  return out;
}

// ---- Trofeo ganado: la app apunta cada copa automática en p.premios («s<temporada>:<copa>»); un apunte nuevo = copa nueva en la vitrina ----
const TRO_TXT = { spl: "la liga", ucl: "la Champions League", uel: "la Europa League", uecl: "la Conference League", bdo: "el Balón de Oro" };
function avisosTrofeo(st, antes, once) {
  const out = [];
  for (const p of reales(st)) {
    const ya = new Set((antes.prem || {})[p.id] || []);
    for (const k of Array.isArray(p.premios) ? p.premios : []) {
      if (!/^s/.test(k) || ya.has(k)) continue;
      const id = k.split(":")[1], t = TRO_TXT[id]; if (!t || !once(`tr:${p.id}:${k}`)) continue;
      out.push({ pid: p.id, tag: "trofeo-" + k, title: "🏆 ¡Trofeo ganado!", body: `¡Has ganado ${t}! Ya está en tu vitrina.` });
    }
  }
  return out;
}
// ---- Clasificado a una competición europea: cuando un cruce europeo recibe a sus jugadores (semifinales, final) ----
const COMP_TXT = { champions: "Champions League", europa: "Europa League", conference: "Conference League" };
function avisosClasificado(st, antes, once) {
  const out = [], by = new Map(st.players.map((p) => [p.id, p]));
  for (const m of st.matches) {
    if (!m.comp || !Array.isArray(m.pl) || m.pl.length < 2 || (antes.pl || {})[m.id] === m.pl.join(",")) continue;
    const c = COMP_TXT[m.comp]; if (!c) continue;
    for (const pid of m.pl) {
      const q = by.get(pid), riv = by.get(m.pl.find((x) => x !== pid)); if (!q || q.sim || !q.regAt || !riv || !once(`q:${m.id}:${pid}`)) continue;
      const final = m.comp === "champions" && m.stage === "final";
      out.push({ pid, tag: "clasif-" + m.id, title: final ? "🏆 ¡Estás en la final!" : "🌍 ¡Te has clasificado!", body: final ? `Has llegado a la final de la ${c} contra ${riv.name}. ¡Haz tu pronóstico!` : `Te has clasificado a la ${c}. Juegas contra ${riv.name}. ¡Haz tu pronóstico!` });
    }
  }
  return out;
}
// ---- Balón de Oro: al abrirse la votación, los nominados reciben «estás nominado» y el resto «a votar» (la app apunta en p.bdo.nm si el jugador es nominado) ----
function avisosBalon(st, antes, once) {
  const out = [];
  for (const p of reales(st)) {
    if (!p.bdo || !p.bdo.t || typeof p.bdo.nm !== "number") continue;
    const ant = (antes.bdo || {})[p.id] || "";
    if (ant && ant.split("|")[0] === String(p.bdo.s)) continue;   // ya estaba abierta esta temporada
    if (!once(`bd:${p.bdo.s}:${p.id}`)) continue;
    out.push(p.bdo.nm
      ? { pid: p.id, tag: "nominado-" + p.bdo.s, title: "⭐️ ¡Estás nominado!", body: "Estás nominado al Balón de Oro. Los demás ya pueden votar." }
      : { pid: p.id, tag: "votobdo-" + p.bdo.s, title: "🗳️ ¡Vota al Balón de Oro!", body: `Elige al mejor jugador de la temporada. Cierra el ${fechaEs(p.bdo.t + 48 * HORA)}.` });
  }
  return out;
}
function avisosPenaltis(st, now, once) {
  const out = [], by = new Map(st.players.map((p) => [p.id, p]));
  for (const p of st.players) {
    if (!p.pen) continue;
    for (const k of Object.keys(p.pen)) {
      const e = p.pen[k]; if (!e || !e.o) continue;
      const o = by.get(e.o); if (!o) continue;
      const f = o.pen && o.pen[k] && o.pen[k].o === p.id ? o.pen[k] : null;
      const tipo = k[0] === "a" ? "amistoso" : k[0] === "w" ? "semanal" : "europeo";
      if (tipo === "amistoso") {
        if (now - amTs(k) > 7 * 864e5) continue;
        // reto recién enviado: p es el retador y el retado aún no ha respondido
        if (e.f === 1 && !f && !e.x && now - amTs(k) <= 48 * HORA && !o.sim && o.regAt && once(`i:${k}:${o.id}`))
          out.push({ pid: o.id, tag: "reto-" + k, title: "🤝🏼Reto Amistoso", body: `${p.name} te reta a una tanda de penaltis. Acepta el reto desde la pestaña de inicio.` });
      }
      if (!f || e.x || f.x || p.sim || !p.regAt) continue;
      const nx = penSiguiente(e, f);
      if (nx.over || nx.ownOk) continue;
      if (nx.rivOk) {
        if (once(`t:${k}:${nx.r}:${p.id}`)) out.push({ pid: p.id, tag: "turno-" + k, title: "⚽️¡Es tu turno!", body: `${o.name} ya ha jugado la ronda ${nx.r + 1} de vuestra tanda. ¡Te toca!` });
      } else if (nx.r === 0 && once(`n:${k}:${p.id}`)) {
        out.push({ pid: p.id, tag: "duelo-" + k, title: tipo === "europeo" ? "🏆 Desempate por penaltis" : tipo === "amistoso" ? "🤝 Reto amistoso listo" : "⚽Duelo de penaltis", body: `Tienes una tanda contra ${o.name}. ¡Entra a jugarla!` });
      }
    }
  }
  return out;
}

// ======================= Rutas =======================
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// ======================= Envío y rutas de avisos =======================
async function enviar(env, estado, jobs) {
  if (!jobs || !jobs.length) return { enviados: 0, fallidos: 0 };
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) { console.error("Faltan VAPID_PUBLIC / VAPID_PRIVATE"); return { enviados: 0, fallidos: jobs.length, error: "Faltan las claves VAPID" }; }
  const caducadas = []; let enviados = 0, fallidos = 0;
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  await Promise.all(jobs.map(async (j) => {
    // hasta 3 intentos: los servicios de push (Apple, Google, Mozilla) fallan a veces con 429/5xx o cortes de red
    let code = 0, err = null;
    for (let i = 0; i < 3; i++) {
      try {
        const ac = new AbortController(), to = setTimeout(() => ac.abort(), 8000);
        try { code = await pushEnviar(env, j.sub, j.payload, 0, ac.signal); } finally { clearTimeout(to); }
        err = null;
        if (code >= 200 && code < 300) break;
        if (code === 404 || code === 410) break;   // suscripción caducada: no tiene sentido reintentar
        if (code !== 429 && code < 500) break;     // error nuestro (400/401/403…): reintentar no lo arregla
      } catch (e) { err = e; code = 0; }
      if (i < 2) await espera(500 * (i + 1) * (i + 1));
    }
    if (code >= 200 && code < 300) enviados++;
    else {
      fallidos++;
      if (code === 404 || code === 410) caducadas.push(j.sub.e);
      else console.error("push falló", code, err && err.message, new URL(j.sub.e).origin);
    }
  }));
  if (caducadas.length) { try { await estado.pushUnsubscribe(caducadas); } catch (e) {} }
  return { enviados, fallidos };
}

// ======================= Copias de seguridad (solo con el PIN de administrador) =======================
async function backupRoutes(req, env, estado, p) {
  if (req.method !== "POST") return json({ error: "método no permitido" }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  b = b || {};
  if (!env.ADMIN_PIN) return json({ error: "Falta el secreto ADMIN_PIN en Cloudflare" }, 500);
  if (String(b.pin || "") !== String(env.ADMIN_PIN)) return json({ error: "PIN incorrecto" }, 403);
  const id = b.id ? String(b.id) : "";
  if (p === "/api/backup/list") return json({ copias: await estado.backupLista() });
  if (p === "/api/backup/save") return json({ ok: true, copia: await estado.backupCrear(b.label, b.tipo) });
  if (p === "/api/backup/export") {
    const r = await estado.backupExportar(id);
    return r ? json({ app: "SuperPredict", version: 1, exportado: new Date().toISOString(), copia: r.meta, state: r.st }) : json({ error: "copia no encontrada" }, 404);
  }
  if (p === "/api/backup/restore") return (await estado.backupRestaurar(id)) ? json({ ok: true }) : json({ error: "copia no encontrada o no válida" }, 404);
  if (p === "/api/backup/delete") return (await estado.backupBorrar(id)) ? json({ ok: true }) : json({ error: "copia no encontrada" }, 404);
  return json({ error: "ruta desconocida" }, 404);
}

async function pushRoutes(req, env, estado, ctx, p) {
  if (p === "/api/push/key" && req.method === "GET") return json({ key: env.VAPID_PUBLIC || "" });
  if (req.method !== "POST") return json({ error: "método no permitido" }, 405);
  let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  b = b || {};
  const admin = () => !!env.ADMIN_PIN && String(b.pin || "") === String(env.ADMIN_PIN);
  const cut = (s, n) => String(s || "").slice(0, n);

  if (p === "/api/push/presence") {   // latido de la app abierta (on) o aviso de que se ha cerrado / pasado a segundo plano (off)
    if (typeof b.pid !== "string" || b.pid.length > 80) return json({ error: "jugador no válido" }, 400);
    await estado.presencia(b.pid, !!b.on); return json({ ok: true });
  }
  if (p === "/api/push/demo") {   // avisos de prueba desde el panel del admin
    if (!env.ADMIN_PIN) return json({ error: "Falta el secreto ADMIN_PIN en Cloudflare" }, 500);
    if (!admin()) return json({ error: "PIN incorrecto" }, 403);
    const r = await estado.pushDemo(String(b.kind || ""), String(b.pid || ""));
    if (r.desconocido) return json({ error: "aviso desconocido" }, 400);
    if (r.sinAvisos) return json({ ok: true, enviados: 0, fallidos: 0, sinAvisos: true });
    const e = await enviar(env, estado, r.jobs);
    return json({ ok: true, ...e });
  }
  if (p === "/api/push/sub") {
    const s = b.sub || {}, k = s.keys || {};
    if (typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 600 || !k.p256dh || !k.auth || typeof b.pid !== "string") return json({ error: "suscripción no válida" }, 400);
    const ok = await estado.pushSubscribe(b.pid, { e: s.endpoint, p: String(k.p256dh), a: String(k.auth) });
    return ok ? json({ ok: true }) : json({ error: "jugador desconocido" }, 404);
  }
  if (p === "/api/push/resub") {   // el navegador renovó la suscripción por su cuenta: se sustituye la antigua por la nueva
    const s = b.sub || {}, k = s.keys || {};
    if (typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 600 || !k.p256dh || !k.auth || typeof b.old !== "string") return json({ error: "suscripción no válida" }, 400);
    const ok = await estado.pushResub(b.old, { e: s.endpoint, p: String(k.p256dh), a: String(k.auth) });
    return ok ? json({ ok: true }) : json({ error: "suscripción antigua desconocida" }, 404);
  }
  if (p === "/api/push/unsub") { await estado.pushUnsubscribe(String(b.endpoint || "")); return json({ ok: true }); }
  if (p === "/api/push/test") {   // aviso de prueba al propio móvil
    const jobs = await estado.pushJobsEndpoint(String(b.endpoint || ""), { t: "✅ Avisos activados", b: "Recibirás las novedades de Súper Predict en este móvil.", tag: "prueba", url: "/" });
    if (!jobs.length) return json({ error: "este móvil no está suscrito" }, 404);
    const r = await enviar(env, estado, jobs);
    return json({ ok: r.enviados > 0, ...r });
  }
  if (p === "/api/push/admin-check") {   // el panel de admin comprueba aquí el PIN (no está escrito en la página)
    if (!env.ADMIN_PIN) return json({ error: "Falta el secreto ADMIN_PIN en Cloudflare" }, 500);
    if (!admin()) return json({ error: "PIN incorrecto" }, 403);
    return json({ ok: true });
  }
  if (p === "/api/push/stats") {
    if (!admin()) return json({ error: "PIN incorrecto" }, 403);
    return json(await estado.pushStats());
  }
  if (p === "/api/push/admin") {
    if (!env.ADMIN_PIN) return json({ error: "Falta el secreto ADMIN_PIN en Cloudflare" }, 500);
    if (!admin()) return json({ error: "PIN incorrecto" }, 403);
    const t = cut(b.title, 80).trim(), cuerpo = cut(b.body, 300).trim();
    if (!t || !cuerpo) return json({ error: "Falta el título o el mensaje" }, 400);
    const pids = Array.isArray(b.to) ? b.to.map(String) : null;   // null = todos
    const { jobs, jugadores, omitidos } = await estado.pushJobsPara(pids, { t, b: cuerpo, tag: "admin-" + Date.now(), url: "/" });
    if (!jobs.length) return json({ ok: true, enviados: 0, fallidos: 0, jugadores: 0, omitidos });
    const r = await enviar(env, estado, jobs);
    return json({ ok: true, jugadores, omitidos, ...r });
  }
  if (p === "/api/push/forma-borrar") {   // borra las estadísticas guardadas (forma, enfrentamientos, comparativa): se vuelven a buscar al abrir el botón
    if (!env.ADMIN_PIN) return json({ error: "Falta el secreto ADMIN_PIN en Cloudflare" }, 500);
    if (!admin()) return json({ error: "PIN incorrecto" }, 403);
    await env.STORE.get(env.STORE.idFromName("cache")).borrarForma();
    return json({ ok: true });
  }
  return json({ error: "ruta desconocida" }, 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, "") || "/";
    const estado = env.STORE.get(env.STORE.idFromName("estado"));
    if (p === "/api") {
      let st;
      if (req.method === "POST") {
        let body;
        try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
        const r = await estado.applyOpsN(body && body.ops, body && body.by);
        st = r.st;
        if (r.jobs && r.jobs.length) ctx.waitUntil(enviar(env, estado, r.jobs).catch((e) => console.error("avisos:", e && e.message)));   // avisos en segundo plano
      } else st = await estado.getState();
      return json({ state: st });
    }
    if (p === "/api/version") return json({ v: (env.CF_VERSION && env.CF_VERSION.id) || "" });
    if (p.startsWith("/api/push/")) return pushRoutes(req, env, estado, ctx, p);
    if (p.startsWith("/api/backup/")) return backupRoutes(req, env, estado, p);
    if (p === "/.netlify/functions/calendario") return calendario(req, env);
    if (p === "/.netlify/functions/forma") return forma(req, env, env.STORE.get(env.STORE.idFromName("cache")));
    // la página y el resto de archivos de la carpeta public
    return env.ASSETS.fetch(p === "/" ? new Request(new URL("/index.html", url), req) : req);
  },
  // Cada 5 minutos (cron de wrangler.jsonc): resultados automáticos de los partidos de liga ya terminados y recordatorios de cierre
  async scheduled(event, env, ctx) {
    const estado = env.STORE.get(env.STORE.idFromName("estado"));
    ctx.waitUntil((async () => {
      try { await resultados(env, estado); } catch (e) { console.error("resultados:", e && e.message); }
      try { await votCierreServidor(env, estado); } catch (e) { console.error("votación:", e && e.message); }   // cierra la votación y crea el partido ganador
      try { await estado.backupCron(); } catch (e) { console.error("copia de seguridad:", e && e.message); }   // copia diaria y de fin de temporada
      try { await enviar(env, estado, await estado.pushReminders()); } catch (e) { console.error("recordatorios:", e && e.message); }   // recordatorios de cierre
    })());
  },
};
