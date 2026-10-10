/**
 * MITECO / GEOPORTAL GASOLINERAS — the price of every fuel at every public
 * service station in Spain, published by the Spanish government and refreshed
 * every half hour, keyless.
 *
 * ## One source per station brand
 *
 * A source's account ref is the fold of the station's `Rótulo` — `repsol`,
 * `cepsa`, `ballenoil`, `plenergy` — and the source is bound to that brand's
 * merchant. Each record is one FUEL at one STATION: the fuel is the product,
 * the station (`storefrontHint`, plus every location fact) is where it is
 * sold. The national list is downloaded once into the shared cache and every
 * brand's source cuts its own stations from it.
 *
 * ## Prices carry three decimals; money carries two
 *
 * Fuel is priced per litre to the tenth of a cent (`1,849`). The offer's price
 * is EUR minor units, so it is rounded half-up to the cent, and the EXACT
 * published price is kept as a fact (`miteco.price_exact`) — rounding is a
 * presentation decision this record does not get to make silently.
 *
 * ## Terms
 *
 * Spain's general reuse terms for public-sector information: cite the source
 * and the update date (`miteco.data_timestamp`), do not distort, do not imply
 * endorsement. Commercial reuse is permitted.
 */

import { readFile } from 'node:fs/promises';
import type { NormalizedSourceRecord } from '@mercaria/shared-types';
import type { OpenDataItem, OpenDataPage, OpenDataPageContext, OpenDataProvider } from '../provider.js';
import { OpenDataSchemaError } from '../provider.js';
import { asArray, asNumber, asObject, asText, decimalMoney, FactCollector, subFeedKey } from '../read.js';

export const MITECO_FUEL_PROVIDER = 'miteco_fuel';

const LIST_URL =
  'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/';
/** The list is regenerated every 30 minutes. */
const LIST_MAX_AGE_MS = 30 * 60 * 1_000;

/** The `Precio …` columns, and the unit each is priced in. */
const FUELS: readonly { readonly column: string; readonly name: string; readonly unit: string }[] = [
  { column: 'Precio Gasolina 95 E5', name: 'Gasolina 95 E5', unit: 'EUR/l' },
  { column: 'Precio Gasolina 95 E10', name: 'Gasolina 95 E10', unit: 'EUR/l' },
  { column: 'Precio Gasolina 95 E25', name: 'Gasolina 95 E25', unit: 'EUR/l' },
  { column: 'Precio Gasolina 95 E5 Premium', name: 'Gasolina 95 E5 Premium', unit: 'EUR/l' },
  { column: 'Precio Gasolina 95 E85', name: 'Gasolina 95 E85', unit: 'EUR/l' },
  { column: 'Precio Gasolina 98 E5', name: 'Gasolina 98 E5', unit: 'EUR/l' },
  { column: 'Precio Gasolina 98 E10', name: 'Gasolina 98 E10', unit: 'EUR/l' },
  { column: 'Precio Gasolina Renovable', name: 'Gasolina renovable', unit: 'EUR/l' },
  { column: 'Precio Gasoleo A', name: 'Gasóleo A', unit: 'EUR/l' },
  { column: 'Precio Gasoleo B', name: 'Gasóleo B', unit: 'EUR/l' },
  { column: 'Precio Gasoleo Premium', name: 'Gasóleo Premium', unit: 'EUR/l' },
  { column: 'Precio Diésel Renovable', name: 'Diésel renovable', unit: 'EUR/l' },
  { column: 'Precio Biodiesel', name: 'Biodiésel', unit: 'EUR/l' },
  { column: 'Precio Bioetanol', name: 'Bioetanol', unit: 'EUR/l' },
  { column: 'Precio Gases licuados del petróleo', name: 'GLP (autogás)', unit: 'EUR/l' },
  { column: 'Precio Gas Natural Comprimido', name: 'Gas natural comprimido (GNC)', unit: 'EUR/kg' },
  { column: 'Precio Gas Natural Licuado', name: 'Gas natural licuado (GNL)', unit: 'EUR/kg' },
  { column: 'Precio Biogas Natural Comprimido', name: 'Biogás natural comprimido', unit: 'EUR/kg' },
  { column: 'Precio Biogas Natural Licuado', name: 'Biogás natural licuado', unit: 'EUR/kg' },
  { column: 'Precio Hidrogeno', name: 'Hidrógeno', unit: 'EUR/kg' },
  { column: 'Precio Adblue', name: 'AdBlue', unit: 'EUR/l' },
  { column: 'Precio Amoniaco', name: 'Amoniaco', unit: 'EUR/kg' },
  { column: 'Precio Metanol', name: 'Metanol', unit: 'EUR/l' },
];

interface BrandCut {
  readonly items: readonly OpenDataItem[];
  readonly digest: string;
}

const cuts = new Map<string, BrandCut>();
const MAX_CACHED_CUTS = 16;

export const mitecoFuelProvider: OpenDataProvider = {
  slug: MITECO_FUEL_PROVIDER,
  name: 'Precios de carburantes (MITECO)',
  homepage: 'https://geoportalgasolineras.es',
  role: 'prices',
  kind: 'feed',
  licence: 'es_public_sector_reuse',
  attribution: 'Fuente: Ministerio para la Transición Ecológica y el Reto Demográfico (Geoportal Gasolineras)',
  accountRefMeaning: 'the station brand, as the fold of its "Rótulo" (e.g. "repsol", "ballenoil")',
  accountRefRequired: true,
  refreshModes: ['full_snapshot', 'incremental'],
  minRequestIntervalMs: 2_000,
  fetchPage: fetchMitecoPage,
};

async function fetchMitecoPage(context: OpenDataPageContext): Promise<OpenDataPage> {
  const brand = subFeedKey(context.accountRef ?? '');
  const download = await context.http.download(LIST_URL, {
    maxAgeMs: LIST_MAX_AGE_MS,
    // The service negotiates: without this it answers XML.
    headers: { accept: 'application/json' },
    minIntervalMs: mitecoFuelProvider.minRequestIntervalMs,
    ...(context.signal ? { signal: context.signal } : {}),
  });

  const key = `${download.digest}|${brand}`;
  let cut = cuts.get(key);
  if (cut === undefined) {
    cut = { digest: download.digest, items: await cutBrand(download.path, brand) };
    cuts.set(key, cut);
    while (cuts.size > MAX_CACHED_CUTS) {
      const oldest = cuts.keys().next().value;
      if (oldest === undefined) break;
      cuts.delete(oldest);
    }
  }

  const offset = context.cursor?.d === cut.digest && typeof context.cursor.o === 'number' ? context.cursor.o : 0;
  const slice = cut.items.slice(offset, offset + context.pageSize);
  const next = offset + slice.length;
  const done = next >= cut.items.length;
  // The national list is every public station, so its last page is a
  // complete enumeration of the brand's station-fuel pairs: a pair it no
  // longer lists is a station that closed or stopped selling that fuel.
  return { items: slice, next: done ? null : { d: cut.digest, o: next }, complete: done };
}

async function cutBrand(path: string, brand: string): Promise<OpenDataItem[]> {
  // The ministry's JSON starts with a UTF-8 byte-order mark.
  const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/u, '');
  let body: Readonly<Record<string, unknown>> | undefined;
  try {
    body = asObject(JSON.parse(text));
  } catch {
    throw new OpenDataSchemaError('the station list is not JSON.');
  }
  if (body === undefined || !Array.isArray(body.ListaEESSPrecio)) {
    throw new OpenDataSchemaError('the station list has no `ListaEESSPrecio` array.');
  }
  const timestamp = madridTimestamp(asText(body.Fecha));

  const items: OpenDataItem[] = [];
  for (const entry of asArray(body.ListaEESSPrecio)) {
    const station = asObject(entry);
    if (station === undefined) continue;
    const label = asText(station['Rótulo']);
    if (label === undefined || subFeedKey(label) !== brand) continue;
    // `R` is a restricted sale (cooperative members, fleets). Only a price
    // anybody can pay belongs in a comparison.
    if (asText(station['Tipo Venta']) !== 'P') continue;
    items.push(...toItems(station, label, timestamp));
  }
  return items.sort((left, right) => (left.externalId < right.externalId ? -1 : left.externalId > right.externalId ? 1 : 0));
}

export function toItems(station: Readonly<Record<string, unknown>>, label: string, timestamp: Date | undefined): OpenDataItem[] {
  const stationId = asText(station.IDEESS);
  if (stationId === undefined) return [];
  const address = asText(station['Dirección']);
  const locality = asText(station.Localidad);
  const province = asText(station.Provincia);
  const storefront = [address, locality].filter((part): part is string => part !== undefined).join(', ');

  const items: OpenDataItem[] = [];
  for (const fuel of FUELS) {
    const raw = asText(station[fuel.column]);
    const price = decimalMoney(raw, 'EUR', ',');
    if (raw === undefined || price === undefined) continue;
    const facts = new FactCollector('miteco')
      .add('station_id', stationId)
      .add('brand', label)
      .add('fuel', fuel.name)
      .number('price_exact', raw, fuel.unit, ',')
      .text('address', address)
      .text('postcode', station['C.P.'])
      .text('locality', locality)
      .text('municipality', station.Municipio)
      .text('province', province)
      .text('municipality_id', station.IDMunicipio)
      .text('province_id', station.IDProvincia)
      .text('autonomous_community_id', station.IDCCAA)
      .number('latitude', station.Latitud, 'deg', ',')
      .number('longitude', station['Longitud (WGS84)'], 'deg', ',')
      .text('opening_hours', station.Horario)
      .text('roadside_margin', station.Margen)
      .text('remission', station['Remisión'])
      .number('bioethanol_percent', station['% BioEtanol'], '%', ',')
      .number('methyl_ester_percent', station['% Éster metílico'], '%', ',')
      .add('data_timestamp', timestamp?.toISOString())
      .toArray();

    const normalized: NormalizedSourceRecord = {
      title: fuel.name,
      identifiers: [],
      options: [],
      media: [],
      merchantHint: label,
      ...(storefront.length === 0 ? {} : { storefrontHint: storefront }),
      price,
      availability: 'in_stock',
      country: 'ES',
      ...(province === undefined ? {} : { region: province }),
      language: 'es',
      categoryKey: 'fuel',
      ...(timestamp === undefined ? {} : { sourceUpdatedAt: timestamp.toISOString() }),
      facts,
    };
    items.push({
      externalType: 'offer',
      externalId: `${stationId}:${subFeedKey(fuel.name)}`,
      normalized,
      ...(timestamp === undefined ? {} : { sourceUpdatedAt: timestamp }),
      raw: { stationId, fuel: fuel.column, price: raw, at: timestamp?.toISOString() ?? null },
    });
  }
  return items;
}

/**
 * `10/10/2026 4:03:28`, Madrid wall-clock time → the instant.
 *
 * The ministry publishes local time with no offset. The offset is read from
 * the platform's own tz database for that wall-clock moment, so the two
 * daylight-saving changes a year need no table here.
 */
export function madridTimestamp(text: string | undefined): Date | undefined {
  if (text === undefined) return undefined;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/u.exec(text);
  if (match === null) return undefined;
  const [, day, month, year, hour, minute, second] = match.map(Number);
  if (day === undefined || month === undefined || year === undefined || hour === undefined || minute === undefined || second === undefined) {
    return undefined;
  }
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const madrid = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(asUtc));
  const part = (type: string) => asNumber(madrid.find((entry) => entry.type === type)?.value) ?? 0;
  const shown = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return new Date(asUtc - (shown - asUtc));
}
