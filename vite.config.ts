import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import agents from "agents/vite";

// LOCAL_ONLY=1 runs without a Cloudflare login: Workers AI is unreachable, so the
// review uses its no-LLM fallbacks (off-spec lines go to the reviewer, template note).
const localOnly = process.env.LOCAL_ONLY === "1";

export default defineConfig({
  plugins: [
    agents(),
    react(),
    cloudflare({ remoteBindings: !localOnly }),
    tailwindcss()
  ]
});
