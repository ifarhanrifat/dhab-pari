// vehicle_type is the committee's own category at registration (trusted);
// model is a free-text nickname the driver can set/change anytime via
// their own catalog page, with no validation against vehicle_type at all.
// Real gap found live: every screen used `model || vehicle_type`, so a
// driver's self-entered model silently overrode the committee's category
// everywhere — a rickshaw registered as "Raksha" displayed as "Suzuki
// Ravi" because the driver had typed that into model. vehicle_type must
// always be the visible primary label; model is a supplementary detail,
// never a replacement.
// Real Urdu-mode bug found live: vehicle_type is free text entered once
// at registration, with no _ur counterpart column (and never could have
// one for a free-text field) — a rental/hourly/equipment vehicle always
// showed its English type even in Urdu mode. Vehicles registered since
// the category system (707) carry a real vehicle_categories.name_ur —
// `localizedType` is that already-isUrdu-resolved string, passed in by
// whichever caller's own RPC now selects it; omit it and this falls
// straight back to the old vehicleType-only behavior unchanged.
export function vehicleDisplayName(vehicleType: string | null | undefined, model?: string | null, localizedType?: string | null): string {
  const type = (localizedType?.trim() || vehicleType?.trim() || '')
  const nickname = model?.trim() || ''
  if (!type) return nickname
  if (nickname && nickname !== type) return `${type} (${nickname})`
  return type
}
