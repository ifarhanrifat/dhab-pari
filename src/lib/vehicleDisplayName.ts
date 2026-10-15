// vehicle_type is the committee's own category at registration (trusted);
// model is a free-text nickname the driver can set/change anytime via
// their own catalog page, with no validation against vehicle_type at all.
// Real gap found live: every screen used `model || vehicle_type`, so a
// driver's self-entered model silently overrode the committee's category
// everywhere — a rickshaw registered as "Raksha" displayed as "Suzuki
// Ravi" because the driver had typed that into model. vehicle_type must
// always be the visible primary label; model is a supplementary detail,
// never a replacement.
export function vehicleDisplayName(vehicleType: string | null | undefined, model?: string | null): string {
  const type = vehicleType?.trim() || ''
  const nickname = model?.trim() || ''
  if (!type) return nickname
  if (nickname && nickname !== type) return `${type} (${nickname})`
  return type
}
