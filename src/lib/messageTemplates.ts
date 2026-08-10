// %%key%% placeholder convention — matches the reference invoicing app this
// was modeled on, so the same mental model transfers directly.
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.split(`%%${key}%%`).join(value),
    body
  )
}

export interface TemplateKeyInfo { token: string; description: string }

export const TEMPLATE_KEYS: Record<string, TemplateKeyInfo[]> = {
  connection_activated: [
    { token: '%%name%%', description: 'Consumer name' },
    { token: '%%consumer_id%%', description: 'Consumer number' },
    { token: '%%monthly_amount%%', description: 'Monthly bill amount' },
  ],
  bill_reminder_weekly: [
    { token: '%%name%%', description: 'Consumer name' },
    { token: '%%consumer_id%%', description: 'Consumer number' },
    { token: '%%outstanding%%', description: 'Total outstanding amount' },
    { token: '%%due_date%%', description: 'Bill due date' },
  ],
  bill_defaulter_warning: [
    { token: '%%name%%', description: 'Consumer name' },
    { token: '%%consumer_id%%', description: 'Consumer number' },
    { token: '%%outstanding%%', description: 'Total outstanding amount' },
    { token: '%%due_date%%', description: 'Bill due date' },
    { token: '%%restore_fee%%', description: 'Reconnection charge (set in Settings)' },
  ],
  donor_recurring_reminder: [
    { token: '%%name%%', description: 'Donor name' },
    { token: '%%amount%%', description: 'Contribution amount' },
    { token: '%%due_date%%', description: 'Next contribution date' },
  ],
  donor_donation_confirmed: [
    { token: '%%name%%', description: 'Donor name' },
    { token: '%%amount%%', description: 'Donation amount' },
    { token: '%%account_no%%', description: 'Donor account number' },
    { token: '%%project%%', description: 'Project name (or General Fund)' },
  ],
  donor_pledge_reminder: [
    { token: '%%name%%', description: 'Donor name' },
    { token: '%%amount%%', description: 'Pledged amount' },
    { token: '%%date%%', description: 'Date the pledge was announced' },
  ],
  role_request_accepted: [
    { token: '%%name%%', description: 'Requester name' },
  ],
  role_request_declined: [
    { token: '%%name%%', description: 'Requester name' },
  ],
  volunteer_accepted: [
    { token: '%%name%%', description: 'Volunteer name' },
    { token: '%%project%%', description: 'Project(s) they were put on, read from Volunteers' },
  ],
  consumer_outstanding_notify: [
    { token: '%%name%%', description: 'Consumer name' },
    { token: '%%consumer_id%%', description: 'Consumer number' },
    { token: '%%outstanding%%', description: 'Total outstanding amount' },
    { token: '%%pending_count%%', description: 'Number of pending bills' },
  ],
}
