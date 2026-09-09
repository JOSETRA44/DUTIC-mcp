import * as cheerio from "cheerio";
import type { Session } from "../core/session.js";
import { fetchAulaHtml } from "./fetch.js";

/**
 * El Dashboard (`/my/`) no es una página fija: es una composición de BLOQUES que cada usuario
 * elige, y Moodle los renderiza en el servidor. Añadir un bloque cambia qué datos aparecen en el
 * HTML, así que el modo de edición no es cosmética — es la palanca que decide qué se puede
 * extraer de esa página. De ahí que este módulo exista: "Usuarios en línea" sólo se puede leer
 * si el bloque está puesto.
 *
 * Mecánica descubierta en el aula (Moodle 4.x, tema learnr/Boost Union):
 *   - Conmutar edición: POST a `editmode.php` con setmode=0|1, sesskey, pageurl y context.
 *   - Catálogo de bloques añadibles: GET `/my/index.php?bui_addblock&sesskey=…` (con edición ON).
 *   - Añadir:  GET `/my/index.php?bui_addblock=<nombre>&sesskey=…`
 *   - Quitar:  GET `/my/index.php?bui_deleteid=<instancia>&sesskey=…&bui_confirm=1`
 *
 * Todas las mutaciones dejan el modo de edición como estaba: el usuario no debería encontrarse
 * el aula en un estado distinto por haber hecho una consulta.
 */

export interface DashboardBlock {
  /** Nombre del plugin: "online_users", "timeline", "calendar_month"… */
  name: string;
  instanceId: number;
  title: string;
}

export interface AddableBlock {
  name: string;
  title: string;
}

export interface DashboardState {
  editing: boolean;
  blocks: DashboardBlock[];
  sesskey: string;
  /** Id de contexto que exige `editmode.php`; sale del propio formulario. */
  contextId: string | null;
  pageUrl: string;
}

/** Lee el sesskey vigente del propio HTML: el guardado en disco puede haber caducado. */
function readSesskey(html: string, fallback: string): string {
  return /"sesskey":"(\w+)"/.exec(html)?.[1] ?? fallback;
}

export function parseDashboard(html: string, session: Session): DashboardState {
  const $ = cheerio.load(html);
  const blocks: DashboardBlock[] = [];
  $("section[data-block]").each((_, el) => {
    const s = $(el);
    const name = s.attr("data-block") ?? "";
    const instanceId = Number(s.attr("data-instance-id"));
    if (!name || !instanceId) return;
    blocks.push({
      name,
      instanceId,
      title: s.find(".card-title").first().text().replace(/\s+/g, " ").trim(),
    });
  });

  const toggle = $('input[name="setmode"]').first();
  return {
    editing: toggle.attr("checked") !== undefined || toggle.is("[checked]"),
    blocks,
    sesskey: readSesskey(html, session.sesskey),
    contextId: $('input[name="context"]').first().attr("value") ?? toggle.attr("data-context") ?? null,
    pageUrl: $('input[name="pageurl"]').first().attr("value") ?? `${session.siteUrl}/my/index.php`,
  };
}

export async function getDashboardState(session: Session): Promise<DashboardState> {
  return parseDashboard(await fetchAulaHtml(session, "/my/"), session);
}

/** Conmuta el modo de edición. Devuelve el estado resultante. */
export async function setEditMode(
  session: Session,
  on: boolean,
  state?: DashboardState,
): Promise<DashboardState> {
  const st = state ?? (await getDashboardState(session));
  if (st.editing === on) return st;

  const body = new URLSearchParams({
    setmode: on ? "1" : "0",
    sesskey: st.sesskey,
    pageurl: st.pageUrl,
    ...(st.contextId ? { context: st.contextId } : {}),
  });
  await fetchAulaHtml(session, "/editmode.php", 30_000, {
    method: "POST",
    // El 303 de vuelta al Dashboard es la respuesta normal; seguirlo confirma el cambio.
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return getDashboardState(session);
}

/**
 * Bloques que se pueden añadir al Dashboard. Exige entrar en edición; se sale al terminar si
 * no estaba ya dentro.
 */
export async function listAddableBlocks(session: Session): Promise<AddableBlock[]> {
  const before = await getDashboardState(session);
  const st = await setEditMode(session, true, before);
  try {
    const html = await fetchAulaHtml(
      session,
      `/my/index.php?bui_addblock&sesskey=${encodeURIComponent(st.sesskey)}`,
    );
    const $ = cheerio.load(html);
    const out = new Map<string, string>();
    $('a[href*="bui_addblock="]').each((_, a) => {
      const href = $(a).attr("href") ?? "";
      const name = /bui_addblock=([\w-]+)/.exec(href)?.[1];
      if (!name) return;
      const title = $(a).text().replace(/\s+/g, " ").trim();
      if (!out.has(name) || (title && !out.get(name))) out.set(name, title);
    });
    return [...out].map(([name, title]) => ({ name, title })).sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    if (!before.editing) await setEditMode(session, false);
  }
}

export interface BlockChange {
  changed: boolean;
  reason: string;
  blocks: DashboardBlock[];
}

/** Añade un bloque al Dashboard del usuario. Idempotente: si ya está, no hace nada. */
export async function addDashboardBlock(session: Session, name: string): Promise<BlockChange> {
  const before = await getDashboardState(session);
  if (before.blocks.some((b) => b.name === name)) {
    return { changed: false, reason: `El bloque "${name}" ya estaba en el Dashboard.`, blocks: before.blocks };
  }
  const st = await setEditMode(session, true, before);
  try {
    await fetchAulaHtml(
      session,
      `/my/index.php?bui_addblock=${encodeURIComponent(name)}&sesskey=${encodeURIComponent(st.sesskey)}`,
    );
  } finally {
    if (!before.editing) await setEditMode(session, false);
  }
  const after = await getDashboardState(session);
  const ok = after.blocks.some((b) => b.name === name);
  return {
    changed: ok,
    reason: ok
      ? `Bloque "${name}" añadido al Dashboard.`
      : `El aula no añadió "${name}". Comprobado en 2026-B: algunos bloques del catálogo fallan ` +
        `al montarse en el Dashboard (a "completion_progress" le pasa) y Moodle los descarta. ` +
        `Prueba otro, o compruébalo a mano en el modo de edición del navegador.`,
    blocks: after.blocks,
  };
}

/** Quita un bloque del Dashboard. Se identifica por nombre de plugin, no por instancia. */
export async function removeDashboardBlock(session: Session, name: string): Promise<BlockChange> {
  const before = await getDashboardState(session);
  const target = before.blocks.find((b) => b.name === name);
  if (!target) {
    return { changed: false, reason: `El bloque "${name}" no está en el Dashboard.`, blocks: before.blocks };
  }
  const st = await setEditMode(session, true, before);
  try {
    await fetchAulaHtml(
      session,
      `/my/index.php?bui_deleteid=${target.instanceId}&sesskey=${encodeURIComponent(st.sesskey)}&bui_confirm=1`,
    );
  } finally {
    if (!before.editing) await setEditMode(session, false);
  }
  const after = await getDashboardState(session);
  const ok = !after.blocks.some((b) => b.name === name);
  return {
    changed: ok,
    reason: ok ? `Bloque "${name}" quitado del Dashboard.` : `No se pudo quitar "${name}".`,
    blocks: after.blocks,
  };
}
