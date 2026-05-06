/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Theme-aware ink palette — driven by CSS variables defined in
        // index.css. `[data-theme="dark"]` (default) keeps the original
        // graphite scheme; `[data-theme="light"]` flips to a clean white.
        ink: {
          900: 'rgb(var(--ink-900) / <alpha-value>)',
          800: 'rgb(var(--ink-800) / <alpha-value>)',
          700: 'rgb(var(--ink-700) / <alpha-value>)',
          600: 'rgb(var(--ink-600) / <alpha-value>)',
          500: 'rgb(var(--ink-500) / <alpha-value>)',
          400: 'rgb(var(--ink-400) / <alpha-value>)',
        },
        accent: {
          cyan: '#00bcd4',
          green: '#00c853',
          red: '#ff1744',
          amber: '#ff9800',
          magenta: '#e040fb',
          violet: '#c5b3ff',
        },
      },
    },
  },
  plugins: [],
}
