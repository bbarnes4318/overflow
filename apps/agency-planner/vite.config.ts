import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Served by the NetEnroll site at /agency-planner/ (see deploy.sh and deploy/nginx-site.conf).
export default defineConfig({ base: '/agency-planner/', plugins: [react(), tailwindcss()] });
