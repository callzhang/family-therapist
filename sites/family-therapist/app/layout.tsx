import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Between Us · Shared Understanding",
  description: "A private shared space for relationship consultation and understanding.",
  other: {
    "codex-preview": "relationship-consultation",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
