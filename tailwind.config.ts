import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // --- surfaces: a cool charcoal ramp, each step a real elevation
        bg: "#0A0C10",
        surface: "#11141B",
        surface2: "#171B24",
        surface3: "#1F242F",
        line: "#232834",
        lineStrong: "#2F3644",

        // --- type
        ink: "#E9EBF1",
        muted: "#98A0B2",
        faint: "#697183",

        // --- product accents. Speech and Video get their own hue so the two
        // halves of the app are instantly distinguishable, while sharing one
        // neutral system, spacing scale and component set.
        audio: "#4ADE9F",
        audioSoft: "#4ADE9F1F",
        video: "#7C9BFF",
        videoSoft: "#7C9BFF1F",

        // --- state. `live` amber appears ONLY while something is actually
        // recording or generating. Never decoration, never a button colour.
        live: "#FFB454",
        liveSoft: "#FFB4541F",
        danger: "#FF6B6B",
        dangerSoft: "#FF6B6B1F",

        // --- legacy aliases so nothing renders broken mid-migration
        desk: "#0A0C10",
        panel: "#11141B",
        rule: "#232834",
        text: "#E9EBF1",
        signal: "#FFB454",
        ready: "#4ADE9F",
      },
      fontFamily: {
        display: ["var(--font-space-grotesk)", "sans-serif"],
        body: ["var(--font-inter)", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "monospace"],
      },
      borderRadius: {
        xl: "14px",
        "2xl": "18px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(0,0,0,.35), 0 8px 24px -12px rgba(0,0,0,.55)",
        lift: "0 2px 4px rgba(0,0,0,.3), 0 16px 40px -16px rgba(0,0,0,.65)",
        glow: "0 0 0 1px rgba(74,222,159,.28), 0 8px 32px -12px rgba(74,222,159,.35)",
        glowVideo: "0 0 0 1px rgba(124,155,255,.28), 0 8px 32px -12px rgba(124,155,255,.35)",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        breathe: {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: ".45" },
        },
      },
      animation: {
        "fade-up": "fade-up .4s cubic-bezier(.2,.8,.3,1) both",
        shimmer: "shimmer 1.6s infinite",
        breathe: "breathe 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
