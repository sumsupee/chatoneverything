/**
 * Selects an element by ID.
 * @param {string} id 
 * @returns {HTMLElement|null}
 */
export const $ = (id) => document.getElementById(id);

/**
 * Normalizes whitespace in a string, replacing multiple spaces with a single space.
 * @param {string} s
 * @returns {string}
 */
export function normalizeWhitespace(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Counts the number of words in a string.
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return 0;
    return normalized.split(' ').filter(Boolean).length;
}

/**
 * Truncates text to a maximum number of words.
 * @param {string} text
 * @param {number} maxWords
 * @returns {string}
 */
export function truncateToMaxWords(text, maxWords) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return '';
    const words = normalized.split(' ').filter(Boolean);
    if (words.length <= maxWords) return normalized;
    return words.slice(0, maxWords).join(' ');
}

/**
 * Escapes HTML special characters to prevent XSS.
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Generates a consistent HSL color based on the username string.
 * @param {string} username
 * @returns {string} HSL color string
 */
export function getUserColor(username) {
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
        hash = username.charCodeAt(i) + ((hash << 5) - hash);
        hash = hash & hash;
    }
    const hue = Math.abs(hash) % 360;
    // Muted colors for theatre use (avoid vibrant user hues)
    const saturation = 28 + (Math.abs(hash >> 8) % 10);
    const lightness = 56 + (Math.abs(hash >> 16) % 10);
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}
