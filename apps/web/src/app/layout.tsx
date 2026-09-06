import type { ReactNode } from "react";
import "./style.css";
export const metadata = {
  title: "Hotspark",
  description: "Self-hosted application platform",
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
