const listeners = new Map();

export function on(event, handler) {
    if (!listeners.has(event)) {
        listeners.set(event, new Set());
    }
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
}

export function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) {
        return;
    }
    for (const handler of [...set]) {
        try {
            handler(payload);
        } catch (err) {
            console.error('[Storybook] listener failed for', event, err);
        }
    }
}

export const STORY_EVENTS = {
    UPDATE: 'story:update',
    JOB: 'story:job',
    STATS: 'story:stats',
    COMPLETE: 'story:complete',
    OPEN: 'story:open',
    SETTINGS: 'story:settings',
};
