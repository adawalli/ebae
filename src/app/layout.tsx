import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "ebae",
  description: "eBay, before anyone else - self-hosted eBay alerting",
  // No `manifest` key: it emits its own <link> without crossOrigin (see below).
  appleWebApp: { title: "ebae", statusBarStyle: "black-translucent" },
};

// themeColor lives here, not in metadata, where it's been deprecated since 13.2.0.
// The two entries track next-themes' light/dark; values are globals.css's
// --background converted from oklch.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef0f4" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0f16" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${plexSans.variable} ${plexMono.variable}`}>
      <head>
        {/* Hand-written rather than metadata.manifest: a manifest link fetches WITHOUT
            credentials by default, so behind Cloudflare Access it gets a login redirect
            instead of JSON and the app silently stops being installable - which on iOS
            means no push at all. Next only emits crossOrigin on Vercel preview deploys
            (lib/metadata/metadata.js), so the attribute has to be set here. */}
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        {/* No <link rel="apple-touch-icon">: Safari falls back to /apple-touch-icon.png at
            the origin root on its own, and public/ serves exactly that. A link tag here
            would be redundant, not a fix. */}
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
