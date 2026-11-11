/** Design tokens live as CSS variables in src/index.css; Tailwind only maps to them. */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: v("bg"),
        surface: { 1: v("surface-1"), 2: v("surface-2"), 3: v("surface-3") },
        fg: { DEFAULT: v("fg"), muted: v("fg-muted"), subtle: v("fg-subtle") },
        accent: { DEFAULT: v("accent"), ink: v("accent-ink") },
        danger: v("danger"),
        success: v("success"),
      },
      fontFamily: {
        sans: ['"Inter Variable"', "system-ui", "sans-serif"],
        display: ['"Fraunces Variable"', "Georgia", "serif"],
      },
      spacing: { gutter: "var(--gutter)", rail: "var(--rail)" },
      borderRadius: { poster: "8px", card: "10px", modal: "16px" },
      boxShadow: {
        rest: "0 8px 30px -12px rgb(0 0 0 / .6)",
        lift: "0 24px 60px -20px rgb(0 0 0 / .85)",
      },
      transitionTimingFunction: { out: "cubic-bezier(.2,.8,.2,1)" },
      keyframes: {
        rise: { from: { opacity: 0, transform: "translateY(8px)" }, to: { opacity: 1, transform: "none" } },
        fade: { from: { opacity: 0 }, to: { opacity: 1 } },
        pop: { from: { opacity: 0, transform: "scale(.97) translateY(-6px)" }, to: { opacity: 1, transform: "none" } },
        shimmer: { from: { backgroundPosition: "-200% 0" }, to: { backgroundPosition: "200% 0" } },
      },
      animation: {
        rise: "rise 280ms cubic-bezier(.2,.8,.2,1) both",
        fade: "fade 200ms ease-out both",
        pop: "pop 180ms cubic-bezier(.2,.8,.2,1) both",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [],
};
