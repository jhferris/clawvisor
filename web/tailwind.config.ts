import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        "surface-0": "rgb(var(--color-surface-0) / <alpha-value>)",
        "surface-1": "rgb(var(--color-surface-1) / <alpha-value>)",
        "surface-2": "rgb(var(--color-surface-2) / <alpha-value>)",
        "surface-3": "rgb(var(--color-surface-3) / <alpha-value>)",
        brand: {
          DEFAULT: "rgb(var(--color-brand) / <alpha-value>)",
          muted: "var(--color-brand-muted)",
          strong: "rgb(var(--color-brand-strong) / <alpha-value>)",
        },
        success: "rgb(var(--color-success) / <alpha-value>)",
        warning: "rgb(var(--color-warning) / <alpha-value>)",
        danger: "rgb(var(--color-danger) / <alpha-value>)",
        "text-primary": "rgb(var(--color-text-primary) / <alpha-value>)",
        "text-secondary": "rgb(var(--color-text-secondary) / <alpha-value>)",
        "text-tertiary": "rgb(var(--color-text-tertiary) / <alpha-value>)",
        "border-default": "rgb(var(--color-border-default) / <alpha-value>)",
        "border-subtle": "var(--color-border-subtle)",
        "border-strong": "rgb(var(--color-border-strong) / <alpha-value>)",
      },
    },
  },
  plugins: [],
} satisfies Config
