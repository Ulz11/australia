import type { Metadata, Viewport } from "next";
import { getLang } from "@/lib/i18n/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "OnSite",
  description: "Shifts for construction crews. Post, match, clock in, approve.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "OnSite" },
};
export const viewport: Viewport = { themeColor: "#15171A", width: "device-width", initialScale: 1, maximumScale: 1, viewportFit: "cover" };

/** `lang` follows whoever is reading: a worker's language, and always English on a boss screen. */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await getLang();
  return (
    <html lang={lang}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
