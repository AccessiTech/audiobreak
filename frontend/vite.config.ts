import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/scrape': 'http://localhost:8000',
      '/download-media': 'http://localhost:8000',
      '/start-download-media': 'http://localhost:8000',
      '/download-progress': 'http://localhost:8000',
      '/download-zip': 'http://localhost:8000',
    },
  },
})
