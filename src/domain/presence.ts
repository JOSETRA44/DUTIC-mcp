import * as cheerio from "cheerio";
import type { Session } from "../core/session.js";
import { fetchAulaHtml } from "./fetch.js";

/**
 * Presencia en tiempo real: el bloque "Usuarios en línea" del Dashboard (`/my/`).
 *
 * Moodle actualiza `user.lastaccess` en CADA petición del usuario, y el bloque lo renderiza en el
 * servidor con precisión de segundos. No hay ningún endpoint AJAX que lo refresque: el navegador
 * sólo lo actualiza recargando la página, así que "tiempo real" aquí significa "en el instante en
 * que se pidió /my/". Consultarlo cuesta una página completa (~230 KB), lo que fija el ritmo
 * razonable de sondeo en decenas de segundos, no en uno.
 *
 * LÍMITE DE PRIVACIDAD, y es del servidor, no nuestro: el bloque nombra sólo a los usuarios con
 * los que compartes curso; el resto se agrega en "Otros usuarios (N)". Además corta la lista en
 * 50 aunque haya cientos conectados. Por eso `total` (el recuento global) y `users` (los que
 * puedes identificar) son magnitudes distintas y nunca hay que presentarlas como la misma cosa.
 */

export interface OnlineUser {
  id: number;
  name: string;
  /** Texto tal cual del servidor: "3 segundos", "2 minutos". */
  idle: string;
  /** El mismo dato en segundos, para ordenar y comparar. null si no se pudo interpretar. */
  idleSeconds: number | null;
  profileUrl: string;
  /** true si es el propio usuario (se detecta por el control de visibilidad del bloque). */
  isMe: boolean;
}

export interface OnlinePresence {
  /** false si el Dashboard no tiene el bloque puesto: hay que añadirlo (ver domain/dashboard). */
  blockPresent: boolean;
  /** Total de conectados que declara el servidor, incluidos los que no puedes identificar. */
  total: number | null;
  /** Ventana que usa el bloque, en minutos (config del sitio; hoy 5). */
  windowMinutes: number | null;
  /** Los que puedes ver por nombre: gente con la que compartes curso. */
  users: OnlineUser[];
  /** Conectados contados pero anónimos para ti ("Otros usuarios (N)"). */
  hiddenCount: number;
  /** "visible" | "hidden": si los demás te ven a ti en su bloque. null si no se pudo leer. */
  myVisibility: "visible" | "hidden" | null;
  /** Momento en que se tomó la foto. */
  takenAt: number;
}

const UNITS: Record<string, number> = {
  segundo: 1,
  minuto: 60,
  hora: 3600,
  día: 86400,
  dia: 86400,
};

/** "2 minutos 30 segundos" → 150. Suma todos los pares número+unidad que encuentre. */
export function parseIdleSeconds(text: string): number | null {
  // El propio usuario aparece como "ahora" en vez de con una cifra: es 0, no "desconocido".
  if (/^\s*ahora\s*$/i.test(text)) return 0;
  let total: number | null = null;
  for (const m of text.matchAll(/(\d+)\s*(segundo|minuto|hora|días?|dia)s?/gi)) {
    const unit = UNITS[m[2].toLowerCase().replace(/s$/, "")];
    if (unit === undefined) continue;
    total = (total ?? 0) + Number(m[1]) * unit;
  }
  return total;
}

/** Extrae el estado del bloque a partir del HTML del Dashboard ya descargado. */
export function parseOnlineBlock(html: string, siteUrl: string): OnlinePresence {
  const $ = cheerio.load(html);
  const block = $('[data-block="online_users"]').first();
  const takenAt = Date.now();

  if (block.length === 0) {
    return {
      blockPresent: false,
      total: null,
      windowMinutes: null,
      users: [],
      hiddenCount: 0,
      myVisibility: null,
      takenAt,
    };
  }

  // "179 usuarios online (últimos 5 minutos)"
  const info = block.find(".info").first().text();
  const totalMatch = /(\d+)\s+usuarios?\s+online/i.exec(info);
  const windowMatch = /(\d+)\s+minutos?/i.exec(info);

  // El control del ojo sólo aparece en la propia fila: identifica quién soy y si estoy visible.
  const visibilityLink = block.find("#change-user-visibility");
  const myId = Number(visibilityLink.attr("data-userid")) || null;
  // data-action es lo que hará el botón, así que "hide" significa que AHORA estoy visible.
  const action = visibilityLink.attr("data-action");
  const myVisibility = action === "hide" ? "visible" : action === "show" ? "hidden" : null;

  const users: OnlineUser[] = [];
  let hiddenCount = 0;

  block.find("li.listentry").each((_, li) => {
    const el = $(li);
    const other = el.find(".otherusers span").first().text();
    if (other) {
      hiddenCount += Number(/(\d+)/.exec(other)?.[1] ?? 0);
      return;
    }
    const a = el.find(".user a").first();
    const href = a.attr("href") ?? "";
    const id = Number(/[?&]id=(\d+)/.exec(href)?.[1] ?? 0);
    if (!id) return;
    // El nombre está como texto suelto junto al avatar; .text() arrastra las iniciales del
    // placeholder ("RC" + "ROSA…"), que sí vienen dentro de un <span title="nombre completo">.
    const initials = a.find("span.userinitials").first();
    const name = (initials.attr("title") ?? a.text()).replace(/\s+/g, " ").trim();
    const idle = (a.attr("title") ?? "").trim();
    users.push({
      id,
      name,
      idle,
      idleSeconds: parseIdleSeconds(idle),
      profileUrl: `${siteUrl}/user/profile.php?id=${id}`,
      isMe: myId !== null && id === myId,
    });
  });

  return {
    blockPresent: true,
    total: totalMatch ? Number(totalMatch[1]) : null,
    windowMinutes: windowMatch ? Number(windowMatch[1]) : null,
    users,
    hiddenCount,
    myVisibility,
    takenAt,
  };
}

/** Foto de quién está conectado ahora mismo. Sin caché: el dato caduca en segundos. */
export async function getOnlinePresence(session: Session): Promise<OnlinePresence> {
  const html = await fetchAulaHtml(session, "/my/");
  return parseOnlineBlock(html, session.siteUrl);
}

/** Normaliza para comparar nombres sin acentos ni mayúsculas. */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/**
 * ¿Está conectada esta persona? Busca por id o por trozos del nombre (todas las palabras han de
 * aparecer, en cualquier orden: "carpio rosa" encuentra a "ROSA YOLANDA CARPIO BARREDA").
 */
export function matchOnline(presence: OnlinePresence, query: string): OnlineUser[] {
  const q = query.trim();
  if (/^\d+$/.test(q)) return presence.users.filter((u) => u.id === Number(q));
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return presence.users.filter((u) => {
    const name = fold(u.name);
    return words.every((w) => name.includes(w));
  });
}
