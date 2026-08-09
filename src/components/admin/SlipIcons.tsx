// Branded contact/action icons for the Universal Slip footer, taken from the
// approved design reference. Brand colours are deliberate: on a printed slip a
// recognisable blue "f" or green WhatsApp mark is found faster than a line of
// text, and the label underneath makes it unambiguous for anyone who doesn't
// recognise the glyph.
//
// Inline SVG with literal fills (no currentColor, no CSS variables) so they
// survive html2canvas rasterisation into the PNG/PDF export unchanged.

export type SlipIconName =
  | 'facebook' | 'whatsapp' | 'whatsappChat' | 'website' | 'email'
  | 'projects' | 'donate' | 'suggestions' | 'complaints'

export const SLIP_ICON_COLORS: Record<SlipIconName, string> = {
  facebook: '#1877F2',
  whatsapp: '#25D366',
  website: '#0EA5E9',
  email: '#F97316',
  projects: '#6366F1',
  donate: '#E11D48',
  // Joining the group and starting a one-to-one chat are different actions, so
  // they get different glyphs — same brand green, but a speech bubble rather
  // than the WhatsApp mark, so nobody taps "group" expecting a private chat.
  whatsappChat: '#25D366',
  suggestions: '#0891B2',
  complaints: '#D97706',
}

export function SlipIcon({ name, size = 20 }: { name: SlipIconName; size?: number }) {
  const c = SLIP_ICON_COLORS[name]
  const common = { width: size, height: size, viewBox: '0 0 24 24', xmlns: 'http://www.w3.org/2000/svg' }
  switch (name) {
    case 'facebook':
      return (
        <svg {...common} fill={c}>
          <path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.4v7A10 10 0 0 0 22 12Z" />
        </svg>
      )
    case 'whatsapp':
      return (
        <svg {...common} fill={c}>
          <path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.4A10 10 0 1 0 12 2Zm0 18.2c-1.6 0-3.2-.4-4.5-1.2l-.3-.2-3.1.8.8-3-.2-.3A8.2 8.2 0 1 1 20.2 12 8.2 8.2 0 0 1 12 20.2Zm4.5-6.1c-.2-.1-1.4-.7-1.6-.8s-.4-.1-.5.1-.6.8-.7.9-.3.2-.5.1a6.7 6.7 0 0 1-2-1.2 7.4 7.4 0 0 1-1.4-1.7c-.1-.2 0-.4.1-.5l.4-.4.2-.4v-.4c0-.1-.5-1.3-.7-1.8s-.4-.4-.5-.4h-.4a.9.9 0 0 0-.6.3 2.7 2.7 0 0 0-.8 2 4.7 4.7 0 0 0 1 2.5 10.7 10.7 0 0 0 4.2 3.7c1.5.6 1.8.5 2.2.5a1.9 1.9 0 0 0 1.3-.9 1.6 1.6 0 0 0 .1-.9c-.1-.1-.2-.2-.4-.3Z" />
        </svg>
      )
    case 'website':
      return (
        <svg {...common} fill="none" stroke={c} strokeWidth="1.8">
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z" />
        </svg>
      )
    case 'email':
      return (
        <svg {...common} fill="none" stroke={c} strokeWidth="1.8">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="m3 6 9 7 9-7" />
        </svg>
      )
    case 'projects':
      return (
        <svg {...common} fill="none" stroke={c} strokeWidth="1.8">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
        </svg>
      )
    case 'whatsappChat':
      return (
        <svg {...common} fill="none" stroke={c} strokeWidth="1.8">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-2.8-.4L3 21l1.6-4.6A8.3 8.3 0 0 1 3.6 11.5 8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />
          <path d="M8.5 10.5h7M8.5 14h4" />
        </svg>
      )
    case 'suggestions':
      return (
        <svg {...common} fill="none" stroke={c} strokeWidth="1.8">
          <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z" />
        </svg>
      )
    case 'complaints':
      return (
        <svg {...common} fill="none" stroke={c} strokeWidth="1.8">
          <path d="M12 3 2.5 20h19L12 3Z" />
          <path d="M12 9.5v4M12 16.8v.2" />
        </svg>
      )
    case 'donate':
      return (
        <svg {...common} fill={c}>
          <path d="M12 21s-7.5-4.6-10-9.1C.6 8.4 2.4 5 6 5c2 0 3.4 1.1 4 2.1C10.6 6.1 12 5 14 5c3.6 0 5.4 3.4 4 6.9-2.5 4.5-10 9.1-10 9.1Z" />
        </svg>
      )
  }
}
