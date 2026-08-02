import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    server: {
      // In dev, proxy /api to localhost backend. In production, VITE_API_URL is used.
      proxy: env.VITE_API_URL
        ? undefined
        : {
            '/api': {
              target: 'http://localhost:8000',
              changeOrigin: true,
            },
          },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom', 'react-router-dom'],
            charts: ['recharts'],
            query: ['@tanstack/react-query'],
          },
        },
      },
    },
  }
})
