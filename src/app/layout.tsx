import type { Metadata, Viewport } from "next";
import { Source_Sans_3, Playfair_Display, Noto_Nastaliq_Urdu, Noto_Naskh_Arabic } from "next/font/google";
import { Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { FloatingWhatsAppButton } from "@/components/layout/FloatingWhatsAppButton";
import { PwaProvider } from "@/components/layout/PwaProvider";
import { LocaleProvider } from "@/lib/i18n/LocaleProvider";
import { SITE } from "@/lib/constants";
import "./globals.css";

const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
});

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  weight: ["700", "800"],
});

const notoNastaliq = Noto_Nastaliq_Urdu({
  variable: "--font-noto-nastaliq",
  subsets: ["latin"],
  weight: ["400", "700"],
});

// Quranic Arabic uses a Naskh-style script (proper for a Mushaf quotation),
// not Nastaliq (that's the Urdu calligraphic style used everywhere else on
// this site) — a separate font, only for the homepage ayah banner.
const notoNaskhArabic = Noto_Naskh_Arabic({
  variable: "--font-noto-naskh",
  subsets: ["arabic"],
  weight: ["400", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: SITE.fullName,
    template: `%s | ${SITE.name}`,
  },
  description: `Official portal for the ${SITE.committee} of ${SITE.name} village, Dist. ${SITE.district}, ${SITE.province}, Pakistan.`,
  metadataBase: new URL(`https://${SITE.domain}`),
  openGraph: {
    siteName: SITE.fullName,
    locale: "en_US",
    type: "website",
  },
  // iOS ignores the web manifest's icons and display mode — these are the
  // only things that make an installed home-screen app look right on iPhone.
  appleWebApp: {
    capable: true,
    title: SITE.name,
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  other: {
    // Next emits the modern `mobile-web-app-capable`, which only iOS 15.4+
    // honours. Plenty of phones in the village will be older than that, and
    // without this legacy tag those launch in a Safari window with the address
    // bar instead of full-screen. Harmless duplication on new devices.
    "apple-mobile-web-app-capable": "yes",
  },
};

// Colours the Android status bar / iOS notch area to match the site header
// so the installed app doesn't show a white strip above the green header.
export const viewport: Viewport = {
  themeColor: "#0B3B2E",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sourceSans.variable} ${playfair.variable} ${notoNastaliq.variable} ${notoNaskhArabic.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* Wraps everything — public site, portal and admin — so a committee
            member who reads Urdu gets Urdu wherever they are, not only on the
            public pages. The provider also sets lang/dir on <html>, which is
            what makes the logical CSS properties mirror the whole layout. */}
        <LocaleProvider>
        {children}
        </LocaleProvider>
        <PwaProvider />
        <FloatingWhatsAppButton />
        <Toaster
          position="top-center"
          richColors
          closeButton
          className="dp-toaster-center"
          toastOptions={{
            duration: 3500,
            classNames: {
              toast: 'dp-toast',
              title: 'dp-toast-title',
            },
          }}
        />
      </body>
    </html>
  );
}
