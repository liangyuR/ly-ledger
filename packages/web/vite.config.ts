import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // 开发期把 /api 转给后端。上线时前端产物由后端一并托管，同域，没有跨域问题
    proxy: {
      '/api': { target: 'http://127.0.0.1:13000', changeOrigin: false },
      // /health 也要转，否则前端探活会拿到 Vite 返回的 index.html
      '/health': { target: 'http://127.0.0.1:13000', changeOrigin: false },
    },
  },
  build: {
    // 产物交给后端的静态托管
    outDir: 'dist',
    // 便携包要小：不生成 sourcemap，它比代码本身还大
    sourcemap: false,
  },
});
