import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // the new backend
      '/api': 'http://localhost:8000',
      // DocAssist, for the stock-changing actions not moved over yet
      '/pharmacy/api': 'http://localhost:5002',
      // DocAssist's patient statement, shared with its hospital accounts
      '/accounts/api': 'http://localhost:5002',
    },
  },
})
