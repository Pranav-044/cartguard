import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CartGuard — Bounded Agent-to-Agent Checkout",
  description:
    "AI-powered shopping with deterministic mandate guardrails, adversarial-catalog defense, and autonomous buyer agents. Powered by Razorpay.",
  keywords: ["AI shopping", "agent commerce", "Razorpay", "autonomous checkout", "agentic AI"],
  openGraph: {
    title: "CartGuard — Bounded Agent-to-Agent Checkout",
    description:
      "The first AI shopping assistant where the LLM never authorizes payments — a deterministic mandate engine does.",
    type: "website",
  },
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
  },
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <meta name="theme-color" content="#8b5cf6" />
      </head>
      <body>{children}</body>
    </html>
  );
}
