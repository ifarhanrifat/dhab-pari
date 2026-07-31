import type { Metadata } from "next";
import { Source_Sans_3, Playfair_Display, Noto_Nastaliq_Urdu } from "next/font/google";
import { Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
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

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Dhab Pari Water & Welfare Committee",
    template: "%s | Dhab Pari",
  },
  description: "Official portal for the Water & Welfare Committee of Dhab Pari village, Dist. Chakwal, Punjab, Pakistan.",
  metadataBase: new URL("https://dhabpari.com"),
  openGraph: {
    siteName: "Dhab Pari Water & Welfare Committee",
    locale: "en_US",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sourceSans.variable} ${playfair.variable} ${notoNastaliq.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster
          position="top-center"
          richColors
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
