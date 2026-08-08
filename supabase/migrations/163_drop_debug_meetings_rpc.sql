-- Migration 163: drop the temporary unguarded debug copies from 162 —
-- verified against real data, no longer needed, never left reachable.
DROP FUNCTION IF EXISTS _debug_get_meetings_core_data();
DROP FUNCTION IF EXISTS get_meetings_core_data_unchecked();
