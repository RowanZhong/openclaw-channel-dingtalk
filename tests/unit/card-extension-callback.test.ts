import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerDingTalkCardExtension as register } from '../../src/card/card-extension-api';
import { dispatchCardExtensionCallback as dispatch } from '../../src/card/card-extension-callback';
import { createCardExtensionHost } from './fixtures/card-extension-host';

let host: ReturnType<typeof createCardExtensionHost>;

const handler = vi.fn();
const log = { debug: vi.fn(), error: vi.fn(), warn: vi.fn() };
const content = { cardPrivateData: { actionIds: ['save'], params: { form: { title: { value: 'text' }, count: 2 } } } };
const payload = () => ({ userId: 'real-user', outTrackId: 'ocx1.main.example.card-1', content: JSON.stringify(content) });
beforeEach(() => {
    host = createCardExtensionHost();
    host.register(() => register(host.api() as any, { accountId: 'main', namespace: 'example', onAction: handler }));
});

describe('card extension callback routing', () => {
    it('normalizes real outer identity and wrapped form values', async () => {
        expect(await dispatch({ accountId: 'main', payload: payload(), callbackId: 'event-1', log })).toBe(true);
        expect(handler).toHaveBeenCalledWith({
            cardId: 'card-1',
            userId: 'real-user', callbackId: 'event-1', actionIds: ['save'], form: { title: 'text', count: 2 },
        });
    });
    it('supports object content and embedded value without changing identity', async () => {
        const { content: _content, ...root } = payload();
        await dispatch({ accountId: 'main', payload: { ...root, value: JSON.stringify(content) } });
        await dispatch({ accountId: 'main', payload: { ...root, content } });
        await dispatch({ accountId: 'main', payload: { ...root, ...content } });
        expect(handler).toHaveBeenCalledTimes(3);
    });
    it('never trusts nested userId, accountId or outTrackId', async () => {
        await dispatch({ accountId: 'main', payload: { ...payload(), content: {
            ...content, userId: 'forged', accountId: 'other', outTrackId: 'ocx1.other.other.other',
        } } });
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ userId: 'real-user', cardId: 'card-1' }));
    });
    it.each([undefined, '', {}, 'bad/user'])('consumes but rejects invalid outer userId %j', async (userId) => {
        expect(await dispatch({ accountId: 'main', payload: { ...payload(), userId, content: { ...content, userId: 'forged' } } })).toBe(true);
        expect(handler).not.toHaveBeenCalled();
    });
    it('does not route using nested card identity', async () => {
        expect(await dispatch({ accountId: 'main', payload: { userId: 'real', content: { ...content, outTrackId: payload().outTrackId } } })).toBe(false);
        expect(handler).not.toHaveBeenCalled();
    });
    it('does not route to another account or namespace', async () => {
        const other = vi.fn();
        host.register(() => register(host.api() as any, { accountId: 'other', namespace: 'example', onAction: other }));
        expect(await dispatch({ accountId: 'other', payload: payload() })).toBe(true);
        expect(await dispatch({ accountId: 'main', payload: { ...payload(), outTrackId: 'ocx1.main.example-more.card-1' } })).toBe(true);
        expect(handler).not.toHaveBeenCalled();
        expect(other).not.toHaveBeenCalled();
    });
    it('consumes malformed and orphaned reserved routes', async () => {
        for (const outTrackId of ['ocx1.', 'ocx1.main.missing.card', 'ocx1.main.example.']) {
            expect(await dispatch({ accountId: 'main', payload: { ...payload(), outTrackId } })).toBe(true);
        }
        expect(handler).not.toHaveBeenCalled();
    });
    it.each(['feedback_up', 'feedback_down', 'btn_stop', 'submit'])('keeps builtin-looking action %s inside extension scope', async (action) => {
        expect(await dispatch({ accountId: 'main', payload: { ...payload(), content: { cardPrivateData: { actionIds: [action] } } } })).toBe(true);
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ actionIds: [action], form: {} }));
    });
    it('leaves builtin cards untouched', async () => {
        expect(await dispatch({ accountId: 'main', payload: { ...payload(), outTrackId: 'dingtalk-card-1' } })).toBe(false);
        expect(handler).not.toHaveBeenCalled();
    });
    it('isolates callback failures and logs no form contents or error text', async () => {
        handler.mockRejectedValueOnce(new Error('private-secret'));
        expect(await dispatch({ accountId: 'main', payload: payload(), log })).toBe(true);
        expect(log.error).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(log)).not.toContain('private-secret');
        expect(log.error.mock.calls.flat().join(' ')).not.toContain('private-secret');
    });
    it('handles malformed embedded JSON or action IDs without dispatch', async () => {
        for (const bad of ['{', {}, { cardPrivateData: { actionIds: [42] } }]) {
            expect(await dispatch({ accountId: 'main', payload: { ...payload(), content: bad } })).toBe(true);
        }
        expect(handler).not.toHaveBeenCalled();
    });
    it('keeps candidate registrations isolated until the host activates that registry', async () => {
        host.stage();
        const replacement = vi.fn();
        host.register(() => register(host.api() as any, { accountId: 'main', namespace: 'example', onAction: replacement }));
        await dispatch({ accountId: 'main', payload: payload() });
        expect(handler).toHaveBeenCalledOnce();
        expect(replacement).not.toHaveBeenCalled();
        host.activate();
        await dispatch({ accountId: 'main', payload: payload() });
        expect(handler).toHaveBeenCalledOnce();
        expect(replacement).toHaveBeenCalledOnce();
    });
    it('does not dispatch a removed consumer after host registry replacement', async () => {
        host.register(() => register(host.api() as any, { accountId: 'main', namespace: 'temporary', onAction: handler }));
        host.reload();
        expect(await dispatch({ accountId: 'main', payload: { ...payload(), outTrackId: 'ocx1.main.temporary.card' } })).toBe(true);
        expect(handler).not.toHaveBeenCalled();
    });
});
