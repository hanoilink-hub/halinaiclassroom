/**
 * Cấu hình mặc định — desktop HaLin AI Platform
 *
 * URL máy chủ API HaLin: dùng cho đăng nhập, cài đặt và gọi backend.
 * Người dùng không cần biết địa chỉ kỹ thuật — form sẽ điền sẵn giá trị này.
 *
 * Khi phát hành bản production, chỉ cần đổi hằng số tại đây (và đồng bộ
 * `DEFAULT_HALIN_BASE_URL` trong `src-tauri/src/settings.rs`).
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
