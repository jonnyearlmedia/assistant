export const metadata = {
  title: "lexa",
  description: "jonny's personal AI that lives in his texts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  );
}
