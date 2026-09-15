import type { Config } from "tailwindcss";
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        hv: { DEFAULT: "#FF7A00", dark: "#D96400", soft: "#FFF1E4" },
        ink: "#15171A",
        slab: "#2B2F36",
        steel: "#6B7280",
        line: "#D9DCE1",
        site: "#F3F4F6",
        go: "#1B8F4C",
        warn: "#C62828",
      },
      fontFamily: {
        sans: ["'Archivo'", "system-ui", "sans-serif"],
        mono: ["'IBM Plex Mono'", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
