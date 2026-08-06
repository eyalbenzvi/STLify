import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Printable Product Studio",
  description:
    "סטודיו לעיצוב מוצרים להדפסה תלת־ממדית: טקסט, לוגו SVG, תבליטי תמונה, תבניות מוצר, בדיקות הדפסה וייצוא STL/3MF — הכול בדפדפן, ללא חשבון",
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
