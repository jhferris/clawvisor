import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        "surface-0": "#0a0c10",
        "surface-1": "#0f1117",
        "surface-2": "#161923",
        "surface-3": "#1e2130",
        brand: { DEFAULT: "#818cf8", muted: "rgba(129,140,248,0.15)", strong: "#a5b4fc" },
        success: "#22c55e",
        warning: "#f59e0b",
        danger: "#ef4444",
        "text-primary": "#f0f1f3",
        "text-secondary": "#9ca3af",
        "text-tertiary": "#6b7280",
        "border-default": "#1f2937",
        "border-subtle": "rgba(31,41,55,0.5)",
        "border-strong": "#374151",
      },
    },
  },
  plugins: [],
} satisfies Config
