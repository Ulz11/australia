import type { Config } from "tailwindcss";

/**
 * The palette is the material. Four of these moved, and each one moved for a measured reason — the
 * contrast figures below are against white unless they say otherwise, and nothing here ships under AA.
 *
 *   site   #F3F4F6 → #F2F2F7  a neutral system grey instead of a blue-grey. Ink on it: 16.10:1.
 *   steel  #6B7280 → #6B6B70  the secondary label. Neutral to match the canvas, and darker so it still
 *                             clears AA *on* the canvas, where the old one fell to 4.33:1. Now 5.30:1
 *                             on white and 4.75:1 on canvas.
 *   line   #D9DCE1 → #E4E4E7  a separator, not a border. It measured 1.37:1 and was never carrying any
 *                             accessibility weight; depth is a shadow now, so it gets to be a whisper.
 *   go     #1B8F4C → #14803F  white on the old green was 4.13:1 — fine for a 20px title, a fail for the
 *                             16px line under it. 5.01:1 now, so green text and white-on-green both pass.
 *
 * New: `edge` is the one grey allowed to identify a control — a filled input, a tinted button, the hours
 * stepper. It is 3.44:1 on white and 3.08:1 on the canvas — a control sits on both, and at #8E8E93 the
 * canvas case measured 2.92:1, under the 3:1 floor for a meaningful UI edge.
 */
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Hazard orange means "this needs you, now" and nothing else. One per screen, icon and words.
        // Ink on hv is 6.87:1; ink on hv-dark is 4.94:1; ink on hv-soft is 16.21:1.
        hv: { DEFAULT: "#FF7A00", dark: "#D96400", soft: "#FFF1E4" },
        ink: "#15171A",
        slab: "#2B2F36",
        steel: "#6B6B70",
        line: "#E4E4E7",
        edge: "#8A8A8E",
        site: "#F2F2F7",
        // go and warn are objects only so each can carry a soft fill for a row inside a mixed list — a
        // paid row among unpaid ones, a rained-off day among worked ones. DEFAULT keeps every existing
        // bg-go, text-warn, border-warn and bg-go/20 call site meaning exactly what it meant before.
        go: { DEFAULT: "#14803F", soft: "#E8F5EE" },
        warn: { DEFAULT: "#C62828", soft: "#FBEAEA" },
      },
      fontFamily: {
        sans: ["'Archivo'", "system-ui", "sans-serif"],
        mono: ["'IBM Plex Mono'", "ui-monospace", "monospace"],
      },
      borderRadius: {
        card: "20px",
        ctl: "14px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(16,24,40,0.04), 0 8px 24px -8px rgba(16,24,40,0.10)",
        raise: "0 2px 6px rgba(16,24,40,0.06), 0 16px 32px -12px rgba(16,24,40,0.14)",
        thumb: "0 3px 8px rgba(16,24,40,0.12), 0 1px 1px rgba(16,24,40,0.04)",
      },
      transitionTimingFunction: {
        app: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
    },
  },
  plugins: [],
} satisfies Config;
