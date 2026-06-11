/* ═══════════════════════════════════════════════════════════
   LA POLLA MUNDIALISTA 30X — lógica
   - Trae los partidos de HOY (hora Colombia) desde la API
     pública de ESPN, con respaldo embebido si falla.
   - Cierra cada partido cuando llega el pitazo inicial
     (hora de inicio o estado en-vivo/final de la API).
   - Captura nombre, correo y celular + predicciones, las
     envía a un webhook configurable y las guarda local.
   ═══════════════════════════════════════════════════════════ */

"use strict";

/* ── Supabase ──────────────────────────────────────────── */

const SUPABASE_URL = "https://qscotgrwdrjbxpuxudpv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzY290Z3J3ZHJqYnhwdXh1ZHB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExOTU5MDgsImV4cCI6MjA5Njc3MTkwOH0.n7B8g4FXCArmm3gBJO_UYelhpdRHitc9RrmPMU5NCFw";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function signUpOrIn(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password });
  if (!error) {
    // Si no hay sesión = email confirmation requerida
    if (!data.session) {
      throw new Error("¡Cuenta creada! Revisa tu correo para confirmar y luego vuelve a jugar.");
    }
    return data.user;
  }

  // Usuario ya existe → intentar sign in
  if (error.status === 422 || error.message.toLowerCase().includes("already")) {
    const { data: siData, error: siError } = await sb.auth.signInWithPassword({ email, password });
    if (siError) throw new Error("Ya tienes cuenta con ese correo. Revisa tu contraseña.");
    return siData.user;
  }
  throw error;
}

async function saveToSupabase(user, payload) {
  // Guarda nombre y celular en el metadata del usuario (visible en Auth dashboard)
  await sb.auth.updateUser({
    data: { nombre: payload.nombre, celular: payload.celular },
  });

  const { error: profileError } = await sb.from("profiles").upsert({
    id: user.id,
    nombre: payload.nombre,
    celular: payload.celular,
    updated_at: new Date().toISOString(),
  });
  if (profileError) throw profileError;

  if (payload.predicciones.length === 0) return;
  const rows = payload.predicciones.map((p) => ({
    user_id: user.id,
    fecha_partidos: payload.diaDePartidos,
    partido_id: p.partidoId,
    partido: p.partido,
    local_score: p.local,
    visitante_score: p.visitante,
    marcador: p.marcador,
    inicio: p.inicio,
  }));
  const { error: predsError } = await sb.from("predicciones").upsert(rows, { onConflict: "user_id,partido_id" });
  if (predsError) throw predsError;
}

async function loadFromSupabase(user) {
  const today = bogotaDateStr();
  const [{ data: profile }, { data: preds }] = await Promise.all([
    sb.from("profiles").select("nombre,celular").eq("id", user.id).single(),
    sb.from("predicciones").select("*").eq("user_id", user.id).eq("fecha_partidos", today),
  ]);

  if (!profile || !preds?.length) return;

  state.submitted = {
    nombre: profile.nombre,
    correo: user.email,
    celular: profile.celular,
    predicciones: preds.map((p) => ({
      partidoId: p.partido_id,
      partido: p.partido,
      local: p.local_score,
      visitante: p.visitante_score,
      marcador: p.marcador,
    })),
    ts: new Date().toISOString(),
  };
  writeJSON(STORE.submitted, state.submitted);
  for (const p of state.submitted.predicciones) {
    state.predictions[p.partidoId] = { home: p.local, away: p.visitante, touched: true };
  }
}

const CONFIG = {
  // Pega aquí tu webhook (n8n, Make, Apps Script, Zapier…).
  // Si queda vacío, las pollas se guardan en localStorage
  // y en una cola de pendientes para reintentar luego.
  WEBHOOK_URL: "",
  TZ: "America/Bogota",
  MAX_GOALS: 15,
  REFRESH_MS: 60_000, // refresco de marcadores/estados
  TICK_MS: 1_000, // cuenta regresiva
  SOON_MS: 15 * 60_000, // umbral "cierra ya"
  COLOMBIA_DEBUT_UTC: "2026-06-18T02:00:00Z", // 17 jun 9:00 p.m. COL
};

const STORE = {
  draft: "polla30x_draft",
  submitted: "polla30x_submitted",
  pending: "polla30x_pending",
};

// Respaldo solo válido para el 11 de junio de 2026 (día inaugural)
const FALLBACK_FIXTURES = {
  "2026-06-11": [
    {
      id: "mex-rsa",
      kickoff: "2026-06-11T19:00:00Z",
      tag: "Partido inaugural",
      venue: "Estadio Banorte",
      city: "Ciudad de México",
      home: { name: "México", abbr: "MEX", flag: "https://a.espncdn.com/i/teamlogos/countries/500/mex.png" },
      away: { name: "Sudáfrica", abbr: "RSA", flag: "https://a.espncdn.com/i/teamlogos/countries/500/rsa.png" },
      state: "pre", homeScore: 0, awayScore: 0, clock: "",
    },
    {
      id: "kor-cze",
      kickoff: "2026-06-12T02:00:00Z",
      tag: "Fase de grupos",
      venue: "Estadio Akron",
      city: "Guadalajara",
      home: { name: "Corea del Sur", abbr: "KOR", flag: "https://a.espncdn.com/i/teamlogos/countries/500/kors.png" },
      away: { name: "Chequia", abbr: "CZE", flag: "https://a.espncdn.com/i/teamlogos/countries/500/cze.png" },
      state: "pre", homeScore: 0, awayScore: 0, clock: "",
    },
  ],
};

const state = {
  matches: [],
  predictions: {}, // { matchId: { home, away, touched } }
  submitted: null, // { nombre, correo, celular, predicciones, ts }
  usingFallback: false,
};

const $ = (sel) => document.querySelector(sel);

/* ── Fechas y formato (siempre hora Colombia) ──────────── */

function bogotaDateStr(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CONFIG.TZ }).format(date);
}

function fmtTimeCol(ts) {
  const parts = new Intl.DateTimeFormat("es-CO", {
    timeZone: CONFIG.TZ, hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(new Date(ts));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const period = get("dayPeriod").toLowerCase().includes("p") ? "P.M." : "A.M.";
  return `${get("hour")}:${get("minute")} ${period}`;
}

function fmtTodayLabel() {
  const txt = new Intl.DateTimeFormat("es-CO", {
    timeZone: CONFIG.TZ, weekday: "long", day: "numeric", month: "short",
  }).format(new Date());
  return txt.replace(/\./g, "").toUpperCase();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return d > 0 ? `${d}D ${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/* ── Datos: ESPN con respaldo ──────────────────────────── */

function isLocked(match) {
  return match.state !== "pre" || Date.now() >= new Date(match.kickoff).getTime();
}

function mapEspnEvent(event) {
  const comp = event.competitions?.[0] ?? {};
  const side = (ha) => comp.competitors?.find((c) => c.homeAway === ha) ?? {};
  const team = (c) => ({
    name: c.team?.shortDisplayName || c.team?.displayName || "Por definir",
    abbr: c.team?.abbreviation || "?",
    flag: c.team?.logo || c.team?.logos?.[0]?.href || "",
  });
  const home = side("home");
  const away = side("away");
  const abbrs = [home.team?.abbreviation, away.team?.abbreviation];
  const isInaugural = bogotaDateStr(new Date(event.date)) === "2026-06-11" &&
    abbrs.includes("MEX") && abbrs.includes("RSA");
  return {
    id: String(event.id),
    kickoff: event.date,
    tag: isInaugural ? "Partido inaugural" : "Fase de grupos",
    venue: comp.venue?.fullName || "",
    city: comp.venue?.address?.city || "",
    home: team(home),
    away: team(away),
    state: event.status?.type?.state || "pre",
    homeScore: Number(home.score ?? 0),
    awayScore: Number(away.score ?? 0),
    clock: event.status?.displayClock || "",
    completed: Boolean(event.status?.type?.completed),
  };
}

async function fetchFixtures() {
  const today = bogotaDateStr();
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${today.replace(/-/g, "")}&lang=es&region=co`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const events = (data.events ?? [])
      .map(mapEspnEvent)
      .filter((m) => bogotaDateStr(new Date(m.kickoff)) === today)
      .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    if (events.length === 0 && FALLBACK_FIXTURES[today]) throw new Error("sin eventos");
    state.usingFallback = false;
    return events;
  } catch (err) {
    console.warn("[polla] API falló, usando respaldo:", err.message);
    state.usingFallback = true;
    return (FALLBACK_FIXTURES[today] ?? []).map((m) => ({ ...m }));
  }
}

/* ── Storage ───────────────────────────────────────────── */

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* lleno o bloqueado */ }
}

function loadSaved() {
  state.submitted = readJSON(STORE.submitted);
  const draft = readJSON(STORE.draft);
  if (draft && typeof draft === "object") state.predictions = draft;
  if (state.submitted?.predicciones) {
    for (const p of state.submitted.predicciones) {
      state.predictions[p.partidoId] = { home: p.local, away: p.visitante, touched: true };
    }
  }
}

/* ── Render de partidos ────────────────────────────────── */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function getPrediction(matchId) {
  if (!state.predictions[matchId]) {
    state.predictions[matchId] = { home: 0, away: 0, touched: false };
  }
  return state.predictions[matchId];
}

function buildStepper(match, sideKey) {
  const pred = getPrediction(match.id);
  const wrap = el("div", "stepper");
  const disabled = isLocked(match) || Boolean(state.submitted);

  const btnMinus = el("button", "stepper__btn", "−");
  btnMinus.type = "button";
  const val = el("span", "stepper__val", String(pred[sideKey]));
  const btnPlus = el("button", "stepper__btn", "+");
  btnPlus.type = "button";

  const teamName = match[sideKey].name;
  btnMinus.setAttribute("aria-label", `Quitar un gol a ${teamName}`);
  btnPlus.setAttribute("aria-label", `Sumar un gol a ${teamName}`);
  btnMinus.disabled = disabled;
  btnPlus.disabled = disabled;

  const step = (delta) => {
    const p = getPrediction(match.id);
    p[sideKey] = Math.min(CONFIG.MAX_GOALS, Math.max(0, p[sideKey] + delta));
    p.touched = true;
    val.textContent = String(p[sideKey]);
    val.classList.remove("bump");
    void val.offsetWidth; // reinicia la animación
    val.classList.add("bump");
    writeJSON(STORE.draft, state.predictions);
  };
  btnMinus.addEventListener("click", () => step(-1));
  btnPlus.addEventListener("click", () => step(1));

  wrap.append(btnMinus, val, btnPlus);
  return wrap;
}

function buildTeamRow(match, sideKey) {
  const team = match[sideKey];
  const row = el("div", "team");

  const flag = el("img", "team__flag");
  flag.alt = `Bandera de ${team.name}`;
  flag.width = 58; flag.height = 58;
  flag.loading = "lazy";
  flag.src = team.flag;
  flag.addEventListener("error", () => {
    const fallback = el("span", "team__flag", team.abbr);
    fallback.style.display = "grid";
    fallback.style.placeItems = "center";
    fallback.style.fontFamily = "var(--font-display)";
    flag.replaceWith(fallback);
  });

  row.append(flag, el("span", "team__name", team.name));

  if (isLocked(match) && match.state !== "pre") {
    const score = sideKey === "home" ? match.homeScore : match.awayScore;
    row.append(el("span", "team__score-final", String(score)));
  } else {
    row.append(buildStepper(match, sideKey));
  }
  return row;
}

function buildMatchFoot(match) {
  const foot = el("div", "match__foot");
  const time = el("span", "match__time", `⏱ ${fmtTimeCol(match.kickoff)} COL`);
  foot.append(time);

  const sent = state.submitted?.predicciones?.find((p) => p.partidoId === match.id);
  if (sent) {
    foot.append(el("span", "match__mypick", `Tu jugada: ${sent.marcador.replace("-", "–")}`));
  }

  if (!isLocked(match)) {
    const cd = el("span", "match__countdown");
    cd.dataset.kickoff = match.kickoff;
    cd.textContent = "CIERRA EN —";
    foot.append(cd);
  } else if (match.state === "in") {
    foot.append(el("span", "match__live", `En juego ${match.clock || ""}`.trim()));
  } else if (match.state === "post" || match.completed) {
    foot.append(el("span", "match__countdown", "FINAL"));
  } else {
    foot.append(el("span", "match__countdown", "CERRADO"));
  }
  return foot;
}

function buildMatchCard(match) {
  const card = el("article", "match");
  card.dataset.id = match.id;
  if (isLocked(match)) card.classList.add("match--locked");

  const top = el("div", "match__top");
  top.append(el("span", "match__tag", match.tag));
  const venueTxt = [match.venue, match.city].filter(Boolean).join(" · ");
  top.append(el("span", "match__venue", venueTxt));

  const body = el("div", "match__body");
  body.append(buildTeamRow(match, "home"));

  const divider = el("div", "match__divider");
  const vsLabel = match.state === "in"
    ? `${match.homeScore} – ${match.awayScore}`
    : "VS";
  divider.append(el("span", "match__vs", vsLabel));
  body.append(divider, buildTeamRow(match, "away"));

  card.append(top, body, buildMatchFoot(match));

  if (isLocked(match)) {
    card.append(el("div", "stamp", "Cerrado"));
  }
  return card;
}

function renderMatches() {
  const list = $("#matchList");
  list.replaceChildren();

  if (state.matches.length === 0) {
    const empty = el("div", "matches__loading", "Hoy el Mundial descansa 🥱 — vuelve mañana por más partidos.");
    list.append(empty);
    return;
  }
  for (const match of state.matches) list.append(buildMatchCard(match));

  const note = $("#matchesNote");
  if (state.usingFallback) {
    note.hidden = false;
    note.textContent = "⚠ Mostrando calendario local: no pudimos conectar con el marcador en vivo.";
  } else {
    note.hidden = true;
  }
}

/* ── Ticker, header y hero ─────────────────────────────── */

function renderChrome() {
  $("#todayLabel").textContent = fmtTodayLabel();

  const open = state.matches.filter((m) => !isLocked(m));
  $("#heroTodayBadge").textContent = state.matches.length > 0
    ? `★ Hoy juegan ${state.matches.length * 2} selecciones`
    : "★ Mundial 2026";

  const parts = state.matches.map((m) =>
    `${m.home.name} vs ${m.away.name} · ${fmtTimeCol(m.kickoff)}`.toUpperCase()
  );
  const tickerTxt = ["MUNDIAL 2026", ...parts, "COLOMBIA DEBUTA EL 17 DE JUNIO 🇨🇴", "LA POLLA MUNDIALISTA 30X — PREDICE ANTES DEL PITAZO"].join(" ★ ") + " ★ ";
  $("#tickerA").textContent = tickerTxt;
  $("#tickerB").textContent = tickerTxt;

  const headerTxt = $("#headerNextText");
  const live = state.matches.find((m) => m.state === "in");
  if (live) {
    headerTxt.textContent = `EN JUEGO: ${live.home.abbr} ${live.homeScore}–${live.awayScore} ${live.away.abbr}`;
  } else if (open.length > 0) {
    const next = open[0];
    headerTxt.textContent = `Cierra ${fmtTimeCol(next.kickoff)}: ${next.home.abbr} vs ${next.away.abbr}`;
  } else if (state.matches.length > 0) {
    headerTxt.textContent = "Predicciones de hoy cerradas";
  } else {
    headerTxt.textContent = "Hoy no hay partidos";
  }
}

/* ── Tick: cuenta regresiva + cierres ──────────────────── */

function tick() {
  const now = Date.now();

  document.querySelectorAll(".match__countdown[data-kickoff]").forEach((node) => {
    const diff = new Date(node.dataset.kickoff).getTime() - now;
    node.textContent = `CIERRA EN ${fmtCountdown(diff)}`;
    node.classList.toggle("match__countdown--soon", diff <= CONFIG.SOON_MS && diff > 0);
  });

  // ¿Algún partido acaba de empezar? → se cierra esa jugada
  let closedNow = false;
  for (const match of state.matches) {
    const card = document.querySelector(`.match[data-id="${CSS.escape(match.id)}"]`);
    if (card && isLocked(match) && !card.classList.contains("match--locked")) {
      closedNow = true;
    }
  }
  if (closedNow) {
    renderMatches();
    renderChrome();
  }

  // Cuenta regresiva al debut de Colombia
  const debut = new Date(CONFIG.COLOMBIA_DEBUT_UTC).getTime() - now;
  const total = Math.max(0, Math.floor(debut / 1000));
  $("#cdD").textContent = String(Math.floor(total / 86400));
  $("#cdH").textContent = pad2(Math.floor((total % 86400) / 3600));
  $("#cdM").textContent = pad2(Math.floor((total % 3600) / 60));
  $("#cdS").textContent = pad2(total % 60);
}

/* ── Formulario ────────────────────────────────────────── */

const validators = {
  nombre(value) {
    const v = value.trim();
    if (v.length < 3) return "Cuéntanos tu nombre (mínimo 3 letras).";
    if (!/^[\p{L}\s.'-]+$/u.test(v)) return "Solo letras y espacios, porfa.";
    return null;
  },
  correo(value) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim())) {
      return "Ese correo se ve raro. Revísalo 👀";
    }
    return null;
  },
  celular(value) {
    const digits = normalizePhone(value);
    if (!/^3\d{9}$/.test(digits)) {
      return "Celular colombiano de 10 dígitos, empieza por 3.";
    }
    return null;
  },
  contrasena(value) {
    if (value.length < 6) return "Mínimo 6 caracteres para la contraseña.";
    return null;
  },
};

function normalizePhone(value) {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("57") && digits.length === 12) digits = digits.slice(2);
  return digits;
}

function showError(fieldId, message) {
  const input = $(`#${fieldId}`);
  const error = $(`#err-${fieldId}`);
  if (!error) return;
  if (message) {
    error.textContent = message;
    error.hidden = false;
    input?.setAttribute("aria-invalid", "true");
  } else {
    error.hidden = true;
    input?.removeAttribute("aria-invalid");
  }
}

function collectPredictions() {
  return state.matches
    .filter((m) => getPrediction(m.id).touched)
    .map((m) => {
      const p = getPrediction(m.id);
      return {
        partidoId: m.id,
        partido: `${m.home.name} vs ${m.away.name}`,
        cerradoAlEnviar: isLocked(m),
        local: p.home,
        visitante: p.away,
        marcador: `${p.home}-${p.away}`,
        inicio: m.kickoff,
      };
    });
}

async function sendToWebhook(payload) {
  if (!CONFIG.WEBHOOK_URL) {
    console.info("[polla] WEBHOOK_URL vacío: guardando solo en este navegador.", payload);
    return true;
  }
  try {
    const res = await fetch(CONFIG.WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch (err) {
    console.error("[polla] Webhook falló:", err);
    return false;
  }
}

function queuePending(payload) {
  const pending = readJSON(STORE.pending) ?? [];
  pending.push(payload);
  writeJSON(STORE.pending, pending);
}

async function retryPending() {
  const pending = readJSON(STORE.pending) ?? [];
  if (pending.length === 0 || !CONFIG.WEBHOOK_URL) return;
  const stillPending = [];
  for (const payload of pending) {
    const ok = await sendToWebhook(payload);
    if (!ok) stillPending.push(payload);
  }
  writeJSON(STORE.pending, stillPending);
}

async function handleSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const nombre = form.nombre.value;
  const correo = form.correo.value;
  const celular = form.celular.value;
  const contrasena = form.contrasena.value;

  // honeypot: si un bot lo llenó, fingimos éxito sin enviar nada
  if (form.empresa.value) {
    showSuccess(nombre.trim() || "crack");
    return;
  }

  let firstBad = null;
  for (const [field, validate] of Object.entries(validators)) {
    const message = validate(form[field].value);
    showError(field, message);
    if (message && !firstBad) firstBad = field;
  }
  if (!$("#consent").checked) {
    showError("consent", "Necesitamos tu autorización para jugar.");
    if (!firstBad) firstBad = "consent";
  } else {
    showError("consent", null);
  }

  const predicciones = collectPredictions().filter((p) => !p.cerradoAlEnviar);
  const hayAbiertos = state.matches.some((m) => !isLocked(m));
  if (hayAbiertos && predicciones.length === 0 && !firstBad) {
    $("#matchesNote").hidden = false;
    $("#matchesNote").textContent = "⚽ Te falta lo más rico: pon al menos un marcador antes de enviar.";
    document.getElementById("partidos").scrollIntoView({ behavior: "smooth" });
    return;
  }
  if (firstBad) {
    $(`#${firstBad}`)?.focus();
    return;
  }

  const btn = $("#submitBtn");
  btn.disabled = true;
  btn.textContent = "Sellando…";

  const email = correo.trim().toLowerCase();
  const payload = {
    source: "polla-mundialista-30x",
    fecha: new Date().toISOString(),
    nombre: nombre.trim(),
    correo: email,
    celular: `+57${normalizePhone(celular)}`,
    autorizaDatos: true,
    diaDePartidos: bogotaDateStr(),
    predicciones,
  };

  try {
    const user = await signUpOrIn(email, contrasena);
    if (user) await saveToSupabase(user, payload);
  } catch (err) {
    showError("contrasena", err.message || "Error al registrar. Intenta de nuevo.");
    btn.disabled = false;
    btn.textContent = "Enviar mi polla →";
    return;
  }

  const sent = await sendToWebhook(payload);
  if (!sent) queuePending(payload);

  state.submitted = {
    nombre: payload.nombre,
    correo: payload.correo,
    celular: payload.celular,
    predicciones,
    ts: payload.fecha,
  };
  writeJSON(STORE.submitted, state.submitted);

  showSuccess(payload.nombre);
  renderMatches();
  renderChrome();
}

/* ── Éxito + compartir + confetti ──────────────────────── */

function showSuccess(nombre, { confetti = true } = {}) {
  $("#pollaForm").hidden = true;
  const panel = $("#successPanel");
  panel.hidden = false;

  const primerNombre = nombre.split(/\s+/)[0] || "crack";
  $("#successMsg").textContent =
    `Listo, ${primerNombre}: tu polla quedó sellada antes del pitazo. Te contamos cómo te fue.`;

  const picks = $("#successPicks");
  picks.replaceChildren();
  const preds = state.submitted?.predicciones ?? [];
  for (const p of preds) {
    picks.append(el("span", "chip", `${p.partido}: ${p.marcador}`));
  }

  const lines = preds.map((p) => `${p.partido} ${p.marcador}`).join(" · ");
  const text = `⚽🏆 Ya sellé mi Polla Mundialista 30X${lines ? `: ${lines}` : ""}. ¿Te la sabes más que yo? Juega gratis antes del pitazo 👉 ${location.href.split("#")[0]}`;
  $("#shareBtn").href = `https://wa.me/?text=${encodeURIComponent(text)}`;

  if (confetti) {
    panel.scrollIntoView({ behavior: "smooth", block: "center" });
    launchConfetti();
  }
}

function launchConfetti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = $("#confettiCanvas");
  const ctx = canvas.getContext("2d");
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  canvas.classList.add("on");

  const colors = ["#ebff6f", "#ffce00", "#0039a6", "#d3122e", "#0a0a0a"];
  const pieces = Array.from({ length: 140 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.4,
    w: 7 + Math.random() * 7,
    h: 10 + Math.random() * 10,
    color: colors[Math.floor(Math.random() * colors.length)],
    vy: 2.4 + Math.random() * 3.4,
    vx: -1.6 + Math.random() * 3.2,
    rot: Math.random() * Math.PI,
    vr: -0.12 + Math.random() * 0.24,
  }));

  const start = performance.now();
  function frame(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (now - start < 2600) {
      requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.classList.remove("on");
    }
  }
  requestAnimationFrame(frame);
}

/* ── Init ──────────────────────────────────────────────── */

async function refreshData() {
  state.matches = await fetchFixtures();
  renderMatches();
  renderChrome();
}

async function init() {
  loadSaved();

  // Restaurar sesión de Supabase si el usuario ya jugó antes
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user && !state.submitted) {
    await loadFromSupabase(session.user);
  }

  $("#pollaForm").addEventListener("submit", handleSubmit);

  await refreshData();

  if (state.submitted) {
    showSuccess(state.submitted.nombre, { confetti: false });
  }

  tick();
  setInterval(tick, CONFIG.TICK_MS);
  setInterval(refreshData, CONFIG.REFRESH_MS);
  retryPending();
}

init();
