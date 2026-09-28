import './blob-environment.js';
import { get, put } from '@vercel/blob';

const SNAPSHOT_PATH = 'daily-fixture-snapshots/current.json';
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_REFRESH_MS = 5 * 60 * 1000;
const MIN_COMPLETE_COMPETITION_FIXTURES = 2;
const DEFAULT_BLOB = { get, put };

function validDate(value) {
  const date = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function validKickoff(value) {
  return Number.isFinite(Date.parse(value || ''));
}

function uniqueFixtures(fixtures) {
  const byId = new Map();
  for (const fixture of Array.isArray(fixtures) ? fixtures : []) {
    const id = positiveId(fixture?.id);
    if (!id || !validKickoff(fixture?.kickoff)) continue;
    byId.set(id, fixture);
  }
  return [...byId.values()];
}

function sortFixtures(fixtures) {
  return [...fixtures].sort((left, right) => (
    Date.parse(left.kickoff) - Date.parse(right.kickoff)
    || Number(left.id) - Number(right.id)
  ));
}

function fixtureGroups(fixtures) {
  const groups = new Map();
  for (const fixture of fixtures) {
    const competitionId = positiveId(fixture?.competitionId);
    if (!competitionId) continue;
    const group = groups.get(competitionId) || [];
    group.push(fixture);
    groups.set(competitionId, group);
  }
  return groups;
}

function snapshotAgeMs(snapshot, now) {
  const capturedAt = Date.parse(snapshot?.capturedAt || '');
  if (!Number.isFinite(capturedAt)) return null;
  const age = Number(now) - capturedAt;
  return age >= 0 ? age : null;
}

function tokyoDate(now) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function isCurrentTokyoDate(date, now) {
  return validDate(date) === tokyoDate(now);
}

export function isUsableDailyFixtureSnapshot(snapshot, { date, now = new Date(), maxAgeMs = SNAPSHOT_TTL_MS } = {}) {
  const expectedDate = validDate(date);
  if (!expectedDate || !snapshot || snapshot.version !== SNAPSHOT_VERSION || snapshot.date !== expectedDate) return false;
  if (!uniqueFixtures(snapshot.fixtures).length) return false;
  const age = snapshotAgeMs(snapshot, now);
  return age != null && age <= maxAgeMs;
}

export function stabilizeDailyFixtures(currentFixtures, snapshot, { date, now = new Date(), maxAgeMs = SNAPSHOT_TTL_MS } = {}) {
  const current = uniqueFixtures(currentFixtures);
  if (!isUsableDailyFixtureSnapshot(snapshot, { date, now, maxAgeMs })) {
    return { fixtures: sortFixtures(current), restoredCompetitionIds: [] };
  }

  const previous = uniqueFixtures(snapshot.fixtures);
  const currentCompetitionIds = new Set(fixtureGroups(current).keys());
  const previousGroups = fixtureGroups(previous);
  const restoredCompetitionIds = [...previousGroups.entries()]
    .filter(([competitionId, fixtures]) => (
      !currentCompetitionIds.has(competitionId)
      && (current.length === 0 || fixtures.length >= MIN_COMPLETE_COMPETITION_FIXTURES)
    ))
    .map(([competitionId]) => competitionId)
    .sort((left, right) => left - right);

  if (!restoredCompetitionIds.length) {
    return { fixtures: sortFixtures(current), restoredCompetitionIds };
  }

  const restoredIds = new Set(restoredCompetitionIds);
  const currentIds = new Set(current.map((fixture) => positiveId(fixture.id)));
  const restored = previous.filter((fixture) => (
    restoredIds.has(positiveId(fixture.competitionId))
    && !currentIds.has(positiveId(fixture.id))
  ));
  return { fixtures: sortFixtures([...current, ...restored]), restoredCompetitionIds };
}

function sameFixtures(left, right) {
  return JSON.stringify(sortFixtures(uniqueFixtures(left))) === JSON.stringify(sortFixtures(uniqueFixtures(right)));
}

function isConditionalWriteConflict(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return error?.status === 412
    || error?.statusCode === 412
    || /precondition|etag|condition.*fail|already exists|conflict/.test(text);
}

async function readSnapshotRecord({ blob = DEFAULT_BLOB } = {}) {
  const result = await blob.get(SNAPSHOT_PATH, { access: 'private', useCache: false });
  if (!result?.stream) return { snapshot: null, etag: null };
  return {
    snapshot: JSON.parse(await new Response(result.stream).text()),
    // `get` returns metadata beneath `blob` in @vercel/blob. Keep the
    // top-level fallback solely for the existing in-process test doubles.
    etag: result.blob?.etag || result.etag || null,
  };
}

function shouldWriteSnapshot(previous, current, stabilized, { date, now }) {
  // A response that needed a recovered competition is useful only to serve
  // this request. Writing it would extend a transient omission's lifetime.
  if (!current.length || stabilized.restoredCompetitionIds.length) return false;
  if (!isUsableDailyFixtureSnapshot(previous, { date, now })) return true;
  if (!sameFixtures(previous.fixtures, current)) return true;
  const age = snapshotAgeMs(previous, now);
  return age == null || age >= SNAPSHOT_REFRESH_MS;
}

function buildResult(current, record, { date, now }) {
  const previous = record.snapshot;
  if (!current.length && !isUsableDailyFixtureSnapshot(previous, { date, now })) return null;
  const stabilized = stabilizeDailyFixtures(current, previous, { date, now });
  if (!stabilized.fixtures.length) return null;
  return {
    ...stabilized,
    shouldWrite: shouldWriteSnapshot(previous, current, stabilized, { date, now }),
  };
}

function snapshotFor(date, current, now) {
  return {
    version: SNAPSHOT_VERSION,
    date,
    capturedAt: new Date(now).toISOString(),
    // Only a direct provider response becomes durable state. In particular,
    // never persist a response with temporarily restored competition groups.
    fixtures: current,
  };
}

async function writeSnapshot(snapshot, record, { blob = DEFAULT_BLOB } = {}) {
  if (record.snapshot && !record.etag) return false;
  await blob.put(SNAPSHOT_PATH, JSON.stringify(snapshot), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: Boolean(record.snapshot),
    contentType: 'application/json',
    ...(record.etag ? { ifMatch: record.etag } : {}),
  });
  return true;
}

export function isProductionDailyFixtureSnapshotEnabled(env = process.env) {
  return env?.VERCEL_ENV === 'production' && Boolean(env?.BLOB_READ_WRITE_TOKEN);
}

// A production deployment has an empty CDN response cache. Keep a very short
// durable last-good daily response so one transient upstream omission cannot
// remove an entire scheduled competition while that cache warms again.
export async function preserveDailyFixtureSnapshot(date, currentFixtures, {
  now = new Date(),
  blob = DEFAULT_BLOB,
} = {}) {
  const normalizedDate = validDate(date);
  const current = uniqueFixtures(currentFixtures);
  if (!normalizedDate || !isCurrentTokyoDate(normalizedDate, now)) return null;

  try {
    let record = await readSnapshotRecord({ blob });
    let result = buildResult(current, record, { date: normalizedDate, now });
    if (!result) return null;
    if (!result.shouldWrite) return { ...result, snapshot: record.snapshot };

    const snapshot = snapshotFor(normalizedDate, current, now);
    try {
      const wrote = await writeSnapshot(snapshot, record, { blob });
      return { ...result, snapshot: wrote ? snapshot : record.snapshot };
    } catch (error) {
      if (!isConditionalWriteConflict(error)) throw error;
      // A concurrent request may have received a more complete or newer
      // provider response. Re-read it but do not retry a stale overwrite.
      record = await readSnapshotRecord({ blob });
      result = buildResult(current, record, { date: normalizedDate, now });
      return result ? { ...result, snapshot: record.snapshot } : null;
    }
  } catch {
    // Cache preservation is advisory: an unavailable Blob store must never
    // turn an otherwise valid fixture response into an error.
    return null;
  }
}
