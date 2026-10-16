import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerDingTalkCardExtension as register } from '../../src/card/card-extension-api';
import { createCardExtensionHost } from './fixtures/card-extension-host';

const options = { accountId: 'main', namespace: 'example', onAction: vi.fn() };
const input = { cardId: 'card-1', userId: 'user-1', templateId: 'example.schema', variables: { title: 'Hello' } };
const transport = () => ({ isConnected: () => true, send: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined) });
let host: ReturnType<typeof createCardExtensionHost>;
const extension = (opts = options) => host.register(() => register(host.api() as any, opts));
beforeEach(() => { host = createCardExtensionHost(); });

describe('card extension public API with the installed host SDK', () => {
    it('registers synchronously before a transport exists and exposes only the small business API', async () => {
        const client = extension();
        expect(client.isReady()).toBe(false);
        expect(Object.keys(client).sort()).toEqual(['isReady', 'sendCard', 'updateCard']);
        await expect(client.sendCard(input)).rejects.toMatchObject({ code: 'unavailable' });
        expect(host.registrations()).toEqual([expect.objectContaining({
            channel: 'dingtalk', namespace: 'ocx1.main.example', pluginId: 'consumer',
            pluginName: 'Plugin consumer', pluginRoot: '/plugins/consumer',
        })]);
    });
    it('rejects an absent runtime before registering a handler', () => {
        for (const api of [{ id: 'consumer' }, { id: 'consumer', runtime: { channel: {} } }]) {
            expect(() => register(api as any, options)).toThrow(expect.objectContaining({ code: 'unavailable' }));
        }
        expect(host.registrations()).toHaveLength(0);
    });
    it('loses readiness when the host aborts the account transport lease', async () => {
        const client = extension();
        const controller = new AbortController();
        host.bind('main', transport(), controller.signal);
        expect(client.isReady()).toBe(true);
        controller.abort();
        expect(client.isReady()).toBe(false);
        await expect(client.updateCard(input)).rejects.toMatchObject({ code: 'unavailable' });
    });
    it('follows scoped transport readiness and returns no wire identifiers', async () => {
        let connected = true;
        const first = transport();
        first.isConnected = () => connected;
        host.bind('main', first);
        const client = extension();
        expect(client.isReady()).toBe(true);
        expect(await client.sendCard(input)).toBeUndefined();
        expect(await client.updateCard(input)).toBeUndefined();
        expect(first.send).toHaveBeenCalledWith(expect.objectContaining({ outTrackId: 'ocx1.main.example.card-1' }));
        expect(first.update).toHaveBeenCalledWith(expect.objectContaining({ outTrackId: 'ocx1.main.example.card-1' }));
        const second = transport();
        host.bind('other', second);
        await extension({ ...options, accountId: 'other' }).sendCard(input);
        expect(second.send).toHaveBeenCalledWith(expect.objectContaining({ outTrackId: 'ocx1.other.example.card-1' }));
        connected = false;
        expect(client.isReady()).toBe(false);
        await expect(client.sendCard(input)).rejects.toMatchObject({ code: 'not-connected' });
        expect(first.send).toHaveBeenCalledTimes(1);
        connected = true;
        expect(client.isReady()).toBe(true);
    });
    it('uses host-owned exact namespace conflicts and allows account/namespace separation', () => {
        extension();
        expect(() => extension()).toThrow(expect.objectContaining({ code: 'namespace-conflict' }));
        expect(() => extension({ ...options, namespace: 'example-more' })).not.toThrow();
        expect(() => extension({ ...options, accountId: 'other' })).not.toThrow();
    });
    it('registers anew after the host replaces its plugin registry', () => {
        extension();
        host.reload();
        expect(host.registrations()).toHaveLength(0);
        expect(() => extension()).not.toThrow();
        expect(host.registrations()).toHaveLength(1);
    });
    it('does not let a stale lease release a replacement transport', () => {
        const first = host.bind('main', transport());
        const next = transport();
        const second = host.bind('main', next);
        first.dispose();
        expect(host.getTransport('main')).toBe(next);
        second.dispose();
        expect(host.getTransport('main')).toBeUndefined();
    });
    it('isolates runtime-context instances and requires the exact capability', () => {
        const first = extension();
        const otherHost = createCardExtensionHost();
        otherHost.bind('main', transport());
        expect(first.isReady()).toBe(false);
        host.channelRuntime.runtimeContexts.register({ channelId: 'dingtalk', accountId: 'main', capability: 'other', context: transport() });
        expect(first.isReady()).toBe(false);
        host.bind('main', transport());
        expect(first.isReady()).toBe(true);
    });
    it.each([null, {}, { isConnected: true }, { isConnected: () => true, send: () => {} }])('rejects malformed host capability %j', async (context) => {
        const client = extension();
        host.bind('main', context);
        expect(client.isReady()).toBe(false);
        await expect(client.sendCard(input)).rejects.toMatchObject({ code: 'unavailable' });
    });
    it.each([
        { accountId: '../other' }, { namespace: '*' }, { namespace: 'a.b' },
        { namespace: 'A' }, { namespace: 'x'.repeat(33) }, { onAction: null },
    ])('rejects invalid registration %j', (change) => {
        expect(() => extension({ ...options, ...change } as any)).toThrow(expect.objectContaining({ code: 'invalid-argument' }));
    });
    it('rejects card route escapes and malformed variables before transport', async () => {
        const client = extension();
        for (const change of [
            { cardId: 'other.card' }, { cardId: '' }, { templateId: 'https://other' },
            { userId: 'x/y' }, { variables: { x: 1 } }, { variables: {} },
            { variables: { x: 'x'.repeat(256 * 1024) } },
        ]) await expect(client.sendCard({ ...input, ...change } as any)).rejects.toMatchObject({ code: 'invalid-argument' });
    });
    it('rejects overlong composed IDs', async () => {
        const client = extension({ ...options, accountId: 'x'.repeat(64) });
        await expect(client.updateCard({ ...input, cardId: 'y'.repeat(64) })).rejects.toMatchObject({ code: 'invalid-argument' });
    });
    it('snapshots the registration and variables against caller mutation', async () => {
        const t = transport();
        host.bind('main', t);
        const config = { ...options };
        const client = extension(config);
        config.accountId = 'other';
        const variables = { title: 'original' };
        const pending = client.sendCard({ ...input, variables });
        variables.title = 'mutated';
        await pending;
        expect(t.send).toHaveBeenCalledWith(expect.objectContaining({ variables: { title: 'original' } }));
    });
});
