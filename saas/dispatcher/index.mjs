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

// ── Vinculación: el estudiante escribe su link_code una vez ────────────────────────
async function handleInboundLinking(sock, messages) {
  for (const msg of messages) {
    if (msg.key.fromMe || !msg.message) continue;
    const jid = msg.key.remoteJid;
    if (!jid || jid.endsWith("@g.us")) continue; // ignorar grupos
    const text = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""
    )
      .trim()
      .toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(text)) continue;

    const { data: student } = await supabase
      .from("students")
      .select("id, full_name, status")
      .eq("link_code", text)
      .eq("status", "pending_link")
      .maybeSingle();
    if (!student) continue;

    const whatsappNumber = jid.split("@")[0];
    await supabase
      .from("students")
      .update({ whatsapp_number: whatsappNumber, status: "active", link_code: null, linked_at: new Date().toISOString() })
      .eq("id", student.id);

    await sock.sendMessage(jid, {
      text: `Listo, ${student.full_name.split(" ")[0]} — quedaste vinculado. Te aviso por acá cuando aparezca algo nuevo en tus cursos.`,
    });
    logger.info({ studentId: student.id }, "estudiante vinculado");
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

async function run() {
  const { creds, keysData } = await loadAuthState(BOT_NUMBER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: { creds, keys: makeCacheableSignalKeyStore(makeSupabaseKeyStore(keysData), logger) },
  });

  sock.ev.on("creds.update", () => persistAuthState(BOT_NUMBER, creds, keysData));

  if (!creds.registered) {
    // Primera vez: hay que correr esto localmente con un teléfono a mano para aceptar
    // el código. No tiene sentido en un cron desatendido de GitHub Actions.
    const code = await sock.requestPairingCode(BOT_NUMBER);
    console.log(`\nCódigo de emparejamiento para ${BOT_NUMBER}: ${code}`);
    console.log("Ingrésalo en WhatsApp → Dispositivos vinculados → Vincular con número de teléfono.\n");
  }

  await new Promise((resolve, reject) => {
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        await randomDelay(2000, 5000); // pequeña espera antes de operar, no disparar al instante
        try {
          await persistAuthState(BOT_NUMBER, creds, keysData);
          await supabase.from("whatsapp_sessions").update({ status: "connected" }).eq("bot_number", BOT_NUMBER);
          const { sent } = await dispatchPending(sock);
          console.log(`Enviados ${sent} avisos.`);
        } finally {
          resolve();
        }
      } else if (connection === "close") {
        const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : undefined;
        if ([DisconnectReason.loggedOut, 401, 403].includes(statusCode)) {
          await markSessionSuspectedBan(BOT_NUMBER);
        }
        reject(lastDisconnect?.error ?? new Error("conexión cerrada"));
      }
    });
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      try {
        await handleInboundLinking(sock, messages);
      } catch (err) {
        logger.error({ err }, "fallo procesando mensajes entrantes");
      }
    });
  });

  await persistAuthState(BOT_NUMBER, creds, keysData);
  process.exit(0);
}

run().catch((err) => {
  console.error("Dispatcher terminó con error:", err?.message ?? err);
  process.exit(1);
});
