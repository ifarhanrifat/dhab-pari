// Retired 2026-10-21: this was one of two competing "my bookings"
// aggregators (the other being marketplace/(mobility)/trips/page.tsx),
// each covering a different subset of booking types — the literal
// mechanism behind the "bookings land in a separate option" complaint.
// Every source this page ever read (shop orders, routes, trip-share,
// hourly) is now merged into the one real Bookings page instead. Kept
// as a redirect, not deleted, so an old bookmark/link still lands
// somewhere real rather than 404ing.
import { redirect } from 'next/navigation'

export default function MarketplaceOrdersRedirect() {
  redirect('/portal/marketplace/trips')
}
