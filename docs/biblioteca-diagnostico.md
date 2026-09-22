# Biblioteca Virtual UNSA (Koha): diagnóstico de rendimiento y arquitectura de integración

> Diagnóstico del 2026-09-21, medido desde Arequipa (conexión residencial) con `curl` y con
> scripts de undici que controlan qué socket usa cada petición. Es la base para integrar el
> catálogo en `dutic` (CLI + MCP) y, más adelante, en una aplicación.

## 1. Resumen ejecutivo

- El OPAC `http://bibliotecavirtual.unsa.edu.pe:8081/` es **Koha 19.11.29** sobre Apache 2.4.29
  (Ubuntu 18.04).
- **Koha en sí es rápido**: una ficha tarda ~0.25 s y una búsqueda ~0.3 s + ~0.05 s por
  registro, **siempre que la petición llegue por una conexión que tuvo otra hace menos de ~1 s**.
- En cualquier otro caso (conexión nueva, o más de ~1 s sin actividad), la petición paga
  **~10 s fijos** antes del primer byte. Como un usuario humano nunca pide dos cosas en menos de
  un segundo, en la práctica **cada consulta paga esos 10 s**. Por eso el portal "es lento".
- Los archivos estáticos (CSS, JS) responden en ~50 ms incluso por conexión nueva. El costo está
  en el camino hacia el backend dinámico de Koha, no en la red.
- **Causa más probable:** Apache le pasa las peticiones dinámicas a un backend Plack/Starman.
  Starman cierra las conexiones ociosas al cabo de **1 s** (su `--keepalive-timeout` por
  defecto), y reabrir esa conexión Apache→backend cuesta ~10 s (el patrón típico de una
  resolución DNS del backend que agota el timeout, 5 s × 2 intentos). No tenemos acceso al
  servidor para confirmarlo, pero todas las mediciones encajan.
- Desde fuera no podemos arreglar el servidor. Lo que sí podemos hacer es: (1) no repetir
  consultas (caché en dos niveles, SWR, singleflight) y (2) **aprovechar la ventana caliente**
  para agrupar en ráfagas secuenciales las peticiones que igual haríamos, en vez de pagar 10 s
  por cada una.

> **Corrección.** La primera versión de este diagnóstico atribuía los 10 s al arranque de Perl en
> modo CGI (sin Plack). Era falso: al reutilizar el socket, el mismo script Perl respondió en
> 0.23 s. Lo descubrimos porque el servidor MCP abrió una ficha en 316 ms justo después de una
> búsqueda.

## 2. Mediciones

### 2.1 Conexión fría (lo que ve un usuario en el navegador)

| Petición | TTFB | Tamaño |
|---|---:|---:|
| CSS estático (`/opac-tmpl/bootstrap/css/opac_19.1129000.css`) | **0.05 s** | 43 KB |
| `/cgi-bin/koha/errors/404.pl` (Perl sin trabajo) | 10.1 s | 30 KB |
| `/api/v1/` (spec OpenAPI) | 9.6 s | 227 KB |
| `/` (portada OPAC) | 12.7 s | 51 KB |
| Búsqueda, `count=20` / `100` / `500` | 12.3 / 17.7 / 34.8 s | 122 KB / 400 KB / 1.7 MB |
| `opac-detail.pl` | 12.5 s | 43 KB |
| 4 búsquedas en paralelo (4 sockets) | ~13 s c/u | |

### 2.2 El mismo socket con distintas pausas

Ficha `opac-detail.pl`, con un único socket de undici:

| Pausa desde la respuesta anterior | Tiempo | `Keep-Alive` |
|---|---:|---|
| (primera, socket nuevo) | 9 286 ms | `timeout=5, max=100` |
| 0 ms (ráfaga, 5 fichas distintas) | 225–278 ms | `max=99…95` (mismo socket) |
| 250 ms | 237 ms | `max=94` |
| 500 ms | 271 ms | `max=93` |
| **1 000 ms** | **9 771 ms** | `max=92` (¡mismo socket, pero frío!) |
| 1 500 ms | 10 071 ms | `max=91` |
| 3 000 ms | 9 269 ms | `max=100` (Apache cerró el socket a los 5 s) |

- **La ventana caliente dura menos de 1 s.** No depende del keep-alive cliente↔Apache (que dura
  5 s): el mismo socket se enfría antes. Por eso apuntamos a un timeout interno de 1 s.
- **Es por conexión.** Un socket nuevo abierto justo después de una petición caliente tardó
  8.3 s.
- **En caliente, el costo es lineal en registros:** búsqueda de 50 → 3.2 s; de 200 → 9.7 s.

Modelo: **t ≈ [10 s si el socket lleva ≥1 s ocioso] + 0.3 s + 0.05 s × registros**.

### 2.3 Otros hechos

- `count` **no tiene tope** (500 funciona).
- Con **exactamente un resultado**, Koha responde `302` a `opac-detail.pl`. Ningún parámetro lo
  evita (probados `offset`, `count`, `sort_by`, `expand`).
- Reutilizar la cookie `CGISESSID` no cambia nada: la lentitud no es de la sesión.

## 3. Superficie del servidor

| Endpoint | Estado | Uso |
|---|---|---|
| `opac-search.pl` (HTML) | ✅ | **Fuente primaria**: disponibilidad, sede, signatura, nº de ejemplares, COinS |
| `opac-search.pl?format=rss` | ✅ | 6× más liviano, pero **sin disponibilidad**; posible respaldo |
| `opac-detail.pl` | ✅ | Ficha: temas, descripción física, cada ejemplar con su estado y vencimiento |
| `opac-export.pl?format=marcxml` | ✅ | MARC21 crudo; útil para una futura indexación propia |
| `oai.pl` (OAI-PMH) | ❌ | "OAI-PMH service is disabled" |
| `/api/v1/public/biblios/{id}` | ❌ | 404 (API REST pública desactivada) |
| Z39.50 (210), SRU (9998) | ❌ | puertos cerrados |
| **8080** | ⚠️ | **Intranet del personal (login de Koha staff) expuesta a Internet** |

> **Hallazgo de seguridad.** El puerto 8080 publica el login de la intranet de Koha. No lo
> tocamos. Conviene avisar a la biblioteca o a la DUTIC: una interfaz de administración expuesta
> sobre Ubuntu 18.04 (sin soporte estándar desde 2023) y Koha 19.11 (sin soporte desde 2021) es
> un riesgo.

### Parámetros de `opac-search.pl`

| Parámetro | Valores | Nota |
|---|---|---|
| `q` | texto | consulta |
| `idx` | vacío (`kw`), `ti`, `au`, `su`, `nb` | cualquiera, título, autor, tema, ISBN |
| `count` | entero | resultados por petición, sin tope |
| `offset` | entero | desplazamiento para paginar |
| `format` | `rss`, `opensearchdescription` | salidas alternativas |

### Estructura del HTML (Koha 19.11, tema bootstrap, español)

- **Total:** `#numresults` → "Su búsqueda retornó **N** resultados." Si no hay nada: "¡No se
  encontraron resultados!".
- **Resultado:** `div.title_summary#title_summary_<biblionumber>` con `a.title`,
  `span.author` (varios autores separados por `span.separator " | "`), `.results_summary.edition`,
  `.publisher`, `.languages`, y en la misma celda `span.Z3988` (COinS con ISBN y fecha
  normalizados; el `title` viene doblemente escapado, `&amp;amp;`).
- **Disponibilidad** (`.results_summary.availability`):
  - `span.available` → uno o varios `span.ItemSummary` = `ItemBranch` + `CallNumber` + `(n)`.
    En datos reales aparece `ItemBranch` vacío (ejemplar sin sede catalogada).
  - `span.noitems` → "No hay ítems disponibles" (registro sin ejemplares físicos).
  - `span.unavailable` y otras clases de estado → texto libre.
- **Ficha:** `h2.title`, microdatos schema.org (`[property=author|publisher|datePublished|
  bookEdition|description|isbn|keywords]`) y la tabla `#holdingst` con un ejemplar por fila
  (`td.itype`, `td.location`, `td.call_no`, `td.copynumber`, `td.status .item-status`,
  `td.date_due`, `td.barcode`).

## 4. Estrategia de aceleración (lado cliente)

| # | Técnica | Efecto medido |
|---|---|---|
| 1 | **Caché en dos niveles**: memoria (LRU) + disco global `~/.dutic/biblioteca/cache` | búsqueda repetida: ~12 s → **3 ms** (MCP) |
| 2 | **Normalización** (minúsculas, sin tildes, espacios; ISBN sin guiones) | "Microeconomía" reutiliza la caché de "microeconomia" |
| 3 | **Singleflight** | N consultas idénticas en vuelo → 1 petición |
| 4 | **Stale-while-revalidate** (MCP) | una copia algo vieja sale al instante y se refresca en segundo plano |
| 5 | **Respaldo ante caída** | si Koha falla, se sirve la última copia marcada `stale` con `warning` |
| 6 | **Ráfagas secuenciales por el socket caliente** | 5 fichas: ~50 s en frío → **1.6 s** |
| 7 | **Prefetch tras cada búsqueda** (MCP: 5 fichas; CLI: `--fichas N`) | abrir una ficha después: ~12 s → **1 ms** |
| 8 | **Una petición por búsqueda** (`limit` 30 por defecto, máx. 200) | evita pagar 10 s por página |
| 9 | **Fichas en secuencia, nunca en paralelo** | en paralelo, cada socket nuevo es frío (10 s c/u) |
| 10 | **Pool pequeño** (2 sockets, keep-alive 4 s) y timeouts propios (90 s) | reusa el socket caliente; búsquedas grandes sin cortes |
| 11 | **Redirect de un único resultado** resuelto a mano | la ficha que ya se descargó queda en caché 7 días |

**Lo que NO hacemos:** mantener el socket caliente con peticiones periódicas. Haría falta una
petición por segundo, sin pausa, a un servidor ajeno de la universidad. Solo usamos la ventana
caliente para peticiones que igual haríamos.

**Frescura.** El catálogo casi no cambia; la disponibilidad sí.

| Dato | Fresco | Servible como `stale` hasta |
|---|---|---|
| Búsqueda | 6 h | 7 días |
| Ficha + ejemplares | 30 min | 7 días |

La caché es **global, no por semestre**: el catálogo es público y no depende del período.

## 5. Arquitectura (clean architecture)

```
src/biblioteca/
  domain/                 Reglas puras. Sin I/O ni dependencias externas.
    entities.ts           BiblioSummary, BiblioRecord, Availability, Item, SearchPage, Fetched<T>
    query.ts              normalización, límites, claves de caché, validación de ids
    errors.ts             LibraryUnavailableError, LibraryProtocolError
  application/            Casos de uso. Solo conocen puertos (interfaces).
    ports.ts              CatalogGateway, CatalogCache, Clock
    freshness.ts          política fresco / stale / vencido
    cachedResolver.ts     caché → singleflight → origen (+ SWR y respaldo)
    libraryService.ts     search(), getRecord(), getRecords(), prefetchRecords()
  infrastructure/
    koha/                 Adaptador del OPAC Koha 19.11
      kohaHttp.ts         agente undici (pool chico, keep-alive), timeouts, guardia de origen
      kohaUrls.ts         construcción de URLs
      kohaParsers.ts      parsers puros (cheerio), probados contra fixtures reales
      kohaGateway.ts      implementa CatalogGateway (incluye el 302 de resultado único)
    cache/caches.ts       MemoryCache, FileCache (escritura atómica), TieredCache, NullCache
  composition.ts          raíz de composición: el único archivo que conoce las implementaciones
```

- Las dependencias solo apuntan hacia adentro: `cli/biblioteca.ts` y `mcp/server.ts` →
  `composition.ts` → `LibraryService` → puertos.
- Dominio y aplicación no importan undici, cheerio ni `fs`. El módulo se puede sacar tal cual a
  un paquete (`@dutic/biblioteca`) y usar desde un backend.
- La URL del OPAC se puede cambiar con `DUTIC_LIBRARY_URL` (útil para un proxy o un espejo).
- Tests: `kohaParsers.test.ts` (fixtures en `test/fixtures/biblioteca/`) y
  `libraryService.test.ts` (gateway falso: frescura, singleflight, SWR, respaldo, prefetch).

### Superficies

| Superficie | Uso |
|---|---|
| CLI | `dutic lib search <texto> [--por titulo\|autor\|tema\|isbn] [-n N] [--offset N] [--fichas N] [--json]` |
| | `dutic lib show <id> [--json]` · `dutic lib cache-clear` · globales `--refresh`, `--no-cache` |
| MCP | `dutic_library_search` (con `notifications/progress` y prefetch de 5 fichas) |
| | `dutic_library_record` (ejemplares con estado y vencimiento) |

### Contrato de datos (lo que consume la app)

```jsonc
// Toda respuesta del servicio: Fetched<T>
{
  "data": { /* SearchPage | BiblioRecord | null */ },
  "fetchedAt": 1790000000000,   // cuándo se obtuvo del OPAC
  "stale": false,               // true: copia vieja (revalidando, o el OPAC falló)
  "source": "network",          // "network" | "cache"
  "warning": "…"                // solo si se sirvió caché porque el OPAC falló
}
// SearchPage
{
  "query": { "text": "matematica para economistas", "field": "any", "limit": 30, "offset": 0 },
  "total": 16, "hasMore": false,
  "results": [{
    "id": "823127",
    "title": "Matemáticas para economistas",
    "authors": ["Dowling, Edward"],
    "edition": "1ra. ed.", "publisher": "México D.F. - México Mcgraw-Hill 1982",
    "year": "1982", "isbn": "B9684512805", "language": null,
    "availability": {
      "state": "available",     // available | unavailable | no_items | unknown
      "holdings": [{ "branch": "Bibl. Central de Sociales", "callNumber": "E01-21-023", "count": 3 }],
      "notes": []
    },
    "url": "http://bibliotecavirtual.unsa.edu.pe:8081/cgi-bin/koha/opac-detail.pl?biblionumber=823127"
  }]
}
// BiblioRecord = BiblioSummary + { description, subjects[], classification, items[] }
// Item = { itemType, branch, shelvingLocation, callNumber, copyNumber,
//          status: "available"|"checked_out"|"unavailable", statusLabel, dueDate, barcode }
```

## 6. Hoja de ruta hacia la app

1. **Proxy del OPAC con sockets calientes.** El hallazgo más importante para escalar. Un
   backend que atiende a muchos usuarios manda peticiones al OPAC casi sin pausa. Si todas pasan
   por **un solo proceso con pocos sockets y una cola**, esos sockets se mantienen calientes con
   tráfico real, y cada consulta cuesta ~0.3–3 s en vez de ~12 s. Con poco tráfico, la primera
   consulta de cada ráfaga paga los 10 s; las demás no. `KohaGateway` ya concentra todo el
   tráfico en un agente de 2 sockets; en la app, ese agente vive en el backend.
2. **Caché compartida (Supabase).** Agregar un adaptador remoto de `CatalogCache` (tabla
   `library_cache(key text primary key, payload jsonb, stored_at timestamptz)` + Edge Function)
   como tercer nivel: `new TieredCache([memory, file, remote])`. El catálogo es público, así que
   lo que busca un usuario queda instantáneo para todos. Solo cambia `composition.ts`.
3. **Índice propio.** Sin OAI-PMH, se puede sembrar un índice (Postgres FTS o Meilisearch) con
   barridos `count=200` por materia, en ráfagas secuenciales (en caliente, cada una cuesta
   ~10 s), de madrugada y a ritmo bajo. Las búsquedas pasarían a milisegundos y la
   disponibilidad se consultaría en vivo por ficha (~0.25 s en caliente).
4. **Del lado de la UNSA** (la solución de fondo): subir el `--keepalive-timeout` de Starman,
   configurar el pool de conexiones al backend en `ProxyPass` (`keepalive=On`, `ttl` mayor) o
   corregir la resolución del nombre del backend. Cualquiera de las tres eliminaría los ~10 s.
   Vale la pena proponérselo a la biblioteca junto con el hallazgo del puerto 8080.

## 7. Resultados de la implementación

| Operación | Antes (navegador / cliente ingenuo) | Ahora |
|---|---:|---:|
| Búsqueda nueva | ~12–16 s | ~10–16 s (límite del servidor) |
| La misma búsqueda otra vez (o con tildes o mayúsculas distintas) | ~12–16 s | **3 ms** (MCP) / **<50 ms** de servicio (CLI) |
| Abrir una de las 5 primeras fichas tras buscar | ~12 s | **1 ms** (precargada) |
| Precargar 5 fichas | ~50–60 s | **1.6 s** |
| Buscar por ISBN (resultado único, 302) | ~28 s | ~28 s la primera vez; la ficha queda en caché |
| OPAC caído con copia guardada | error | copia `stale` + `warning` |

Tests: 17 casos sin red (`npx tsx --test src/biblioteca/**/*.test.ts`).
