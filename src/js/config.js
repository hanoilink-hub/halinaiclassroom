/**
 * Cấu hình mặc định — desktop HaLin AI Platform
 *
 * URL backend được quyết định bởi Rust settings.rs dựa theo build mode:
 *   - tauri dev  (debug)   → http://localhost:8000
 *   - tauri build (release) → https://noibo.hanoilink.edu.vn
 *
 * Hằng số này chỉ là fallback JS khi settings Rust bị lỗi hoàn toàn.
 * Không cần sửa file này khi chuyển qua lại giữa dev và production.
 */
export const DEFAULT_HALIN_API_BASE_URL = 'https://noibo.hanoilink.edu.vn';

/**
 * Warn when a non-local API URL uses plain HTTP (risk of eavesdropping on the network).
 * @param {string} url
 */
export function validateBaseUrl(url) {
  const u = String(url || '').trim();
  if (!u) return;
  if (u.startsWith('http://') && !u.includes('127.0.0.1') && !u.includes('localhost')) {
    console.warn('⚠️ HaLin API URL không dùng HTTPS — dữ liệu có thể bị nghe lén');
  }
}
