---
name: Dhab Pari Design System
colors:
  surface: '#fcf9f8'
  surface-dim: '#dcd9d9'
  surface-bright: '#fcf9f8'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f6f3f2'
  surface-container: '#f0eded'
  surface-container-high: '#eae7e7'
  surface-container-highest: '#e5e2e1'
  on-surface: '#1c1b1b'
  on-surface-variant: '#404945'
  inverse-surface: '#313030'
  inverse-on-surface: '#f3f0ef'
  outline: '#707975'
  outline-variant: '#bfc9c4'
  surface-tint: '#2a6959'
  primary: '#00372c'
  on-primary: '#ffffff'
  primary-container: '#085041'
  on-primary-container: '#83c1ad'
  inverse-primary: '#94d3bf'
  secondary: '#006c4e'
  on-secondary: '#ffffff'
  secondary-container: '#83f5c6'
  on-secondary-container: '#007151'
  tertiary: '#003829'
  on-tertiary: '#ffffff'
  tertiary-container: '#00513d'
  on-tertiary-container: '#5bc8a3'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#b0efdb'
  primary-fixed-dim: '#94d3bf'
  on-primary-fixed: '#002019'
  on-primary-fixed-variant: '#095041'
  secondary-fixed: '#86f8c9'
  secondary-fixed-dim: '#68dbae'
  on-secondary-fixed: '#002115'
  on-secondary-fixed-variant: '#00513a'
  tertiary-fixed: '#8af7cf'
  tertiary-fixed-dim: '#6edab4'
  on-tertiary-fixed: '#002117'
  on-tertiary-fixed-variant: '#00513d'
  background: '#fcf9f8'
  on-background: '#1c1b1b'
  surface-variant: '#e5e2e1'
typography:
  display-lg:
    fontFamily: Playfair Display
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 60px
  headline-lg:
    fontFamily: Playfair Display
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
  headline-lg-mobile:
    fontFamily: Playfair Display
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
  title-md:
    fontFamily: Source Sans 3
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Source Sans 3
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Source Sans 3
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-sm:
    fontFamily: Source Sans 3
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.05em
  urdu-body:
    fontFamily: Noto Nastaliq Urdu
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 36px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  container-max: 1200px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 40px
---

## Brand & Style
The design system is engineered to evoke trust, communal growth, and institutional stability for a village welfare portal. The brand personality is authoritative yet approachable, bridging the gap between traditional community values and modern administrative efficiency. 

The aesthetic follows a **Corporate / Modern** direction with a focus on legibility and structured information density. It utilizes a flat, card-based layout that prioritizes content over decorative flourishes. The visual language emphasizes "Nature and Growth" through a monochromatic green scale, reflecting the agricultural and environmental context of the region. The UI should feel like a reliable public service—stable, transparent, and permanent.

## Colors
The palette is rooted in a deep, institutional green to establish immediate authority. 

- **Primary Dark (#085041):** Used for the brand wordmark, primary navigation backgrounds, and high-level headers.
- **Primary Mid (#0F6E56):** Used for primary action buttons and active states.
- **Accent Green (#1D9E75):** Used for supportive UI elements and secondary actions.
- **Teal Highlight (#5DCAA5):** Reserved for success states and highlighting positive progress.
- **Surface & Background:** A soft, mint-tinted light background (#E1F5EE) provides a low-strain reading environment, while pure white (#FFFFFF) cards create clear separation for content.
- **Status Colors:** Use standard semantic reds for "UNPAID" and ambers for "Ongoing," but ensure they are slightly desaturated to harmonize with the green-heavy environment.

## Typography
The typography strategy uses a "Serif for Authority, Sans for Utility" approach.

- **Headings & Logo:** Playfair Display provides a literary, dignified feel for all major headings and the text-only logo.
- **Body & Interface:** Source Sans 3 (as a professional alternative to standard sans) is used for all functional text, data tables, and forms to ensure maximum legibility.
- **Bilingual Support:** Noto Nastaliq Urdu is integrated for all Urdu translations. Note that Urdu script requires significantly higher line-heights (minimum 1.5x - 2x) compared to Latin text to prevent character overlapping.
- **Hierarchy:** Maintain a clear distinction between the elegant serif titles and the functional sans-serif metadata.

## Layout & Spacing
The layout follows a **Fixed Grid** model on desktop to maintain an institutional "portal" feel, centered with a maximum width of 1200px.

- **Desktop:** 12-column grid with 24px gutters. Content is housed in distinct white cards.
- **Mobile:** Single column with 16px side margins. Key actions are moved to a fixed bottom navigation bar for thumb-friendly access.
- **Spacing Rhythm:** Use a 4px base unit. Component padding should lean towards generous (16px, 24px, or 32px) to ensure the interface feels accessible to elderly users or those with limited digital literacy.
- **Announcement Bar:** A high-contrast scrolling bar sits above the sticky header for urgent village updates.

## Elevation & Depth
In line with the "Flat Design" requirement, this design system avoids heavy shadows.

- **Low-Contrast Outlines:** Instead of shadows, cards use a 1px border (#CFE8E0) to separate them from the light background.
- **Tonal Layers:** Depth is communicated through color blocks. The main background is tinted (#E1F5EE), and interactive surfaces are pure white.
- **Hover States:** Interactive elements like list items or buttons should utilize a subtle background color shift (e.g., darkening by 5%) rather than lifting off the page with shadows.

## Shapes
The shape language is **Soft** (4px - 8px radius). This provides a modern touch without appearing overly "tech-startup" or playful. 

- **Cards & Inputs:** 4px (Soft) corner radius.
- **Buttons:** 4px corner radius to maintain a professional, sturdy appearance.
- **Status Badges:** Fully rounded (pill-shaped) to distinguish them from functional buttons.

## Components
- **Sticky Header:** The header remains fixed at the top, featuring the "Dhab Pari" wordmark in Playfair Display. It uses the Primary Dark (#085041) background with white text.
- **Data Tables:** Robust, high-contrast tables with zebra-striping using the background tint. Headers must be sticky for long lists of village records.
- **Status Badges:** 
    - **PAID:** Dark Green background, white text.
    - **UNPAID:** Soft Red background, dark red text.
    - **Ongoing:** Amber background, dark brown text.
- **Buttons:** Primary buttons use the Primary Mid green. Secondary buttons use a "Ghost" style with a 2px green border.
- **Mobile Bottom Navigation:** A fixed bar with 4-5 icons (Home, Records, News, Profile) to ensure ease of use on small screens.
- **Input Fields:** Use thick 2px borders for focus states to ensure high visibility for accessibility. Use labels above the fields, never as placeholders only.