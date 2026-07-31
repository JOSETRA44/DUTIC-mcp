// Dispatcher del piloto de notificaciones DUTIC.
//
// Corre "conecta → trabaja → se apaga", pensado para un cron de GitHub Actions (o
// ejecución manual local para el pairing inicial). NUNCA toca la sesión de Moodle de
// nadie: sólo lee `pending_notifications` (ya calculadas por `dutic saas push` en la
// PC de cada estudiante) y las envía por WhatsApp usando Baileys.
//
// Estado de la sesión de Baileys (creds + claves de Signal) se guarda en la tabla
// `whatsapp_sessions` de Supabase — así el pairing sólo se hace una vez, aunque el
// runner de GitHub Actions sea efímero.
//
// Mitigación de ban (WhatsApp no oficial): demoras aleatorias entre envíos, texto
// variado por tipo de aviso (no plantilla idéntica), exige que el estudiante escriba
// primero para vincularse, y marca la sesión como "sospechosa de ban" ante códigos de
// desconexión típicos de baneo para poder rotar de número sin tocar a los estudiantes.

import { createClient } from "@supabase/supabase-js";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  initAuthCreds,
  BufferJSON,
  isLidUser,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const BOT_NUMBER = requireEnv("BOT_NUMBER"); // ej. "51987654321" (sin '+', sin espacios)

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const logger = pino({ level: process.env.LOG_LEVEL ?? "warn" });

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
  return v;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function randomDelay(minMs, maxMs) {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

// ── Estado de Baileys persistido en Supabase (una fila por número del bot) ─────────
async function loadAuthState(botNumber) {
  const { data } = await supabase
    .from("whatsapp_sessions")
    .select("creds, keys")
    .eq("bot_number", botNumber)
    .maybeSingle();

  const creds = data?.creds && Object.keys(data.creds).length ? JSON.parse(JSON.stringify(data.creds), BufferJSON.reviver) : initAuthCreds();
  const keysData = data?.keys && Object.keys(data.keys).length ? JSON.parse(JSON.stringify(data.keys), BufferJSON.reviver) : {};

  return { creds, keysData };
}

async function persistAuthState(botNumber, creds, keysData) {
  const credsJson = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
  const keysJson = JSON.parse(JSON.stringify(keysData, BufferJSON.replacer));
  await supabase.from("whatsapp_sessions").upsert(
    { bot_number: botNumber, creds: credsJson, keys: keysJson, updated_at: new Date().toISOString() },
    { onConflict: "bot_number" },
  );
}

/** Adapta el blob plano {tipo: {id: valor}} a la interfaz de SignalKeyStore que pide Baileys. */
function makeSupabaseKeyStore(keysData) {
  return {
    get: async (type, ids) => {
      const result = {};
      for (const id of ids) {
        const value = keysData[type]?.[id];
        if (value !== undefined) result[id] = value;
      }
      return result;
    },
    set: async (data) => {
      for (const type of Object.keys(data)) {
        keysData[type] ??= {};
        for (const id of Object.keys(data[type])) {
          const value = data[type][id];
          if (value === null || value === undefined) delete keysData[type][id];
          else keysData[type][id] = value;
        }
      }
    },
  };
}

// ── Texto de los avisos (variado por tipo, no siempre idéntico) ────────────────────
const TEMPLATES = {
  new_task: [
    (p) => `📌 Nueva tarea en ${p.courseName}: "${p.name}".${p.dueDate ? ` Entrega: ${new Date(p.dueDate * 1000).toLocaleString("es-PE")}.` : ""}`,
    (p) => `Apareció una tarea nueva en ${p.courseName} — "${p.name}".${p.dueDate ? ` Fecha límite: ${new Date(p.dueDate * 1000).toLocaleString("es-PE")}.` : ""}`,
  ],
  new_grade: [
    (p) => `⭐ Te publicaron una nota en ${p.courseName}: ${p.item} = ${p.grade}.`,
    (p) => `Nueva nota en ${p.courseName} — ${p.item}: ${p.grade}.`,
  ],
  grade_change: [
    (p) => `~ Te actualizaron una nota en ${p.grade.courseName}: ${p.grade.item} pasó de ${p.from} a ${p.to}.`,
  ],
  submission_change: [
    (p) => `» Cambió el estado de entrega de "${p.task.name}": ${p.from} → ${p.to}.`,
  ],
  due_date_change: [
    (p) => `⚠ Cambió la fecha de "${p.task.name}": ahora ${p.to ? new Date(p.to * 1000).toLocaleString("es-PE") : "sin fecha"}.`,
  ],
  // Aviso del propio sistema: el agente local perdió la sesión y no pudo renovarla en
  // silencio. Sin esto el estudiante dejaría de recibir avisos sin enterarse nunca.
  session_expired: [
    (p) => p.message ?? "Tu sesión del aula virtual expiró. Corre `dutic login` en tu PC para reactivar los avisos.",
  ],
};

function renderNotification(kind, payload) {
  const variants = TEMPLATES[kind];
  if (!variants) return `Novedad (${kind}): ${JSON.stringify(payload)}`;
  const fn = variants[Math.floor(Math.random() * variants.length)];
  try {
    return fn(payload);
  } catch {
    return `Novedad en tus cursos (${kind}).`;
  }
}

/**
 * Extrae texto plano de las formas de mensaje más comunes en las que puede llegar un
 * código tecleado a mano (texto simple, texto con contexto de cita/link-preview, y el
 * envoltorio de "mensajes efímeros" que activa por defecto en chats nuevos).
 */
function extractText(message) {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.ephemeralMessage?.message?.conversation ||
    message.ephemeralMessage?.message?.extendedTextMessage?.text ||
    ""
  );
}

/**
 * Resuelve el número de teléfono real del remitente. WhatsApp migró buena parte del
 * tráfico a identificadores "LID" (jid terminado en @lid) por privacidad — remoteJid
 * ya no es de fiar como número de teléfono. Baileys expone el número real en
 * msg.key.senderPn cuando remoteJid es un LID; si no viene, no hay forma confiable de
 * recuperarlo y se descarta (mejor no guardar basura en whatsapp_number).
 */
function resolvePhoneNumber(msg, jid) {
  if (!isLidUser(jid)) return jidNormalizedUser(jid).split("@")[0];
  const pn = msg.key.senderPn;
  return pn ? jidNormalizedUser(pn).split("@")[0] : null;
}

// ── Vinculación: el estudiante escribe su link_code una vez ────────────────────────
async function handleInboundLinking(sock, messages) {
  for (const msg of messages) {
    if (msg.key.fromMe || !msg.message) continue;
    const jid = msg.key.remoteJid;
    if (!jid || jid.endsWith("@g.us")) continue; // ignorar grupos

    const text = extractText(msg.message).trim().toUpperCase();
    // Siempre logueado, aunque no matchee — así un test real deja rastro en vez de
    // desaparecer en silencio (el bug reportado: "el bot me ignora por completo").
    logger.info({ jid, senderPn: msg.key.senderPn, text, matchesFormat: /^[A-Z0-9]{6}$/.test(text) }, "mensaje entrante recibido");

    if (!/^[A-Z0-9]{6}$/.test(text)) continue;

    const { data: student } = await supabase
      .from("students")
      .select("id, full_name, status")
      .eq("link_code", text)
      .eq("status", "pending_link")
      .maybeSingle();
    if (!student) {
      logger.warn({ text }, "código recibido pero no hay estudiante pending_link con ese link_code");
      await sock.sendMessage(jid, { text: "Ese código no es válido o ya fue usado. Revisa `dutic saas enroll` y vuelve a intentar." });
      continue;
    }

    const whatsappNumber = resolvePhoneNumber(msg, jid);
    if (!whatsappNumber) {
      logger.warn({ jid, studentId: student.id }, "no se pudo resolver el número real (remoteJid es @lid sin senderPn)");
      await sock.sendMessage(jid, {
        text: "Recibí tu código pero no pude confirmar tu número de WhatsApp. Escríbele al operador del piloto para vincularte a mano.",
      });
      continue;
    }

    await supabase
      .from("students")
      .update({ whatsapp_number: whatsappNumber, status: "active", link_code: null, linked_at: new Date().toISOString() })
      .eq("id", student.id);

    await sock.sendMessage(jid, {
      text: `Listo, ${student.full_name.split(" ")[0]} — quedaste vinculado. Te aviso por acá cuando aparezca algo nuevo en tus cursos.`,
    });
    logger.info({ studentId: student.id, whatsappNumber }, "estudiante vinculado");
  }
}

// ── Envío de lo pendiente (rate-limited) ────────────────────────────────────────────
async function dispatchPending(sock) {
  const { data: pending, error } = await supabase
    .from("pending_notifications")
    .select("id, kind, payload, students!inner(whatsapp_number, status)")
    .is("sent_at", null)
    .eq("students.status", "active")
    .not("students.whatsapp_number", "is", null)
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) {
    logger.error({ error }, "no se pudo leer pending_notifications");
    return { sent: 0 };
  }
  if (!pending?.length) return { sent: 0 };

  let sent = 0;
  for (const n of pending) {
    const jid = `${n.students.whatsapp_number}@s.whatsapp.net`;
    const text = renderNotification(n.kind, n.payload);
    try {
      await sock.sendMessage(jid, { text });
      await supabase.from("pending_notifications").update({ sent_at: new Date().toISOString() }).eq("id", n.id);
      sent++;
    } catch (err) {
      logger.error({ err, notificationId: n.id }, "fallo al enviar, se reintenta en la próxima corrida");
    }
    await randomDelay(4000, 9000); // demora aleatoria — evita el patrón de envío en ráfaga
  }
  return { sent };
}

async function markSessionSuspectedBan(botNumber) {
  await supabase.from("whatsapp_sessions").update({ status: "banned_suspected" }).eq("bot_number", botNumber);
  console.error(
    `[!] El número ${botNumber} parece haber sido desconectado/baneado por WhatsApp. ` +
      `Rota a otro número dedicado (el estado vive en Supabase, no afecta a los estudiantes).`,
  );
}

// El flujo de pairing-code de Baileys NO es "conecta y ya": tras teclear el código en
// el teléfono, el servidor de WhatsApp cierra el socket con el código 515
// (restartRequired) a propósito — hay que reconectar (mismo estado de auth, socket
// nuevo) para que la conexión quede realmente abierta. Tratar ese cierre como error
// fatal (como hacía la versión anterior) explica el "Connection Closed" casi
// instantáneo: se rendía en el primer cierre, que era justo el esperado.
const MAX_CONNECT_ATTEMPTS = 6;

async function connectOnce(creds, keysData, state) {
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    logger,
    auth: { creds, keys: makeCacheableSignalKeyStore(makeSupabaseKeyStore(keysData), logger) },
  });

  sock.ev.on("creds.update", () => persistAuthState(BOT_NUMBER, creds, keysData));
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    try {
      await handleInboundLinking(sock, messages);
    } catch (err) {
      logger.error({ err }, "fallo procesando mensajes entrantes");
    }
  });

  if (!state.pairingRequested && !creds.registered) {
    state.pairingRequested = true;
    // Dar un respiro a que el socket abra el WebSocket antes de pedir el código.
    await sleep(3000);
    const code = await sock.requestPairingCode(BOT_NUMBER);
    console.log(`\nCódigo de emparejamiento para ${BOT_NUMBER}: ${code}`);
    console.log("Ingrésalo en tu teléfono: WhatsApp → Dispositivos vinculados → Vincular con número de teléfono.");
    console.log("Tienes unos minutos antes de que expire. No cierres esta ventana.\n");
  }

  // Cuando terminamos a propósito (tras despachar), NO llamamos sock.end(): esa función
  // emite su propio 'connection.update' con connection:'close' (lastDisconnect.error
  // queda undefined), y ese mismo evento lo recibía este handler y lo interpretaba como
  // una desconexión más por reconectar — carrera que producía el bucle infinito
  // observado (cada "cierre" tenía "código desconocido" porque SIEMPRE era nuestro
  // propio end(), nunca un cierre real de WhatsApp). Con este flag, cualquier 'close'
  // posterior a terminar con éxito se ignora; el proceso sale con process.exit() en
  // run(), que de por sí mata el socket sin necesitar cerrarlo a mano.
  let finishedIntentionally = false;

  return new Promise((resolve) => {
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        console.log("Conectado a WhatsApp.");
        await randomDelay(2000, 5000); // pequeña espera antes de operar, no disparar al instante
        await persistAuthState(BOT_NUMBER, creds, keysData);
        await supabase.from("whatsapp_sessions").update({ status: "connected" }).eq("bot_number", BOT_NUMBER);
        const { sent } = await dispatchPending(sock);
        console.log(`Enviados ${sent} avisos.`);
        // Ventana corta extra escuchando mensajes entrantes (vinculación) antes de
        // cortar — como el ciclo es "conecta → trabaja → sale", sin esto la ventana
        // para que un estudiante alcance a escribir su link_code sería de sólo un par
        // de segundos. Configurable por si en GitHub Actions se quiere recortar.
        const listenMs = Number(process.env.POST_DISPATCH_LISTEN_SECONDS ?? 15) * 1000;
        if (listenMs > 0) {
          console.log(`Escuchando vinculaciones ${Math.round(listenMs / 1000)}s más…`);
          await sleep(listenMs);
        }
        finishedIntentionally = true;
        resolve("done");
      } else if (connection === "close") {
        if (finishedIntentionally) return; // ya resolvimos "done"; ignorar el eco del cierre
        const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : undefined;
        const reason = lastDisconnect?.error?.message ?? "sin detalle";
        console.log(`Conexión cerrada (código ${statusCode ?? "desconocido"}: ${reason}).`);
        if (statusCode === DisconnectReason.loggedOut) {
          await markSessionSuspectedBan(BOT_NUMBER);
          resolve("terminal");
        } else if (statusCode === DisconnectReason.restartRequired) {
          console.log("Reinicio esperado (normal tras el pairing) — reconectando…");
          resolve("retry");
        } else {
          console.log("Desconexión no terminal — reconectando…");
          resolve("retry");
        }
      }
    });
  });
}

async function run() {
  const { creds, keysData } = await loadAuthState(BOT_NUMBER);
  const state = { pairingRequested: creds.registered };

  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
    const result = await connectOnce(creds, keysData, state);
    if (result === "done") {
      await persistAuthState(BOT_NUMBER, creds, keysData);
      process.exit(0);
    }
    if (result === "terminal") process.exit(1);
    await sleep(1500);
  }

  console.error(`No se logró completar la conexión tras ${MAX_CONNECT_ATTEMPTS} intentos.`);
  process.exit(1);
}

run().catch((err) => {
  console.error("Dispatcher terminó con error:", err?.message ?? err);
  process.exit(1);
});
