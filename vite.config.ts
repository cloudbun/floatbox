import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig({
    plugins: [
        react(),
        VitePWA({
            registerType: 'prompt',
            workbox: {
                globPatterns: ['**/*.{js,css,html,wasm}'],
                maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5 MiB — WASM binary is ~4 MB
            },
            manifest: {
                name: 'UAR Tool',
                short_name: 'UAR',
                description: 'Offline User Access Review Tool',
                theme_color: '#1e293b',
                background_color: '#0a0a0a',
                display: 'standalone',
                icons: [
                    {
                        src: '/icon-192.png',
                        sizes: '192x192',
                        type: 'image/png',
                    },
                    {
                        src: '/icon-512.png',
                        sizes: '512x512',
                        type: 'image/png',
                    },
                ],
            },
        }),
    ],
    root: '.',
    build: {
        outDir: 'dist',
        target: 'es2020',
    },
    worker: {
        format: 'es',
    },
});
