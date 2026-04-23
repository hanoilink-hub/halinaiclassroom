/**
 * Transcript UI — continuous paragraph flow display with speaker diarization
 * 
 * Design: All text flows as one continuous paragraph.
 * - Translated text: white (primary color)
 * - Original text (pending translation): cyan/accent color  
 * - Provisional text (being recognized): dimmed
 * - Speaker labels: shown when speaker changes (e.g. "Speaker 1:")
 * - Language badges: shown when detected language changes (e.g. "🇯🇵 JA")
 * - Confidence: low-confidence segments highlighted
 */

export class TranscriptUI {
    constructor(container) {
        this.container = container;
        this.contentEl = null;
        this.maxChars = 1200;
        this.fontSize = 16;
        this.viewMode = 'single'; // 'single' or 'dual'
        this.sessionLogMax = 5000;

        // Segments: each has { original, translation, status, speaker, language, confidence }
        this.segments = [];
        // sessionLog: bounded buffer (avoid RAM bloat on long runs)
        this.sessionLog = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this.currentSpeaker = null; // Track current speaker to detect changes
        this.currentLanguage = null; // Track current language to detect changes
        this.lastConfidence = null; // Last confidence score from Soniox
    }

    /**
     * Update display settings
     */
    configure({ maxLines, showOriginal, fontSize, fontColor, viewMode }) {
        if (maxLines !== undefined) this.maxChars = maxLines * 160;
        if (fontSize !== undefined) {
            this.fontSize = fontSize;
            this.container.style.setProperty('--transcript-font-size', `${fontSize}px`);
        }
        if (fontColor !== undefined) {
            this.fontColor = fontColor;
            this.container.style.setProperty('--transcript-font-color', fontColor);
        }
        if (viewMode !== undefined) {
            this.viewMode = viewMode;
            const overlay = document.getElementById('overlay-view');
            if (overlay) {
                overlay.classList.toggle('dual-view', viewMode === 'dual');
            }
            this._render();
        }
    }

    /**
     * Add finalized original text (pending translation)
     */
    addOriginal(text, speaker, language) {
        this._removeListening();
        const seg = {
            original: text,
            translation: null,
            status: 'original',
            speaker: speaker || null,
            language: language || null,
            confidence: this.lastConfidence,
            createdAt: Date.now(),
        };
        this.segments.push(seg);
        // Also push a separate copy to sessionLog (never trimmed)
        this.sessionLog.push({
            original: text,
            translation: null,
            status: 'original',
            speaker: speaker || null,
            language: language || null,
            confidence: this.lastConfidence,
            createdAt: seg.createdAt,
        });
        this._trimSessionLog();
        if (speaker) this.currentSpeaker = speaker;
        if (language) this.currentLanguage = language;
        this._cleanupStaleOriginals();
        this._render();
    }

    /**
     * Apply translation to the oldest untranslated segment
     */
    addTranslation(text) {
        const seg = this.segments.find(s => s.status === 'original');
        if (seg) {
            seg.translation = text;
            seg.status = 'translated';
            // Mirror update in sessionLog: find matching entry by createdAt
            const logSeg = this.sessionLog.find(
                s => s.status === 'original' && s.createdAt === seg.createdAt
            );
            if (logSeg) {
                logSeg.translation = text;
                logSeg.status = 'translated';
            }
        } else {
            const newSeg = {
                original: '',
                translation: text,
                status: 'translated',
                speaker: null,
                createdAt: Date.now(),
            };
            this.segments.push(newSeg);
            this.sessionLog.push({ ...newSeg });
            this._trimSessionLog();
        }
        this._render();
    }

    /**
     * One finalized line from backend STT (HaLin Whisper): no separate translation step.
     * Single-view only renders `translated` rows; using addOriginal+addTranslation per line can
     * pair incorrectly when several segments arrive at once — this path is atomic.
     */
    addSttFinalSegment(text, speaker, language) {
        const t = String(text || '').trim();
        if (!t) return;
        this._removeListening();
        const now = Date.now();
        const seg = {
            original: t,
            translation: t,
            status: 'translated',
            speaker: speaker != null ? speaker : null,
            language: language != null ? String(language) : null,
            confidence: this.lastConfidence,
            createdAt: now,
        };
        this.segments.push(seg);
        this.sessionLog.push({
            original: t,
            translation: t,
            status: 'translated',
            speaker: seg.speaker,
            language: seg.language,
            confidence: seg.confidence,
            createdAt: now,
        });
        this._trimSessionLog();
        if (seg.speaker) this.currentSpeaker = seg.speaker;
        if (seg.language) this.currentLanguage = seg.language;
        this._render();
    }

    /**
     * Build segment list for POST /finalize-live `client_segments` when server DB has no chunk rows.
     * Uses sessionLog (full history); timestamps are approximate (ordering preserved).
     */
    getHalinFinalizeSegments() {
        const log = this.sessionLog || [];
        if (!log.length) return null;
        const out = [];
        let tCursor = 0;
        for (const s of log) {
            const text = String(s.translation || s.original || '').trim();
            if (!text) continue;
            const dur = Math.max(0.3, Math.min(45, text.length * 0.05));
            const start = tCursor;
            const end = start + dur;
            tCursor = end;
            const row = {
                start,
                end,
                text,
                speaker: s.speaker != null ? s.speaker : null,
                language: s.language != null ? String(s.language) : null,
                status: 'final',
            };
            out.push(row);
        }
        return out.length ? out : null;
    }

    /**
     * Update provisional (in-progress) text
     */
    setProvisional(text, speaker, language) {
        this._removeListening();
        this.provisionalText = text;
        this.provisionalSpeaker = speaker || null;
        this.provisionalLanguage = language || null;
        this._render();
    }

    /**
     * Clear provisional text
     */
    clearProvisional() {
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this._render();
    }

    /**
     * Check if there is any content to display
     */
    hasContent() {
        return this.segments.length > 0 || this.provisionalText ||
            !!this.container.querySelector('.listening-indicator');
    }

    /**
     * Show placeholder state
     */
    showPlaceholder() {
        this.container.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'transcript-placeholder transcript-placeholder--minimal';
        wrap.setAttribute('aria-hidden', 'true');
        this.container.appendChild(wrap);

        this.segments = [];
        this.sessionLog = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this.currentSpeaker = null;
        this.currentLanguage = null;
        this.lastConfidence = null;
        this.contentEl = null;
    }

    /**
     * Show listening state
     */
    showListening() {
        // Remove existing indicators first (prevent duplicates)
        this.container.querySelectorAll('.listening-indicator').forEach(el => el.remove());

        const placeholder = this.container.querySelector('.transcript-placeholder');
        if (placeholder) placeholder.remove();

        this._ensureContent();

        const indicator = document.createElement('div');
        indicator.className = 'listening-indicator';
        const waves = document.createElement('div');
        waves.className = 'listening-waves';
        for (let i = 0; i < 5; i++) waves.appendChild(document.createElement('span'));
        const text = document.createElement('p');
        text.textContent = 'Đang nghe…';
        indicator.appendChild(waves);
        indicator.appendChild(text);
        this.contentEl.appendChild(indicator);
    }

    /**
     * Show status message in transcript area (e.g. loading model)
     */
    showStatusMessage(message) {
        this._ensureContent();
        let statusEl = this.contentEl.querySelector('.pipeline-status');
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.className = 'pipeline-status';
            statusEl.className = 'pipeline-status';
            this.contentEl.appendChild(statusEl);
        }
        statusEl.textContent = message;
    }

    /**
     * Remove status message
     */
    removeStatusMessage() {
        if (this.contentEl) {
            const statusEl = this.contentEl.querySelector('.pipeline-status');
            if (statusEl) statusEl.remove();
        }
    }

    /**
     * Get transcript as plain text for copying
     */
    getPlainText() {
        let lines = [];
        for (const seg of this.segments) {
            if (seg.original) lines.push(seg.original);
            if (seg.translation) lines.push(seg.translation);
            if (seg.original || seg.translation) lines.push('');
        }
        if (this.provisionalText) lines.push(this.provisionalText);
        return lines.join('\n').trim();
    }

    /**
     * Get formatted content for saving to file (markdown with metadata)
     */
    getFormattedContent(metadata = {}) {
        if (this.segments.length === 0) return null;

        const lines = [];

        // Metadata header
        lines.push('---');
        lines.push(`date: ${new Date().toISOString()}`);
        if (metadata.model) lines.push(`model: ${metadata.model}`);
        if (metadata.sourceLang) lines.push(`source_language: ${metadata.sourceLang}`);
        if (metadata.targetLang) lines.push(`target_language: ${metadata.targetLang}`);
        if (metadata.duration) lines.push(`recording_duration: ${metadata.duration}`);
        if (metadata.audioSource) lines.push(`audio_source: ${metadata.audioSource}`);
        lines.push(`segments: ${this.segments.length}`);
        lines.push('---');
        lines.push('');

        // Transcript entries
        for (const seg of this.segments) {
            if (seg.speaker) {
                const role = this._speakerRole(seg.speaker);
                lines.push(`**${role.label}:**`);
            }
            if (seg.original) lines.push(`> ${seg.original}`);
            if (seg.translation) lines.push(seg.translation);
            lines.push('');
        }

        return lines.join('\n').trim();
    }

    /**
     * Check if there are segments to save
     */
    hasSegments() {
        return this.segments.length > 0;
    }

    /**
     * Check if sessionLog has content (full session, not display buffer)
     */
    hasSessionContent() {
        return this.sessionLog.length > 0;
    }

    /**
     * Get full session text from sessionLog (never trimmed).
     * Returns formatted markdown with all segments.
     */
    getFullSessionText(metadata = {}) {
        if (this.sessionLog.length === 0) return null;

        const lines = [];

        // YAML frontmatter
        lines.push('---');
        const now = new Date();
        lines.push(`date: ${now.toISOString().slice(0, 10)}`);
        lines.push(`time: ${now.toTimeString().slice(0, 8)}`);
        if (metadata.duration) lines.push(`duration: ${metadata.duration}`);
        if (metadata.sourceLang) lines.push(`source_lang: ${metadata.sourceLang}`);
        if (metadata.targetLang) lines.push(`target_lang: ${metadata.targetLang}`);
        if (metadata.mode) lines.push(`mode: ${metadata.mode}`);
        if (metadata.audioSource) lines.push(`audio_source: ${metadata.audioSource}`);
        if (metadata.model) lines.push(`model: ${metadata.model}`);
        lines.push(`segments: ${this.sessionLog.length}`);
        lines.push('---');
        lines.push('');

        // Transcript entries
        for (const seg of this.sessionLog) {
            if (seg.speaker) {
                const role = this._speakerRole(seg.speaker);
                lines.push(`**${role.label}:**`);
            }
            if (seg.original) lines.push(`> ${seg.original}`);
            if (seg.translation) lines.push(seg.translation);
            lines.push('');
        }

        return lines.join('\n').trim();
    }

    /**
     * Clear session log (call after saving)
     */
    clearSession() {
        this.sessionLog = [];
    }

    /**
     * Clear display buffer only (segments array).
     * sessionLog is NOT cleared — use clearSession() explicitly.
     */
    clear() {
        this.container.innerHTML = '';
        this.segments = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this.currentSpeaker = null;
        this.currentLanguage = null;
        this.lastConfidence = null;
        this.contentEl = null;
    }

    /**
     * Update confidence score
     */
    setConfidence(confidence) {
        this.lastConfidence = confidence;
    }

    // ─── Internal ──────────────────────────────────────────

    _ensureContent() {
        if (!this.contentEl) {
            this.container.innerHTML = '';
            this.contentEl = document.createElement('div');
            this.contentEl.className = 'transcript-flow';
            this.container.appendChild(this.contentEl);
        }
    }

    _removeListening() {
        const indicator = this.container.querySelector('.listening-indicator');
        if (indicator) indicator.remove();
    }

    _render() {
        this._ensureContent();
        this._trimSegments();

        if (this.viewMode === 'dual') {
            this._renderDual();
        } else {
            this._renderSingle();
        }
    }

    _renderSingle() {
        this.contentEl.textContent = '';

        for (const seg of this.segments) {
            if (seg.status !== 'translated' || !seg.translation) continue;

            const role = this._speakerRole(seg.speaker);
            const row = document.createElement('div');
            row.className = `msg-row msg-row--${role.css}`;

            const meta = document.createElement('div');
            meta.className = 'msg-meta';

            const label = document.createElement('span');
            label.className = 'msg-label';
            label.textContent = role.label;

            const time = document.createElement('span');
            time.className = 'msg-time';
            time.textContent = this._formatMsgTime(seg.createdAt);

            meta.appendChild(label);
            meta.appendChild(time);

            const bubble = document.createElement('div');
            bubble.className = 'msg-bubble';
            if (seg.confidence !== null && seg.confidence < 0.7) bubble.classList.add('low-confidence');

            if (seg.language) {
                const badge = document.createElement('span');
                badge.className = 'lang-badge';
                badge.textContent = this._langEmoji(seg.language);
                bubble.appendChild(badge);
                bubble.appendChild(document.createTextNode(' '));
            }
            bubble.appendChild(document.createTextNode(String(seg.translation)));

            row.appendChild(meta);
            row.appendChild(bubble);
            this.contentEl.appendChild(row);
        }

        if (this.provisionalText) {
            const role = this._speakerRole(this.provisionalSpeaker);
            const row = document.createElement('div');
            row.className = `msg-row msg-row--${role.css}`;

            const meta = document.createElement('div');
            meta.className = 'msg-meta';

            const label = document.createElement('span');
            label.className = 'msg-label';
            label.textContent = role.label;

            const time = document.createElement('span');
            time.className = 'msg-time';
            time.textContent = this._formatMsgTime(Date.now());

            meta.appendChild(label);
            meta.appendChild(time);

            const bubble = document.createElement('div');
            bubble.className = 'msg-bubble is-live';

            if (this.provisionalLanguage) {
                const badge = document.createElement('span');
                badge.className = 'lang-badge';
                badge.textContent = this._langEmoji(this.provisionalLanguage);
                bubble.appendChild(badge);
                bubble.appendChild(document.createTextNode(' '));
            }
            bubble.appendChild(document.createTextNode(String(this.provisionalText)));

            row.appendChild(meta);
            row.appendChild(bubble);
            this.contentEl.appendChild(row);
        }

        this._smartScroll(this.container.parentElement || this.container);
    }

    _renderDual() {
        // Save scroll state before re-render
        const oldSrcPanel = this.contentEl.querySelector('.panel-source');
        const oldTgtPanel = this.contentEl.querySelector('.panel-translation');
        const srcScrollState = oldSrcPanel ? this._getScrollState(oldSrcPanel) : { nearBottom: true, scrollTop: 0 };
        const tgtScrollState = oldTgtPanel ? this._getScrollState(oldTgtPanel) : { nearBottom: true, scrollTop: 0 };

        let lastSpeaker = null;
        let lastLang = null;

        this.contentEl.textContent = '';
        const srcPanel = document.createElement('div');
        srcPanel.className = 'panel-source';
        const tgtPanel = document.createElement('div');
        tgtPanel.className = 'panel-translation';

        for (const seg of this.segments) {
            const showSpeaker = Boolean(seg.speaker && seg.speaker !== lastSpeaker);
            const showLang = Boolean(seg.language && seg.language !== lastLang);

            let role = null;
            if (showSpeaker) {
                role = this._speakerRole(seg.speaker);
                const sp1 = document.createElement('div');
                sp1.className = `speaker-label speaker-label--${role.css}`;
                sp1.textContent = role.label;
                srcPanel.appendChild(sp1);

                const sp2 = document.createElement('div');
                sp2.className = 'speaker-label';
                sp2.textContent = '\u00A0'; // fixed placeholder, no user data
                tgtPanel.appendChild(sp2);

                lastSpeaker = seg.speaker;
            }

            if (showLang) {
                const badge = document.createElement('span');
                badge.className = 'lang-badge';
                badge.textContent = this._langEmoji(seg.language);
                // Insert as its own line-like element to match previous layout.
                const wrap = document.createElement('div');
                wrap.appendChild(badge);
                srcPanel.appendChild(wrap);
                lastLang = seg.language;
            }

            if (seg.status === 'translated' && seg.translation) {
                const src = document.createElement('div');
                src.className = 'seg-text';
                src.textContent = String(seg.original || '');
                srcPanel.appendChild(src);

                const tgt = document.createElement('div');
                tgt.className = 'seg-text';
                if (seg.confidence !== null && seg.confidence < 0.7) tgt.classList.add('low-confidence');
                tgt.textContent = String(seg.translation);
                tgtPanel.appendChild(tgt);
            } else if (seg.status === 'original' && seg.original) {
                const src = document.createElement('div');
                src.className = 'seg-text pending';
                src.textContent = String(seg.original);
                srcPanel.appendChild(src);

                const tgt = document.createElement('div');
                tgt.className = 'seg-text pending';
                tgt.textContent = '...';
                tgtPanel.appendChild(tgt);
            }
        }

        if (this.provisionalText) {
            const src = document.createElement('div');
            src.className = 'seg-text pending';
            src.textContent = String(this.provisionalText);
            srcPanel.appendChild(src);

            const tgt = document.createElement('div');
            tgt.className = 'seg-text pending';
            tgt.textContent = '...';
            tgtPanel.appendChild(tgt);
        }

        this.contentEl.appendChild(srcPanel);
        this.contentEl.appendChild(tgtPanel);

        // Restore scroll: auto-scroll if was near bottom, otherwise keep position
        if (srcPanel) {
            if (srcScrollState.nearBottom) {
                srcPanel.scrollTop = srcPanel.scrollHeight;
            } else {
                srcPanel.scrollTop = srcScrollState.scrollTop;
            }
        }
        if (tgtPanel) {
            if (tgtScrollState.nearBottom) {
                tgtPanel.scrollTop = tgtPanel.scrollHeight;
            } else {
                tgtPanel.scrollTop = tgtScrollState.scrollTop;
            }
        }
    }

    _getScrollState(el) {
        return {
            nearBottom: (el.scrollHeight - el.scrollTop - el.clientHeight) < 100,
            scrollTop: el.scrollTop
        };
    }

    _smartScroll(el) {
        const isNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 100;
        if (isNearBottom) {
            el.scrollTop = el.scrollHeight;
        }
    }

    _trimSegments() {
        let totalLen = 0;
        for (const seg of this.segments) {
            totalLen += (seg.translation || seg.original || '').length;
        }
        while (totalLen > this.maxChars && this.segments.length > 2) {
            const removed = this.segments.shift();
            totalLen -= (removed.translation || removed.original || '').length;
        }
    }

    _trimSessionLog() {
        const max = Number(this.sessionLogMax);
        if (!Number.isFinite(max) || max <= 0) return;
        const extra = this.sessionLog.length - max;
        if (extra > 0) {
            this.sessionLog.splice(0, extra);
        }
    }

    /**
     * Remove stale original segments that never received translation.
     * - Originals older than 10s are removed
     * - Max 3 pending originals allowed (oldest dropped)
     */
    _cleanupStaleOriginals() {
        const now = Date.now();
        const STALE_MS = 10000; // 10 seconds
        const MAX_PENDING = 3;

        // Remove originals older than STALE_MS
        this.segments = this.segments.filter(seg => {
            if (seg.status === 'original' && (now - seg.createdAt) > STALE_MS) {
                return false; // drop stale
            }
            return true;
        });

        // If still too many pending originals, drop oldest
        let pending = this.segments.filter(s => s.status === 'original');
        while (pending.length > MAX_PENDING) {
            const oldest = pending.shift();
            const idx = this.segments.indexOf(oldest);
            if (idx !== -1) this.segments.splice(idx, 1);
        }
    }

    _esc(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Get language flag emoji + code
     */
    _langEmoji(langCode) {
        const flags = {
            'en': '🇬🇧', 'ja': '🇯🇵', 'ko': '🇰🇷', 'zh': '🇨🇳',
            'vi': '🇻🇳', 'fr': '🇫🇷', 'de': '🇩🇪', 'es': '🇪🇸',
            'th': '🇹🇭', 'id': '🇮🇩', 'pt': '🇵🇹', 'ru': '🇷🇺',
            'ar': '🇸🇦', 'hi': '🇮🇳', 'it': '🇮🇹', 'nl': '🇳🇱',
            'pl': '🇵🇱', 'tr': '🇹🇷', 'sv': '🇸🇪', 'da': '🇩🇰',
            'no': '🇳🇴', 'fi': '🇫🇮', 'el': '🇬🇷', 'cs': '🇨🇿',
            'ro': '🇷🇴', 'hu': '🇭🇺', 'uk': '🇺🇦', 'he': '🇮🇱',
            'ms': '🇲🇾', 'tl': '🇵🇭', 'bn': '🇧🇩', 'ta': '🇱🇰',
        };
        const flag = flags[langCode] || '🌐';
        return `${flag} ${langCode.toUpperCase()}`;
    }

    /**
     * Map diarization speaker id → Teacher / Student bubbles
     */
    _speakerRole(speaker) {
        // Whisper / HaLin backend STT does not send diarization — null must not imply "teacher".
        if (speaker === null || speaker === undefined || speaker === '') {
            return { css: 'neutral', label: 'Phiên âm' };
        }
        const raw = String(speaker).trim();
        const s = raw.toLowerCase();
        if (s === 'teacher') return { css: 'teacher', label: 'Giáo viên' };
        if (s === 'unknown') return { css: 'neutral', label: 'Chưa xác định' };
        const m = /^student_?0*(\d+)$/i.exec(raw);
        if (m) return { css: 'student', label: `Học viên ${m[1]}` };
        if (s === 'student') return { css: 'student', label: 'Học viên' };
        const n = Number(speaker);
        if (n === 2) return { css: 'student', label: 'Học viên' };
        if (n === 1 || n === 0) return { css: 'teacher', label: 'Giáo viên' };
        if (!Number.isNaN(n) && String(speaker).trim() !== '') {
            return { css: 'neutral', label: `Người nói ${n}` };
        }
        return { css: 'neutral', label: raw };
    }

    _formatMsgTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
}
