/** @type {import('tailwindcss').Config} */
export default {
  content: ["./web/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        void: {
          0: "var(--void-0)",
          1: "var(--void-1)",
          2: "var(--void-2)",
          3: "var(--void-3)",
        },
        ember: {
          0: "var(--ember-0)",
          1: "var(--ember-1)",
          2: "var(--ember-2)",
          3: "var(--ember-3)",
          4: "var(--ember-4)",
          5: "var(--ember-5)",
          6: "var(--ember-6)",
        },
        blue: {
          0: "var(--blue-0)",
          1: "var(--blue-1)",
          2: "var(--blue-2)",
          3: "var(--blue-3)",
          4: "var(--blue-4)",
          5: "var(--blue-5)",
        },
        ink: {
          DEFAULT: "var(--ink)",
          dim: "var(--ink-dim)",
          faint: "var(--ink-faint)",
        },
      },
      fontFamily: {
        pixel: ['"Press Start 2P"', "monospace"],
        ui: ['"Pixelify Sans"', "sans-serif"],
        num: ["ui-monospace", "Consolas", "SFMono-Regular", "monospace"],
      },
      transitionTimingFunction: {
        out: "cubic-bezier(.16,1,.3,1)",
        snap: "cubic-bezier(.34,1.56,.64,1)",
      },
      boxShadow: {
        ember: "0 0 24px rgba(255,155,47,.28)",
        blue: "0 0 24px rgba(47,134,255,.25)",
      },
    },
  },
  plugins: [],
};
