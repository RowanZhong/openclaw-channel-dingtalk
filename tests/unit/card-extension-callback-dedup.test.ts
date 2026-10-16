import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerDingTalkCardExtension as register } from '../../src/card/card-extension-api';
import { dispatchCardExtensionCallback as dispatch } from '../../src/card/card-extension-callback';
import { createCardExtensionHost } from './fixtures/card-extension-host';

let host: ReturnType<typeof createCardExtensionHost>;
const handler = vi.fn();
const log = { warn: vi.fn(), error: vi.fn() };
const input = (callbackId?: string, accountId = 'main') => ({
    accountId, callbackId, log,
    payload: { outTrackId: `ocx1.${accountId}.example.card`, userId: 'owner',
        content: { cardPrivateData: { actionIds: ['save'] } } },
});
beforeEach(() => {
    host = createCardExtensionHost();
    host.register(() => register(host.api() as any, { accountId: 'main', namespace: 'example', onAction: handler }));
});
afterEach(() => vi.useRealTimers());

describe('host-owned callback delivery deduplication', () => {
    it('does not expire an in-flight delivery even after the completed TTL', async () => {
        vi.useFakeTimers();
        let finish!: () => void;
        handler.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
        const first = dispatch(input('slow'));
        await Promise.resolve();
        vi.advanceTimersByTime(10 * 60_000);
        await dispatch(input('slow'));
        expect(handler).toHaveBeenCalledOnce();
        finish(); await first;
        await dispatch(input('slow'));
        expect(handler).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(5 * 60_000 + 1);
        await dispatch(input('slow'));
        expect(handler).toHaveBeenCalledTimes(2);
    });
    it('scopes duplicate IDs to accounts and keeps different clicks distinct', async () => {
        host.register(() => register(host.api() as any, { accountId: 'other', namespace: 'example', onAction: handler }));
        await dispatch(input('id1'));
        await dispatch(input('id1', 'other'));
        await dispatch(input('id2'));
        expect(handler).toHaveBeenCalledTimes(3);
    });
    it.each([undefined, ''])('does not collapse callbacks with missing/empty IDs %j', async (id) => {
        await dispatch(input(id)); await dispatch(input(id));
        expect(handler).toHaveBeenCalledTimes(2);
    });
    it('releases a failed claim for redelivery, then deduplicates its successful retry', async () => {
        handler.mockRejectedValueOnce(new Error('private')).mockResolvedValue(undefined);
        expect(await dispatch(input('failed'))).toBe(true);
        expect(await dispatch(input('failed'))).toBe(true);
        expect(await dispatch(input('failed'))).toBe(true);
        expect(handler).toHaveBeenCalledTimes(2);
        expect(log.error).toHaveBeenCalledOnce();
        expect(log.error.mock.calls.flat().join(' ')).not.toContain('private');
    });
    it('releases a synchronous exception for redelivery', async () => {
        handler.mockImplementationOnce(() => { throw new Error('private'); });
        await dispatch(input('sync'));
        await dispatch(input('sync'));
        expect(handler).toHaveBeenCalledTimes(2);
    });
    it('ACKs reserved invalid/orphaned routes without invoking a consumer', async () => {
        const acknowledge = vi.fn();
        for (const outTrackId of ['ocx1.invalid', 'ocx1.main.missing.card']) {
            await dispatch({ ...input(), acknowledge, payload: { ...input().payload, outTrackId } });
        }
        expect(acknowledge).toHaveBeenCalledTimes(2);
        expect(handler).not.toHaveBeenCalled();
        expect(await dispatch({ ...input(), acknowledge, payload: { outTrackId: 'builtin' } })).toBe(false);
        expect(acknowledge).toHaveBeenCalledTimes(2);
    });
    it('ACKs before any consumer code runs, including a synchronous throw', async () => {
        const acknowledge = vi.fn();
        handler.mockImplementation(() => {
            expect(acknowledge).toHaveBeenCalledOnce();
            throw new Error('private');
        });
        await dispatch({ ...input(), acknowledge });
        expect(handler).toHaveBeenCalledOnce();
    });
    it('routes callbacks to the replacement registration after host reload', async () => {
        await dispatch(input('old'));
        host.reload();
        const replacement = vi.fn();
        host.register(() => register(host.api() as any, { accountId: 'main', namespace: 'example', onAction: replacement }));
        await dispatch(input('new'));
        expect(handler).toHaveBeenCalledOnce();
        expect(replacement).toHaveBeenCalledOnce();
    });
});
