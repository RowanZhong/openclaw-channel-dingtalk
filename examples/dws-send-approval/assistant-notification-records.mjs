import { PENDING } from "./assistant-store.mjs";
const KEY = "notificationCoverage";
function liveTracks(store, now) {
  return new Set(
    store
      .listCards()
      .filter(
        (c) => c.lane === "notification" && c.protocol === 2 && !c.invalidated && c.expires > now,
      )
      .map((c) => c.outTrackId),
  );
}
export function unnotifiedDrafts(store, rows, now) {
  const coverage = store.get(KEY) ?? {},
    live = liveTracks(store, now);
  return rows.filter((d) => {
    const record = coverage[d.id];
    return !record || record.version !== d.version || !live.has(record.track);
  });
}
export function rememberNotification(store, card, refs, now) {
  if (card.lane !== "notification" || !refs?.length) return;
  const active = new Set(store.list([...PENDING, "unknown"]).map((d) => String(d.id)));
  const live = liveTracks(store, now);
  const coverage = Object.fromEntries(
    Object.entries(store.get(KEY) ?? {}).filter(([id, r]) => active.has(id) && live.has(r.track)),
  );
  for (const ref of refs) {
    if (
      active.has(String(ref.id)) &&
      (!coverage[ref.id] || coverage[ref.id].version <= ref.version)
    )
      coverage[ref.id] = { version: ref.version, track: card.outTrackId };
  }
  // Bound by the pending queue; no message text or extra timer/CLI process.
  store.set(KEY, coverage);
}

export function legacyNotificationTrack(store, rows, now) {
  if (rows.length !== 1) return;
  const d = rows[0],
    live = liveTracks(store, now);
  return store
    .listCards()
    .find(
      (c) =>
        live.has(c.outTrackId) &&
        c.deliveryState === undefined &&
        ["draft", "inbox"].includes(c.name) &&
        c.refs.some((r) => r.id === d.id && r.version === d.version),
    )?.outTrackId;
}
