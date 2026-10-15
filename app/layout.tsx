import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import { getLocale } from "@/lib/i18n";
import "./globals.css";

const archivo = Archivo({ variable: "--font-archivo", subsets: ["latin"], display: "swap" });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "VDX Core", template: "%s · VDX Core" },
  description: "One platform for every VDX product.",
  appleWebApp: { capable: true, title: "VDX Core", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = { themeColor: "#050608" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang={await getLocale()} className={`${archivo.variable} ${plexMono.variable}`}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
