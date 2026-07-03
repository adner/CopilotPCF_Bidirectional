import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Bundles mcp-app.html + src/mcp-app.ts into a single self-contained
// dist/mcp-app.html, which server.ts serves as the MCP App viewer resource.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: "mcp-app.html",
    },
  },
});
