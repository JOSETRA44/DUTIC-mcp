/**
 * Política de frescura de la caché del catálogo.
 *
 * El OPAC tarda ~11 s por petición, así que cada decisión aquí es un trade-off directo entre
 * VELOCIDAD (responder con lo guardado) y EXACTITUD (sobre todo de la disponibilidad, que cambia
 * cuando alguien presta un libro).
 */

export type Freshness =
  /** Se sirve de caché sin tocar la red. */
  | "fresh"
  /** Se sirve de caché al instante, pero se revalida en segundo plano (stale-while-revalidate). */
  | "stale"
  /** No se sirve: hay que ir a la red y esperar. */
  | "expired";

export interface FreshnessPolicy {
  /** Hasta esta edad el dato se considera fresco. */
  ttlMs: number;
  /** Hasta esta edad todavía puede servirse como `stale` mientras se revalida. */
  maxStaleMs: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Búsquedas: el catálogo cambia poco; lo que envejece es el resumen de disponibilidad. */
export const SEARCH_POLICY: FreshnessPolicy = { ttlMs: 6 * HOUR, maxStaleMs: 7 * DAY };
/** Fichas: los metadatos casi no cambian, pero el estado de cada ejemplar sí. */
export const RECORD_POLICY: FreshnessPolicy = { ttlMs: 30 * 60 * 1000, maxStaleMs: 7 * DAY };

/**
 * Decide qué hacer con una entrada de caché según su edad.
 *
 * @param ageMs   edad de la entrada (ahora - storedAt). Puede ser negativa si el reloj retrocedió.
 * @param policy  ventanas de la política.
 */
export function decideFreshness(ageMs: number, policy: FreshnessPolicy): Freshness {
  // 1. Defensa: reloj desincronizado
  if (ageMs < 0) return 'expired';

  // 2. Fresco: no requiere red
  if (ageMs <= policy.ttlMs) return 'fresh';

  // 3. Stale: responde al instante (caché viejo) y actualiza en fondo
  if (ageMs <= policy.maxStaleMs) return 'stale';

  // 4. Expirado: obliga a esperar los ~10s de Koha
  return 'expired';
}