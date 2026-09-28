import type { Config } from "tailwindcss";

/**
 * Design system — mirrors the Tech Notebook project: light slate ground,
 * blue brand + violet accent, white cards with soft shadows.
 *
 * The token NAMES are unchanged from the previous dark theme on purpose:
 * every component already styles itself through them, so re-pointing the
 * values re-skins the whole app without touching each component.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // --- ground + surfaces (slate ramp)
        bg: "#f1f5f9",
        surface: "#ffffff",
        surface2: "#f8fafc",
        surface3: "#f1f5f9",
        line: "#e2e8f0",
        lineStrong: "#cbd5e1",

        // --- type
        ink: "#0f172a",
        muted: "#475569",
        faint: "#94a3b8",

        // --- product accents. Speech = brand blue, Video = violet.
        // Same meaning as before, re-hued to the Tech Notebook palette.
        audio: "#2563eb",
        audioSoft: "#2563eb14",
        video: "#7c3aed",
        videoSoft: "#7c3aed14",

        // --- state. `live` amber ONLY while recording/generating.
        live: "#f59e0b",
        liveSoft: "#f59e0b1a",
        danger: "#ef4444",
        dangerSoft: "#ef44441a",
        ready: "#22c55e",

        // --- brand ramp (gradients + hover shades)
        brand: {
          50: "#eff6ff",
          100: "#dbeafe",
          300: "#93c5fd",
          400: "#60a5fa",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          950: "#172554",
        },
        accent: {
          400: "#a78bfa",
          500: "#8b5cf6",
          600: "#7c3aed",
        },

        // --- legacy aliases so nothing renders broken mid-migration
        desk: "#f1f5f9",
        panel: "#ffffff",
        rule: "#e2e8f0",
        text: "#0f172a",
        signal: "#f59e0b",
      },
      fontFamily: {
        display: ["var(--font-space-grotesk)", "system-ui", "sans-serif"],
        body: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "monospace"],
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "1rem",
      },
      boxShadow: {
        card: "0 1px 2px rgba(15,23,42,.05), 0 4px 12px rgba(15,23,42,.05)",
        lift: "0 8px 20px rgba(15,23,42,.08)",
        glow: "0 0 0 1px rgba(37,99,235,.25), 0 8px 24px -10px rgba(37,99,235,.35)",
        glowVideo: "0 0 0 1px rgba(124,58,237,.25), 0 8px 24px -10px rgba(124,58,237,.35)",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: { "100%": { transform: "translateX(100%)" } },
        breathe: {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: ".55" },
        },
        slide: {
          "0%": { left: "-35%" },
          "100%": { left: "100%" },
        },
      },
      animation: {
        "fade-up": "fade-up .3s ease-out both",
        shimmer: "shimmer 1.6s infinite",
        breathe: "breathe 1.8s ease-in-out infinite",
        slide: "slide 1.3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
