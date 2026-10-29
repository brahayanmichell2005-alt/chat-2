import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// El proxy apunta al PORT definido en el .env de la raíz (por defecto 3000).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "..", "");
  return {
    plugins: [react()],
    server: { port: 5173, proxy: { "/api": { target: `http://localhost:${env.PORT || 3000}`, changeOrigin: false } } },
  };
});
