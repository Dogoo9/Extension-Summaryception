// Deterministic name-retention check for layer promotion. AGPL-3.0
// Promotion squeezes several snippets into one short line, and minor names are
// the first thing a model drops. This finds names in the merged inputs and
// reports which are missing from the promoted text. No model call is involved.

// Capitalized words that are usually not names. Only consulted for heuristic
// (non-protected) candidates.
const COMMON_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'so', 'yet', 'nor', 'if', 'then', 'than', 'as', 'at', 'by', 'for',
    'from', 'in', 'into', 'of', 'on', 'onto', 'to', 'with', 'without', 'within', 'after', 'before', 'during',
    'while', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how', 'what', 'once', 'later', 'meanwhile',
    'he', 'she', 'it', 'they', 'we', 'you', 'i', 'me', 'him', 'her', 'them', 'us', 'his', 'hers', 'its', 'their',
    'our', 'your', 'my', 'this', 'that', 'these', 'those', 'there', 'here', 'all', 'both', 'each', 'some', 'none',
    'no', 'not', 'yes', 'oh', 'ok', 'okay', 'player', 'assistant', 'user', 'narrator', 'system', 'mr', 'mrs', 'ms',
    'dr', 'sir', 'lady', 'lord', 'god', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november',
    'december', 'still', 'now', 'also', 'despite', 'although', 'though', 'because', 'since', 'until', 'upon',
    'together', 'eventually', 'finally', 'first', 'next', 'soon', 'unresolved', 'ongoing', 'current', 'currently',
]);

const SENTENCE_BREAK = /[.!?…:;"“”'‘’()[\]{}<>—–|\n-]$/u;

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `name` appears in `text` as a whole word (case-insensitive). */
export function containsName(text, name) {
    if (!name) return false;
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}_])`, 'iu');
    return pattern.test(String(text || ''));
}

/** Split a user-entered list (newline or comma separated) into unique names. */
export function parseNameList(value) {
    const items = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
    const seen = new Set();
    const names = [];
    for (const item of items) {
        const name = String(item || '').trim();
        if (name.length < 2 || seen.has(name.toLocaleLowerCase())) continue;
        seen.add(name.toLocaleLowerCase());
        names.push(name);
    }
    return names;
}

/**
 * Likely proper nouns in the inputs. Snippets are phrase lists, so names often
 * start a phrase; a capitalized word counts when it appears mid-phrase at least
 * once or phrase-initially at least twice, and never appears in lowercase.
 */
export function extractProperNouns(texts) {
    const stats = new Map();
    const lowercase = new Set();
    for (const text of texts) {
        const source = String(text || '');
        for (const match of source.matchAll(/\p{Ll}[\p{L}'’-]*\p{L}/gu)) {
            const word = match[0].replace(/['’]s$/u, '');
            // Only words that start lowercase; "iPhone"-style tokens are rare enough to ignore.
            const prev = source[match.index - 1];
            if (!prev || !/\p{L}/u.test(prev)) lowercase.add(word.toLocaleLowerCase());
        }
        for (const match of source.matchAll(/\p{Lu}[\p{L}'’-]*\p{L}/gu)) {
            const word = match[0].replace(/['’]s$/u, '');
            if (word.length < 3 || COMMON_WORDS.has(word.toLocaleLowerCase())) continue;
            // All-caps words are usually emphasis or acronyms; skip them.
            if (word === word.toLocaleUpperCase()) continue;
            const key = word.toLocaleLowerCase();
            const entry = stats.get(key) || { word, mid: 0, start: 0 };
            const before = source.slice(0, match.index).trimEnd();
            if (!before || SENTENCE_BREAK.test(before)) entry.start++;
            else entry.mid++;
            stats.set(key, entry);
        }
    }
    return [...stats.entries()]
        .filter(([key, entry]) => !lowercase.has(key) && (entry.mid >= 1 || entry.start >= 2))
        .map(([, entry]) => entry.word);
}

/**
 * @param {string[]} inputs  texts being merged
 * @param {string} output    promoted text
 * @param {object} [options]
 * @param {string[]} [options.protectedNames] names that must survive if present in the inputs
 * @param {number} [options.tolerance] fraction of heuristic names that may be dropped (default 0.25)
 */
export function checkNameRetention(inputs, output, { protectedNames = [], tolerance = 0.25 } = {}) {
    const protectedPresent = parseNameList(protectedNames).filter(name => inputs.some(text => containsName(text, name)));
    const protectedKeys = new Set(protectedPresent.map(name => name.toLocaleLowerCase()));
    // A heuristic word that is part of a protected name ("Mara" in "Mara Voss") is covered by that name.
    const protectedWords = new Set(protectedPresent.flatMap(name => name.toLocaleLowerCase().split(/\s+/)));
    const heuristic = extractProperNouns(inputs).filter(word => !protectedKeys.has(word.toLocaleLowerCase())
        && !protectedWords.has(word.toLocaleLowerCase()));
    const missingProtected = protectedPresent.filter(name => !containsName(output, name));
    const missingHeuristic = heuristic.filter(word => !containsName(output, word));
    const allowed = Math.floor(heuristic.length * tolerance);
    return {
        candidates: [...protectedPresent, ...heuristic],
        missing: [...missingProtected, ...missingHeuristic],
        missingProtected,
        missingHeuristic,
        ok: missingProtected.length === 0 && missingHeuristic.length <= allowed,
    };
}
