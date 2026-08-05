import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem', screens: { '2xl': '1440px' } },
    extend: {
      colors: {
        canvas: 'hsl(var(--canvas))',
        panel: 'hsl(var(--panel))',
        panelRaised: 'hsl(var(--panel-raised))',
        border: 'hsl(var(--border))',
        text: 'hsl(var(--text))',
        muted: 'hsl(var(--muted))',
        brand: 'hsl(var(--brand))',
        positive: 'hsl(var(--positive))',
        negative: 'hsl(var(--negative))',
        warning: 'hsl(var(--warning))',
        white: '#ffffff',
      },
      borderRadius: { xl: 'var(--radius)', '2xl': 'calc(var(--radius) + 4px)' },
      boxShadow: { panel: '0 18px 40px rgb(0 0 0 / 0.18)', glow: '0 0 32px rgb(57 135 229 / 0.14)' },
      fontFamily: { sans: ['var(--font-sans)'] },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        pulse: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '.45' } },
      },
      animation: { 'fade-up': 'fade-up .36s ease-out both', pulse: 'pulse 2s ease-in-out infinite' },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
