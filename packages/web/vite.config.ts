import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Tauri 按这个端口连开发服务器，被占了就该报错，不能悄悄换一个
    port: 5173,
    strictPort: true,
  },
  build: {
    // 产物由 Tauri 编进 exe（tauri.conf.json 的 frontendDist）
    outDir: 'dist',
    // 包要小：不生成 sourcemap，它比代码本身还大
    sourcemap: false,
  },
});
