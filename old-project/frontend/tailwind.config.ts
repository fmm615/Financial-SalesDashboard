import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'purple-deep': '#2A004C',
        'purple-mid': '#2C0660',
        'accent': '#C8FF00',
        'brand-red': '#D32F2F',
        'target-line': '#a6d600',
      },
      fontFamily: {
        sans: ['Work Sans', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

export default config
