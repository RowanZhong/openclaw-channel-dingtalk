import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerDingTalkCardExtension as register } from '../../src/card/card-extension-api';
import { createCardExtensionCallbackDispatcher } from '../../src/card/card-extension-callback';

let dispatch = createCardExtensionCallbackDispatcher();
const handler = vi.fn();
const log = { warn: vi.fn(), error: vi.fn() };
const input = (callbackId?: string, accountId = 'main') => ({
    accountId, callbackId, log,
    payload: { outTrackId: `ocx1.${accountId}.example.card`, userId: 'owner',
        content: { cardPrivateData: { actionIds: ['save'] } } },
});
beforeEach(() => {
    delete (globalThis as any)[Symbol.for('openclaw.dingtalk.card-extensions')];
    dispatch = createCardExtensionCallbackDispatcher();
    register({ accountId: 'main', namespace: 'example', onAction: handler });
});
afterEach(() => vi.useRealTimers());

describe('bounded card callback delivery deduplication', () => {
    it('does not expire an in-flight delivery even after the completed TTL', async () => {
        vi.useFakeTimers();
        let finish!: () => void;
        handler.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
        const first = dispatch(input('slow'));
        vi.advanceTimersByTime(10 * 60_000);
        await dispatch(input('slow'));
        expect(handler).toHaveBeenCalledOnce();
        finish(); await first;
        await dispatch(input('slow'));
        expect(handler).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(5 * 60_000);
        await dispatch(input('slow'));
        expect(handler).toHaveBeenCalledTimes(2);
    });
    it('scopes duplicate IDs to accounts and keeps different clicks distinct', async () => {
        register({ accountId: 'other', namespace: 'example', onAction: handler });
        await dispatch(input('id1'));
        await dispatch(input('id1', 'other'));
        await dispatch(input('id2'));
        expect(handler).toHaveBeenCalledTimes(3);
    });
    it('does not collapse callbacks with missing IDs', async () => {
        await dispatch(input()); await dispatch(input());
        expect(handler).toHaveBeenCalledTimes(2);
    });
    it('does not fall through or repeat effects after async rejection', async () => {
        handler.mockRejectedValue(new Error('private'));
        expect(await dispatch(input('failed'))).toBe(true);
        expect(await dispatch(input('failed'))).toBe(true);
        expect(handler).toHaveBeenCalledOnce();
        expect(log.error).toHaveBeenCalledOnce();
        expect(log.error.mock.calls.flat().join(' ')).not.toContain('private');
    });
    it('caps in-flight work without evicting pending IDs and admits work after settlement', async () => {
        let finish!: () => void;
        handler.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
        const pending = Array.from({ length: 1024 }, (_, i) => dispatch(input(`pending-${i}`)));
        await dispatch(input('overflow'));
        await dispatch(input('pending-0'));
        expect(handler).toHaveBeenCalledTimes(1024);
        expect(log.warn).toHaveBeenCalledOnce();
        finish(); await Promise.all(pending);
        await dispatch(input('new'));
        expect(handler).toHaveBeenCalledTimes(1025);
        await dispatch(input('pending-1023'));
        expect(handler).toHaveBeenCalledTimes(1025);
    });
    it('removes expired completed metadata when at capacity', async () => {
        vi.useFakeTimers();
        for (let i = 0; i < 1024; i++) await dispatch(input(`done-${i}`));
        vi.advanceTimersByTime(5 * 60_000);
        await dispatch(input('fresh'));
        await dispatch(input('done-0'));
        expect(handler).toHaveBeenCalledTimes(1026);
        expect(log.warn).not.toHaveBeenCalled();
    });
    it('ACKs reserved invalid/orphaned routes without invoking a consumer', async () => {
        const acknowledge = vi.fn();
        await dispatch({ ...input(), acknowledge, payload: { outTrackId: 'ocx1.invalid' } });
        expect(acknowledge).toHaveBeenCalledOnce();
        expect(handler).not.toHaveBeenCalled();
        expect(await dispatch({ ...input(), acknowledge, payload: { outTrackId: 'builtin' } })).toBe(false);
        expect(acknowledge).toHaveBeenCalledOnce();
    });
});
