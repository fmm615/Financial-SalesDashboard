import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          primary: "rgb(var(--color-brand-primary) / <alpha-value>)",
          accent: "rgb(var(--color-brand-accent) / <alpha-value>)",
          "accent-hover": "rgb(var(--color-brand-accent-hover) / <alpha-value>)",
          lime: "rgb(var(--color-brand-lime) / <alpha-value>)",
          "lime-hover": "rgb(var(--color-brand-lime-hover) / <alpha-value>)",
        },
        canvas: "rgb(var(--color-canvas) / <alpha-value>)",
        surface: "rgb(var(--color-surface) / <alpha-value>)",
        "surface-muted": "rgb(var(--color-surface-muted) / <alpha-value>)",
        "surface-accent": "rgb(var(--color-surface-accent) / <alpha-value>)",
        text: { primary: "rgb(var(--color-text-primary) / <alpha-value>)", secondary: "rgb(var(--color-text-secondary) / <alpha-value>)", muted: "rgb(var(--color-text-muted) / <alpha-value>)" },
        border: "rgb(var(--color-border) / <alpha-value>)",
        success: "rgb(var(--color-success) / <alpha-value>)",
        warning: "rgb(var(--color-warning) / <alpha-value>)",
        danger: "rgb(var(--color-danger) / <alpha-value>)",
        ink: "rgb(var(--color-text-primary) / <alpha-value>)",
        forest: "rgb(var(--color-brand-primary) / <alpha-value>)",
        mint: "rgb(var(--color-surface-accent) / <alpha-value>)",
        stone: "rgb(var(--color-surface-muted) / <alpha-value>)",
        line: "rgb(var(--color-border) / <alpha-value>)",
        amber: "rgb(var(--color-warning) / <alpha-value>)",
      },
      boxShadow: { card: "var(--shadow-card)", elevated: "var(--shadow-elevated)", cta: "var(--shadow-cta)" },
      borderRadius: { card: "var(--radius-md)", panel: "var(--radius-lg)", pill: "var(--radius-pill)" },
    },
  },
  plugins: [],
};

export default config;
