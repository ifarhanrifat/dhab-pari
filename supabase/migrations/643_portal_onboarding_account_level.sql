-- Real bug found live on device, 2026-10-13: WelcomeTour and PortalHelp
-- both tracked "already seen" as a plain localStorage flag, scoped to
-- one browser. Perfectly fine the first time, but every new device,
-- browser, or cleared-data session reads as "never seen" again --
-- exactly the "instructions keep showing every time I log in" report.
-- Moved to the account itself (portal_users), the same place every other
-- per-user preference already lives (e.g. notification_preferences),
-- so "seen" really does mean seen, from any device, forever.
alter table portal_users add column if not exists welcome_tour_seen boolean not null default false;
alter table portal_users add column if not exists dismissed_help_pages text[] not null default '{}';

comment on column portal_users.welcome_tour_seen is 'Whether this account has dismissed the one-time app-wide WelcomeTour. Account-level, not per-device.';
comment on column portal_users.dismissed_help_pages is 'PortalHelp page keys this account has dismissed the (?) explainer for. Account-level, not per-device.';
