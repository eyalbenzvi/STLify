import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PrintCraft STL Studio",
  description:
    "יצירת קבצי STL להדפסה תלת־ממדית: שלטים, מחזיקי מפתחות, לוחיות לוגו ותבליטים",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="he" dir="rtl">
      <body className="antialiased">{children}</body>
    </html>
  );
}
