import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        desk: "#12141A",
        panel: "#1A1D26",
        rule: "#272B38",
        text: "#E4E6ED",
        muted: "#7C8299",
        // `signal` is ONLY for live/recording/generating state. Never buttons.
        signal: "#FF6B4A",
        ready: "#5EE6A8",
      },
      fontFamily: {
        display: ["var(--font-space-grotesk)", "sans-serif"],
        body: ["var(--font-inter)", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
