import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

const target = process.env.UZINA_WEB_API_ORIGIN ?? "http://127.0.0.1:8788";
const origin = new URL(target);
const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
if (
  !["http:", "https:"].includes(origin.protocol) ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash ||
  (origin.protocol === "http:" && !loopback)
)
  throw new Error(
    "UZINA_WEB_API_ORIGIN must be an origin; HTTP is restricted to loopback",
  );

export default defineConfig({
  plugins: [tanstackStart({ spa: { enabled: true } }), viteReact()],
  server: {
    host: "127.0.0.1",
    proxy: Object.fromEntries(
      ["/v1", "/login", "/join", "/sharing"].map((path) => [
        path,
        { target: origin.origin, changeOrigin: false },
      ]),
    ),
  },
  preview: { host: "127.0.0.1" },
});
