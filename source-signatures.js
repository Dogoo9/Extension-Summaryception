// Source validation for narrative memory. AGPL-3.0
// Two independent 32-bit hashes avoid storing copies of every original passage.
// Ghost visibility flags are excluded because /hide changes them as a side effect.
const signatureCache = new WeakMap();

export function messageSignature(message) {
    const cached = message && signatureCache.get(message);
    if (cached && cached.mes === message.mes && cached.name === message.name
        && cached.user === message.is_user && cached.swipe === message.swipe_id) return cached.signature;
    const text = JSON.stringify([message?.is_user, message?.name, message?.mes, message?.swipe_id]);
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        a = Math.imul(a ^ text.charCodeAt(i), 16777619);
        b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
    const signature = `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
    if (message && typeof message === 'object') signatureCache.set(message,
        { mes: message.mes, name: message.name, user: message.is_user, swipe: message.swipe_id, signature });
    return signature;
}

export function firstSourceChange(signatures, chat) {
    for (let i = 0; i < signatures.length; i++) {
        if (signatures[i] != null && (i >= chat.length || signatures[i] !== messageSignature(chat[i]))) return i;
    }
    return -1;
}
