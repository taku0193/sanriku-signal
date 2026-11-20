import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const runtimePackages = ["react", "react-dom", "scheduler"];
const runtimeLicenses = new Set(runtimePackages.map((name) =>
  readFileSync(new URL(`./node_modules/${name}/LICENSE`, import.meta.url), "utf8")
));

export default defineConfig({
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "web",
    emptyOutDir: false,
    target: ["chrome111", "edge111", "firefox114", "safari16.4"],
    rolldownOptions: {
      output: { postBanner: `/*! ${runtimePackages.join(", ")}\n${[...runtimeLicenses].join("\n")}*/` },
    },
    lib: {
      entry: "frontend/main.tsx",
      name: "YamadaGuide",
      formats: ["iife"],
      fileName: () => "app.js",
    },
  },
});
