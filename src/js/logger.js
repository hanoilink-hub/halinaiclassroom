const MAX_LOG = 500;
const _logs = [];

function _push(level, tag, msg, data) {
  _logs.push({
    ts: new Date().toISOString(),
    level,
    tag: String(tag || ''),
    msg: String(msg || ''),
    data,
  });
  if (_logs.length > MAX_LOG) _logs.splice(0, _logs.length - MAX_LOG);
}

export function logInfo(tag, msg, data) {
  _push('INFO', tag, msg, data);
}

export function logWarn(tag, msg, data) {
  _push('WARN', tag, msg, data);
}

export function logError(tag, msg, err) {
  const payload =
    err && typeof err === 'object'
      ? { message: err.message || String(err), stack: err.stack || null }
      : (err != null ? String(err) : null);
  _push('ERROR', tag, msg, payload);
}

export function exportLogs() {
  return JSON.stringify(_logs, null, 2);
}

