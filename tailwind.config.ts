import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: "#14261f",
        forest: "#174b3b",
        mint: "#dff0e8",
        stone: "#f7f7f3",
        line: "#dbe2dd",
        amber: "#b66517",
      },
      boxShadow: { card: "0 1px 2px rgba(20, 38, 31, 0.05)" },
    },
  },
  plugins: [],
};

export default config;
