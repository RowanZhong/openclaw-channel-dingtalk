import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerDingTalkCardExtension as register } from '../../src/card/card-extension-api';
import { bindCardExtensionTransport, getCardExtensionRegistry } from '../../src/card/card-extension-registry';

const registryKey = Symbol.for('openclaw.dingtalk.card-extensions');
const options = { accountId: 'main', namespace: 'example', onAction: vi.fn() };
const input = { cardId: 'card-1', userId: 'user-1', templateId: 'example.schema', variables: { title: 'Hello' } };
const transport = () => ({ isConnected: () => true, send: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined) });

beforeEach(() => { delete (globalThis as any)[registryKey]; });

describe('card extension public API', () => {
    it('registers before the Channel loads without starting services', async () => {
        const extension = register(options);
        expect(extension.getStatus()).toBe('unavailable');
        await expect(extension.sendCard(input)).rejects.toMatchObject({ code: 'unavailable' });
    });
    it('reports disabled, unconfigured and disconnected states without HTTP', async () => {
        const extension = register(options);
        const registry = getCardExtensionRegistry();
        for (const state of ['account-disabled', 'account-unconfigured', 'configured'] as const) {
            registry.accountStatus = () => state;
            const expected = state === 'configured' ? 'not-connected' : state;
            expect(extension.getStatus()).toBe(expected);
            await expect(extension.updateCard(input)).rejects.toMatchObject({ code: expected });
        }
    });
    it('follows account connectivity and uses stable account-scoped IDs', async () => {
        getCardExtensionRegistry().accountStatus = () => 'configured';
        let connected = true;
        const first = transport();
        first.isConnected = () => connected;
        bindCardExtensionTransport('main', first);
        const extension = register(options);
        expect(await extension.sendCard(input)).toEqual({ outTrackId: 'ocx1.main.example.card-1' });
        await extension.updateCard(input);
        expect(first.update).toHaveBeenCalledWith(expect.objectContaining({ outTrackId: 'ocx1.main.example.card-1' }));
        const second = transport();
        bindCardExtensionTransport('other', second);
        await register({ ...options, accountId: 'other' }).sendCard(input);
        expect(second.send).toHaveBeenCalledWith(expect.objectContaining({ outTrackId: 'ocx1.other.example.card-1' }));
        connected = false;
        await expect(extension.sendCard(input)).rejects.toMatchObject({ code: 'not-connected' });
        expect(first.send).toHaveBeenCalledTimes(1);
        connected = true;
        expect(extension.getStatus()).toBe('ready');
    });
    it('rejects duplicate exact namespaces and allows distinct namespaces', () => {
        register(options);
        expect(() => register(options)).toThrow(expect.objectContaining({ code: 'namespace-conflict' }));
        expect(() => register({ ...options, namespace: 'example-more' })).not.toThrow();
        expect(() => register({ ...options, accountId: 'other' })).not.toThrow();
    });
    it('disposes idempotently without deleting a replacement registration', async () => {
        const old = register(options);
        old.dispose();
        const replacement = register(options);
        old.dispose();
        expect(getCardExtensionRegistry().registrations.size).toBe(1);
        expect(replacement.getStatus()).toBe('unavailable');
        expect(old.getStatus()).toBe('disposed');
        await expect(old.sendCard(input)).rejects.toMatchObject({ code: 'disposed' });
    });
    it('does not let a stale lifecycle release a newer account transport', () => {
        const releaseOld = bindCardExtensionTransport('main', transport());
        const next = transport();
        const releaseNew = bindCardExtensionTransport('main', next);
        releaseOld();
        expect(getCardExtensionRegistry().transports.get('main')).toBe(next);
        releaseNew();
        expect(getCardExtensionRegistry().transports.size).toBe(0);
    });
    it.each([
        { accountId: '../other' }, { namespace: '*' }, { namespace: 'a.b' },
        { namespace: 'A' }, { namespace: 'x'.repeat(33) }, { onAction: null },
    ])('rejects invalid registration %j', (change) => {
        expect(() => register({ ...options, ...change } as any)).toThrow(expect.objectContaining({ code: 'invalid-argument' }));
    });
    it('rejects card route escapes and malformed variables before transport', async () => {
        const extension = register(options);
        for (const change of [
            { cardId: 'other.card' }, { cardId: '' }, { templateId: 'https://other' },
            { userId: 'x/y' }, { variables: { x: 1 } }, { variables: {} },
            { variables: { x: 'x'.repeat(256 * 1024) } },
        ]) {
            await expect(extension.sendCard({ ...input, ...change } as any)).rejects.toMatchObject({ code: 'invalid-argument' });
        }
    });
    it('rejects overlong composed IDs', async () => {
        const extension = register({ ...options, accountId: 'x'.repeat(64) });
        await expect(extension.updateCard({ ...input, cardId: 'y'.repeat(64) })).rejects.toMatchObject({ code: 'invalid-argument' });
    });
    it('snapshots the registration and variables against caller mutation', async () => {
        getCardExtensionRegistry().accountStatus = () => 'configured';
        const t = transport();
        bindCardExtensionTransport('main', t);
        const config = { ...options };
        const extension = register(config);
        config.accountId = 'other';
        const variables = { title: 'original' };
        const pending = extension.sendCard({ ...input, variables });
        variables.title = 'mutated';
        await pending;
        expect(t.send).toHaveBeenCalledWith(expect.objectContaining({ variables: { title: 'original' } }));
    });
    it('fails explicitly on registry protocol mismatch', () => {
        (globalThis as any)[registryKey] = { version: 2 };
        expect(() => register(options)).toThrow(expect.objectContaining({ code: 'version-mismatch' }));
    });
});
