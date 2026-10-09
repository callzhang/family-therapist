import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "我们之间 · 共同理解",
  description: "为彼此理解而设的关系咨询共同空间。",
  other: {
    "codex-preview": "我们之间 · 关系咨询",
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
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
